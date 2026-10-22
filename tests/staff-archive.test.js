const request = require("supertest");
const bcrypt = require("bcryptjs");
const { app, pool } = require("../server.js");
const { createRestaurant, uniquePhone, uniqueEmail } = require("./helpers");

const day = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
let A, B, ann, annAgent, past, future;

beforeAll(async () => {
  const factory = () => request.agent(app);
  A = await createRestaurant(factory);
  B = await createRestaurant(factory);
  const created = await A.agent.post("/api/staff").send({ name: "Ann Archive", phone: uniquePhone(), roles: ["Server"], hourlyRate: 20 });
  ann = created.body.id;
  const email = uniqueEmail("arch");
  await pool.query("UPDATE staff SET email = $1, password_hash = $2 WHERE id = $3", [email, await bcrypt.hash("staffpassword123", 4), ann]);
  annAgent = request.agent(app);
  await annAgent.post("/api/staff-auth/login").send({ email, password: "staffpassword123" });
  past = (await A.agent.post("/api/schedule").send({ staffId: ann, date: day(-5), startTime: "17:00", endTime: "23:00", role: "Server" })).body.id;
  future = (await A.agent.post("/api/schedule").send({ staffId: ann, date: day(4), startTime: "17:00", endTime: "23:00", role: "Server" })).body.id;
});
afterAll(async () => { await pool.end(); });

describe("removing a staff member keeps their history", () => {
  test("remove: past shift stays, future shift goes, login stops working", async () => {
    expect((await annAgent.get("/api/staff-auth/me")).status).toBe(200);
    expect((await A.agent.delete(`/api/staff/${ann}`)).status).toBe(204);

    const kept = await pool.query("SELECT id FROM schedule_shifts WHERE staff_id = $1", [ann]);
    expect(kept.rows.map((r) => r.id)).toEqual([past]);

    const list = await A.agent.get("/api/staff");
    const row = list.body.find((s) => s.id === ann);
    expect(row).toBeTruthy();       // still there, so payroll can show the name and rate
    expect(row.archived).toBe(true);
    expect(row.hourlyRate).toBe(20);

    expect((await annAgent.get("/api/staff-auth/me")).status).toBe(401); // old cookie no longer works
    const relog = await request.agent(app).post("/api/staff-auth/login").send({ email: "x@x.com", password: "staffpassword123" });
    expect(relog.status).not.toBe(200);
  });

  test("removed people are not picked for the schedule or bulk add", async () => {
    const res = await A.agent.post("/api/schedule/bulk").send({ shifts: [{ staffId: ann, date: day(6), startTime: "17:00", endTime: "23:00", role: "Server" }] });
    const created = (res.body && res.body.created) || [];
    expect(created.length).toBe(0);
  });

  test("restore brings them back without a login or future shifts", async () => {
    const res = await A.agent.post(`/api/staff/${ann}/restore`);
    expect(res.status).toBe(200);
    expect(res.body.archived).toBe(false);
    expect(res.body.hasLogin).toBe(false);
    expect((await pool.query("SELECT id FROM schedule_shifts WHERE staff_id = $1", [ann])).rows.length).toBe(1);
  });

  test("another restaurant cannot remove or restore this person", async () => {
    await B.agent.delete(`/api/staff/${ann}`);
    const row = (await A.agent.get("/api/staff")).body.find((s) => s.id === ann);
    expect(row.archived).toBe(false);
    await A.agent.delete(`/api/staff/${ann}`);
    expect((await B.agent.post(`/api/staff/${ann}/restore`)).status).toBe(404);
  });
});
