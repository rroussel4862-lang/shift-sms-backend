// The AI is never really called: fetch is faked and answers with token counts, so these tests cost nothing.
process.env.ANTHROPIC_API_KEY = "test-key-not-real";
process.env.AI_PRICE_INPUT = "3";
process.env.AI_PRICE_OUTPUT = "15";

const request = require("supertest");
const bcrypt = require("bcryptjs");
const { app, pool } = require("../server.js");
const { createRestaurant, uniqueEmail } = require("./helpers");

let A, B, admin;
const realFetch = global.fetch;

beforeAll(async () => {
  const factory = () => request.agent(app);
  A = await createRestaurant(factory, { restaurantName: "Cost A" });
  B = await createRestaurant(factory, { restaurantName: "Cost B" });
  const email = uniqueEmail("platform");
  await pool.query("INSERT INTO platform_admins (id, email, password_hash, created_at) VALUES ($1,$2,$3,$4)", ["pa" + Date.now(), email, await bcrypt.hash("adminpassword123", 4), Date.now()]);
  admin = request.agent(app);
  if ((await admin.post("/api/platform-auth/login").send({ email, password: "adminpassword123" })).status !== 200) throw new Error("platform login failed");
});
beforeEach(() => {
  global.fetch = jest.fn(async (url, opts) => {
    if (!String(url).includes("api.anthropic.com")) return realFetch(url, opts);
    return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: JSON.stringify({ title: "T", body: "B" }) }], usage: { input_tokens: 1000000, output_tokens: 100000 } }) };
  });
});
afterEach(() => { global.fetch = realFetch; });
afterAll(async () => { await pool.end(); });

const waitFor = async (fn) => { for (let i = 0; i < 30; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } return null; };

describe("AI cost tracking per restaurant", () => {
  test("each AI call is logged against its restaurant with an estimated cost", async () => {
    expect((await A.agent.post("/api/ai/board-draft").send({ idea: "meeting friday", lang: "en" })).status).toBe(200);
    expect((await A.agent.post("/api/ai/board-draft").send({ idea: "another one", lang: "en" })).status).toBe(200);
    expect((await B.agent.post("/api/ai/board-draft").send({ idea: "hello", lang: "en" })).status).toBe(200);

    const row = await waitFor(async () => {
      const r = (await admin.get("/api/platform/ai-usage?days=1")).body.restaurants.find((x) => x.id === A.restaurantId);
      return r && r.calls === 2 ? r : null;
    });
    expect(row).toBeTruthy();
    expect(row.inputTokens).toBe(2000000);
    expect(row.outputTokens).toBe(200000);
    expect(row.costUsd).toBeCloseTo(2 * (3 + 1.5), 4); // $3 per million in, $15 per million out
    expect(row.byFeature[0].feature).toBe("board-draft");

    const b = (await admin.get("/api/platform/ai-usage?days=1")).body.restaurants.find((x) => x.id === B.restaurantId);
    expect(b.calls).toBe(1); // one restaurant's usage never lands on another
  });

  test("only platform admins can see it", async () => {
    expect((await request(app).get("/api/platform/ai-usage")).status).toBe(401);
    expect((await A.agent.get("/api/platform/ai-usage")).status).toBe(401);
  });
});
