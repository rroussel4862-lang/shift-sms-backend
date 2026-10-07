const request = require("supertest");
const { app, pool } = require("../server.js");
const { createRestaurant } = require("./helpers");

let A, B;
const DAY = "2026-03-02";
const DAY2 = "2026-03-03";

beforeAll(async () => {
  const factory = () => request.agent(app);
  A = await createRestaurant(factory);
  B = await createRestaurant(factory);
});

afterAll(async () => {
  await pool.end();
});

const get = (agent, start = "2026-03-01", end = "2026-03-31") => agent.get(`/api/actual-sales?start=${start}&end=${end}`);

describe("food and beverage sales", () => {
  test("a day's total is food plus beverage", async () => {
    const res = await A.agent.put("/api/actual-sales").send({ date: DAY, foodAmount: "1200.50", bevAmount: "800" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ date: DAY, foodAmount: 1200.5, bevAmount: 800, amount: 2000.5 });

    const list = await get(A.agent);
    expect(list.body.find((r) => r.date === DAY)).toMatchObject({ foodAmount: 1200.5, bevAmount: 800, amount: 2000.5 });
  });

  test("updating only one half keeps the other and recomputes the total", async () => {
    const res = await A.agent.put("/api/actual-sales").send({ date: DAY, bevAmount: 900 });
    expect(res.body).toMatchObject({ foodAmount: 1200.5, bevAmount: 900, amount: 2100.5 });
  });

  test("empty values clear a half; clearing both leaves no total", async () => {
    const res = await A.agent.put("/api/actual-sales").send({ date: DAY, foodAmount: "" });
    expect(res.body).toMatchObject({ foodAmount: null, bevAmount: 900, amount: 900 });
    const res2 = await A.agent.put("/api/actual-sales").send({ date: DAY, foodAmount: "", bevAmount: "" });
    expect(res2.body).toMatchObject({ foodAmount: null, bevAmount: null, amount: null });
  });

  test("a POS-style total with no split clears the split", async () => {
    await A.agent.put("/api/actual-sales").send({ date: DAY2, foodAmount: 100, bevAmount: 50 });
    const res = await A.agent.put("/api/actual-sales").send({ date: DAY2, amount: 5000, source: "pos" });
    expect(res.body).toMatchObject({ amount: 5000, foodAmount: null, bevAmount: null, source: "pos" });
  });

  test("negative or non-numeric amounts are rejected", async () => {
    for (const body of [{ foodAmount: -5 }, { bevAmount: "abc" }, { amount: -1 }]) {
      const res = await A.agent.put("/api/actual-sales").send({ date: DAY, ...body });
      expect(res.status).toBe(400);
    }
  });

  test("a date is required", async () => {
    const res = await A.agent.put("/api/actual-sales").send({ foodAmount: 10 });
    expect(res.status).toBe(400);
  });

  test("restaurants never see each other's sales", async () => {
    await A.agent.put("/api/actual-sales").send({ date: DAY, foodAmount: 111, bevAmount: 222 });
    const res = await get(B.agent);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test("login is required", async () => {
    expect((await request(app).get("/api/actual-sales?start=2026-03-01&end=2026-03-31")).status).toBe(401);
    expect((await request(app).put("/api/actual-sales").send({ date: DAY, foodAmount: 1 })).status).toBe(401);
  });

  test("the old cost-percentage endpoint is gone and /api/restaurant no longer returns cost percentages", async () => {
    expect((await A.agent.put("/api/restaurant/costs").send({ foodCostPct: 30 })).status).toBe(404);
    const res = await A.agent.get("/api/restaurant");
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("foodCostPct");
    expect(res.body).not.toHaveProperty("bevCostPct");
  });
});
