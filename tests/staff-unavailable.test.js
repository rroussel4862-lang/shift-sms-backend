const request = require("supertest");
const bcrypt = require("bcryptjs");
const { app, pool, clearBillingCache } = require("../server.js");
const { createRestaurant, uniquePhone, uniqueEmail } = require("./helpers");

let A, annAgent, email;

beforeAll(async () => {
  A = await createRestaurant(() => request.agent(app));
  const created = await A.agent.post("/api/staff").send({ name: "Ann Unpaid", phone: uniquePhone(), roles: ["Server"], hourlyRate: 20 });
  email = uniqueEmail("unpaid");
  await pool.query("UPDATE staff SET email = $1, password_hash = $2 WHERE id = $3", [email, await bcrypt.hash("staffpassword123", 4), created.body.id]);
  annAgent = request.agent(app);
  await annAgent.post("/api/staff-auth/login").send({ email, password: "staffpassword123" });
});
afterAll(async () => { await pool.end(); });

describe("staff of a restaurant that hasn't paid", () => {
  test("get a neutral 'unavailable' answer with nothing about payment, and are let back in once it's paid", async () => {
    expect((await annAgent.get("/api/staff-auth/me")).status).toBe(200);

    await pool.query("UPDATE restaurants SET billing_status = 'unpaid' WHERE id = $1", [A.restaurantId]);
    clearBillingCache(A.restaurantId);

    const me = await annAgent.get("/api/staff-auth/me");
    expect(me.status).toBe(402);
    expect(me.body.code).toBe("restaurant_unavailable");
    expect(JSON.stringify(me.body).toLowerCase()).not.toMatch(/pay|billing|subscri|card/);

    const login = await request.agent(app).post("/api/staff-auth/login").send({ email, password: "staffpassword123" });
    expect(login.status).toBe(402);
    expect(login.body.code).toBe("restaurant_unavailable");

    await pool.query("UPDATE restaurants SET billing_status = 'active' WHERE id = $1", [A.restaurantId]);
    clearBillingCache(A.restaurantId);
    expect((await annAgent.get("/api/staff-auth/me")).status).toBe(200);
  });
});
