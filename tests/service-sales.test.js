// The AI is never really called here: global.fetch is replaced.
process.env.ANTHROPIC_API_KEY = "test-key-not-real";

const request = require("supertest");
const { app, pool } = require("../server.js");
const { createRestaurant } = require("./helpers");

let A, B;
const DAY = "2026-04-06"; // a Monday
const realFetch = global.fetch;
let aiReply = "{}";

beforeAll(async () => {
  const factory = () => request.agent(app);
  A = await createRestaurant(factory);
  B = await createRestaurant(factory);
});
beforeEach(() => {
  global.fetch = jest.fn(async (url, opts) => {
    if (!String(url).includes("api.anthropic.com")) return realFetch(url, opts);
    return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: aiReply }] }) };
  });
});
afterEach(() => { global.fetch = realFetch; });
afterAll(async () => { await pool.end(); });

const proj = (agent) => agent.get(`/api/sales-projections?start=2026-04-01&end=2026-04-30`);
const actual = (agent) => agent.get(`/api/actual-sales?start=2026-04-01&end=2026-04-30`);

describe("forecast sales: lunch/brunch + dinner = total", () => {
  test("typing lunch then dinner builds the day's total", async () => {
    let res = await A.agent.put("/api/sales-projections").send({ date: DAY, lunchAmount: 1800 });
    expect(res.body).toMatchObject({ lunchAmount: 1800, dinnerAmount: null, projectedAmount: 1800 });
    res = await A.agent.put("/api/sales-projections").send({ date: DAY, dinnerAmount: "3200" });
    expect(res.body).toMatchObject({ lunchAmount: 1800, dinnerAmount: 3200, projectedAmount: 5000 });
    const list = await proj(A.agent);
    expect(list.body.find((r) => r.date === DAY)).toMatchObject({ lunchAmount: 1800, dinnerAmount: 3200, projectedAmount: 5000 });
  });

  test("clearing one half leaves the other as the total; clearing both empties it", async () => {
    let res = await A.agent.put("/api/sales-projections").send({ date: DAY, lunchAmount: "" });
    expect(res.body).toMatchObject({ lunchAmount: null, dinnerAmount: 3200, projectedAmount: 3200 });
    res = await A.agent.put("/api/sales-projections").send({ date: DAY, dinnerAmount: "" });
    expect(res.body).toMatchObject({ lunchAmount: null, dinnerAmount: null, projectedAmount: null });
  });

  test("last year's figure is stored without touching the rest", async () => {
    await A.agent.put("/api/sales-projections").send({ date: DAY, lunchAmount: 1000, dinnerAmount: 2000 });
    const res = await A.agent.put("/api/sales-projections").send({ date: DAY, lastYearAmount: "4800" });
    expect(res.body).toMatchObject({ projectedAmount: 3000, lunchAmount: 1000, dinnerAmount: 2000, lastYearAmount: 4800 });
  });

  test("a total sent on its own is still accepted (older callers)", async () => {
    const res = await A.agent.put("/api/sales-projections").send({ date: "2026-04-07", projectedAmount: 5000 });
    expect(res.body).toMatchObject({ projectedAmount: 5000, lunchAmount: null, dinnerAmount: null });
  });

  test("rejects negatives and empty bodies", async () => {
    expect((await A.agent.put("/api/sales-projections").send({ date: DAY, lunchAmount: -5 })).status).toBe(400);
    expect((await A.agent.put("/api/sales-projections").send({ date: DAY, dinnerAmount: "abc" })).status).toBe(400);
    expect((await A.agent.put("/api/sales-projections").send({ date: DAY })).status).toBe(400);
  });

  test("another restaurant does not see it", async () => {
    const list = await proj(B.agent);
    expect(list.body.find((r) => r.date === DAY)).toBeUndefined();
  });
});

