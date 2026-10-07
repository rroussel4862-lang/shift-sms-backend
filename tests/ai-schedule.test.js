// The AI is faked (global.fetch replaced) — no key, no cost. What matters here is that whatever the model
// says is checked by the server before it can reach the grid.
process.env.ANTHROPIC_API_KEY = "test-key-not-real";

const request = require("supertest");
const crypto = require("crypto");
const { app, pool } = require("../server.js");
const { createRestaurant, uniquePhone } = require("./helpers");

const WEEK = "2026-03-02"; // a Monday
let A, B, ana, ben, cal, bStaff;
const realFetch = global.fetch;
let lastBody = null;
let nextReply = null;
let replyQueue = []; // when set, successive model calls get successive replies

function fakeAnthropic() {
  global.fetch = jest.fn(async (url, opts) => {
    if (!String(url).includes("api.anthropic.com")) return realFetch(url, opts);
    lastBody = JSON.parse(opts.body);
    const reply = replyQueue.length ? replyQueue.shift() : nextReply;
    return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: typeof reply === "string" ? reply : JSON.stringify(reply) }] }) };
  });
}

async function mkStaff(r, name, roles) {
  const res = await r.agent.post("/api/staff").send({ name, phone: uniquePhone(), roles, hourlyRate: 20 });
  expect(res.status).toBe(201);
  return res.body.id;
}

beforeAll(async () => {
  const factory = () => request.agent(app);
  A = await createRestaurant(factory);
  B = await createRestaurant(factory);
  ana = await mkStaff(A, "Ana Server", ["Server", "Host"]);
  ben = await mkStaff(A, "Ben Server", ["Server"]);
  cal = await mkStaff(A, "Cal Cook", ["Line Cook"]);
  bStaff = await mkStaff(B, "Bea Other", ["Server"]);
  // Ben can't work Tuesdays.
  await pool.query(
    "INSERT INTO staff_availability (id, restaurant_id, staff_id, availability, updated_at) VALUES ($1,$2,$3,$4,$5)",
    [crypto.randomUUID(), A.restaurantId, ben, JSON.stringify({ tue: { available: false, note: "" } }), Date.now()]
  );
});

beforeEach(() => { fakeAnthropic(); lastBody = null; replyQueue = []; });
afterEach(() => { global.fetch = realFetch; });
afterAll(async () => { await pool.end(); });

const sh = (staffId, date, startTime, endTime, role = "Server") => ({ staffId, date, startTime, endTime, role });

describe("POST /api/ai/schedule", () => {
  test("returns a validated proposal and saves nothing", async () => {
    nextReply = {
      summary: "Covered the week.",
      shifts: [
        sh(ana, "2026-03-02", "11:00", "17:00"),
        sh(ben, "2026-03-03", "11:00", "17:00"),          // Ben unavailable Tuesday -> dropped
        sh("not-a-real-id", "2026-03-02", "11:00", "17:00"), // unknown staff -> dropped
        sh(ana, "2026-03-20", "11:00", "17:00"),          // outside the week -> dropped
        sh(ben, "2026-03-04", "25:00", "17:00"),          // invalid time -> dropped
        sh(ben, "2026-03-05", "16:00", "22:00", "Line Cook"), // role he doesn't hold -> corrected to Server
        sh(bStaff, "2026-03-02", "11:00", "17:00"),       // another restaurant's staff -> dropped
      ],
    };
    const res = await A.agent.post("/api/ai/schedule").send({ prompt: "Fill the week", weekStart: WEEK, lang: "en" });
    expect(res.status).toBe(200);
    expect(res.body.summary).toBe("Covered the week.");
    expect(res.body.shifts.map((s) => `${s.staffName}|${s.date}|${s.role}`)).toEqual(["Ana Server|2026-03-02|Server", "Ben Server|2026-03-05|Server"]);
    expect(res.body.skipped.map((s) => s.code).sort()).toEqual(["bad_date", "bad_time", "unavailable", "unknown_staff", "unknown_staff"].sort());

    const grid = await A.agent.get(`/api/schedule?start=${WEEK}&end=2026-03-08`);
    expect(grid.body).toHaveLength(0);
  });

  test("the model is told about availability, existing shifts and only the allowed staff", async () => {
    await A.agent.post("/api/schedule").send({ staffId: ana, date: "2026-03-06", startTime: "10:00", endTime: "16:00", role: "Server" });
    nextReply = { summary: "", shifts: [sh(ana, "2026-03-06", "12:00", "18:00")] }; // overlaps the existing shift
    const res = await A.agent.post("/api/ai/schedule").send({ prompt: "Fill Friday", weekStart: WEEK, staffIds: [ana, ben] });
    expect(res.status).toBe(200);
    expect(res.body.shifts).toHaveLength(0);
    expect(res.body.skipped[0].code).toBe("overlap");
    expect(lastBody.system).toContain("Ana Server");
    expect(lastBody.system).not.toContain("Cal Cook");      // excluded by staffIds
    expect(lastBody.system).not.toContain("Bea Other");     // other restaurant
    expect(lastBody.system).toContain('"free":false');       // Ben's Tuesday
    expect(lastBody.system).toContain("2026-03-06");         // existing shift is in the context
  });

  test("validates input and requires login", async () => {
    expect((await A.agent.post("/api/ai/schedule").send({ prompt: "", weekStart: WEEK })).status).toBe(400);
    expect((await A.agent.post("/api/ai/schedule").send({ prompt: "x", weekStart: "soon" })).status).toBe(400);
    expect((await request(app).post("/api/ai/schedule").send({ prompt: "x", weekStart: WEEK })).status).toBe(401);
  });

  test("an unusable reply is a clean 502", async () => {
    nextReply = { nothing: true };
    expect((await A.agent.post("/api/ai/schedule").send({ prompt: "x", weekStart: WEEK })).status).toBe(502);
  });
});

