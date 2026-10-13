const request = require("supertest");
const { app, pool } = require("../server.js");
const { createRestaurant } = require("./helpers");

let A;
beforeAll(async () => { A = await createRestaurant(() => request.agent(app)); });
afterAll(async () => { await pool.end(); });

describe("name for the Overview greeting", () => {
  test("starts empty, can be saved, and is returned by /api/auth/me", async () => {
    expect((await A.agent.get("/api/auth/me")).body.name).toBe("");
    const r = await A.agent.patch("/api/auth/me").send({ name: "  Raphael   R " });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe("Raphael R");
    expect((await A.agent.get("/api/auth/me")).body.name).toBe("Raphael R");
  });
  test("rejects empty or too-long names", async () => {
    expect((await A.agent.patch("/api/auth/me").send({ name: "   " })).status).toBe(400);
    expect((await A.agent.patch("/api/auth/me").send({ name: "x".repeat(61) })).status).toBe(400);
  });
});
