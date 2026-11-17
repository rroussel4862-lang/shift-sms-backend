const request = require("supertest");
const bcrypt = require("bcryptjs");
const { app, pool } = require("../server.js");
const { createRestaurant, uniqueEmail } = require("./helpers");

let admin, hotel, restaurantB, outsider, propertyId;

beforeAll(async () => {
  const f = () => request.agent(app);
  hotel = await createRestaurant(f, { restaurantName: "Prop Hotel" });
  restaurantB = await createRestaurant(f, { restaurantName: "Prop Restaurant" });
  outsider = await createRestaurant(f, { restaurantName: "Prop Outsider" });
  const email = uniqueEmail("platform");
  await pool.query("INSERT INTO platform_admins (id, email, password_hash, created_at) VALUES ($1,$2,$3,$4)", ["pa" + Date.now(), email, await bcrypt.hash("adminpassword123", 4), Date.now()]);
  admin = request.agent(app);
  if ((await admin.post("/api/platform-auth/login").send({ email, password: "adminpassword123" })).status !== 200) throw new Error("platform login failed");
});
afterAll(async () => { await pool.end(); });

describe("properties group establishments and drive access", () => {
  test("only the platform admin manages properties; names are required and unique", async () => {
    expect((await request(app).post("/api/platform/properties").send({ name: "X" })).status).toBe(401);
    expect((await hotel.agent.post("/api/platform/properties").send({ name: "X" })).status).toBe(401);
    expect((await admin.post("/api/platform/properties").send({ name: " " })).status).toBe(400);
    const r = await admin.post("/api/platform/properties").send({ name: "Hôtel Test " + Date.now() });
    expect(r.status).toBe(201);
    propertyId = r.body.id;
    expect((await admin.post("/api/platform/properties").send({ name: r.body.name.toUpperCase() })).status).toBe(409);
  });

  test("establishments get a kind and a property; bad values are refused", async () => {
    expect((await admin.patch(`/api/platform/restaurants/${hotel.restaurantId}/placement`).send({ propertyId, kind: "hotel" })).status).toBe(200);
    expect((await admin.patch(`/api/platform/restaurants/${restaurantB.restaurantId}/placement`).send({ propertyId })).status).toBe(200);
    expect((await admin.patch(`/api/platform/restaurants/${hotel.restaurantId}/placement`).send({ kind: "spaceship" })).status).toBe(400);
    expect((await admin.patch(`/api/platform/restaurants/${hotel.restaurantId}/placement`).send({ propertyId: "nope" })).status).toBe(400);
    const list = (await admin.get("/api/platform/restaurants")).body;
    expect(list.find((r) => r.id === hotel.restaurantId)).toMatchObject({ kind: "hotel", propertyId });
    const p = (await admin.get("/api/platform/properties")).body.find((x) => x.id === propertyId);
    expect(p.establishments.map((e) => e.name).sort()).toEqual(["Prop Hotel", "Prop Restaurant"]);
  });

  test("a property administrator reaches every place in it (even later ones); a manager only the places given", async () => {
    const ownerEmail = uniqueEmail("padmin");
    const o = await admin.post("/api/platform/owners").send({ name: "Pat Admin", email: ownerEmail, propertyIds: [propertyId] });
    expect(o.status).toBe(201);
    const pw = o.body.tempPassword;
    const ownerAgent = request.agent(app);
    const login = await ownerAgent.post("/api/owner-auth/login").send({ email: ownerEmail, password: pw });
    expect(login.status).toBe(200);
    expect(login.body.restaurantIds.sort()).toEqual([hotel.restaurantId, restaurantB.restaurantId].sort());
    expect((await ownerAgent.post(`/api/owner/open/${restaurantB.restaurantId}`)).status).toBe(200);
    expect((await ownerAgent.post(`/api/owner/open/${outsider.restaurantId}`)).status).toBe(404);

    // an establishment added to the property later is reachable at once
    await admin.patch(`/api/platform/restaurants/${outsider.restaurantId}/placement`).send({ propertyId, kind: "bar" });
    expect((await ownerAgent.post(`/api/owner/open/${outsider.restaurantId}`)).status).toBe(200);
    const overview = (await ownerAgent.get("/api/owner/overview")).body;
    expect(overview.restaurants.find((r) => r.id === outsider.restaurantId)).toMatchObject({ kind: "bar", propertyId });
    await admin.patch(`/api/platform/restaurants/${outsider.restaurantId}/placement`).send({ propertyId: null });

    // a restricted manager: property links are ignored, only the listed place opens
    const mEmail = uniqueEmail("pmgr");
    const m = await admin.post("/api/platform/owners").send({ name: "Mo Manager", email: mEmail, role: "manager", restaurantIds: [restaurantB.restaurantId], propertyIds: [propertyId] });
    expect(m.status).toBe(201);
    const mAgent = request.agent(app);
    const ml = await mAgent.post("/api/owner-auth/login").send({ email: mEmail, password: m.body.tempPassword });
    expect(ml.body.restaurantIds).toEqual([restaurantB.restaurantId]);
    expect((await mAgent.post(`/api/owner/open/${hotel.restaurantId}`)).status).toBe(404);
  });

  test("deleting a property ungroups its places and removes the access it gave", async () => {
    expect((await admin.delete(`/api/platform/properties/${propertyId}`)).status).toBe(204);
    const list = (await admin.get("/api/platform/restaurants")).body;
    expect(list.find((r) => r.id === hotel.restaurantId)).toMatchObject({ propertyId: null });
    expect(list.find((r) => r.id === hotel.restaurantId)).toBeTruthy();
  });
});