describe("bulk apply and undo", () => {
  let ids;
  test("applies a proposal in one go", async () => {
    const res = await A.agent.post("/api/schedule/bulk").send({ shifts: [sh(ana, "2026-03-09", "11:00", "17:00"), sh(ben, "2026-03-09", "17:00", "23:00"), sh(cal, "2026-03-10", "08:00", "16:00", "Line Cook")] });
    expect(res.status).toBe(201);
    expect(res.body.created).toHaveLength(3);
    ids = res.body.created.map((c) => c.id);
    const grid = await A.agent.get("/api/schedule?start=2026-03-09&end=2026-03-15");
    expect(grid.body).toHaveLength(3);
  });

  test("applying the same shifts again skips them as overlaps instead of duplicating", async () => {
    const res = await A.agent.post("/api/schedule/bulk").send({ shifts: [sh(ana, "2026-03-09", "11:00", "17:00")] });
    expect(res.status).toBe(201);
    expect(res.body.created).toHaveLength(0);
    expect(res.body.skipped[0].code).toBe("overlap");
  });

  test("another restaurant cannot schedule my staff or delete my shifts", async () => {
    const put = await B.agent.post("/api/schedule/bulk").send({ shifts: [sh(ana, "2026-03-11", "11:00", "17:00")] });
    expect(put.body.created).toHaveLength(0);
    expect(put.body.skipped[0].code).toBe("unknown_staff");
    const del = await B.agent.post("/api/schedule/bulk-delete").send({ ids });
    expect(del.body.deleted).toBe(0);
    expect((await A.agent.get("/api/schedule?start=2026-03-09&end=2026-03-15")).body).toHaveLength(3);
  });

  test("undo removes exactly those shifts", async () => {
    const del = await A.agent.post("/api/schedule/bulk-delete").send({ ids });
    expect(del.body.deleted).toBe(3);
    expect((await A.agent.get("/api/schedule?start=2026-03-09&end=2026-03-15")).body).toHaveLength(0);
  });

  test("rejects empty or oversized requests", async () => {
    expect((await A.agent.post("/api/schedule/bulk").send({ shifts: [] })).status).toBe(400);
    expect((await A.agent.post("/api/schedule/bulk-delete").send({ ids: [] })).status).toBe(400);
    const tooMany = Array.from({ length: 251 }, () => sh(ana, "2026-03-12", "10:00", "11:00"));
    expect((await A.agent.post("/api/schedule/bulk").send({ shifts: tooMany })).status).toBe(400);
  });
});

