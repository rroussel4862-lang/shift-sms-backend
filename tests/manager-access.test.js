const request = require("supertest");
const { app, pool } = require("../server.js");
const { createRestaurant, uniquePhone, uniqueEmail } = require("./helpers");

let A, B, sam, other;
beforeAll(async () => {
  const factory = () => request.agent(app);
  A = await createRestaurant(factory);
  B = await createRestaurant(factory);
  sam = (await A.agent.post("/api/staff").send({ name: "Sam Shiftlead", phone: uniquePhone(), roles: ["Manager"] })).body.id;
  other = (await A.agent.post("/api/staff").send({ name: "Olive Other", phone: uniquePhone(), roles: ["Server"] })).body.id;
});
afterAll(async () => { await pool.end(); });

describe("hide from schedule", () => {
  test("flag is saved, returned, and can be turned off", async () => {
    const on = await A.agent.patch(`/api/staff/${sam}`).send({ hideFromSchedule: true });
    expect(on.status).toBe(200);
    expect(on.body.hideFromSchedule).toBe(true);
    const off = await A.agent.patch(`/api/staff/${sam}`).send({ hideFromSchedule: false });
    expect(off.body.hideFromSchedule).toBe(false);
    const again = await A.agent.patch(`/api/staff/${sam}`).send({ name: "Sam Shiftlead" });
    expect(again.body.hideFromSchedule).toBe(false); // untouched by other edits
  });
});

describe("manager access for a staff member", () => {
  let email, tempPassword, mgrAgent;

  test("grant creates a working manager login for this restaurant only", async () => {
    email = uniqueEmail("mgr");
    const res = await A.agent.post(`/api/staff/${sam}/manager-access`).send({ email });
    expect(res.status).toBe(201);
    tempPassword = res.body.tempPassword;
    expect(tempPassword.length).toBeGreaterThanOrEqual(8);

    mgrAgent = request.agent(app);
    const login = await mgrAgent.post("/api/auth/login").send({ email, password: tempPassword });
    expect(login.status).toBe(200);
    expect((await mgrAgent.get("/api/staff")).status).toBe(200);

    const row = (await A.agent.get("/api/staff")).body.find((s) => s.id === sam);
    expect(row.hasManagerAccess).toBe(true);
  });

  test("a second grant, a reused email, or another restaurant is refused", async () => {
    expect((await A.agent.post(`/api/staff/${sam}/manager-access`).send({ email: uniqueEmail("x") })).status).toBe(409);
    expect((await A.agent.post(`/api/staff/${other}/manager-access`).send({ email })).status).toBe(409);
    expect((await B.agent.post(`/api/staff/${other}/manager-access`).send({ email: uniqueEmail("y") })).status).toBe(404);
    expect((await A.agent.post(`/api/staff/${other}/manager-access`).send({ email: "not-an-email" })).status).toBe(400);
  });

  test("a manager cannot hand out manager access", async () => {
    const res = await mgrAgent.post(`/api/staff/${other}/manager-access`).send({ email: uniqueEmail("z") });
    expect(res.status).toBe(403);
  });

  test("removing access signs them out immediately", async () => {
    expect((await A.agent.delete(`/api/staff/${sam}/manager-access`)).status).toBe(204);
    expect((await mgrAgent.get("/api/staff")).status).toBe(401);
    const relog = await request.agent(app).post("/api/auth/login").send({ email, password: tempPassword });
    expect(relog.status).toBe(401);
    const row = (await A.agent.get("/api/staff")).body.find((s) => s.id === sam);
    expect(row.hasManagerAccess).toBe(false);
  });

  test("removing the staff member also removes their manager login", async () => {
    const e2 = uniqueEmail("mgr2");
    const g = await A.agent.post(`/api/staff/${sam}/manager-access`).send({ email: e2 });
    expect(g.status).toBe(201);
    await A.agent.delete(`/api/staff/${sam}`);
    const relog = await request.agent(app).post("/api/auth/login").send({ email: e2, password: g.body.tempPassword });
    expect(relog.status).toBe(401);
  });
});
