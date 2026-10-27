const request = require("supertest");
const bcrypt = require("bcryptjs");
const { app, pool } = require("../server.js");
const { createRestaurant, uniqueEmail } = require("./helpers");

let admin, A;

beforeAll(async () => {
  A = await createRestaurant(() => request.agent(app), { restaurantName: "New Design Place" });
  const email = uniqueEmail("platform");
  await pool.query("INSERT INTO platform_admins (id, email, password_hash, created_at) VALUES ($1,$2,$3,$4)", ["pa" + Date.now(), email, await bcrypt.hash("adminpassword123", 4), Date.now()]);
  admin = request.agent(app);
  const login = await admin.post("/api/platform-auth/login").send({ email, password: "adminpassword123" });
  if (login.status !== 200) throw new Error("platform login failed");
});
afterAll(async () => { await pool.end(); });

describe("new layout and design switch", () => {
  test("is on by default for a restaurant, and the dashboard lists it", async () => {
    expect((await A.agent.get("/api/auth/me")).body.newDesign).toBe(true);
    const list = await admin.get("/api/platform/restaurants");
    expect(list.body.find((r) => r.id === A.restaurantId).newDesign).toBe(true);
  });

  test("the dashboard can turn it off and on again for one restaurant", async () => {
    const off = await admin.patch(`/api/platform/restaurants/${A.restaurantId}/design`).send({ newDesign: false });
    expect(off.status).toBe(200);
    expect(off.body.newDesign).toBe(false);
    expect((await A.agent.get("/api/auth/me")).body.newDesign).toBe(false);
    const on = await admin.patch(`/api/platform/restaurants/${A.restaurantId}/design`).send({ newDesign: true });
    expect(on.body.newDesign).toBe(true);
    expect((await A.agent.get("/api/auth/me")).body.newDesign).toBe(true);
  });

  test("rejects a bad value and an unknown restaurant, and needs a platform login", async () => {
    expect((await admin.patch(`/api/platform/restaurants/${A.restaurantId}/design`).send({ newDesign: "yes" })).status).toBe(400);
    expect((await admin.patch("/api/platform/restaurants/nope/design").send({ newDesign: true })).status).toBe(404);
    expect((await A.agent.patch(`/api/platform/restaurants/${A.restaurantId}/design`).send({ newDesign: false })).status).toBe(401);
  });
});
