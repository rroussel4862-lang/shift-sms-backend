// The demo restaurant: made-up data for showing the app to prospects. These tests make sure it is complete, safe (no real
// texts, no AI web searches, no leaking into real restaurants) and that a re-seed leaves open demo sessions working.

const request = require("supertest");
const { app, pool, seedDemoNow, demoIds } = require("../server.js");
const { createRestaurant } = require("./helpers");

const realFetch = global.fetch;
let fetchedUrls = [];
let real;

beforeAll(async () => {
  global.fetch = jest.fn(async (url, opts) => { fetchedUrls.push(String(url)); throw new Error("no network in tests"); });
  real = await createRestaurant(() => request.agent(app));
  await seedDemoNow();
});
afterAll(async () => { global.fetch = realFetch; await pool.end(); });

const enter = async (role) => {
  const agent = request.agent(app);
  const res = await agent.post("/api/demo/enter").send({ role });
  return { agent, res };
};

describe("demo restaurant", () => {
  test("is flagged as a demo and fully populated", async () => {
    expect(demoIds.has("demo-restaurant")).toBe(true);
    const q = async (sql) => Number((await pool.query(sql)).rows[0].n);
    expect(await q("SELECT COUNT(*) AS n FROM restaurants WHERE id = 'demo-restaurant' AND is_demo")).toBe(1);
    expect(await q("SELECT COUNT(*) AS n FROM staff WHERE restaurant_id = 'demo-restaurant'")).toBeGreaterThanOrEqual(20);
    expect(await q("SELECT COUNT(*) AS n FROM schedule_shifts WHERE restaurant_id = 'demo-restaurant'")).toBeGreaterThan(300);
    expect(await q("SELECT COUNT(*) AS n FROM schedule_shifts WHERE restaurant_id = 'demo-restaurant' AND station IS NOT NULL")).toBeGreaterThan(20);
    expect(await q("SELECT COUNT(*) AS n FROM shift_swaps WHERE restaurant_id = 'demo-restaurant' AND status = 'pending'")).toBeGreaterThanOrEqual(1);
    expect(await q("SELECT COUNT(*) AS n FROM actual_sales WHERE restaurant_id = 'demo-restaurant'")).toBeGreaterThan(40);
    expect(await q("SELECT COUNT(*) AS n FROM board_posts WHERE restaurant_id = 'demo-restaurant'")).toBeGreaterThanOrEqual(3);
    expect(await q("SELECT COUNT(*) AS n FROM staff_time_off WHERE restaurant_id = 'demo-restaurant' AND status = 'pending'")).toBeGreaterThanOrEqual(1);
    // every demo address is made up
    expect(await q("SELECT COUNT(*) AS n FROM staff WHERE restaurant_id = 'demo-restaurant' AND (email NOT LIKE '%@demo.invalid' OR phone NOT LIKE '+1555%')")).toBe(0);
  });

  test("a visitor can open the manager view and sees the demo data only", async () => {
    const { agent, res } = await enter("manager");
    expect(res.status).toBe(200);
    expect(res.body.next).toBe("/index.html");
    const me = await agent.get("/api/auth/me");
    expect(me.body.demo).toBe(true);
    expect(me.body.restaurant.id).toBe("demo-restaurant");
    const staff = await agent.get("/api/staff");
    expect(staff.body.length).toBeGreaterThanOrEqual(20);
    expect(staff.body.every((p) => p.email === undefined || String(p.email).endsWith("@demo.invalid"))).toBe(true);
    const swaps = await agent.get("/api/swaps");
    expect(swaps.body.filter((w) => w.status === "pending").length).toBeGreaterThanOrEqual(1);
    // and the real restaurant never sees demo people
    expect((await real.agent.get("/api/staff")).body.length).toBe(0);
  });

  test("a visitor can open the staff view and sees a posted schedule", async () => {
    const { agent, res } = await enter("staff");
    expect(res.status).toBe(200);
    expect(res.body.next).toBe("/staff-portal.html");
    const me = await agent.get("/api/staff-auth/me");
    expect(me.body.demo).toBe(true);
    expect(me.body.name).toBe("Camille Tremblay");
    const news = await agent.get("/api/staff-auth/schedule-news");
    expect(news.body.weeks.length).toBeGreaterThanOrEqual(1);
    expect((await agent.get("/api/staff-auth/swaps")).status).toBe(200);
  });

  test("the daily snapshot shows seeded events and never asks the AI to search", async () => {
    const { agent } = await enter("manager");
    fetchedUrls = [];
    const snap = await agent.get("/api/day-snapshot");
    expect(snap.status).toBe(200);
    expect(snap.body.location).toBe("ok");
    expect(snap.body.eventsStatus).toBe("ok");
    expect(Array.isArray(snap.body.events)).toBe(true);
    expect(fetchedUrls.some((u) => u.includes("anthropic.com"))).toBe(false);
  });

  test("no real texts go out and nothing reaches the live activity feed", async () => {
    const { agent } = await enter("manager");
    const before = Number((await pool.query("SELECT COUNT(*) AS n FROM activity_log WHERE restaurant_id = 'demo-restaurant'")).rows[0].n);
    const monday = (await pool.query("SELECT to_char(date_trunc('week', now() AT TIME ZONE 'America/Toronto') + interval '14 days', 'YYYY-MM-DD') AS d")).rows[0].d;
    const pub = await agent.post("/api/schedule/publish").send({ weekStart: monday, house: "foh" });
    expect(pub.status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    const after = Number((await pool.query("SELECT COUNT(*) AS n FROM activity_log WHERE restaurant_id = 'demo-restaurant'")).rows[0].n);
    expect(after).toBe(before); // no sms_sent rows, nothing logged for the demo
  });

  test("re-seeding rebuilds the data but keeps open demo sessions working", async () => {
    const { agent } = await enter("manager");
    const before = (await agent.get("/api/staff")).body.length;
    await pool.query("DELETE FROM staff WHERE restaurant_id = 'demo-restaurant' AND id = 'demo-s22'");
    await seedDemoNow();
    const after = await agent.get("/api/staff"); // the same cookie still works
    expect(after.status).toBe(200);
    expect(after.body.length).toBe(before);
  });

  test("only a platform admin can rebuild the demo from the dashboard", async () => {
    expect((await request(app).post("/api/platform/demo/reset")).status).toBe(401);
    expect((await real.agent.post("/api/platform/demo/reset")).status).toBe(401);
  });
});
