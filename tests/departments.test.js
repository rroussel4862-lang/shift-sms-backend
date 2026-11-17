const request = require("supertest");
const bcrypt = require("bcryptjs");
const { app, pool } = require("../server.js");
const { createRestaurant, uniquePhone, uniqueEmail } = require("./helpers");

const addDays = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const mondayOf = (iso) => addDays(iso, -((new Date(iso + "T00:00:00Z").getUTCDay() + 6) % 7));
const NEXT_MON = addDays(mondayOf(new Date().toISOString().slice(0, 10)), 14);

let admin, hotel, diner, restricted, fullManager;
let rita, hana, ellis; // reception, housekeeping, maintenance staff

beforeAll(async () => {
  const f = () => request.agent(app);
  hotel = await createRestaurant(f, { restaurantName: "Dept Hotel" });
  diner = await createRestaurant(f, { restaurantName: "Dept Diner" });
  const email = uniqueEmail("platform");
  await pool.query("INSERT INTO platform_admins (id, email, password_hash, created_at) VALUES ($1,$2,$3,$4)", ["pa" + Date.now(), email, await bcrypt.hash("adminpassword123", 4), Date.now()]);
  admin = request.agent(app);
  if ((await admin.post("/api/platform-auth/login").send({ email, password: "adminpassword123" })).status !== 200) throw new Error("platform login failed");
  await admin.patch(`/api/platform/restaurants/${hotel.restaurantId}/placement`).send({ kind: "hotel" });
  const mk = async (name, roles) => (await hotel.agent.post("/api/staff").send({ name, phone: uniquePhone(), roles })).body.id;
  rita = await mk("Rita Reception", ["Front Desk Agent"]);
  hana = await mk("Hana Housekeeping", ["Room Attendant"]);
  ellis = await mk("Ellis Engineer", ["Maintenance Technician"]);
});
afterAll(async () => { await pool.end(); });

const shift = (staffId, role, date = NEXT_MON) => ({ staffId, date, startTime: "08:00", endTime: "16:00", role });

