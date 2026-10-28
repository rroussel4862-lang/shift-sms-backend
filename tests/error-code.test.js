const request = require("supertest");
const { app, pool, makeErrorCode } = require("../server.js");
const { createRestaurant } = require("./helpers");

let A;
beforeAll(async () => { A = await createRestaurant(() => request.agent(app)); });
afterAll(async () => { await pool.end(); });

const waitFor = async (fn, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } return null; };

describe("unexpected errors answer cleanly with a reference code", () => {
  test("makeErrorCode gives short, readable codes", () => {
    const codes = new Set(Array.from({ length: 200 }, makeErrorCode));
    expect(codes.size).toBe(200);
    for (const c of codes) expect(c).toMatch(/^E-[A-HJ-NP-Z2-9]{6}$/);
  });

  test("a failure inside a route returns a 500 with the code (no hanging) and logs the same code", async () => {
    await A.agent.get("/api/staff"); // warm the billing check first, so the simulated failure lands inside the route itself
    const spy = jest.spyOn(pool, "query").mockRejectedValueOnce(new Error("boom: simulated database failure"));
    let res;
    try { res = await A.agent.get("/api/staff"); } finally { spy.mockRestore(); }
    expect(res.status).toBe(500);
    expect(res.body.errorCode).toMatch(/^E-[A-HJ-NP-Z2-9]{6}$/);
    expect(res.body.error).toContain(res.body.errorCode);
    expect(res.body.error).not.toMatch(/boom/); // the internal message is not shown to the person
    const row = await waitFor(async () => (await pool.query("SELECT detail, level, restaurant_id FROM activity_log WHERE event_type = 'server_error' AND detail LIKE $1", [`%${res.body.errorCode}%`])).rows[0]);
    expect(row).toBeTruthy();
    expect(row.level).toBe("error");
    expect(row.restaurant_id).toBe(A.restaurantId);
    expect(row.detail).toContain("boom");
  });

  test("bad input from the client is a plain 400, not a server error", async () => {
    const res = await request(app).post("/api/auth/login").set("Content-Type", "application/json").send("{ not json");
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBeUndefined();
  });

  test("normal routes still work", async () => {
    expect((await A.agent.get("/api/staff")).status).toBe(200);
    expect((await request(app).get("/api/health")).status).toBe(200);
  });
});
