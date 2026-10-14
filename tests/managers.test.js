const request = require("supertest");
const bcrypt = require("bcryptjs");
const { app, pool } = require("../server.js");
const { createRestaurant, uniqueEmail } = require("./helpers");

let admin, A, B;

beforeAll(async () => {
  const factory = () => request.agent(app);
  A = await createRestaurant(factory, { restaurantName: "Manager Test A" });
  B = await createRestaurant(factory, { restaurantName: "Manager Test B" });
  const email = uniqueEmail("platform");
  await pool.query("INSERT INTO platform_admins (id, email, password_hash, created_at) VALUES ($1,$2,$3,$4)", ["pm" + Date.now(), email, await bcrypt.hash("adminpassword123", 4), Date.now()]);
  admin = request.agent(app);
  const login = await admin.post("/api/platform-auth/login").send({ email, password: "adminpassword123" });
  if (login.status !== 200) throw new Error("platform login failed");
});
afterAll(async () => { await pool.end(); });

describe("manager logins created from the dashboard", () => {
  test("role defaults to owner; manager role is saved, editable and validated", async () => {
    const o = await admin.post("/api/platform/owners").send({ name: "Default Role", email: uniqueEmail("d"), restaurantIds: [A.restaurantId] });
    expect(o.body.owner.role).toBe("owner");
    const m = await admin.post("/api/platform/owners").send({ name: "Mia Manager", email: uniqueEmail("m"), restaurantIds: [A.restaurantId], role: "manager" });
    expect(m.status).toBe(201);
    expect(m.body.owner.role).toBe("manager");
    expect((await admin.patch(`/api/platform/owners/${m.body.owner.id}`).send({ role: "boss" })).status).toBe(400);
    expect((await admin.patch(`/api/platform/owners/${m.body.owner.id}`).send({ role: "owner" })).body.role).toBe("owner");
    expect((await admin.patch(`/api/platform/owners/${m.body.owner.id}`).send({ role: "manager" })).body.role).toBe("manager");
  });

  test("a one-restaurant manager's login says exactly which restaurant to open; opening gives full manager access without a switcher", async () => {
    const email = uniqueEmail("single");
    const created = await admin.post("/api/platform/owners").send({ name: "Solo Manager", email, restaurantIds: [A.restaurantId], role: "manager" });
    const agent = request.agent(app);
    const login = await agent.post("/api/owner-auth/login").send({ email, password: created.body.tempPassword });
    expect(login.status).toBe(200);
    expect(login.body).toMatchObject({ name: "Solo Manager", role: "manager", restaurantIds: [A.restaurantId] });

    expect((await agent.post(`/api/owner/open/${B.restaurantId}`)).status).toBe(404); // not theirs
    expect((await agent.post(`/api/owner/open/${A.restaurantId}`)).status).toBe(200);
    const me = await agent.get("/api/auth/me");
    expect(me.body).toMatchObject({ viaOwner: true, canSwitch: false, restaurant: { id: A.restaurantId } });
    expect((await agent.get("/api/staff")).status).toBe(200);
  });

  test("a multi-restaurant manager can switch between their restaurants", async () => {
    const email = uniqueEmail("multi");
    const created = await admin.post("/api/platform/owners").send({ name: "Multi Manager", email, restaurantIds: [A.restaurantId, B.restaurantId], role: "manager" });
    const agent = request.agent(app);
    const login = await agent.post("/api/owner-auth/login").send({ email, password: created.body.tempPassword });
    expect(login.body.restaurantIds.sort()).toEqual([A.restaurantId, B.restaurantId].sort());
    await agent.post(`/api/owner/open/${A.restaurantId}`);
    expect((await agent.get("/api/auth/me")).body.canSwitch).toBe(true);
    expect((await agent.get("/api/owner/overview")).body.restaurants).toHaveLength(2);
    await agent.post(`/api/owner/open/${B.restaurantId}`);
    expect((await agent.get("/api/auth/me")).body.restaurant.id).toBe(B.restaurantId);
  });

  test("logging out of the owner/manager session also drops the restaurant session", async () => {
    const email = uniqueEmail("out");
    const created = await admin.post("/api/platform/owners").send({ name: "Out Manager", email, restaurantIds: [A.restaurantId], role: "manager" });
    const agent = request.agent(app);
    await agent.post("/api/owner-auth/login").send({ email, password: created.body.tempPassword });
    await agent.post(`/api/owner/open/${A.restaurantId}`);
    expect((await agent.get("/api/staff")).status).toBe(200);
    await agent.post("/api/owner-auth/logout");
    expect((await agent.get("/api/staff")).status).toBe(401);
    expect((await agent.get("/api/owner-auth/me")).status).toBe(401);
  });

  test("a dashboard-made login also works on the main page: one restaurant opens straight away, several go to the owner page", async () => {
    const email = uniqueEmail("main");
    const created = await admin.post("/api/platform/owners").send({ name: "Main Page", email, restaurantIds: [A.restaurantId], role: "manager" });
    const agent = request.agent(app);
    const bad = await agent.post("/api/auth/login").send({ email, password: "wrong-password-1" });
    expect(bad.status).toBe(401);
    const login = await agent.post("/api/auth/login").send({ email, password: created.body.tempPassword });
    expect(login.status).toBe(200);
    expect(login.body).toMatchObject({ restaurant: { id: A.restaurantId }, viaOwner: true });
    expect((await agent.get("/api/auth/me")).body.restaurant.id).toBe(A.restaurantId);

    const email2 = uniqueEmail("multi");
    const two = await admin.post("/api/platform/owners").send({ name: "Two Places", email: email2, restaurantIds: [A.restaurantId, B.restaurantId] });
    const login2 = await request.agent(app).post("/api/auth/login").send({ email: email2, password: two.body.tempPassword });
    expect(login2.status).toBe(200);
    expect(login2.body).toEqual({ redirect: "/owner.html" });
  });
});

describe("deleting a restaurant from the dashboard", () => {
  test("needs the exact name, removes the restaurant and its logins, leaves others alone", async () => {
    const factory = () => request.agent(app);
    const stray = await createRestaurant(factory, { restaurantName: "Stray Shay" });
    expect((await admin.delete(`/api/platform/restaurants/${stray.restaurantId}`).send({})).status).toBe(400);
    expect((await admin.delete(`/api/platform/restaurants/${stray.restaurantId}`).send({ confirmName: "stray shay" })).status).toBe(400); // case matters
    expect((await admin.delete(`/api/platform/restaurants/${stray.restaurantId}`).send({ confirmName: "Stray Shay" })).status).toBe(204);
    expect((await admin.delete(`/api/platform/restaurants/${stray.restaurantId}`).send({ confirmName: "Stray Shay" })).status).toBe(404);
    const { rows } = await pool.query("SELECT id FROM users WHERE restaurant_id = $1", [stray.restaurantId]);
    expect(rows.length).toBe(0);
    const { rows: still } = await pool.query("SELECT id FROM restaurants WHERE id = $1", [A.restaurantId]);
    expect(still.length).toBe(1);
  });

  test("requires platform login", async () => {
    expect((await request(app).delete(`/api/platform/restaurants/${A.restaurantId}`).send({ confirmName: "Manager Test A" })).status).toBe(401);
  });
});
