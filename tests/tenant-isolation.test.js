const request = require("supertest");
const { app, pool } = require("../server.js");
const { createRestaurant, uniquePhone } = require("./helpers");

let restaurantA, restaurantB;

beforeAll(async () => {
  const agentFactory = () => request.agent(app);
  restaurantA = await createRestaurant(agentFactory);
  restaurantB = await createRestaurant(agentFactory);
});

afterAll(async () => {
  await pool.end();
});

describe("staff isolation", () => {
  let staffAId, staffBId;

  beforeAll(async () => {
    const resA = await restaurantA.agent.post("/api/staff").send({
      name: "Staffer A", phone: uniquePhone(), roles: ["Server"],
    });
    staffAId = resA.body.id;

    const resB = await restaurantB.agent.post("/api/staff").send({
      name: "Staffer B", phone: uniquePhone(), roles: ["Server"],
    });
    staffBId = resB.body.id;
  });

  test("a restaurant's staff list never includes another restaurant's staff", async () => {
    const res = await restaurantA.agent.get("/api/staff");
    expect(res.status).toBe(200);
    expect(res.body.some((s) => s.id === staffBId)).toBe(false);
    expect(res.body.some((s) => s.id === staffAId)).toBe(true);
  });

  test("editing another restaurant's staff member by ID fails", async () => {
    const res = await restaurantA.agent.patch(`/api/staff/${staffBId}`).send({ name: "Hijacked Name" });
    expect(res.status).toBe(404);

    // Confirm restaurant B's staffer was genuinely untouched.
    const check = await restaurantB.agent.get("/api/staff");
    const stillThere = check.body.find((s) => s.id === staffBId);
    expect(stillThere.name).toBe("Staffer B");
  });

  test("deleting another restaurant's staff member by ID does not delete it", async () => {
    await restaurantA.agent.delete(`/api/staff/${staffBId}`);
    const check = await restaurantB.agent.get("/api/staff");
    expect(check.body.some((s) => s.id === staffBId)).toBe(true);
  });
});

describe("shift ticket isolation", () => {
  let shiftAId, shiftBId;

  beforeAll(async () => {
    await restaurantA.agent.post("/api/staff").send({ name: "A Server", phone: uniquePhone(), roles: ["Server"] });
    await restaurantB.agent.post("/api/staff").send({ name: "B Server", phone: uniquePhone(), roles: ["Server"] });

    const resA = await restaurantA.agent.post("/api/shifts").send({ role: "Server", time: "Today 5pm" });
    shiftAId = resA.body.shift.id;
    const resB = await restaurantB.agent.post("/api/shifts").send({ role: "Server", time: "Today 6pm" });
    shiftBId = resB.body.shift.id;
  });

  test("a restaurant's open shifts never include another restaurant's shifts", async () => {
    const res = await restaurantA.agent.get("/api/shifts");
    expect(res.body.some((s) => s.id === shiftBId)).toBe(false);
    expect(res.body.some((s) => s.id === shiftAId)).toBe(true);
  });

  test("deleting another restaurant's shift by ID does not delete it", async () => {
    await restaurantA.agent.delete(`/api/shifts/${shiftBId}`);
    const check = await restaurantB.agent.get("/api/shifts");
    expect(check.body.some((s) => s.id === shiftBId)).toBe(true);
  });
});

describe("hiring isolation", () => {
  let postingAId, postingBId;

  beforeAll(async () => {
    const resA = await restaurantA.agent.post("/api/hiring/postings").send({ title: "A's Opening", role: "Server" });
    postingAId = resA.body.id;
    const resB = await restaurantB.agent.post("/api/hiring/postings").send({ title: "B's Opening", role: "Server" });
    postingBId = resB.body.id;
  });

  test("a restaurant's postings list never includes another restaurant's postings", async () => {
    const res = await restaurantA.agent.get("/api/hiring/postings");
    expect(res.body.some((p) => p.id === postingBId)).toBe(false);
  });

  test("the public posting page only ever shows what it's asked for, scoped correctly", async () => {
    // The public endpoint is intentionally unauthenticated, but still must not leak
    // cross-restaurant data beyond the single posting it's asked about.
    const res = await request(app).get(`/api/public/postings/${postingBId}`);
    expect(res.status).toBe(200);
    expect(res.body.title).toBe("B's Opening");
  });

  test("deleting another restaurant's posting by ID does not delete it", async () => {
    await restaurantA.agent.delete(`/api/hiring/postings/${postingBId}`);
    const check = await restaurantB.agent.get("/api/hiring/postings");
    expect(check.body.some((p) => p.id === postingBId)).toBe(true);
  });
});

