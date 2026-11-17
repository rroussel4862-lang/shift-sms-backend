const request = require("supertest");
const { app, pool } = require("../server.js");
const { createRestaurant } = require("./helpers");

let A;
beforeAll(async () => { A = await createRestaurant(() => request.agent(app), { restaurantName: "Pw Test" }); });
afterAll(async () => { await pool.end(); });

test("a manager can change their password any time, and the new one is what works afterwards", async () => {
  const { rows } = await pool.query("SELECT email FROM users WHERE restaurant_id = $1", [A.restaurantId]);
  const email = rows[0].email;
  expect((await request(app).post("/api/auth/change-password").send({ currentPassword: "x", newPassword: "newpassword123" })).status).toBe(401);
  expect((await A.agent.post("/api/auth/change-password").send({ currentPassword: "wrong-one", newPassword: "newpassword123" })).status).toBe(401);
  expect((await A.agent.post("/api/auth/change-password").send({ currentPassword: A.password, newPassword: "short" })).status).toBe(400);
  expect((await A.agent.post("/api/auth/change-password").send({ currentPassword: A.password, newPassword: "newpassword123" })).status).toBe(200);
  expect((await request(app).post("/api/auth/login").send({ email, password: A.password })).status).toBe(401);
  expect((await request(app).post("/api/auth/login").send({ email, password: "newpassword123" })).status).toBe(200);
  // and again later, not only the first time
  expect((await A.agent.post("/api/auth/change-password").send({ currentPassword: "newpassword123", newPassword: "another-one-456" })).status).toBe(200);
});
