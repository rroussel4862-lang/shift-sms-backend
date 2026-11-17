const request = require("supertest");
const bcrypt = require("bcryptjs");
const { app, pool } = require("../server.js");
const { createRestaurant, uniquePhone, uniqueEmail } = require("./helpers");

let admin, hotel, diner, other, propertyId, otherPropertyId;
const today = new Date().toISOString().slice(0, 10); // inside the current week, which is always visible to staff

beforeAll(async () => {
  const f = () => request.agent(app);
  hotel = await createRestaurant(f, { restaurantName: "Shared Hotel" });
  diner = await createRestaurant(f, { restaurantName: "Shared Diner" });
  other = await createRestaurant(f, { restaurantName: "Elsewhere Cafe" });
  const email = uniqueEmail("platform");
  await pool.query("INSERT INTO platform_admins (id, email, password_hash, created_at) VALUES ($1,$2,$3,$4)", ["pa" + Date.now(), email, await bcrypt.hash("adminpassword123", 4), Date.now()]);
  admin = request.agent(app);
  if ((await admin.post("/api/platform-auth/login").send({ email, password: "adminpassword123" })).status !== 200) throw new Error("platform login failed");
  propertyId = (await admin.post("/api/platform/properties").send({ name: "Shared Property " + Date.now() })).body.id;
  otherPropertyId = (await admin.post("/api/platform/properties").send({ name: "Other Property " + Date.now() })).body.id;
  await admin.patch(`/api/platform/restaurants/${hotel.restaurantId}/placement`).send({ propertyId, kind: "hotel" });
  await admin.patch(`/api/platform/restaurants/${diner.restaurantId}/placement`).send({ propertyId });
  await admin.patch(`/api/platform/restaurants/${other.restaurantId}/placement`).send({ propertyId: otherPropertyId });
});
afterAll(async () => { await pool.end(); });

const addStaff = async (place, name, phone, roles) => (await place.agent.post("/api/staff").send({ name, phone, roles })).body;
const shift = (staffId, startTime, endTime, role, extra = {}) => ({ staffId, date: today, startTime, endTime, role, ...extra });
let phone, atHotel, atDiner;

describe("one person in several places of a property", () => {
  test("adding the same phone number in another place of the property links them as one person", async () => {
    phone = uniquePhone();
    atHotel = await addStaff(hotel, "Sam Shared", phone, ["Front Desk Agent"]);
    expect(atHotel.alsoAt).toEqual([]);
    atDiner = await addStaff(diner, "Sam Shared", phone, ["Server"]);
    expect(atDiner.alsoAt).toEqual(["Shared Hotel"]);
    const hotelTeam = (await hotel.agent.get("/api/staff")).body.find((x) => x.id === atHotel.id);
    expect(hotelTeam.alsoAt).toEqual(["Shared Diner"]);
  });

  test("a place outside the property, and a restaurant with no property, never link", async () => {
    const stranger = await addStaff(other, "Sam Shared", phone, ["Server"]);
    expect(stranger.alsoAt).toEqual([]);
    const standalone = await createRestaurant(() => request.agent(app), { restaurantName: "Solo" });
    expect((await addStaff(standalone, "Sam Shared", phone, ["Server"])).alsoAt).toEqual([]);
  });

  test("scheduling the same person at the same time in two places is flagged; elsewhere in the day is fine", async () => {
    const first = await hotel.agent.post("/api/schedule").send(shift(atHotel.id, "17:00", "23:00", "Front Desk Agent"));
    expect(first.status).toBe(201);

    const clash = await diner.agent.post("/api/schedule").send(shift(atDiner.id, "20:00", "23:30", "Server"));
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe("person_overlap");
    expect(clash.body.conflicts[0]).toMatchObject({ restaurantName: "Shared Hotel", startTime: "17:00", endTime: "23:00" });
    expect(clash.body.error).toContain("Shared Hotel");

    expect((await diner.agent.post("/api/schedule").send(shift(atDiner.id, "08:00", "12:00", "Server"))).status).toBe(201); // no overlap
    expect((await diner.agent.post("/api/schedule").send(shift(atDiner.id, "20:00", "23:30", "Server", { force: true }))).status).toBe(201); // the manager confirmed
  });

  test("moving a shift into a clash is flagged too, and the bulk/AI scheduler skips it", async () => {
    const morning = (await diner.agent.get(`/api/schedule?start=${today}&end=${today}`)).body.find((s) => s.startTime === "08:00");
    const moved = await diner.agent.patch(`/api/schedule/${morning.id}`).send({ startTime: "16:00", endTime: "18:00" });
    expect(moved.status).toBe(409);
    expect(moved.body.code).toBe("person_overlap");
    expect((await diner.agent.patch(`/api/schedule/${morning.id}`).send({ role: "Host" })).status).toBe(200); // not a time change: no check
    const tomorrow = new Date(Date.parse(today + "T12:00:00Z") + 86400000).toISOString().slice(0, 10);
    await hotel.agent.post("/api/schedule").send({ staffId: atHotel.id, date: tomorrow, startTime: "09:00", endTime: "15:00", role: "Front Desk Agent" });
    const bulk = await diner.agent.post("/api/schedule/bulk").send({ shifts: [{ staffId: atDiner.id, date: tomorrow, startTime: "10:00", endTime: "14:00", role: "Server" }, { staffId: atDiner.id, date: tomorrow, startTime: "16:00", endTime: "20:00", role: "Server" }] });
    expect(bulk.status).toBe(201);
    expect(bulk.body.created).toHaveLength(1);
    expect(bulk.body.skipped[0]).toMatchObject({ code: "overlap" });
  });

  test("the person's one login shows the shifts of every place, labelled", async () => {
    const email = uniqueEmail("sam");
    await pool.query("UPDATE staff SET email = $1, password_hash = $2 WHERE id = $3", [email, await bcrypt.hash("staffpassword123", 4), atDiner.id]);
    const sam = request.agent(app);
    expect((await sam.post("/api/staff-auth/login").send({ email, password: "staffpassword123" })).status).toBe(200);
    const mine = (await sam.get(`/api/staff-auth/schedule?start=${today}&end=${today}`)).body;
    expect(new Set(mine.map((s) => s.restaurantName))).toEqual(new Set(["Shared Hotel", "Shared Diner"]));
    const atTheHotel = mine.find((s) => s.restaurantName === "Shared Hotel");
    expect(atTheHotel).toMatchObject({ startTime: "17:00", otherPlace: true });
    expect(mine.find((s) => s.restaurantName === "Shared Diner").otherPlace).toBe(false);
    // someone who works in one place only gets the plain list (no labels)
    const solo = await addStaff(other, "Solo Sue", uniquePhone(), ["Server"]);
    await other.agent.post("/api/schedule").send(shift(solo.id, "10:00", "14:00", "Server"));
    const soloEmail = uniqueEmail("sue");
    await pool.query("UPDATE staff SET email = $1, password_hash = $2 WHERE id = $3", [soloEmail, await bcrypt.hash("staffpassword123", 4), solo.id]);
    const sue = request.agent(app);
    await sue.post("/api/staff-auth/login").send({ email: soloEmail, password: "staffpassword123" });
    const sueShifts = (await sue.get(`/api/staff-auth/schedule?start=${today}&end=${today}`)).body;
    expect(sueShifts).toHaveLength(1);
    expect(sueShifts[0].restaurantName).toBeUndefined();
  });
});

