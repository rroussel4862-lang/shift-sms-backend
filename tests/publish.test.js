const request = require("supertest");
const bcrypt = require("bcryptjs");
const { app, pool } = require("../server.js");
const { createRestaurant, uniquePhone, uniqueEmail } = require("./helpers");

let A, B, ann, annPhone;
const addDays = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const mondayOf = (iso) => addDays(iso, -((new Date(iso + "T00:00:00Z").getUTCDay() + 6) % 7));
const today = new Date().toISOString().slice(0, 10);
const THIS_MON = mondayOf(today);
const NEXT_MON = addDays(THIS_MON, 14); // safely a future week whatever time zone the server is in
const AFTER_MON = addDays(THIS_MON, 21);

async function makeStaff(restaurant, name, roles = ["Server"]) {
  const phone = uniquePhone();
  const created = await restaurant.agent.post("/api/staff").send({ name, phone, roles });
  const email = uniqueEmail("pub");
  await pool.query("UPDATE staff SET email = $1, password_hash = $2 WHERE id = $3", [email, await bcrypt.hash("staffpassword123", 4), created.body.id]);
  const agent = request.agent(app);
  await agent.post("/api/staff-auth/login").send({ email, password: "staffpassword123" });
  return { id: created.body.id, agent, phone };
}

beforeAll(async () => {
  const factory = () => request.agent(app);
  A = await createRestaurant(factory);
  B = await createRestaurant(factory);
  ann = await makeStaff(A, "Ann");
});
afterAll(async () => { await pool.end(); });

const staffSees = async (from, to) => (await ann.agent.get(`/api/staff-auth/schedule?start=${from}&end=${to}`)).body;
const smsCount = async (phone) => (await pool.query("SELECT COUNT(*)::int AS n FROM activity_log WHERE restaurant_id = $1 AND event_type = 'sms_sent' AND detail LIKE $2", [A.restaurantId, `%${phone}%`])).rows[0].n;
const waitFor = async (fn, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };

describe("draft weeks stay hidden from staff until published", () => {
  test("a future week is hidden, the manager still sees it, posting it reveals it and texts the staff who work it", async () => {
    const mk = await A.agent.post("/api/schedule").send({ staffId: ann.id, date: NEXT_MON, startTime: "17:00", endTime: "23:00", role: "Server" });
    expect(mk.status).toBe(201);
    expect(await staffSees(NEXT_MON, addDays(NEXT_MON, 6))).toHaveLength(0);
    expect((await A.agent.get(`/api/schedule?start=${NEXT_MON}&end=${addDays(NEXT_MON, 6)}`)).body).toHaveLength(1);

    const st = await A.agent.get(`/api/schedule/publish?weekStart=${NEXT_MON}`);
    expect(st.body).toMatchObject({ published: false, alwaysLive: false, visibleToStaff: false });

    const before = await smsCount(ann.phone);
    const pub = await A.agent.post("/api/schedule/publish").send({ weekStart: NEXT_MON });
    expect(pub.status).toBe(200);
    expect(pub.body).toMatchObject({ published: true, visibleToStaff: true });
    expect(await staffSees(NEXT_MON, addDays(NEXT_MON, 6))).toHaveLength(1);
    expect(pub.body.texted).toBe(1); // Ann works that week, so she gets a text
    expect(await waitFor(async () => (await smsCount(ann.phone)) === before + 1)).toBe(true);
    const again = await A.agent.post("/api/schedule/publish").send({ weekStart: NEXT_MON });
    expect(again.status).toBe(200); // posting twice is harmless...
    expect(again.body.texted).toBe(0); // ...and doesn't text again
    await new Promise((r) => setTimeout(r, 500));
    expect(await smsCount(ann.phone)).toBe(before + 1);
  });

  test("back to draft hides it again", async () => {
    expect((await A.agent.delete(`/api/schedule/publish/${NEXT_MON}`)).status).toBe(200);
    expect(await staffSees(NEXT_MON, addDays(NEXT_MON, 6))).toHaveLength(0);
  });

  test("the current week is always live and can't be hidden", async () => {
    const mk = await A.agent.post("/api/schedule").send({ staffId: ann.id, date: THIS_MON, startTime: "10:00", endTime: "15:00", role: "Server" });
    expect(mk.status).toBe(201);
    expect(await staffSees(THIS_MON, addDays(THIS_MON, 6))).toHaveLength(1);
    expect((await A.agent.get(`/api/schedule/publish?weekStart=${THIS_MON}`)).body.alwaysLive).toBe(true);
    expect((await A.agent.delete(`/api/schedule/publish/${THIS_MON}`)).status).toBe(400);
  });

  test("validation, tenant isolation and auth", async () => {
    expect((await A.agent.post("/api/schedule/publish").send({ weekStart: addDays(NEXT_MON, 1) })).status).toBe(400); // not a Monday
    expect((await A.agent.post("/api/schedule/publish").send({ weekStart: "nope" })).status).toBe(400);
    expect((await request(app).post("/api/schedule/publish").send({ weekStart: NEXT_MON })).status).toBe(401);
    // B publishing the same week doesn't reveal A's draft
    await B.agent.post("/api/schedule/publish").send({ weekStart: AFTER_MON });
    await A.agent.post("/api/schedule").send({ staffId: ann.id, date: AFTER_MON, startTime: "12:00", endTime: "18:00", role: "Server" });
    expect(await staffSees(AFTER_MON, addDays(AFTER_MON, 6))).toHaveLength(0);
  });

  test("another week can be posted on its own", async () => {
    await A.agent.post("/api/schedule/publish").send({ weekStart: AFTER_MON });
    expect(await staffSees(AFTER_MON, addDays(AFTER_MON, 6))).toHaveLength(1);
  });
});

