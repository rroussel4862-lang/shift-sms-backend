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

async function makeStaff(restaurant, name) {
  const phone = uniquePhone();
  const created = await restaurant.agent.post("/api/staff").send({ name, phone, roles: ["Server"] });
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
  test("a future week is hidden, the manager still sees it, publishing reveals it and texts the people on it", async () => {
    const mk = await A.agent.post("/api/schedule").send({ staffId: ann.id, date: NEXT_MON, startTime: "17:00", endTime: "23:00", role: "Server" });
    expect(mk.status).toBe(201);
    expect(await staffSees(NEXT_MON, addDays(NEXT_MON, 6))).toHaveLength(0);
    expect((await A.agent.get(`/api/schedule?start=${NEXT_MON}&end=${addDays(NEXT_MON, 6)}`)).body).toHaveLength(1);

    const st = await A.agent.get(`/api/schedule/publish?weekStart=${NEXT_MON}`);
    expect(st.body).toMatchObject({ published: false, alwaysLive: false, visibleToStaff: false });

    const before = await smsCount(ann.phone);
    const pub = await A.agent.post("/api/schedule/publish").send({ weekStart: NEXT_MON });
    expect(pub.status).toBe(200);
    expect(pub.body).toMatchObject({ published: true, texted: 1 });
    expect(await staffSees(NEXT_MON, addDays(NEXT_MON, 6))).toHaveLength(1);
    expect(await waitFor(async () => (await smsCount(ann.phone)) === before + 1)).toBe(true);

    // publishing twice doesn't text twice
    expect((await A.agent.post("/api/schedule/publish").send({ weekStart: NEXT_MON })).body.texted).toBe(0);
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

  test("publish with notify:false reveals without texting", async () => {
    const before = await smsCount(ann.phone);
    const pub = await A.agent.post("/api/schedule/publish").send({ weekStart: AFTER_MON, notify: false });
    expect(pub.body.texted).toBe(0);
    expect(await staffSees(AFTER_MON, addDays(AFTER_MON, 6))).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 400));
    expect(await smsCount(ann.phone)).toBe(before);
  });
});
