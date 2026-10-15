const request = require("supertest");
const { app, pool } = require("../server.js");
const { createRestaurant, uniquePhone } = require("./helpers");

let A, B, id;
beforeAll(async () => {
  const factory = () => request.agent(app);
  A = await createRestaurant(factory);
  B = await createRestaurant(factory);
  id = (await A.agent.post("/api/staff").send({ name: "Driss", phone: uniquePhone(), roles: ["Server"] })).body.id;
});
afterAll(async () => { await pool.end(); });

describe("editing a staff member", () => {
  test("the edit form's payload (empty hire date sent as null) saves", async () => {
    const res = await A.agent.patch(`/api/staff/${id}`).send({ name: "Driss L.", address: "", phone: uniquePhone(), roles: ["Server", "Busser"], hourlyRate: "13.5", hireDate: null });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: "Driss L.", roles: ["Server", "Busser"], hourlyRate: 13.5 });
    expect(res.body.hireDate).toBeFalsy();
  });

  test("hire date and address can be set, then cleared", async () => {
    const set = await A.agent.patch(`/api/staff/${id}`).send({ hireDate: "2025-05-01", address: "12 Rue Test" });
    expect(set.body).toMatchObject({ hireDate: "2025-05-01", address: "12 Rue Test" });
    const cleared = await A.agent.patch(`/api/staff/${id}`).send({ hireDate: null, address: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.hireDate).toBeFalsy();
    expect(cleared.body.address).toBeFalsy();
  });

  test("bad input is a 400, another restaurant gets 404", async () => {
    expect((await A.agent.patch(`/api/staff/${id}`).send({ hireDate: "yesterday" })).status).toBe(400);
    expect((await A.agent.patch(`/api/staff/${id}`).send({ name: "  " })).status).toBe(400);
    expect((await B.agent.patch(`/api/staff/${id}`).send({ name: "Hacked" })).status).toBe(404);
  });
});