describe("Front of House and Back of House are posted separately", () => {
  const WEEK = addDays(THIS_MON, 28);
  let kim;
  const seen = async (who) => (await who.agent.get(`/api/staff-auth/schedule?start=${WEEK}&end=${addDays(WEEK, 6)}`)).body;

  test("posting FOH shows and texts only FOH; BOH stays hidden until it is posted too", async () => {
    kim = await makeStaff(A, "Kim", ["Line Cook"]);
    await A.agent.post("/api/schedule").send({ staffId: ann.id, date: addDays(WEEK, 1), startTime: "17:00", endTime: "23:00", role: "Server" });
    await A.agent.post("/api/schedule").send({ staffId: kim.id, date: addDays(WEEK, 1), startTime: "15:00", endTime: "23:00", role: "Line Cook" });
    expect(await seen(ann)).toHaveLength(0);
    expect(await seen(kim)).toHaveLength(0);

    const annBefore = await smsCount(ann.phone), kimBefore = await smsCount(kim.phone);
    const foh = await A.agent.post("/api/schedule/publish").send({ weekStart: WEEK, house: "foh" });
    expect(foh.body).toMatchObject({ house: "foh", published: true, texted: 1 });
    expect(await seen(ann)).toHaveLength(1);
    expect(await seen(kim)).toHaveLength(0); // the cook still can't see it
    expect(await waitFor(async () => (await smsCount(ann.phone)) === annBefore + 1)).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    expect(await smsCount(kim.phone)).toBe(kimBefore); // and wasn't texted

    expect((await A.agent.get(`/api/schedule/publish?weekStart=${WEEK}&house=foh`)).body.published).toBe(true);
    expect((await A.agent.get(`/api/schedule/publish?weekStart=${WEEK}&house=boh`)).body.published).toBe(false);

    const boh = await A.agent.post("/api/schedule/publish").send({ weekStart: WEEK, house: "boh" });
    expect(boh.body).toMatchObject({ house: "boh", published: true, texted: 1 });
    expect(await seen(kim)).toHaveLength(1);
    expect(await waitFor(async () => (await smsCount(kim.phone)) === kimBefore + 1)).toBe(true);
  });

  test("taking one house back to draft hides only that house; bad house values are rejected", async () => {
    expect((await A.agent.delete(`/api/schedule/publish/${WEEK}?house=boh`)).status).toBe(200);
    expect(await seen(kim)).toHaveLength(0);
    expect(await seen(ann)).toHaveLength(1);
    expect((await A.agent.post("/api/schedule/publish").send({ weekStart: WEEK, house: "kitchen" })).status).toBe(400);
    expect((await A.agent.get(`/api/schedule/publish?weekStart=${WEEK}&house=nope`)).status).toBe(400);
  });
});

describe("a week is remembered exactly as it was posted", () => {
  const WEEK = addDays(THIS_MON, 35);
  const snap = (agent, house = "foh") => agent.get(`/api/schedule/snapshot?weekStart=${WEEK}&house=${house}`);

  test("a shift cancelled after posting is still in the posted copy; a shift added after posting is not", async () => {
    const thu = (await A.agent.post("/api/schedule").send({ staffId: ann.id, date: addDays(WEEK, 3), startTime: "17:00", endTime: "23:00", role: "Server" })).body;
    await A.agent.post("/api/schedule").send({ staffId: ann.id, date: addDays(WEEK, 4), startTime: "17:00", endTime: "23:00", role: "Server" });
    expect((await snap(A.agent)).status).toBe(404); // nothing posted yet

    expect((await A.agent.post("/api/schedule/publish").send({ weekStart: WEEK, house: "foh" })).status).toBe(200);
    expect((await A.agent.delete(`/api/schedule/${thu.id}`)).status).toBe(204); // cancelled after posting
    await A.agent.post("/api/schedule").send({ staffId: ann.id, date: addDays(WEEK, 5), startTime: "17:00", endTime: "23:00", role: "Server" }); // added after posting

    const res = await snap(A.agent);
    expect(res.status).toBe(200);
    expect(res.body.shifts.map((s) => s.date).sort()).toEqual([addDays(WEEK, 3), addDays(WEEK, 4)]);
    expect(res.body.shifts[0]).toEqual(expect.objectContaining({ staffId: ann.id, startTime: expect.any(String), endTime: expect.any(String), role: "Server" }));

    // posting again does not overwrite the copy
    await A.agent.post("/api/schedule/publish").send({ weekStart: WEEK, house: "foh" });
    expect((await snap(A.agent)).body.shifts).toHaveLength(2);
    // and the other house has no copy
    expect((await snap(A.agent, "boh")).status).toBe(404);
  });

  test("going back to draft drops the copy, the next post takes a fresh one, and other restaurants can't see it", async () => {
    expect((await B.agent.get(`/api/schedule/snapshot?weekStart=${WEEK}&house=foh`)).status).toBe(404);
    expect((await A.agent.delete(`/api/schedule/publish/${WEEK}?house=foh`)).status).toBe(200);
    expect((await snap(A.agent)).status).toBe(404);
    await A.agent.post("/api/schedule/publish").send({ weekStart: WEEK, house: "foh" });
    expect((await snap(A.agent)).body.shifts.map((s) => s.date).sort()).toEqual([addDays(WEEK, 4), addDays(WEEK, 5)]);
    expect((await request(app).get(`/api/schedule/snapshot?weekStart=${WEEK}&house=foh`)).status).toBe(401);
  });
});
