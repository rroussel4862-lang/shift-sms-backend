const request = require("supertest");
const bcrypt = require("bcryptjs");
const { app, pool } = require("../server.js");
const { createRestaurant, uniqueEmail, uniquePhone } = require("./helpers");

let admin, A, B, C;
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
const monday = () => {
  const d = new Date(today() + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};

beforeAll(async () => {
  const factory = () => request.agent(app);
  A = await createRestaurant(factory, { restaurantName: "Owner Test A" });
  B = await createRestaurant(factory, { restaurantName: "Owner Test B" });
  C = await createRestaurant(factory, { restaurantName: "Owner Test C (not theirs)" });

  const email = uniqueEmail("platform");
  await pool.query("INSERT INTO platform_admins (id, email, password_hash, created_at) VALUES ($1,$2,$3,$4)", ["pa" + Date.now(), email, await bcrypt.hash("adminpassword123", 4), Date.now()]);
  admin = request.agent(app);
  const login = await admin.post("/api/platform-auth/login").send({ email, password: "adminpassword123" });
  if (login.status !== 200) throw new Error("platform login failed");
});
afterAll(async () => { await pool.end(); });

describe("platform admin manages owners", () => {
  let ownerId, ownerEmail, tempPw;

  test("requires platform login; restaurant managers can't create owners", async () => {
    const body = { name: "X", email: uniqueEmail("o"), restaurantIds: [A.restaurantId] };
    expect((await request(app).post("/api/platform/owners").send(body)).status).toBe(401);
    expect((await A.agent.post("/api/platform/owners").send(body)).status).toBe(401);
  });

  test("validates name, email, restaurants", async () => {
    expect((await admin.post("/api/platform/owners").send({ email: uniqueEmail("o"), restaurantIds: [A.restaurantId] })).status).toBe(400);
    expect((await admin.post("/api/platform/owners").send({ name: "X", email: "nope", restaurantIds: [A.restaurantId] })).status).toBe(400);
    expect((await admin.post("/api/platform/owners").send({ name: "X", email: uniqueEmail("o"), restaurantIds: [] })).status).toBe(400);
    expect((await admin.post("/api/platform/owners").send({ name: "X", email: uniqueEmail("o"), restaurantIds: ["does-not-exist"] })).status).toBe(400);
  });

  test("creates an owner with a one-time password and the linked restaurants", async () => {
    ownerEmail = uniqueEmail("owner");
    const res = await admin.post("/api/platform/owners").send({ name: "Marie Tremblay", email: ownerEmail.toUpperCase(), restaurantIds: [A.restaurantId, B.restaurantId] });
    expect(res.status).toBe(201);
    ownerId = res.body.owner.id;
    tempPw = res.body.tempPassword;
    expect(tempPw.length).toBeGreaterThanOrEqual(10);
    expect(res.body.owner.email).toBe(ownerEmail.toLowerCase());
    expect(res.body.owner.restaurants.map((r) => r.id).sort()).toEqual([A.restaurantId, B.restaurantId].sort());
    expect(JSON.stringify(res.body)).not.toContain("password_hash");
    expect((await admin.post("/api/platform/owners").send({ name: "Dup", email: ownerEmail, restaurantIds: [A.restaurantId] })).status).toBe(409);
    const list = await admin.get("/api/platform/owners");
    expect(list.body.find((o) => o.id === ownerId).name).toBe("Marie Tremblay");
  });

  test("owner can log in with the temporary password", async () => {
    const agent = request.agent(app);
    const ok = await agent.post("/api/owner-auth/login").send({ email: ownerEmail, password: tempPw });
    expect(ok.status).toBe(200);
    expect(ok.body.name).toBe("Marie Tremblay");
    expect((await agent.get("/api/owner-auth/me")).body.email).toBe(ownerEmail.toLowerCase());
  });

  test("editing links/unlinks restaurants; a new password invalidates the old one; delete removes the login", async () => {
    const patch = await admin.patch(`/api/platform/owners/${ownerId}`).send({ restaurantIds: [A.restaurantId] });
    expect(patch.body.restaurants.map((r) => r.id)).toEqual([A.restaurantId]);
    expect((await admin.patch(`/api/platform/owners/${ownerId}`).send({ restaurantIds: [] })).status).toBe(400);
    await admin.patch(`/api/platform/owners/${ownerId}`).send({ restaurantIds: [A.restaurantId, B.restaurantId] });

    const reset = await admin.post(`/api/platform/owners/${ownerId}/reset-password`);
    expect(reset.status).toBe(200);
    expect((await request(app).post("/api/owner-auth/login").send({ email: ownerEmail, password: tempPw })).status).toBe(401);
    expect((await request(app).post("/api/owner-auth/login").send({ email: ownerEmail, password: reset.body.tempPassword })).status).toBe(200);
    tempPw = reset.body.tempPassword;
  });
});

describe("owner landing data", () => {
  let owner, ownerEmail, pw;

  beforeAll(async () => {
    ownerEmail = uniqueEmail("owner2");
    const res = await admin.post("/api/platform/owners").send({ name: "Paul Owner", email: ownerEmail, restaurantIds: [A.restaurantId, B.restaurantId] });
    pw = res.body.tempPassword;
    owner = request.agent(app);
    await owner.post("/api/owner-auth/login").send({ email: ownerEmail, password: pw });

    // Restaurant A: sales + a cheap shift today + two open shifts. Restaurant B: nothing at all.
    const staff = await A.agent.post("/api/staff").send({ name: "Cook", phone: uniquePhone(), roles: ["Line Cook"], hourlyRate: 20 });
    await A.agent.put("/api/actual-sales").send({ date: monday(), foodAmount: 1000, bevAmount: 0 });
    await A.agent.post("/api/schedule").send({ staffId: staff.body.id, date: monday(), startTime: "10:00", endTime: "15:00", role: "Line Cook" }); // 5h * $20 = $100 → 10%
    await A.agent.post("/api/shifts").send({ role: "Line Cook", time: "Today" });
    await A.agent.post("/api/shifts").send({ role: "Line Cook", time: "Tomorrow" });
  });

  test("requires an owner login (managers and staff can't use it)", async () => {
    expect((await request(app).get("/api/owner/overview")).status).toBe(401);
    expect((await A.agent.get("/api/owner/overview")).status).toBe(401);
    expect((await admin.get("/api/owner/overview")).status).toBe(401);
  });

  test("shows only the owner's restaurants, with sales, labor % and open shifts", async () => {
    const res = await owner.get("/api/owner/overview");
    expect(res.status).toBe(200);
    expect(res.body.owner.name).toBe("Paul Owner");
    expect(res.body.restaurants.map((r) => r.id).sort()).toEqual([A.restaurantId, B.restaurantId].sort());
    expect(JSON.stringify(res.body)).not.toContain(C.restaurantId);

    const a = res.body.restaurants.find((r) => r.id === A.restaurantId);
    expect(a.salesWeek).toBe(1000);
    expect(a.laborPct).toBe(10);
    expect(a.openShifts).toBe(2);
    expect(a.status).toBe("on_track");

    const b = res.body.restaurants.find((r) => r.id === B.restaurantId);
    expect(b).toMatchObject({ salesWeek: 0, laborPct: null, openShifts: 0, status: "on_track" });
    expect(b.flags.map((f) => f.code)).toContain("no_sales");

    expect(res.body.totals).toMatchObject({ salesWeek: 1000, openShifts: 2, needAttention: 0, locations: 2 });
  });

  test("flags a restaurant that needs attention (high labor, many open shifts)", async () => {
    await A.agent.post("/api/shifts").send({ role: "Line Cook", time: "Friday" }); // 3 open now
    const staff2 = await A.agent.post("/api/staff").send({ name: "Pricey", phone: uniquePhone(), roles: ["Line Cook"], hourlyRate: 100 });
    await A.agent.post("/api/schedule").send({ staffId: staff2.body.id, date: monday(), startTime: "10:00", endTime: "14:00", role: "Line Cook" }); // +$400 → 50%
    const res = await owner.get("/api/owner/overview");
    const a = res.body.restaurants.find((r) => r.id === A.restaurantId);
    expect(a.status).toBe("attention");
    expect(a.flags.filter((f) => f.level === "attention").map((f) => f.code).sort()).toEqual(["labor_high", "open_shifts"]);
    expect(res.body.totals.needAttention).toBe(1);
  });

  test("opening a restaurant gives the owner full manager access to that restaurant only", async () => {
    expect((await owner.post(`/api/owner/open/${C.restaurantId}`)).status).toBe(404); // not theirs
    expect((await request(app).post(`/api/owner/open/${A.restaurantId}`)).status).toBe(401);
    expect((await owner.get("/api/staff")).status).toBe(401); // no manager session yet

    expect((await owner.post(`/api/owner/open/${A.restaurantId}`)).status).toBe(200);
    const me = await owner.get("/api/auth/me");
    expect(me.body).toMatchObject({ viaOwner: true, restaurant: { id: A.restaurantId, name: "Owner Test A" } });
    const staff = await owner.get("/api/staff");
    expect(staff.status).toBe(200);
    expect(staff.body.map((s) => s.name)).toContain("Cook");
    // manager-level writes work too
    const made = await owner.post("/api/staff").send({ name: "Added by owner", phone: uniquePhone(), roles: ["Server"] });
    expect(made.status).toBe(201);
    expect((await A.agent.get("/api/staff")).body.map((s) => s.name)).toContain("Added by owner");

    // switching to the other restaurant swaps the session; the first one's data is no longer reachable
    expect((await owner.post(`/api/owner/open/${B.restaurantId}`)).status).toBe(200);
    expect((await owner.get("/api/staff")).body.map((s) => s.name)).not.toContain("Cook");
    expect((await owner.get("/api/auth/me")).body.restaurant.id).toBe(B.restaurantId);
  });

  // (login attempts share a rate limiter, so this one test covers password change, the new login and logout)
  test("owner can change their own password, log in with it, and log out", async () => {
    expect((await owner.post("/api/owner-auth/change-password").send({ currentPassword: "nope", newPassword: "brandnewpassword1" })).status).toBe(401);
    expect((await owner.post("/api/owner-auth/change-password").send({ currentPassword: pw, newPassword: "short" })).status).toBe(400);
    expect((await owner.post("/api/owner-auth/change-password").send({ currentPassword: pw, newPassword: "brandnewpassword1" })).status).toBe(200);
    const agent = request.agent(app);
    expect((await agent.post("/api/owner-auth/login").send({ email: ownerEmail, password: "brandnewpassword1" })).status).toBe(200);
    expect((await agent.get("/api/owner/overview")).status).toBe(200);
    await agent.post("/api/owner-auth/logout");
    expect((await agent.get("/api/owner/overview")).status).toBe(401);
  });
});