describe("scheduling from the Comms chat", () => {
  test("a scheduling request becomes a preview proposal for the right week and house — nothing saved", async () => {
    replyQueue = [
      { action: "schedule", weekStart: "2026-03-04", house: "foh", request: "Put two servers on Wednesday dinner" }, // a Wednesday: server snaps to Monday
      { summary: "Two servers on Wednesday.", shifts: [sh(ana, "2026-03-04", "17:00", "23:00"), sh(ben, "2026-03-04", "17:00", "23:00")] },
    ];
    const res = await A.agent.post("/api/ai/ask").send({ question: "schedule two servers wednesday night", lang: "en" });
    expect(res.status).toBe(200);
    expect(res.body.answer).toBe("Two servers on Wednesday.");
    expect(res.body.proposal.weekStart).toBe("2026-03-02");
    expect(res.body.proposal.shifts).toHaveLength(2);
    expect(res.body.proposal.totalHours).toBe(12);
    expect(res.body.proposal.estCost).toBe(240);       // 12h x $20
    // the scheduling call only saw front-of-house staff and the restated request
    expect(lastBody.system).toContain("Ana Server");
    expect(lastBody.system).not.toContain("Cal Cook");
    expect(lastBody.messages[0].content).toBe("Put two servers on Wednesday dinner");
    const grid = await A.agent.get("/api/schedule?start=2026-03-02&end=2026-03-08&x=1");
    expect(grid.body.filter((g) => g.date === "2026-03-04")).toHaveLength(0);
  });

  test("the proposal from chat is applied through the same bulk endpoint, and undo works", async () => {
    const proposal = [sh(ana, "2026-03-04", "17:00", "23:00")];
    const applied = await A.agent.post("/api/schedule/bulk").send({ shifts: proposal });
    expect(applied.body.created).toHaveLength(1);
    const undo = await A.agent.post("/api/schedule/bulk-delete").send({ ids: applied.body.created.map((c) => c.id) });
    expect(undo.body.deleted).toBe(1);
  });

  test("a normal question is answered in prose with no proposal", async () => {
    replyQueue = ["Ana works Monday."];
    const res = await A.agent.post("/api/ai/ask").send({ question: "who works monday?" });
    expect(res.body).toEqual({ answer: "Ana works Monday." });
  });

  test("a malformed action is shown as plain text instead of crashing", async () => {
    replyQueue = ['{"action":"schedule","weekStart":"someday"}'];
    const res = await A.agent.post("/api/ai/ask").send({ question: "fill the week" });
    expect(res.status).toBe(200);
    expect(res.body.proposal).toBeUndefined();
  });

  test("a house with no staff gives a clear error, not a crash", async () => {
    replyQueue = [{ action: "schedule", weekStart: "2026-03-02", house: "boh", request: "fill the kitchen" }];
    const empty = await createRestaurant(() => request.agent(app));
    await empty.agent.post("/api/staff").send({ name: "Only Server", phone: uniquePhone(), roles: ["Server"] });
    const res = await empty.agent.post("/api/ai/ask").send({ question: "fill the kitchen" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no staff/i);
  });
});

describe("sales-aware crews", () => {
  let C, dee;
  const PAST_FRIDAYS = ["2026-02-06", "2026-02-13", "2026-02-20", "2026-02-27"];

  beforeAll(async () => {
    C = await createRestaurant(() => request.agent(app));
    dee = await mkStaff(C, "Dee Server", ["Server"]);
    for (const d of PAST_FRIDAYS) {
      await C.agent.put("/api/actual-sales").send({ date: d, foodAmount: 3000, bevAmount: 1000 });
      await C.agent.post("/api/schedule").send({ staffId: dee, date: d, startTime: "10:00", endTime: "20:00", role: "Server" }); // 10h x $20
    }
    await C.agent.put("/api/sales-projections").send({ date: "2026-03-03", projectedAmount: 5000 });
  });

  test("the AI is given expected sales, the food/beverage split and a labor-hours benchmark", async () => {
    nextReply = { summary: "Sized to sales.", shifts: [sh(dee, "2026-03-06", "11:00", "21:00")] };
    const res = await C.agent.post("/api/ai/schedule").send({ prompt: "Staff to sales", weekStart: WEEK });
    expect(res.status).toBe(200);
    const plan = JSON.parse(lastBody.system.split("DATA:\n")[1]);
    const fri = plan.salesPlan.find((d) => d.date === "2026-03-06");
    expect(fri).toMatchObject({ weekday: "fri", expectedSales: 4000, foodPercent: 75, beveragePercent: 25 });
    expect(fri.basis).toMatch(/average of 4/);
    expect(plan.salesPlan.find((d) => d.date === "2026-03-03")).toMatchObject({ expectedSales: 5000, basis: "manager projection" });
    expect(plan.staffingBenchmarks).toMatchObject({ daysOfHistory: 4, salesPerLaborHour: 400, laborPercentOfSales: 5 });
    expect(plan.staffingBenchmarks.suggestedLaborHours).toEqual({ "2026-03-03": 12.5, "2026-03-06": 10 });
  });

  test("the preview reports labor % per day and for the week", async () => {
    nextReply = { summary: "", shifts: [sh(dee, "2026-03-06", "11:00", "21:00")] };
    const res = await C.agent.post("/api/ai/schedule").send({ prompt: "x", weekStart: WEEK });
    const fri = res.body.days.find((d) => d.date === "2026-03-06");
    expect(fri).toEqual({ date: "2026-03-06", hours: 10, cost: 200, expectedSales: 4000, laborPct: 5 });
    expect(res.body.days.find((d) => d.date === "2026-03-02").laborPct).toBeNull(); // no sales, no shifts that day
    expect(res.body.weekLaborPct).toBe(2.2); // $200 against $9,000 expected for the week
  });

  test("with no sales history it says so instead of inventing numbers", async () => {
    nextReply = { summary: "Spread evenly.", shifts: [sh(ana, "2026-03-11", "11:00", "17:00")] };
    const res = await A.agent.post("/api/ai/schedule").send({ prompt: "x", weekStart: "2026-03-09" });
    const plan = JSON.parse(lastBody.system.split("DATA:\n")[1]);
    expect(plan.salesPlan.every((d) => d.expectedSales === null)).toBe(true);
    expect(plan.staffingBenchmarks.suggestedLaborHours).toBeNull();
    expect(res.body.weekLaborPct).toBeNull();
  });
});
