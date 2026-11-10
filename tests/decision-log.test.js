const request = require("supertest");
const bcrypt = require("bcryptjs");
const { app, pool } = require("../server.js");
const { createRestaurant, uniquePhone, uniqueEmail } = require("./helpers");

let A, admin, ann;
const addDays = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const DAY = addDays(new Date().toISOString().slice(0, 10), 4);
const waitFor = async (fn, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };

beforeAll(async () => {
  A = await createRestaurant(() => request.agent(app), { restaurantName: "Decision Place" });
  await A.agent.patch("/api/auth/me").send({ name: "Marie Manager" });
  ann = (await A.agent.post("/api/staff").send({ name: "Ann Staff", phone: uniquePhone(), roles: ["Server"] })).body.id;
  const email = uniqueEmail("platform");
  await pool.query("INSERT INTO platform_admins (id, email, password_hash, created_at) VALUES ($1,$2,$3,$4)", ["pa" + Date.now(), email, await bcrypt.hash("adminpassword123", 4), Date.now()]);
  admin = request.agent(app);
  await admin.post("/api/platform-auth/login").send({ email, password: "adminpassword123" });
});
afterAll(async () => { await pool.end(); });

test("approving, declining and entering time off / availability are logged by the manager's name", async () => {
  await pool.query("INSERT INTO staff_time_off (id, restaurant_id, staff_id, off_date, note, status, created_at) VALUES ('t1',$1,$2,$3,'', 'pending',$4), ('t2',$1,$2,$5,'', 'pending',$4)", [A.restaurantId, ann, DAY, Date.now(), addDays(DAY, 1)]);
  expect((await A.agent.post("/api/time-off-requests/t1/approve")).status).toBe(200);
  expect((await A.agent.post("/api/time-off-requests/t2/decline")).status).toBe(200);
  await A.agent.post("/api/time-off").send({ staffId: ann, date: addDays(DAY, 2) });
  await pool.query("INSERT INTO staff_availability (id, restaurant_id, staff_id, availability, pending, pending_at, updated_at) VALUES ('av1',$1,$2,'{}'::jsonb,'{}'::jsonb,$3,$3)", [A.restaurantId, ann, Date.now()]);
  expect((await A.agent.post(`/api/availability-requests/${ann}/approve`)).status).toBe(200);

  expect(await waitFor(async () => (await admin.get(`/api/platform/decisions?restaurantId=${A.restaurantId}`)).body.length === 4)).toBe(true);
  const rows = (await admin.get(`/api/platform/decisions?restaurantId=${A.restaurantId}`)).body;
  expect(rows.every((r) => r.decidedBy === "Marie Manager" && r.staffName === "Ann Staff")).toBe(true);
  expect(rows.map((r) => r.kind + ":" + r.decision).sort()).toEqual(["availability:approved", "time_off:approved", "time_off:declined", "time_off:entered"]);
  expect((await admin.get(`/api/platform/decisions?restaurantId=${A.restaurantId}&kind=availability`)).body).toHaveLength(1);
  expect((await A.agent.get("/api/platform/decisions")).status).toBe(401);
});
