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

function fakeAnthropic() {
  global.fetch = jest.fn(async (url, opts) => {
    if (!String(url).includes("api.anthropic.com")) return realFetch(url, opts);
    lastBody = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: JSON.stringify(nextReply) }] }) };
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

beforeEach(() => { fakeAnthropic(); lastBody = null; });
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
