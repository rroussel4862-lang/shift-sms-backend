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

const put = (agent, body) => agent.put("/api/actual-sales").send(body);
const day = async (date) => (await A.agent.get(`/api/actual-sales?start=${date}&end=${date}`)).body.find((r) => r.date === date);

describe("food / beverage rows per service (Sales tab)", () => {
  const D = "2026-06-05";

  test("each service's food + beverage becomes that service's amount, and the day's totals are the sums", async () => {
    let res = await put(A.agent, { date: D, serviceSplit: { lunch: { food: "500" } } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ serviceSplit: { lunch: { food: 500, bev: null } }, serviceAmounts: { lunch: 500 }, amount: 500, foodAmount: 500, bevAmount: null });
    res = await put(A.agent, { date: D, serviceSplit: { lunch: { bev: 120 }, dinner: { food: 3000, bev: 900 } } });
    expect(res.body).toMatchObject({
      serviceSplit: { lunch: { food: 500, bev: 120 }, dinner: { food: 3000, bev: 900 } },
      serviceAmounts: { lunch: 620, dinner: 3900 },
      foodAmount: 3500, bevAmount: 1020, amount: 4520,
    });
    expect(await day(D)).toMatchObject({ amount: 4520, serviceAmounts: { lunch: 620, dinner: 3900 } });
  });

  test("clearing cells removes the service, and the totals follow", async () => {
    await put(A.agent, { date: D, serviceSplit: { lunch: { food: "", bev: null } } });
    expect(await day(D)).toMatchObject({ serviceSplit: { dinner: { food: 3000, bev: 900 } }, serviceAmounts: { dinner: 3900 }, amount: 3900, foodAmount: 3000, bevAmount: 900 });
    expect((await day(D)).serviceAmounts).not.toHaveProperty("lunch");
  });

  test("a day entered the old way (whole-day food / beverage) shows under the LAST service", async () => {
    const OLD = "2026-06-06";
    await put(A.agent, { date: OLD, foodAmount: 1000, bevAmount: 400 });
    expect((await day(OLD)).serviceSplit).toEqual({ dinner: { food: 1000, bev: 400 } });
    // editing the brunch row keeps the old numbers under dinner and adds brunch
    const res = await put(A.agent, { date: OLD, serviceSplit: { lunch: { food: 250 } } });
    expect(res.body).toMatchObject({ serviceSplit: { lunch: { food: 250, bev: null }, dinner: { food: 1000, bev: 400 } }, amount: 1650, foodAmount: 1250, bevAmount: 400 });
  });

  test("writing a whole-day figure the old way replaces the per-service split", async () => {
    await put(A.agent, { date: D, foodAmount: 777, bevAmount: 111 });
    expect((await day(D)).serviceSplit).toEqual({ dinner: { food: 777, bev: 111 } });
  });

  test("bad input, unknown service, tenant isolation, auth", async () => {
    expect((await put(A.agent, { date: D, serviceSplit: { brunch: { food: 1 } } })).status).toBe(400);
    expect((await put(A.agent, { date: D, serviceSplit: { lunch: { food: -5 } } })).status).toBe(400);
    expect((await put(A.agent, { date: D, serviceSplit: { lunch: { bev: "abc" } } })).status).toBe(400);
    expect((await put(A.agent, { date: D, serviceSplit: [] })).status).toBe(400);
    expect((await request(app).put("/api/actual-sales").send({ date: D, serviceSplit: { lunch: { food: 1 } } })).status).toBe(401);
    await put(B.agent, { date: D, serviceSplit: { lunch: { food: 99 } } });
    expect((await day(D)).serviceSplit).not.toHaveProperty("lunch"); // B's number never shows up in A
  });
});