describe("actual sales: lunch/brunch + dinner = total", () => {
  test("lunch and dinner typed into the grid make the day's total", async () => {
    let res = await A.agent.put("/api/actual-sales").send({ date: DAY, lunchAmount: 1500 });
    expect(res.body).toMatchObject({ lunchAmount: 1500, dinnerAmount: null, amount: 1500 });
    res = await A.agent.put("/api/actual-sales").send({ date: DAY, dinnerAmount: 2500 });
    expect(res.body).toMatchObject({ lunchAmount: 1500, dinnerAmount: 2500, amount: 4000 });
    const list = await actual(A.agent);
    expect(list.body.find((r) => r.date === DAY)).toMatchObject({ amount: 4000, lunchAmount: 1500, dinnerAmount: 2500 });
  });

  test("a day with a food/beverage split keeps that split as its total", async () => {
    await A.agent.put("/api/actual-sales").send({ date: "2026-04-08", foodAmount: 3000, bevAmount: 1000 });
    const res = await A.agent.put("/api/actual-sales").send({ date: "2026-04-08", lunchAmount: 1200, dinnerAmount: 2500 });
    expect(res.body).toMatchObject({ foodAmount: 3000, bevAmount: 1000, amount: 4000, lunchAmount: 1200, dinnerAmount: 2500 });
  });

  test("later food/beverage edits keep the lunch and dinner figures", async () => {
    const res = await A.agent.put("/api/actual-sales").send({ date: "2026-04-08", bevAmount: 1200 });
    expect(res.body).toMatchObject({ amount: 4200, lunchAmount: 1200, dinnerAmount: 2500 });
  });

  test("clearing both leaves no total; lunch and a total can be sent together; negatives are rejected", async () => {
    let res = await A.agent.put("/api/actual-sales").send({ date: DAY, lunchAmount: "", dinnerAmount: "" });
    expect(res.body).toMatchObject({ lunchAmount: null, dinnerAmount: null, amount: null });
    res = await A.agent.put("/api/actual-sales").send({ date: "2026-04-09", amount: 6000, lunchAmount: 2000 });
    expect(res.body).toMatchObject({ amount: 6000, lunchAmount: 2000 });
    expect((await A.agent.put("/api/actual-sales").send({ date: DAY, dinnerAmount: -1 })).status).toBe(400);
  });
});

describe("AI sales forecast", () => {
  test("needs a Monday", async () => {
    const res = await A.agent.post("/api/ai/sales-forecast").send({ weekStart: "2026-04-07" });
    expect(res.status).toBe(400);
  });

  test("refuses when there is nothing to base a forecast on", async () => {
    const res = await B.agent.post("/api/ai/sales-forecast").send({ weekStart: "2026-04-13" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/history/i);
  });

  test("saves the AI's numbers for the week and ignores anything else", async () => {
    // history: four earlier days of actual sales
    for (const [d, amt] of [["2026-03-30", 4000], ["2026-03-31", 3000], ["2026-04-01", 3500], ["2026-04-02", 5000]]) {
      await A.agent.put("/api/actual-sales").send({ date: d, amount: amt });
    }
    aiReply = 'Sure!\n{"days":[{"date":"2026-04-13","amount":4100},{"date":"2026-04-14","amount":null},{"date":"2026-04-15","amount":-5},{"date":"2026-05-01","amount":9999}]}';
    const res = await A.agent.post("/api/ai/sales-forecast").send({ weekStart: "2026-04-13" });
    expect(res.status).toBe(200);
    expect(res.body.days).toEqual([{ date: "2026-04-13", amount: 4100 }, { date: "2026-04-14", amount: null }]);
    const list = await A.agent.get("/api/sales-projections?start=2026-04-13&end=2026-04-19");
    expect(list.body.find((r) => r.date === "2026-04-13")).toMatchObject({ aiAmount: 4100, projectedAmount: null });
  });

  test("an AI number far from the worked-out baseline is pulled back to it", async () => {
    // earlier test saved a Monday actual of 4000 (2026-03-30), so the baseline for Monday 2026-04-13 is 4000
    aiReply = '{"days":[{"date":"2026-04-13","amount":9000}]}';
    const res = await A.agent.post("/api/ai/sales-forecast").send({ weekStart: "2026-04-13" });
    expect(res.status).toBe(200);
    expect(res.body.days).toEqual([{ date: "2026-04-13", amount: 4000 }]);
  });

  test("an unreadable AI answer is reported, not saved", async () => {
    aiReply = "I cannot do that";
    const res = await A.agent.post("/api/ai/sales-forecast").send({ weekStart: "2026-04-13" });
    expect(res.status).toBe(502);
  });
});