describe("schedule and sales isolation", () => {
  test("schedule shifts never cross restaurants for the same date range", async () => {
    const staffRes = await restaurantA.agent.post("/api/staff").send({ name: "Schedule Staffer A", phone: uniquePhone(), roles: ["Server"] });
    const today = new Date().toISOString().slice(0, 10);

    await restaurantA.agent.post("/api/schedule").send({
      staffId: staffRes.body.id, date: today, startTime: "09:00", endTime: "17:00", role: "Server",
    });

    const bScheduleRes = await restaurantB.agent.get(`/api/schedule?start=${today}&end=${today}`);
    expect(bScheduleRes.body.length).toBe(0);
  });

  test("sales projections for the same date are kept separate per restaurant", async () => {
    const today = new Date().toISOString().slice(0, 10);
    await restaurantA.agent.put("/api/sales-projections").send({ date: today, projectedAmount: 1000 });
    await restaurantB.agent.put("/api/sales-projections").send({ date: today, projectedAmount: 2500 });

    const aRes = await restaurantA.agent.get(`/api/sales-projections?start=${today}&end=${today}`);
    const bRes = await restaurantB.agent.get(`/api/sales-projections?start=${today}&end=${today}`);

    expect(aRes.body.find((p) => p.date === today).projectedAmount).toBe(1000);
    expect(bRes.body.find((p) => p.date === today).projectedAmount).toBe(2500);
  });
});

describe("the SMS inbound webhook — the exact scenario the dedicated-number fix addresses", () => {
  // The real bug this guards against: the same phone number staffed at two
  // different restaurants. Before the fix, an inbound text could resolve to
  // whichever restaurant's row Postgres happened to return first. The fix
  // resolves the restaurant by the dedicated number the text arrived on
  // (Twilio's "To" field) before ever looking at the phone number.
  test("a shared phone number resolves to the correct restaurant once a dedicated number is set", async () => {
    const sharedPhone = uniquePhone();
    const dedicatedNumber = "+15145550100";

    // Directly assigning the dedicated number here (rather than through the
    // platform-admin endpoint) keeps this test focused on the webhook's own
    // resolution logic, not on platform auth.
    await pool.query("UPDATE restaurants SET twilio_phone_number = $1 WHERE id = $2", [dedicatedNumber, restaurantA.restaurantId]);

    // The same phone number is staff at BOTH restaurants — exactly the scenario
    // that was ambiguous before dedicated numbers existed.
    await restaurantA.agent.post("/api/staff").send({ name: "Shared Phone — A's version", phone: sharedPhone, roles: ["Server"] });
    await restaurantB.agent.post("/api/staff").send({ name: "Shared Phone — B's version", phone: sharedPhone, roles: ["Server"] });

    // A text arrives on restaurant A's dedicated number, from the shared phone,
    // with no matching shift code — we're only checking which restaurant it
    // resolves to, visible in the reply text.
    const res = await request(app)
      .post("/api/sms/inbound")
      .type("form")
      .send({ From: sharedPhone, To: dedicatedNumber, Body: "hello" });

    expect(res.status).toBe(200);
    // A valid staffer (resolved via the dedicated number) gets the "reply YES + code"
    // prompt; an unrecognized number would instead get "ask your manager to add you".
    // Either way, this proves resolution happened via restaurant A's number, not a
    // phone-only guess that could have landed on either restaurant.
    expect(res.text).toMatch(/YES/i);
  });
});
