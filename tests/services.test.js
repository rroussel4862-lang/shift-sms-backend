const request = require("supertest");
const { app, pool, initDb } = require("../server.js");
const { createRestaurant } = require("./helpers");

let A, B;
const DAY = "2026-05-04"; // a Monday

beforeAll(async () => {
  const factory = () => request.agent(app);
  A = await createRestaurant(factory);
  B = await createRestaurant(factory);
});
afterAll(async () => { await pool.end(); });

describe("per-restaurant services", () => {
  test("a new restaurant starts with Lunch / Brunch and Dinner", async () => {
    const res = await A.agent.get("/api/services");
    expect(res.status).toBe(200);
    expect(res.body.services.map((s) => s.id)).toEqual(["lunch", "dinner"]);
  });

  test("requires login", async () => {
    expect((await request(app).get("/api/services")).status).toBe(401);
    expect((await request(app).put("/api/services").send({ services: [] })).status).toBe(401);
  });

  test("validates the list", async () => {
    const put = (services) => A.agent.put("/api/services").send({ services });
    expect((await put([])).status).toBe(400);
    expect((await put("nope")).status).toBe(400);
    expect((await put([{ name: "", from: "10:00" }])).status).toBe(400);
    expect((await put([{ name: "Brunch", from: "25:00" }])).status).toBe(400);
    expect((await put([{ name: "A", from: "10:00" }, { name: "B", from: "10:00" }])).status).toBe(400);
    expect((await put([1, 2, 3, 4, 5].map((n) => ({ name: "S" + n, from: `0${n}:00` })))).status).toBe(400);
  });

  test("saves a custom set, sorted by start time, and only for that restaurant", async () => {
    const res = await A.agent.put("/api/services").send({ services: [
      { id: "dinner", name: "Dinner", from: "16:00" },
      { id: "breakfast", name: "Breakfast", from: "05:00" },
      { id: "lunch", name: "Lunch", from: "11:00" },
    ] });
    expect(res.status).toBe(200);
    expect(res.body.services.map((s) => s.id)).toEqual(["breakfast", "lunch", "dinner"]);
    expect((await A.agent.get("/api/services")).body.services).toHaveLength(3);
    expect((await B.agent.get("/api/services")).body.services.map((s) => s.id)).toEqual(["lunch", "dinner"]);
  });

  test("forecast and actual sales are stored per service and add up to the day", async () => {
    let res = await A.agent.put("/api/sales-projections").send({ date: DAY, serviceAmounts: { breakfast: 800, lunch: 2000 } });
    expect(res.body).toMatchObject({ serviceAmounts: { breakfast: 800, lunch: 2000 }, projectedAmount: 2800 });
    res = await A.agent.put("/api/sales-projections").send({ date: DAY, serviceAmounts: { dinner: "4000", breakfast: "" } });
    expect(res.body).toMatchObject({ serviceAmounts: { lunch: 2000, dinner: 4000 }, projectedAmount: 6000 });

    res = await A.agent.put("/api/actual-sales").send({ date: DAY, serviceAmounts: { breakfast: 700, lunch: 1800, dinner: 3500 } });
    expect(res.body).toMatchObject({ serviceAmounts: { breakfast: 700, lunch: 1800, dinner: 3500 }, amount: 6000 });
    const list = await A.agent.get(`/api/actual-sales?start=${DAY}&end=${DAY}`);
    expect(list.body[0].serviceAmounts).toEqual({ breakfast: 700, lunch: 1800, dinner: 3500 });
  });

  test("unknown services and bad amounts are rejected", async () => {
    expect((await A.agent.put("/api/sales-projections").send({ date: DAY, serviceAmounts: { brunch: 100 } })).status).toBe(400);
    expect((await A.agent.put("/api/sales-projections").send({ date: DAY, serviceAmounts: { lunch: -1 } })).status).toBe(400);
    expect((await A.agent.put("/api/actual-sales").send({ date: DAY, serviceAmounts: { lunch: "x" } })).status).toBe(400);
    // the older lunchAmount key only works while a service called "lunch" exists
    await B.agent.put("/api/services").send({ services: [{ id: "dinner", name: "Dinner", from: "00:00" }] });
    expect((await B.agent.put("/api/sales-projections").send({ date: DAY, lunchAmount: 100 })).status).toBe(400);
    expect((await B.agent.put("/api/sales-projections").send({ date: DAY, dinnerAmount: 100 })).status).toBe(200);
  });

  test("older lunch/dinner columns are migrated into per-service amounts", async () => {
    await pool.query(
      "INSERT INTO sales_projections (id, restaurant_id, proj_date, projected_amount, lunch_amount, dinner_amount, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      ["legacy" + Date.now(), A.restaurantId, "2026-05-11", 3000, 1000, 2000, Date.now()]
    );
    await initDb();
    const list = await A.agent.get("/api/sales-projections?start=2026-05-11&end=2026-05-11");
    expect(list.body[0]).toMatchObject({ projectedAmount: 3000, serviceAmounts: { lunch: 1000, dinner: 2000 } });
  });
});
