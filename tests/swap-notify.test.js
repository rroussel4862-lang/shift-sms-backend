const request = require("supertest");
const bcrypt = require("bcryptjs");
const { app, pool } = require("../server.js");
const { createRestaurant, uniquePhone, uniqueEmail } = require("./helpers");

let R, ann, bob, mgrPhone, cookPhone;
const future = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const smsCount = async (phone) => (await pool.query("SELECT COUNT(*)::int AS n FROM activity_log WHERE restaurant_id = $1 AND event_type = 'sms_sent' AND detail LIKE $2", [R.restaurantId, `%${phone}%`])).rows[0].n;
const waitFor = async (fn, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };

async function makeStaff(name, roles = ["Server"], phone = uniquePhone()) {
  const created = await R.agent.post("/api/staff").send({ name, phone, roles });
  const email = uniqueEmail("swapnote");
  await pool.query("UPDATE staff SET email = $1, password_hash = $2 WHERE id = $3", [email, await bcrypt.hash("staffpassword123", 4), created.body.id]);
  const agent = request.agent(app);
  const login = await agent.post("/api/staff-auth/login").send({ email, password: "staffpassword123" });
  if (login.status !== 200) throw new Error("staff login failed");
  return { id: created.body.id, agent };
}

beforeAll(async () => {
  R = await createRestaurant(() => request.agent(app));
  mgrPhone = uniquePhone(); cookPhone = uniquePhone();
  await R.agent.post("/api/staff").send({ name: "Mia Manager", phone: mgrPhone, roles: ["Manager"] });
  await R.agent.post("/api/staff").send({ name: "Cook Only", phone: cookPhone, roles: ["Line Cook"] });
  ann = await makeStaff("Ann");
  bob = await makeStaff("Bob");
});
afterAll(async () => { await pool.end(); });

test("when a coworker accepts a swap, the manager is texted (and nobody else on staff is)", async () => {
  const shift = (await R.agent.post("/api/schedule").send({ staffId: ann.id, date: future(3), startTime: "17:00", endTime: "23:00", role: "Server" })).body.id;
  const posted = await ann.agent.post("/api/staff-auth/swaps").send({ shiftId: shift, kind: "give" });
  expect(posted.status).toBe(201);
  // posting alone doesn't text the manager yet — nothing to approve until someone accepts
  expect(await smsCount(mgrPhone)).toBe(0);
  const accepted = await bob.agent.post(`/api/staff-auth/swaps/${posted.body.id}/accept`).send({});
  expect(accepted.status).toBe(200);
  expect(await waitFor(async () => (await smsCount(mgrPhone)) === 1)).toBe(true);
  expect(await smsCount(cookPhone)).toBe(0);
});
