const request = require("supertest");
const bcrypt = require("bcryptjs");
const { app, pool } = require("../server.js");
const { createRestaurant, uniquePhone, uniqueEmail } = require("./helpers");

let A, B, ann;

async function makeStaff(restaurant, name) {
  const created = await restaurant.agent.post("/api/staff").send({ name, phone: uniquePhone(), roles: ["Server"] });
  const email = uniqueEmail("av");
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

const approvedFor = async (id) => (await pool.query("SELECT availability FROM staff_availability WHERE staff_id = $1", [id])).rows[0].availability;

describe("availability changes need a manager's approval", () => {
  test("a submission is only a request: the schedule still sees the approved availability", async () => {
    const res = await ann.agent.put("/api/staff-auth/availability").send({ availability: { mon: { available: false, note: "school" }, bogus: { available: true } } });
    expect(res.status).toBe(200);
    expect(res.body.pending).toEqual({ mon: { available: false, note: "school" } }); // unknown keys dropped
    expect(res.body.availability).toEqual({});
    expect(await approvedFor(ann.id)).toEqual({});
  });

  test("the manager sees it, and other restaurants do not", async () => {
    const list = await A.agent.get("/api/availability-requests");
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ staffId: ann.id, name: "Ann", requested: { mon: { available: false, note: "school" } } });
    expect((await B.agent.get("/api/availability-requests")).body).toHaveLength(0);
    expect((await B.agent.post(`/api/availability-requests/${ann.id}/approve`)).status).toBe(404);
    expect((await request(app).get("/api/availability-requests")).status).toBe(401);
  });

  test("approving makes it count; the staff member sees the decision", async () => {
    const res = await A.agent.post(`/api/availability-requests/${ann.id}/approve`);
    expect(res.status).toBe(200);
    expect(await approvedFor(ann.id)).toEqual({ mon: { available: false, note: "school" } });
    expect((await A.agent.get("/api/availability-requests")).body).toHaveLength(0);
    const mine = await ann.agent.get("/api/staff-auth/availability");
    expect(mine.body).toMatchObject({ pending: null, decision: "approved" });
  });

  test("a later request that is declined leaves the approved availability untouched", async () => {
    await ann.agent.put("/api/staff-auth/availability").send({ availability: { mon: { available: true, note: "" } } });
    expect(await approvedFor(ann.id)).toEqual({ mon: { available: false, note: "school" } }); // still the approved one
    expect((await A.agent.post(`/api/availability-requests/${ann.id}/decline`)).status).toBe(200);
    expect(await approvedFor(ann.id)).toEqual({ mon: { available: false, note: "school" } });
    expect((await ann.agent.get("/api/staff-auth/availability")).body).toMatchObject({ pending: null, decision: "declined" });
    expect((await A.agent.post(`/api/availability-requests/${ann.id}/approve`)).status).toBe(404); // nothing pending any more
  });

  test("busy hours are kept, bad times dropped, and only approved availability reaches the schedule grid", async () => {
    const res = await ann.agent.put("/api/staff-auth/availability").send({ availability: {
      tue: { available: false, note: "", from: "17:00", to: "22:00" },
      wed: { available: false, note: "", from: "25:99", to: "nope" },
      thu: { available: true, note: "", from: "10:00", to: "12:00" }, // on a free day the hours mean "only available between these times"
    } });
    expect(res.body.pending).toEqual({
      tue: { available: false, note: "", from: "17:00", to: "22:00" },
      wed: { available: false, note: "" },
      thu: { available: true, note: "", from: "10:00", to: "12:00" },
    });
    expect((await A.agent.get("/api/availability")).body[ann.id]).not.toHaveProperty("tue"); // not approved yet
    await A.agent.post(`/api/availability-requests/${ann.id}/approve`);
    const grid = await A.agent.get("/api/availability");
    expect(grid.body[ann.id].tue).toEqual({ available: false, note: "", from: "17:00", to: "22:00" });
    expect((await B.agent.get("/api/availability")).body[ann.id]).toBeUndefined();
    expect((await request(app).get("/api/availability")).status).toBe(401);
  });
});
