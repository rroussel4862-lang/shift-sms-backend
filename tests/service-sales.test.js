const request = require("supertest");
const { app, pool } = require("../server.js");
const { createRestaurant } = require("./helpers");

let A, B;
const DAY = "2026-04-06";

beforeAll(async () => {
  const factory = () => request.agent(app);
  A = await createRestaurant(factory);
  B = await createRestaurant(factory);
});

afterAll(async () => {
  await pool.end();
});

const proj = (agent) => agent.get(`/api/sales-projections?start=2026-04-01&end=2026-04-30`);
const actual = (agent) => agent.get(`/api/actual-sales?start=2026-04-01&end=2026-04-30`);

describe("lunch/brunch projected sales", () => {
  test("lunch and day total are stored independently", async () => {
    let res = await A.agent.put("/api/sales-projections").send({ date: DAY, projectedAmount: 5000 });
    expect(res.body).toMatchObject({ projectedAmount: 5000, lunchAmount: null });
    res = await A.agent.put("/api/sales-projections").send({ date: DAY, lunchAmount: 1800 });
    expect(res.body).toMatchObject({ projectedAmount: 5000, lunchAmount: 1800 });
    res = await A.agent.put("/api/sales-projections").send({ date: DAY, projectedAmount: 5500 });
    expect(res.body).toMatchObject({ projectedAmount: 5500, lunchAmount: 1800 });
    const list = await proj(A.agent);
    expect(list.body.find((r) => r.date === DAY)).toMatchObject({ projectedAmount: 5500, lunchAmount: 1800 });
  });

  test("lunch can be set on a day with no total yet, and cleared", async () => {
    let res = await A.agent.put("/api/sales-projections").send({ date: "2026-04-07", lunchAmount: "900" });
    expect(res.body).toMatchObject({ projectedAmount: null, lunchAmount: 900 });
    res = await A.agent.put("/api/sales-projections").send({ date: "2026-04-07", lunchAmount: "" });
    expect(res.body).toMatchObject({ projectedAmount: null, lunchAmount: null });
  });

  test("last year's daily figure is stored alongside, without disturbing the rest", async () => {
    const res = await A.agent.put("/api/sales-projections").send({ date: DAY, lastYearAmount: "4800" });
    expect(res.body).toMatchObject({ projectedAmount: 5500, lunchAmount: 1800, lastYearAmount: 4800 });
    const res2 = await A.agent.put("/api/sales-projections").send({ date: DAY, projectedAmount: 6000 });
    expect(res2.body).toMatchObject({ projectedAmount: 6000, lastYearAmount: 4800 });
  });

  test("rejects negatives and empty bodies", async () => {
    expect((await A.agent.put("/api/sales-projections").send({ date: DAY, lunchAmount: -5 })).status).toBe(400);
    expect((await A.agent.put("/api/sales-projections").send({ date: DAY })).status).toBe(400);
  });

  test("another restaurant does not see it", async () => {
    const list = await proj(B.agent);
    expect(list.body.find((r) => r.date === DAY)).toBeUndefined();
  });
});

describe("lunch/brunch actual sales", () => {
  test("setting lunch leaves the food/beverage total untouched", async () => {
    await A.agent.put("/api/actual-sales").send({ date: DAY, foodAmount: 3000, bevAmount: 1000 });
    const res = await A.agent.put("/api/actual-sales").send({ date: DAY, lunchAmount: 1500 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ foodAmount: 3000, bevAmount: 1000, amount: 4000, lunchAmount: 1500 });
  });

  test("later food/beverage edits keep the lunch figure", async () => {
    const res = await A.agent.put("/api/actual-sales").send({ date: DAY, bevAmount: 1200 });
    expect(res.body).toMatchObject({ amount: 4200, lunchAmount: 1500 });
  });

  test("lunch on a day with no sales yet creates the row without a total", async () => {
    const res = await A.agent.put("/api/actual-sales").send({ date: "2026-04-08", lunchAmount: 700 });
    expect(res.body).toMatchObject({ amount: null, lunchAmount: 700 });
    const list = await actual(A.agent);
    expect(list.body.find((r) => r.date === "2026-04-08")).toMatchObject({ lunchAmount: 700 });
  });

  test("lunch and total can be sent together; negatives are rejected", async () => {
    const res = await A.agent.put("/api/actual-sales").send({ date: "2026-04-09", amount: 6000, lunchAmount: 2000 });
    expect(res.body).toMatchObject({ amount: 6000, lunchAmount: 2000 });
    expect((await A.agent.put("/api/actual-sales").send({ date: DAY, lunchAmount: -1 })).status).toBe(400);
  });
});
