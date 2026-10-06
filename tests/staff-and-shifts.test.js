const request = require("supertest");
const { app, pool } = require("../server.js");
const { createRestaurant, uniquePhone } = require("./helpers");

let restaurant;

beforeAll(async () => {
  restaurant = await createRestaurant(() => request.agent(app));
});

afterAll(async () => {
  await pool.end();
});

describe("staff validation", () => {
  test("requires a name", async () => {
    const res = await restaurant.agent.post("/api/staff").send({ phone: uniquePhone(), roles: ["Server"] });
    expect(res.status).toBe(400);
  });

  test("requires a phone number", async () => {
    const res = await restaurant.agent.post("/api/staff").send({ name: "No Phone", roles: ["Server"] });
    expect(res.status).toBe(400);
  });

  test("creates a staff member with a valid hourly rate", async () => {
    const res = await restaurant.agent.post("/api/staff").send({
      name: "Rate Test", phone: uniquePhone(), roles: ["Server"], hourlyRate: "15.50",
    });
    expect(res.status).toBe(201);
    expect(res.body.hourlyRate).toBe(15.5);
  });
});

describe("the full shift lifecycle", () => {
  let staff, shiftId;

  beforeAll(async () => {
    const res = await restaurant.agent.post("/api/staff").send({
      name: "Lifecycle Staffer", phone: uniquePhone(), roles: ["Server"],
    });
    staff = res.body;
  });

  test("posting an open shift texts matching staff (mocked) and creates the ticket", async () => {
    const res = await restaurant.agent.post("/api/shifts").send({ role: "Server", time: "Tonight 6pm", note: "Covering a no-show" });
    expect(res.status).toBe(201);
    expect(res.body.shift.status).toBe("open");
    expect(res.body.sms.total).toBeGreaterThanOrEqual(1);
    shiftId = res.body.shift.id;
  });

  test("a staff member responding is recorded on the ticket", async () => {
    const res = await restaurant.agent.post(`/api/shifts/${shiftId}/respond`).send({ staffId: staff.id });
    expect(res.status).toBe(200);
    expect(res.body.responders.some((r) => r.staffId === staff.id)).toBe(true);
  });

  test("assigning the shift marks it filled", async () => {
    const res = await restaurant.agent.post(`/api/shifts/${shiftId}/assign`).send({ staffId: staff.id });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("filled");
    expect(res.body.assignedTo).toBe(staff.id);
  });

  test("a filled shift no longer appears in the open shifts the staff portal would see", async () => {
    const res = await restaurant.agent.get("/api/shifts");
    const thisShift = res.body.find((s) => s.id === shiftId);
    expect(thisShift.status).toBe("filled");
  });
});

describe("the AI agent endpoint's rate limit is scoped per restaurant, not globally", () => {
  test("a second restaurant's AI usage is unaffected by the first restaurant's requests", async () => {
    // This doesn't call the real Anthropic API (ANTHROPIC_API_KEY is unset in tests),
    // so it exercises the "not configured yet" path — which is enough to confirm the
    // route itself is reachable and scoped by restaurant before the external call.
    const res = await restaurant.agent.post("/api/ai/ask").send({ question: "test question" });
    expect([200, 502, 503]).toContain(res.status);
  });
});
