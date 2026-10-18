const request = require("supertest");
const bcrypt = require("bcryptjs");
const { app, pool } = require("../server.js");
const { createRestaurant, uniquePhone, uniqueEmail } = require("./helpers");

let R, ann, bob;
const mondayAfter = (weeks) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7) + (weeks - 1) * 7); return d.toISOString().slice(0, 10); };
const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

async function makeStaff(name) {
  const created = await R.agent.post("/api/staff").send({ name, phone: uniquePhone(), roles: ["Server"] });
  const email = uniqueEmail("news");
  await pool.query("UPDATE staff SET email = $1, password_hash = $2 WHERE id = $3", [email, await bcrypt.hash("staffpassword123", 4), created.body.id]);
  const agent = request.agent(app);
  const login = await agent.post("/api/staff-auth/login").send({ email, password: "staffpassword123" });
  if (login.status !== 200) throw new Error("staff login failed");
  return { id: created.body.id, agent };
}

beforeAll(async () => {
  R = await createRestaurant(() => request.agent(app));
  ann = await makeStaff("Ann");
  bob = await makeStaff("Bob");
});
afterAll(async () => { await pool.end(); });

test("publishing a week puts a notice in the portal of staff who work it, until they tap Got it", async () => {
  const week = mondayAfter(1);
  await R.agent.post("/api/schedule").send({ staffId: ann.id, date: addDays(week, 2), startTime: "17:00", endTime: "23:00", role: "Server" });
  await R.agent.post("/api/schedule").send({ staffId: ann.id, date: addDays(week, 3), startTime: "17:00", endTime: "23:00", role: "Server" });

  // draft: nothing yet
  expect((await ann.agent.get("/api/staff-auth/schedule-news")).body.weeks.filter((w) => w.weekStart === week)).toHaveLength(0);

  expect((await R.agent.post("/api/schedule/publish").send({ weekStart: week })).status).toBe(200);
  const news = (await ann.agent.get("/api/staff-auth/schedule-news")).body.weeks.find((w) => w.weekStart === week);
  expect(news).toMatchObject({ weekStart: week, shiftCount: 2 });
  // Bob has no shifts that week, so nothing for him
  expect((await bob.agent.get("/api/staff-auth/schedule-news")).body.weeks.find((w) => w.weekStart === week)).toBeUndefined();

  expect((await ann.agent.post("/api/staff-auth/schedule-news/seen")).status).toBe(200);
  expect((await ann.agent.get("/api/staff-auth/schedule-news")).body.weeks.find((w) => w.weekStart === week)).toBeUndefined();
  expect((await request(app).get("/api/staff-auth/schedule-news")).status).toBe(401);
});
