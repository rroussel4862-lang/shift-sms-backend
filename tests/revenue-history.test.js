const request = require("supertest");
const { app, pool } = require("../server.js");
const { createRestaurant } = require("./helpers");

let A, B;
beforeAll(async () => {
  const factory = () => request.agent(app);
  A = await createRestaurant(factory);
  B = await createRestaurant(factory);
});
afterAll(async () => { await pool.end(); });

// 2025 view: first week starts Mon 2024-12-30 (its Thursday, Jan 2, is in 2025); the comparable last-year week starts 364 days earlier, Mon 2024-01-01.
describe("revenue history", () => {
  test("requires login", async () => {
    expect((await request(app).get("/api/revenue-history?year=2025")).status).toBe(401);
    expect((await request(app).put("/api/revenue-history").send({ weekStart: "2024-01-01", amount: 1 })).status).toBe(401);
  });

  test("weekStart must be a Monday, in range, with a sane amount", async () => {
    expect((await A.agent.put("/api/revenue-history").send({ weekStart: "2024-01-02", amount: 100 })).status).toBe(400);
    expect((await A.agent.put("/api/revenue-history").send({ weekStart: "nope", amount: 100 })).status).toBe(400);
    expect((await A.agent.put("/api/revenue-history").send({ weekStart: "1990-01-01", amount: 100 })).status).toBe(400);
    expect((await A.agent.put("/api/revenue-history").send({ weekStart: "2024-01-01", amount: "abc" })).status).toBe(400);
    expect((await A.agent.put("/api/revenue-history").send({ weekStart: "2024-01-01", amount: -5 })).status).toBe(400);
  });

  test("saves, updates and clears a prior-year week", async () => {
    let res = await A.agent.put("/api/revenue-history").send({ weekStart: "2024-01-01", amount: "$12,345.50" });
    expect(res.status).toBe(200);
    expect(res.body.amount).toBe(12345.5);
    await A.agent.put("/api/revenue-history").send({ weekStart: "2024-01-01", amount: 20000 });
    let get = await A.agent.get("/api/revenue-history?year=2025");
    expect(get.status).toBe(200);
    const wk = get.body.weeks.find((w) => w.lastYearWeekStart === "2024-01-01");
    expect(wk).toBeTruthy();
    expect(wk.lastYear).toBe(20000);
    res = await A.agent.put("/api/revenue-history").send({ weekStart: "2024-01-01", amount: null });
    expect(res.body.amount).toBeNull();
    get = await A.agent.get("/api/revenue-history?year=2025");
    expect(get.body.weeks.find((w) => w.lastYearWeekStart === "2024-01-01").lastYear).toBeNull();
  });

  test("a week belongs to the year holding its Thursday", async () => {
    const get = await A.agent.get("/api/revenue-history?year=2025");
    expect(get.body.weeks[0].weekStart).toBe("2024-12-30");
    expect(get.body.weeks[0].month).toBe(1);
    expect(get.body.weeks.every((w) => w.weekStart <= w.weekEnd)).toBe(true);
  });

  test("this year's weeks sum the daily actual sales, and compare to last year", async () => {
    // Week of 2025-03-03 (Mon) vs last-year week 2024-03-04 (Mon, 364 days earlier)
    await A.agent.put("/api/actual-sales").send({ date: "2025-03-03", foodAmount: 600, bevAmount: 400 });
    await A.agent.put("/api/actual-sales").send({ date: "2025-03-05", foodAmount: 1000, bevAmount: 0 });
    await A.agent.put("/api/revenue-history").send({ weekStart: "2024-03-04", amount: 2000 });
    const get = await A.agent.get("/api/revenue-history?year=2025");
    const wk = get.body.weeks.find((w) => w.weekStart === "2025-03-03");
    expect(wk.thisYear).toBe(2000);
    expect(wk.daysEntered).toBe(2);
    expect(wk.lastYearWeekStart).toBe("2024-03-04");
    expect(wk.lastYear).toBe(2000);
    expect(wk.completed).toBe(true);
    expect(get.body.cards.ytd.weeks.weeksCompared).toBeGreaterThanOrEqual(1);
    expect(get.body.months.find((m) => m.month === 3)).toBeTruthy();
  });

  test("restaurants never see each other's history", async () => {
    await A.agent.put("/api/revenue-history").send({ weekStart: "2024-03-11", amount: 777 });
    const get = await B.agent.get("/api/revenue-history?year=2025");
    expect(get.status).toBe(200);
    expect(get.body.weeks.find((w) => w.lastYearWeekStart === "2024-03-11").lastYear).toBeNull();
    expect(get.body.weeks.find((w) => w.weekStart === "2025-03-03").thisYear).toBeNull();
  });
});
