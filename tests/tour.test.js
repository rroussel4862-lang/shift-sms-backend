const request = require("supertest");
const bcrypt = require("bcryptjs");
const { app, pool } = require("../server.js");
const { createRestaurant, uniquePhone, uniqueEmail } = require("./helpers");

let A, B, ann;

async function makeStaff(restaurant, name) {
  const created = await restaurant.agent.post("/api/staff").send({ name, phone: uniquePhone(), roles: ["Server"] });
  const email = uniqueEmail("tour");
  await pool.query("UPDATE staff SET email = $1, password_hash = $2 WHERE id = $3", [email, await bcrypt.hash("staffpassword123", 4), created.body.id]);
  const agent = request.agent(app);
  await agent.post("/api/staff-auth/login").send({ email, password: "staffpassword123" });
  return { id: created.body.id, agent };
}

beforeAll(async () => {
  const factory = () => request.agent(app);
  A = await createRestaurant(factory);
  B = await createRestaurant(factory);
  ann = await makeStaff(A, "Ann");
});
afterAll(async () => { await pool.end(); });

describe("manager tour", () => {
  test("a new restaurant starts as 'new' with step 0 and an empty checklist", async () => {
    const r = await A.agent.get("/api/tour");
    expect(r.status).toBe(200);
    expect(r.body.tour).toEqual({ status: "new", step: 0 });
    const done = Object.fromEntries(r.body.checklist.items.map((i) => [i.key, i.done]));
    expect(done.schedule).toBe(false);
    expect(done.sales).toBe(false);
    expect(done.post).toBe(false);
    expect(r.body.checklist.allDone).toBe(false);
  });

  test("progress is saved and can be replayed", async () => {
    expect((await A.agent.put("/api/tour").send({ status: "active", step: 4 })).body.tour).toEqual({ status: "active", step: 4 });
    expect((await A.agent.get("/api/tour")).body.tour).toEqual({ status: "active", step: 4 });
    await A.agent.put("/api/tour").send({ status: "skipped", step: 2 });
    expect((await A.agent.get("/api/tour")).body.tour.status).toBe("skipped");
    await A.agent.put("/api/tour").send({ status: "done" });
    expect((await A.agent.get("/api/tour")).body.tour).toEqual({ status: "done", step: 0 });
  });

  test("rejects a bad status and clamps a silly step", async () => {
    expect((await A.agent.put("/api/tour").send({ status: "banana" })).status).toBe(400);
    expect((await A.agent.put("/api/tour").send({ status: "active", step: 9999 })).body.tour.step).toBe(0);
  });

  test("the tour is per restaurant", async () => {
    await A.agent.put("/api/tour").send({ status: "done" });
    expect((await B.agent.get("/api/tour")).body.tour.status).toBe("new");
  });

  test("the checklist ticks itself off from real data", async () => {
    const get = async () => Object.fromEntries((await B.agent.get("/api/tour")).body.checklist.items.map((i) => [i.key, i.done]));
    expect((await get()).staff).toBe(false);
    const st = await B.agent.post("/api/staff").send({ name: "Bo", phone: uniquePhone(), roles: ["Server"] });
    expect((await get()).staff).toBe(true);
    expect((await get()).login).toBe(false);
    await pool.query("UPDATE staff SET claim_token = 'tok-' || id WHERE id = $1", [st.body.id]);
    expect((await get()).login).toBe(true);
    expect((await get()).services).toBe(false);
    await B.agent.put("/api/services").send({ services: [{ id: "lunch", name: "Lunch", from: "00:00" }, { id: "dinner", name: "Dinner", from: "16:00" }] });
    expect((await get()).services).toBe(true);
    const day = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
    await B.agent.post("/api/schedule").send({ staffId: st.body.id, date: day, startTime: "17:00", endTime: "23:00", role: "Server" });
    expect((await get()).schedule).toBe(true);
    await B.agent.put("/api/actual-sales").send({ date: day, amount: 1234 });
    expect((await get()).sales).toBe(true);
    expect((await get()).post).toBe(false);
    const mon = new Date(day + "T00:00:00Z"); mon.setUTCDate(mon.getUTCDate() - ((mon.getUTCDay() + 6) % 7));
    await B.agent.post("/api/schedule/publish").send({ weekStart: mon.toISOString().slice(0, 10) });
    expect((await get()).post).toBe(true);
    expect((await B.agent.get("/api/tour")).body.checklist.allDone).toBe(true);
  });

  test("requires a manager login", async () => {
    expect((await request(app).get("/api/tour")).status).toBe(401);
    expect((await request(app).put("/api/tour").send({ status: "done" })).status).toBe(401);
    expect((await ann.agent.get("/api/tour")).status).toBe(401);
  });
});

describe("staff tour", () => {
  test("starts new, saves progress, is private to the person", async () => {
    expect((await ann.agent.get("/api/staff-auth/tour")).body.tour).toEqual({ status: "new", step: 0 });
    await ann.agent.put("/api/staff-auth/tour").send({ status: "active", step: 2 });
    expect((await ann.agent.get("/api/staff-auth/tour")).body.tour).toEqual({ status: "active", step: 2 });
    const bob = await makeStaff(A, "Bob");
    expect((await bob.agent.get("/api/staff-auth/tour")).body.tour.status).toBe("new");
    expect((await ann.agent.put("/api/staff-auth/tour").send({ status: "nope" })).status).toBe(400);
  });

  test("requires a staff login", async () => {
    expect((await request(app).get("/api/staff-auth/tour")).status).toBe(401);
    expect((await A.agent.get("/api/staff-auth/tour")).status).toBe(401);
  });
});