describe("linking by hand (platform admin)", () => {
  test("lists a property's people; link needs entries from different places of the same property", async () => {
    const a = await addStaff(hotel, "Lee Linked", uniquePhone(), ["Concierge"]);
    const b = await addStaff(diner, "Lee Linked", uniquePhone(), ["Host"]); // different numbers: not auto-linked
    expect(b.alsoAt).toEqual([]);
    const c = await addStaff(other, "Lee Linked", uniquePhone(), ["Host"]);
    const list = (await admin.get(`/api/platform/properties/${propertyId}/people`)).body;
    expect(list.people.map((p) => p.id)).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(list.people.map((p) => p.id)).not.toContain(c.id); // another property

    expect((await hotel.agent.post("/api/platform/staff/link").send({ staffIds: [a.id, b.id] })).status).toBe(401); // managers can't
    expect((await admin.post("/api/platform/staff/link").send({ staffIds: [a.id] })).status).toBe(400);
    expect((await admin.post("/api/platform/staff/link").send({ staffIds: [a.id, c.id] })).status).toBe(400); // different property
    const same = await addStaff(hotel, "Lee Twin", uniquePhone(), ["Bellhop"]);
    expect((await admin.post("/api/platform/staff/link").send({ staffIds: [a.id, same.id] })).status).toBe(400); // same place twice

    expect((await admin.post("/api/platform/staff/link").send({ staffIds: [a.id, b.id] })).status).toBe(200);
    expect((await hotel.agent.get("/api/staff")).body.find((x) => x.id === a.id).alsoAt).toEqual(["Shared Diner"]);

    expect((await admin.post(`/api/platform/staff/${b.id}/unlink`)).status).toBe(200);
    expect((await hotel.agent.get("/api/staff")).body.find((x) => x.id === a.id).alsoAt).toEqual([]); // a group of one is no group
    expect((await diner.agent.get("/api/staff")).body.find((x) => x.id === b.id).alsoAt).toEqual([]);
  });

  test("the same phone in two places that were never linked is suggested", async () => {
    const p = uniquePhone();
    const a = await addStaff(hotel, "Pat Pair", p, ["Bellhop"]);
    await pool.query("UPDATE staff SET person_id = NULL WHERE phone = $1", [p]);
    const b = await addStaff(diner, "Pat Pair", p, ["Server"]);
    await pool.query("UPDATE staff SET person_id = NULL WHERE id = ANY($1)", [[a.id, b.id]]); // as if they were added before this existed
    const list = (await admin.get(`/api/platform/properties/${propertyId}/people`)).body;
    expect(list.suggestions.some((g) => g.includes(a.id) && g.includes(b.id))).toBe(true);
  });
});
