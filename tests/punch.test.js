const request = require("supertest");
const { app, pool } = require("../server.js");
const { createRestaurant, uniquePhone } = require("./helpers");

let A, B, ana, shift;
const DAY = "2026-12-02";

beforeAll(async () => {
  const factory = () => request.agent(app);
  A = await createRestaurant(factory);
  B = await createRestaurant(factory);
  ana = (await A.agent.post("/api/staff").send({ name: "Ana", phone: uniquePhone(), roles: ["Server"] })).body.id;
  shift = (await A.agent.post("/api/schedule").send({ staffId: ana, date: DAY, startTime: "17:00", endTime: "23:00", role: "Server" })).body;
});
afterAll(async () => { await pool.end(); });

const get = async () => (await A.agent.get(`/api/schedule?start=${DAY}&end=${DAY}`)).body.find((s) => s.id === shift.id);

describe("punch clock", () => {
  test("punch times replace the grid times and the scheduled times are kept", async () => {
    const res = await A.agent.post("/api/schedule/punch").send({ entries: [{ id: shift.id, punchIn: "17:12", punchOut: "23:40" }] });
    expect(res.status).toBe(200);
    expect(res.body.updated).toHaveLength(1);
    expect(await get()).toMatchObject({ startTime: "17:12", endTime: "23:40", punchIn: "17:12", punchOut: "23:40", scheduledStart: "17:00", scheduledEnd: "23:00" });
  });

  test("punching again keeps the ORIGINAL schedule; a half-filled entry changes only that side", async () => {
    await A.agent.post("/api/schedule/punch").send({ entries: [{ id: shift.id, punchOut: "23:55" }] });
    expect(await get()).toMatchObject({ startTime: "17:12", endTime: "23:55", scheduledStart: "17:00", scheduledEnd: "23:00" });
  });

  test("empty entries change nothing; bad times are rejected and change nothing", async () => {
    expect((await A.agent.post("/api/schedule/punch").send({ entries: [{ id: shift.id }] })).body.updated).toHaveLength(0);
    expect((await A.agent.post("/api/schedule/punch").send({ entries: [{ id: shift.id, punchIn: "25:00" }] })).status).toBe(400);
    expect((await A.agent.post("/api/schedule/punch").send({ entries: [{ id: shift.id, punchIn: "20:00", punchOut: "20:00" }] })).status).toBe(400);
    expect(await get()).toMatchObject({ startTime: "17:12", endTime: "23:55" });
  });

  test("another restaurant can't touch it, and logged-out requests are refused", async () => {
    expect((await B.agent.post("/api/schedule/punch").send({ entries: [{ id: shift.id, punchIn: "01:00" }] })).status).toBe(404);
    expect((await request(app).post("/api/schedule/punch").send({ entries: [{ id: shift.id, punchIn: "01:00" }] })).status).toBe(401);
    expect(await get()).toMatchObject({ startTime: "17:12" });
  });

  test("reset puts the scheduled times back", async () => {
    await A.agent.post("/api/schedule/punch").send({ entries: [{ id: shift.id, reset: true }] });
    expect(await get()).toMatchObject({ startTime: "17:00", endTime: "23:00", punchIn: "", punchOut: "", scheduledStart: "", scheduledEnd: "" });
  });

  test("a batch is all or nothing", async () => {
    const res = await A.agent.post("/api/schedule/punch").send({ entries: [{ id: shift.id, punchIn: "18:00" }, { id: "does-not-exist", punchIn: "18:00" }] });
    expect(res.status).toBe(404);
    expect(await get()).toMatchObject({ startTime: "17:00" });
  });
});

describe("cancelling a shift from the punch clock", () => {
  const smsCount = async (phone) => (await pool.query("SELECT COUNT(*)::int AS n FROM activity_log WHERE restaurant_id = $1 AND event_type = 'sms_sent' AND detail LIKE $2", [A.restaurantId, `%${phone}%`])).rows[0].n;
  const waitFor = async (fn, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };
  const mk = async (date) => (await A.agent.post("/api/schedule").send({ staffId: ana, date, startTime: "17:00", endTime: "22:00", role: "Server" })).body;

  test("notify=1 on a future shift removes it and texts the person; a plain delete does not", async () => {
    const phone = (await pool.query("SELECT phone FROM staff WHERE id = $1", [ana])).rows[0].phone;
    const before = await smsCount(phone);
    const s1 = await mk("2030-01-10");
    expect((await A.agent.delete(`/api/schedule/${s1.id}?notify=1`)).status).toBe(204);
    expect(await waitFor(async () => (await smsCount(phone)) === before + 1)).toBe(true);
    const s2 = await mk("2030-01-11");
    expect((await A.agent.delete(`/api/schedule/${s2.id}`)).status).toBe(204);
    await new Promise((r) => setTimeout(r, 500));
    expect(await smsCount(phone)).toBe(before + 1);
  });

  test("a past shift is removed without a text, and another restaurant can't delete it", async () => {
    const phone = (await pool.query("SELECT phone FROM staff WHERE id = $1", [ana])).rows[0].phone;
    const before = await smsCount(phone);
    const past = await mk("2020-01-10");
    await B.agent.delete(`/api/schedule/${past.id}?notify=1`);
    expect((await pool.query("SELECT 1 FROM schedule_shifts WHERE id = $1", [past.id])).rows).toHaveLength(1);
    expect((await A.agent.delete(`/api/schedule/${past.id}?notify=1`)).status).toBe(204);
    await new Promise((r) => setTimeout(r, 500));
    expect(await smsCount(phone)).toBe(before);
  });
});
