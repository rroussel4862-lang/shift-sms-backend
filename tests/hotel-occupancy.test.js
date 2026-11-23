const request = require("supertest");
const bcrypt = require("bcryptjs");
const { app, pool } = require("../server.js");
const { createRestaurant, uniqueEmail } = require("./helpers");

let admin, hotel, diner;
const today = new Date().toISOString().slice(0, 10);
const addDays = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const D1 = addDays(today, 3), D2 = addDays(today, 4);

beforeAll(async () => {
  const f = () => request.agent(app);
  hotel = await createRestaurant(f, { restaurantName: "Occ Hotel" });
  diner = await createRestaurant(f, { restaurantName: "Occ Diner" });
  const email = uniqueEmail("platform");
  await pool.query("INSERT INTO platform_admins (id, email, password_hash, created_at) VALUES ($1,$2,$3,$4)", ["pa" + Date.now(), email, await bcrypt.hash("adminpassword123", 4), Date.now()]);
  admin = request.agent(app);
  if ((await admin.post("/api/platform-auth/login").send({ email, password: "adminpassword123" })).status !== 200) throw new Error("platform login failed");
  await admin.patch(`/api/platform/restaurants/${hotel.restaurantId}/placement`).send({ kind: "hotel" });
});
afterAll(async () => { await pool.end(); });

describe("hotel room occupancy", () => {
  test("a hotel saves forecast and actual occupancy (rooms) per day; each field changes on its own", async () => {
    const a = await hotel.agent.put(`/api/occupancy/${D1}`).send({ forecastRooms: 42 });
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ date: D1, forecastRooms: 42, actualRooms: null });
    const b = await hotel.agent.put(`/api/occupancy/${D1}`).send({ actualRooms: 45 });
    expect(b.body).toMatchObject({ forecastRooms: 42, actualRooms: 45 }); // forecast kept
    await hotel.agent.put(`/api/occupancy/${D2}`).send({ forecastRooms: 30 });
    const list = (await hotel.agent.get(`/api/occupancy?start=${D1}&end=${D2}`)).body;
    expect(list.map((x) => x.date)).toEqual([D1, D2]);
    expect(list[0]).toMatchObject({ forecastRooms: 42, actualRooms: 45 });
  });

  test("anything that isn't a whole number of rooms is refused; clearing both removes the day", async () => {
    expect((await hotel.agent.put(`/api/occupancy/${D1}`).send({ forecastRooms: 5001 })).status).toBe(400);
    expect((await hotel.agent.put(`/api/occupancy/${D1}`).send({ forecastRooms: -1 })).status).toBe(400);
    expect((await hotel.agent.put(`/api/occupancy/${D1}`).send({ forecastRooms: 42.5 })).status).toBe(400);
    expect((await hotel.agent.put(`/api/occupancy/not-a-date`).send({ forecastRooms: 50 })).status).toBe(400);
    await hotel.agent.put(`/api/occupancy/${D2}`).send({ forecastRooms: null });
    const list = (await hotel.agent.get(`/api/occupancy?start=${D1}&end=${D2}`)).body;
    expect(list.map((x) => x.date)).toEqual([D1]);
  });

  test("occupancy is only for hotels, needs a login, and stays inside its own establishment", async () => {
    expect((await diner.agent.put(`/api/occupancy/${D1}`).send({ forecastRooms: 50 })).status).toBe(400);
    expect((await request(app).get(`/api/occupancy?start=${D1}&end=${D1}`)).status).toBe(401);
    expect((await diner.agent.get(`/api/occupancy?start=${D1}&end=${D1}`)).body).toEqual([]);
  });

  test("the day overview carries occupancy for a hotel and nothing for a restaurant", async () => {
    const h = (await hotel.agent.get(`/api/day-snapshot?date=${D1}`)).body;
    expect(h.kind).toBe("hotel");
    expect(h.occupancy).toEqual({ forecastRooms: 42, actualRooms: 45 });
    const r = (await diner.agent.get(`/api/day-snapshot?date=${D1}`)).body;
    expect(r.kind).toBe("restaurant");
    expect(r.occupancy).toBeNull();
  });
});
