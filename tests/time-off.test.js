const request = require("supertest");
const bcrypt = require("bcryptjs");
const { app, pool, checkScheduleCandidates } = require("../server.js");
const { createRestaurant, uniquePhone, uniqueEmail } = require("./helpers");

let A, B, ann;
const iso = (offset) => { const d = new Date(Date.now() + offset * 86400000); return d.toISOString().slice(0, 10); };

async function makeStaff(restaurant, name) {
  const created = await restaurant.agent.post("/api/staff").send({ name, phone: uniquePhone(), roles: ["Server"] });
  const email = uniqueEmail("to");
  await pool.query("UPDATE staff SET email = $1, password_hash = $2 WHERE id = $3", [email, await bcrypt.hash("staffpassword123", 4), created.body.id]);
  const agent = request.agent(app);
  await agent.post("/api/staff-auth/login").send({ email, password: "staffpassword123" });
  return { id: created.body.id, agent };
}

beforeAll(async () => {
  const factory = () => request.agent(app);
  A = await createRestaurant(factory);
  B = await createRestaurant(factory);
  ann = await makeStaff(A, "Ann");
});
afterAll(async () => { await pool.end(); });

describe("one-time unavailability (time off)", () => {
  let all, part;
  const d1 = iso(10), d2 = iso(11);

  test("staff can request a day and a part of a day; validation rejects bad input", async () => {
    all = await ann.agent.post("/api/staff-auth/time-off").send({ date: d1, note: "wedding" });
    expect(all.status).toBe(201);
    expect(all.body).toMatchObject({ date: d1, from: "", to: "", note: "wedding", status: "pending" });
    part = await ann.agent.post("/api/staff-auth/time-off").send({ date: d2, from: "17:00", to: "23:00" });
    expect(part.body).toMatchObject({ from: "17:00", to: "23:00", status: "pending" });
    expect((await ann.agent.post("/api/staff-auth/time-off").send({ date: d1, note: "again" })).status).toBe(409);
    expect((await ann.agent.post("/api/staff-auth/time-off").send({ date: "nope" })).status).toBe(400);
    expect((await ann.agent.post("/api/staff-auth/time-off").send({ date: iso(-2) })).status).toBe(400);
    expect((await ann.agent.post("/api/staff-auth/time-off").send({ date: d1, from: "25:00" })).status).toBe(400);
    expect((await request(app).post("/api/staff-auth/time-off").send({ date: d1 })).status).toBe(401);
    expect((await ann.agent.get("/api/staff-auth/time-off")).body).toHaveLength(2);
  });

  test("pending requests are not counted yet; the manager sees them, other restaurants do not", async () => {
    expect((await A.agent.get(`/api/time-off?start=${d1}&end=${d2}`)).body).toHaveLength(0);
    const list = await A.agent.get("/api/time-off-requests");
    expect(list.body.map((r) => r.date)).toEqual([d1, d2]);
    expect(list.body[0]).toMatchObject({ name: "Ann", staffId: ann.id });
    expect((await B.agent.get("/api/time-off-requests")).body).toHaveLength(0);
    expect((await B.agent.post(`/api/time-off-requests/${all.body.id}/approve`)).status).toBe(404);
    expect((await request(app).get("/api/time-off-requests")).status).toBe(401);
  });

  test("approving counts it; declining does not; each can only be decided once", async () => {
    expect((await A.agent.post(`/api/time-off-requests/${all.body.id}/approve`)).body.status).toBe("approved");
    expect((await A.agent.post(`/api/time-off-requests/${part.body.id}/decline`)).body.status).toBe("declined");
    expect((await A.agent.post(`/api/time-off-requests/${all.body.id}/approve`)).status).toBe(404);
    const approved = await A.agent.get(`/api/time-off?start=${d1}&end=${d2}`);
    expect(approved.body.map((r) => r.id)).toEqual([all.body.id]);
    expect((await B.agent.get(`/api/time-off?start=${d1}&end=${d2}`)).body).toHaveLength(0);
    expect((await A.agent.get("/api/time-off-requests")).body).toHaveLength(0);
  });

  test("staff can take back their own entry, nobody else's", async () => {
    const other = await makeStaff(A, "Bob");
    expect((await other.agent.delete(`/api/staff-auth/time-off/${all.body.id}`)).status).toBe(404);
    expect((await ann.agent.delete(`/api/staff-auth/time-off/${all.body.id}`)).status).toBe(204);
    expect((await A.agent.get(`/api/time-off?start=${d1}&end=${d2}`)).body).toHaveLength(0);
  });
});

describe("staff are texted the manager's decision", () => {
  const smsCount = async (restaurantId, phone) => (await pool.query("SELECT COUNT(*)::int AS n FROM activity_log WHERE restaurant_id = $1 AND event_type = 'sms_sent' AND detail LIKE $2", [restaurantId, `%${phone}%`])).rows[0].n;
  const waitFor = async (fn, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };

  test("approving or declining time off and weekly availability sends a text", async () => {
    const who = await makeStaff(A, "Cara");
    const phone = (await pool.query("SELECT phone FROM staff WHERE id = $1", [who.id])).rows[0].phone;
    const before = await smsCount(A.restaurantId, phone);
    const t1 = await who.agent.post("/api/staff-auth/time-off").send({ date: iso(20) });
    await A.agent.post(`/api/time-off-requests/${t1.body.id}/approve`);
    expect(await waitFor(async () => (await smsCount(A.restaurantId, phone)) === before + 1)).toBe(true);
    const t2 = await who.agent.post("/api/staff-auth/time-off").send({ date: iso(21) });
    await A.agent.post(`/api/time-off-requests/${t2.body.id}/decline`);
    expect(await waitFor(async () => (await smsCount(A.restaurantId, phone)) === before + 2)).toBe(true);
    await who.agent.put("/api/staff-auth/availability").send({ availability: { tue: { available: false, note: "" } } });
    await A.agent.post(`/api/availability-requests/${who.id}/approve`);
    expect(await waitFor(async () => (await smsCount(A.restaurantId, phone)) === before + 3)).toBe(true);
  });
});

describe("the scheduler respects approved time off", () => {
  const staffById = { s1: { name: "Ann", roles: ["Server"] } };
  const cand = (date, startTime, endTime) => ({ staffId: "s1", date, startTime, endTime, role: "Server" });
  const run = (c, timeOff) => checkScheduleCandidates([c], { staffById, existing: [], availabilityByStaff: null, timeOffByStaff: timeOff });

  test("an all-day entry blocks every shift that day, other days are fine", () => {
    const off = { s1: { "2026-11-02": [{ from: "", to: "" }] } };
    expect(run(cand("2026-11-02", "11:00", "16:00"), off).skipped[0].code).toBe("unavailable");
    expect(run(cand("2026-11-03", "11:00", "16:00"), off).ok).toHaveLength(1);
  });

  test("an entry with hours only blocks shifts that overlap them", () => {
    const off = { s1: { "2026-11-02": [{ from: "17:00", to: "23:00" }] } };
    expect(run(cand("2026-11-02", "11:00", "16:00"), off).ok).toHaveLength(1);
    expect(run(cand("2026-11-02", "16:00", "20:00"), off).skipped[0].code).toBe("unavailable");
  });
});
