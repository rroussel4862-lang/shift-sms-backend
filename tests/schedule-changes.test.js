const request = require("supertest");
const { app, pool } = require("../server.js");
const { createRestaurant, uniquePhone } = require("./helpers");

let A, ann, bob;
const addDays = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const mondayOf = (iso) => addDays(iso, -((new Date(iso + "T00:00:00Z").getUTCDay() + 6) % 7));
const WEEK = addDays(mondayOf(new Date().toISOString().slice(0, 10)), 14); // a future week
const smsCount = async (phone) => (await pool.query("SELECT COUNT(*)::int AS n FROM activity_log WHERE restaurant_id = $1 AND event_type = 'sms_sent' AND detail LIKE $2", [A.restaurantId, `%${phone}%`])).rows[0].n;
const waitFor = async (fn, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };

beforeAll(async () => {
  A = await createRestaurant(() => request.agent(app));
  const a = uniquePhone(), b = uniquePhone();
  ann = { phone: a, id: (await A.agent.post("/api/staff").send({ name: "Ann", phone: a, roles: ["Server"] })).body.id };
  bob = { phone: b, id: (await A.agent.post("/api/staff").send({ name: "Bob", phone: b, roles: ["Server"] })).body.id };
});
afterAll(async () => { await pool.end(); });

describe("changes to a posted week", () => {
  test("nothing to review until the week is posted; afterwards edits are listed per person and texted only when the manager says so", async () => {
    const s1 = await A.agent.post("/api/schedule").send({ staffId: ann.id, date: WEEK, startTime: "17:00", endTime: "23:00", role: "Server" });
    const s2 = await A.agent.post("/api/schedule").send({ staffId: bob.id, date: addDays(WEEK, 1), startTime: "17:00", endTime: "23:00", role: "Server" });
    expect(s1.status).toBe(201);

    expect((await A.agent.get(`/api/schedule/changes?weekStart=${WEEK}&house=foh`)).body).toMatchObject({ hasBaseline: false, total: 0 });
    expect((await A.agent.post(`/api/schedule/publish`).send({ weekStart: WEEK, house: "foh" })).status).toBeLessThan(300);
    expect((await A.agent.get(`/api/schedule/changes?weekStart=${WEEK}&house=foh`)).body).toMatchObject({ hasBaseline: true, total: 0 });

    // move Ann's shift, delete Bob's, add a new one for Bob
    await A.agent.patch(`/api/schedule/${s1.body.id}`).send({ staffId: ann.id, date: WEEK, startTime: "18:00", endTime: "23:00", role: "Server" });
    await A.agent.delete(`/api/schedule/${s2.body.id}`);
    await A.agent.post("/api/schedule").send({ staffId: bob.id, date: addDays(WEEK, 3), startTime: "11:00", endTime: "16:00", role: "Server" });

    const ch = (await A.agent.get(`/api/schedule/changes?weekStart=${WEEK}&house=foh`)).body;
    expect(ch.total).toBe(3);
    const annCh = ch.people.find((p) => p.staffId === ann.id).changes;
    expect(annCh).toHaveLength(1);
    expect(annCh[0]).toMatchObject({ type: "changed", before: { startTime: "17:00" }, after: { startTime: "18:00" } });
    expect(ch.people.find((p) => p.staffId === bob.id).changes.map((c) => c.type).sort()).toEqual(["added", "removed"]);
    expect(await smsCount(ann.phone)).toBe(0); // no text until the manager taps Notify

    const sent = await A.agent.post("/api/schedule/changes/notify").send({ weekStart: WEEK, house: "foh", action: "send" });
    expect(sent.body).toMatchObject({ texted: 2, people: 2 });
    expect(await waitFor(async () => (await smsCount(ann.phone)) === 1 && (await smsCount(bob.phone)) === 1)).toBe(true);

    expect((await A.agent.get(`/api/schedule/changes?weekStart=${WEEK}&house=foh`)).body.total).toBe(0); // baseline reset
  });

  test("'Don't notify' clears the list without texting; bad input is refused", async () => {
    const sh = await A.agent.post("/api/schedule").send({ staffId: ann.id, date: addDays(WEEK, 2), startTime: "10:00", endTime: "14:00", role: "Server" });
    expect(sh.status).toBe(201);
    const before = await smsCount(ann.phone);
    expect((await A.agent.get(`/api/schedule/changes?weekStart=${WEEK}&house=foh`)).body.total).toBe(1);
    const d = await A.agent.post("/api/schedule/changes/notify").send({ weekStart: WEEK, house: "foh", action: "dismiss" });
    expect(d.body).toMatchObject({ texted: 0 });
    await new Promise((r) => setTimeout(r, 400));
    expect(await smsCount(ann.phone)).toBe(before);
    expect((await A.agent.get(`/api/schedule/changes?weekStart=${WEEK}&house=foh`)).body.total).toBe(0);

    expect((await A.agent.post("/api/schedule/changes/notify").send({ weekStart: WEEK, house: "foh", action: "x" })).status).toBe(400);
    expect((await A.agent.get(`/api/schedule/changes?weekStart=2026-01-02&house=foh`)).status).toBe(400);
    expect((await request.agent(app).get(`/api/schedule/changes?weekStart=${WEEK}&house=foh`)).status).toBe(401);
  });
});

describe("the current (always live) week", () => {
  test("changes are listed from the first time the week is opened", async () => {
    const mon = mondayOf(new Date().toISOString().slice(0, 10));
    const day = addDays(mon, 6); // Sunday: today or later unless we are past it, so use a far-enough day below
    const target = day >= new Date().toISOString().slice(0, 10) ? day : addDays(day, 0);
    expect((await A.agent.get(`/api/schedule/changes?weekStart=${mon}&house=foh`)).body).toMatchObject({ hasBaseline: true, total: 0 });
    await A.agent.post("/api/schedule").send({ staffId: ann.id, date: target, startTime: "09:00", endTime: "13:00", role: "Server" });
    expect((await A.agent.get(`/api/schedule/changes?weekStart=${mon}&house=foh`)).body.total).toBe(1);
  });
});
