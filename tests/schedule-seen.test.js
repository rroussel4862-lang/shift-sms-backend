const request = require("supertest");
const bcrypt = require("bcryptjs");
const { app, pool } = require("../server.js");
const { createRestaurant, uniquePhone, uniqueEmail } = require("./helpers");

let A, ann, bob, annAgent;
const addDays = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const mondayOf = (iso) => addDays(iso, -((new Date(iso + "T00:00:00Z").getUTCDay() + 6) % 7));
const WEEK = addDays(mondayOf(new Date().toISOString().slice(0, 10)), 14);

beforeAll(async () => {
  A = await createRestaurant(() => request.agent(app));
  ann = (await A.agent.post("/api/staff").send({ name: "Ann", phone: uniquePhone(), roles: ["Server"] })).body.id;
  bob = (await A.agent.post("/api/staff").send({ name: "Bob", phone: uniquePhone(), roles: ["Server"] })).body.id;
  const email = uniqueEmail("seen");
  await pool.query("UPDATE staff SET email = $1, password_hash = $2 WHERE id = $3", [email, await bcrypt.hash("staffpassword123", 4), ann]);
  annAgent = request.agent(app);
  await annAgent.post("/api/staff-auth/login").send({ email, password: "staffpassword123" });
});
afterAll(async () => { await pool.end(); });

test("the manager sees who has opened the posted week", async () => {
  for (const id of [ann, bob]) await A.agent.post("/api/schedule").send({ staffId: id, date: WEEK, startTime: "17:00", endTime: "23:00", role: "Server" });
  await A.agent.post("/api/schedule/publish").send({ weekStart: WEEK, house: "foh" });
  await annAgent.get(`/api/staff-auth/schedule?start=${WEEK}&end=${addDays(WEEK, 6)}`); // not yet visible? posted, so Ann sees it

  const r = (await A.agent.get(`/api/schedule/seen?weekStart=${WEEK}&house=foh`)).body;
  expect(r).toMatchObject({ total: 2, seen: 1 });
  expect(r.people.find((p) => p.name === "Ann").seenAt).toBeGreaterThan(0);
  expect(r.people.find((p) => p.name === "Bob").seenAt).toBeNull();
  expect((await A.agent.get(`/api/schedule/seen?weekStart=2026-01-02&house=foh`)).status).toBe(400);
  expect((await request.agent(app).get(`/api/schedule/seen?weekStart=${WEEK}&house=foh`)).status).toBe(401);
});
