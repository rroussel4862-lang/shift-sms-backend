const request = require("supertest");
const { app, pool } = require("../server.js");
const { createRestaurant, uniquePhone } = require("./helpers");

let A, B, ann;
const addDays = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const DAY = addDays(new Date().toISOString().slice(0, 10), 3);

beforeAll(async () => {
  const f = () => request.agent(app);
  A = await createRestaurant(f); B = await createRestaurant(f);
  ann = (await A.agent.post("/api/staff").send({ name: "Ann", phone: uniquePhone(), roles: ["Server"] })).body.id;
});
afterAll(async () => { await pool.end(); });

describe("manager marks someone unavailable", () => {
  test("is approved at once, shows in the grid feed, can be removed, and is private to the restaurant", async () => {
    const r = await A.agent.post("/api/time-off").send({ staffId: ann, date: DAY, note: "Dentist" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: "approved", date: DAY, from: "", to: "", shiftsThatDay: 0 });
    expect((await A.agent.post("/api/time-off").send({ staffId: ann, date: DAY })).status).toBe(409);

    const list = (await A.agent.get(`/api/time-off?start=${DAY}&end=${DAY}`)).body;
    expect(list).toHaveLength(1);

    expect((await B.agent.delete(`/api/time-off/${r.body.id}`)).status).toBe(404);
    expect((await B.agent.post("/api/time-off").send({ staffId: ann, date: DAY, from: "10:00", to: "14:00" })).status).toBe(404);
    expect((await A.agent.delete(`/api/time-off/${r.body.id}`)).status).toBe(204);
    expect((await A.agent.get(`/api/time-off?start=${DAY}&end=${DAY}`)).body).toHaveLength(0);
  });

  test("a time range works, warns about an existing shift, and bad input is refused", async () => {
    await A.agent.post("/api/schedule").send({ staffId: ann, date: DAY, startTime: "17:00", endTime: "23:00", role: "Server" });
    const r = await A.agent.post("/api/time-off").send({ staffId: ann, date: DAY, from: "17:00", to: "20:00" });
    expect(r.body).toMatchObject({ from: "17:00", to: "20:00", shiftsThatDay: 1 });
    expect((await A.agent.post("/api/time-off").send({ staffId: ann, date: "nope" })).status).toBe(400);
    expect((await A.agent.post("/api/time-off").send({ staffId: ann, date: DAY, from: "25:00" })).status).toBe(400);
    expect((await A.agent.post("/api/time-off").send({ staffId: ann, date: "2020-01-01" })).status).toBe(400);
    expect((await request.agent(app).post("/api/time-off").send({ staffId: ann, date: DAY })).status).toBe(401);
  });
});