describe("departments", () => {
  test("a restaurant keeps Front and Back of House; a hotel gets Reception, Housekeeping and Maintenance", async () => {
    const r = (await diner.agent.get("/api/departments")).body;
    expect(r.kind).toBe("restaurant");
    expect(r.departments.map((d) => d.key)).toEqual(["foh", "boh"]);
    expect(r.allowed).toBeNull();
    const h = (await hotel.agent.get("/api/departments")).body;
    expect(h.kind).toBe("hotel");
    expect(h.departments.map((d) => d.key)).toEqual(["reception", "housekeeping", "maintenance"]);
    expect(h.departments[1].roles).toContain("Room Attendant");
  });

  test("posting works per department, and only for that kind's departments", async () => {
    // the hotel does not have 'foh'; the restaurant does not have 'reception'
    expect((await hotel.agent.get(`/api/schedule/publish?weekStart=${NEXT_MON}&house=foh`)).status).toBe(400);
    expect((await diner.agent.get(`/api/schedule/publish?weekStart=${NEXT_MON}&house=reception`)).status).toBe(400);
    expect((await diner.agent.get(`/api/schedule/publish?weekStart=${NEXT_MON}&house=boh`)).status).toBe(200);
    // no department given = the first one (older callers keep working)
    expect((await hotel.agent.get(`/api/schedule/publish?weekStart=${NEXT_MON}`)).body.house).toBe("reception");

    await hotel.agent.post("/api/schedule").send(shift(hana, "Room Attendant"));
    const post = await hotel.agent.post("/api/schedule/publish").send({ weekStart: NEXT_MON, house: "housekeeping" });
    expect(post.status).toBe(200);
    expect(post.body.house).toBe("housekeeping");
    expect(post.body.texted).toBe(1); // only Hana works that week in that department
    const rec = (await hotel.agent.get(`/api/schedule/publish?weekStart=${NEXT_MON}&house=reception`)).body;
    expect(rec.published).toBe(false); // Reception is still a draft
  });

  test("changes after posting are tracked per department", async () => {
    const sh = (await hotel.agent.post("/api/schedule").send(shift(hana, "Room Attendant", addDays(NEXT_MON, 1)))).body;
    const changes = (await hotel.agent.get(`/api/schedule/changes?weekStart=${NEXT_MON}&house=housekeeping`)).body;
    expect(changes.total).toBe(1);
    expect((await hotel.agent.get(`/api/schedule/changes?weekStart=${NEXT_MON}&house=maintenance`)).body.total).toBe(0);
    await hotel.agent.delete(`/api/schedule/${sh.id}`);
  });

  test("an admin limits a manager to some departments; the limit is enforced on the server", async () => {
    const email = uniqueEmail("lim");
    const o = await admin.post("/api/platform/owners").send({ name: "Lee Limited", email, role: "manager", restaurantIds: [hotel.restaurantId], restaurantDepartments: { [hotel.restaurantId]: ["reception"] } });
    expect(o.status).toBe(201);
    expect(o.body.owner.restaurants[0].departments).toEqual(["reception"]);
    restricted = request.agent(app);
    expect((await restricted.post("/api/owner-auth/login").send({ email, password: o.body.tempPassword })).status).toBe(200);
    expect((await restricted.post(`/api/owner/open/${hotel.restaurantId}`)).status).toBe(200);

    const d = (await restricted.get("/api/departments")).body;
    expect(d.allowed).toEqual(["reception"]);

    // reception: allowed
    expect((await restricted.get(`/api/schedule/publish?weekStart=${NEXT_MON}&house=reception`)).status).toBe(200);
    const mine = await restricted.post("/api/schedule").send(shift(rita, "Front Desk Agent"));
    expect(mine.status).toBe(201);
    expect((await restricted.patch(`/api/schedule/${mine.body.id}`).send({ startTime: "09:00" })).status).toBe(200);
    expect((await restricted.patch(`/api/schedule/${mine.body.id}`).send({ role: "Room Attendant" })).status).toBe(403); // can't move it into housekeeping
    expect((await restricted.delete(`/api/schedule/${mine.body.id}`)).status).toBe(204);

    // housekeeping / maintenance: refused everywhere
    expect((await restricted.get(`/api/schedule/publish?weekStart=${NEXT_MON}&house=housekeeping`)).status).toBe(403);
    expect((await restricted.post("/api/schedule/publish").send({ weekStart: NEXT_MON, house: "maintenance" })).status).toBe(403);
    expect((await restricted.get(`/api/schedule/changes?weekStart=${NEXT_MON}&house=housekeeping`)).status).toBe(403);
    expect((await restricted.post("/api/schedule").send(shift(hana, "Room Attendant"))).status).toBe(403);
    expect((await restricted.post("/api/schedule").send(shift(ellis, "Maintenance Technician"))).status).toBe(403);
    expect((await restricted.post("/api/schedule/bulk").send({ shifts: [shift(ellis, "Maintenance Technician")] })).status).toBe(403);
    const hk = (await hotel.agent.get(`/api/schedule?start=${NEXT_MON}&end=${addDays(NEXT_MON, 6)}`)).body.find((s) => s.staffId === hana);
    expect((await restricted.patch(`/api/schedule/${hk.id}`).send({ startTime: "10:00" })).status).toBe(403);
    expect((await restricted.delete(`/api/schedule/${hk.id}`)).status).toBe(403);
  });

  test("a manager with no limit, and the establishment's own login, see every department", async () => {
    const email = uniqueEmail("full");
    const o = await admin.post("/api/platform/owners").send({ name: "Fay Full", email, role: "manager", restaurantIds: [hotel.restaurantId] });
    fullManager = request.agent(app);
    await fullManager.post("/api/owner-auth/login").send({ email, password: o.body.tempPassword });
    await fullManager.post(`/api/owner/open/${hotel.restaurantId}`);
    expect((await fullManager.get("/api/departments")).body.allowed).toBeNull();
    expect((await fullManager.get(`/api/schedule/publish?weekStart=${NEXT_MON}&house=housekeeping`)).status).toBe(200);
    expect((await hotel.agent.get("/api/departments")).body.allowed).toBeNull();
  });

  test("editing a manager's places without sending departments keeps the limits; sending them changes the limits", async () => {
    const ownerId = (await admin.get("/api/platform/owners")).body.find((x) => x.name === "Lee Limited").id;
    const keep = await admin.patch(`/api/platform/owners/${ownerId}`).send({ name: "Lee Limited", restaurantIds: [hotel.restaurantId, diner.restaurantId] });
    expect(keep.status).toBe(200);
    expect(keep.body.restaurants.find((r) => r.id === hotel.restaurantId).departments).toEqual(["reception"]);
    expect(keep.body.restaurants.find((r) => r.id === diner.restaurantId).departments).toBeNull();
    const change = await admin.patch(`/api/platform/owners/${ownerId}`).send({ restaurantDepartments: { [hotel.restaurantId]: ["housekeeping", "nonsense"], [diner.restaurantId]: ["boh"] } });
    expect(change.body.restaurants.find((r) => r.id === hotel.restaurantId).departments).toEqual(["housekeeping"]);
    expect(change.body.restaurants.find((r) => r.id === diner.restaurantId).departments).toEqual(["boh"]);
    // ticking every department is the same as no limit
    const all = await admin.patch(`/api/platform/owners/${ownerId}`).send({ restaurantDepartments: { [hotel.restaurantId]: ["reception", "housekeeping", "maintenance"] } });
    expect(all.body.restaurants.find((r) => r.id === hotel.restaurantId).departments).toBeNull();
  });

  test("a restaurant's own scheduling is unchanged (Front/Back of House by role)", async () => {
    const cook = (await diner.agent.post("/api/staff").send({ name: "Cy Cook", phone: uniquePhone(), roles: ["Line Cook"] })).body.id;
    await diner.agent.post("/api/schedule").send(shift(cook, "Line Cook"));
    const boh = await diner.agent.post("/api/schedule/publish").send({ weekStart: NEXT_MON, house: "boh" });
    expect(boh.body.texted).toBe(1);
    const foh = await diner.agent.post("/api/schedule/publish").send({ weekStart: NEXT_MON, house: "foh" });
    expect(foh.body.texted).toBe(0);
  });
});
