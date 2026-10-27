const request = require("supertest");
const { app, pool } = require("../server.js");
const { createRestaurant } = require("./helpers");

let A;
beforeAll(async () => { A = await createRestaurant(() => request.agent(app), { restaurantName: "New Design Place" }); });
afterAll(async () => { await pool.end(); });

describe("the Open Shift Rail look", () => {
  test("is the only look: sign-in info always says so, and there is no switch to turn it off", async () => {
    expect((await A.agent.get("/api/auth/me")).body.newDesign).toBe(true);
    const res = await request(app).patch(`/api/platform/restaurants/${A.restaurantId}/design`).send({ newDesign: false });
    expect(res.status).toBe(404);
  });
});
