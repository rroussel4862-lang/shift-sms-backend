const request = require("supertest");
const bcrypt = require("bcryptjs");
const { app, pool } = require("../server.js");
const { createRestaurant, uniqueEmail } = require("./helpers");

let admin, A;
const rname = () => "New Place " + Math.random().toString(36).slice(2, 8);

beforeAll(async () => {
  A = await createRestaurant(() => request.agent(app), { restaurantName: "Add Rest Existing" });
  const email = uniqueEmail("platform");
  await pool.query("INSERT INTO platform_admins (id, email, password_hash, created_at) VALUES ($1,$2,$3,$4)", ["pa" + Date.now(), email, await bcrypt.hash("adminpassword123", 4), Date.now()]);
  admin = request.agent(app);
  const login = await admin.post("/api/platform-auth/login").send({ email, password: "adminpassword123" });
  if (login.status !== 200) throw new Error("platform login failed");
});
afterAll(async () => { await pool.end(); });

describe("adding a restaurant from the dashboard", () => {
  test("creates the restaurant and a working owner login", async () => {
    const email = uniqueEmail("own");
    const name = rname();
    const res = await admin.post("/api/platform/restaurants").send({ name, ownerName: "Olga Owner", ownerEmail: email });
    expect(res.status).toBe(201);
    expect(res.body.restaurant.name).toBe(name);
    expect(res.body.tempPassword.length).toBeGreaterThanOrEqual(8);

    const list = await admin.get("/api/platform/restaurants");
    expect(list.body.some((r) => r.id === res.body.restaurant.id)).toBe(true);

    const owner = request.agent(app);
    const login = await owner.post("/api/auth/login").send({ email, password: res.body.tempPassword });
    expect(login.status).toBe(200);
    expect(login.body.restaurant.id).toBe(res.body.restaurant.id);
    expect((await owner.get("/api/staff")).status).toBe(200);
  });

  test("an existing owner gets the restaurant added, with no new password", async () => {
    const email = uniqueEmail("multi");
    const first = await admin.post("/api/platform/restaurants").send({ name: rname(), ownerName: "Max Multi", ownerEmail: email });
    const second = await admin.post("/api/platform/restaurants").send({ name: rname(), ownerEmail: email });
    expect(second.status).toBe(201);
    expect(second.body.tempPassword).toBeNull();
    expect(second.body.owner.id).toBe(first.body.owner.id);
    expect(second.body.owner.restaurants.length).toBe(2);
  });

  test("bad input and clashes are refused", async () => {
    expect((await admin.post("/api/platform/restaurants").send({ name: "", ownerName: "X", ownerEmail: uniqueEmail("a") })).status).toBe(400);
    expect((await admin.post("/api/platform/restaurants").send({ name: rname(), ownerName: "X", ownerEmail: "nope" })).status).toBe(400);
    expect((await admin.post("/api/platform/restaurants").send({ name: rname(), ownerEmail: uniqueEmail("noname") })).status).toBe(400);
    expect((await admin.post("/api/platform/restaurants").send({ name: "add rest existing", ownerName: "X", ownerEmail: uniqueEmail("dup") })).status).toBe(409);
  });

  test("only the platform admin can do it", async () => {
    const res = await request(app).post("/api/platform/restaurants").send({ name: rname(), ownerName: "X", ownerEmail: uniqueEmail("x") });
    expect(res.status).toBe(401);
    expect((await A.agent.post("/api/platform/restaurants").send({ name: rname(), ownerName: "X", ownerEmail: uniqueEmail("y") })).status).toBe(401);
  });
});
