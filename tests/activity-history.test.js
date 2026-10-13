const request = require("supertest");
const bcrypt = require("bcryptjs");
const { app, pool, archiveOldActivity } = require("../server.js");
const { createRestaurant, uniqueEmail } = require("./helpers");

let admin, R;
const DAY = 24 * 60 * 60 * 1000;
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });

async function log(restaurantId, eventType, level, detail, ageMs, durationMs = null) {
  await pool.query(
    "INSERT INTO activity_log (id, restaurant_id, event_type, level, detail, duration_ms, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    ["t" + Math.random().toString(16).slice(2, 12), restaurantId, eventType, level, detail, durationMs, Date.now() - ageMs]
  );
}

beforeAll(async () => {
  R = await createRestaurant(() => request.agent(app), { restaurantName: "History Test" });
  const email = uniqueEmail("platform");
  await pool.query("INSERT INTO platform_admins (id, email, password_hash, created_at) VALUES ($1,$2,$3,$4)", ["pa" + Date.now(), email, await bcrypt.hash("adminpassword123", 4), Date.now()]);
  admin = request.agent(app);
  const login = await admin.post("/api/platform-auth/login").send({ email, password: "adminpassword123" });
  if (login.status !== 200) throw new Error("platform login failed");
});

afterAll(async () => { await pool.end(); });

describe("activity history, export and archive", () => {
  test("requires platform login", async () => {
    expect((await request(app).get("/api/platform/history")).status).toBe(401);
    expect((await request(app).get("/api/platform/activity/export")).status).toBe(401);
  });

  test("daily history counts today's SMS/AI events for one restaurant", async () => {
    await log(R.restaurantId, "sms_sent", "info", "a", 1000, 120);
    await log(R.restaurantId, "sms_sent", "info", "b", 1000, 80);
    await log(R.restaurantId, "sms_failed", "error", "c", 1000);
    await log(R.restaurantId, "ai_answered", "info", "d", 1000, 900);
    const res = await admin.get(`/api/platform/history?days=7&restaurantId=${R.restaurantId}`);
    expect(res.status).toBe(200);
    expect(res.body.days).toHaveLength(7);
    const row = res.body.days.find((d) => d.day === today()) || res.body.days[1];
    const tot = res.body.days.reduce((a, d) => ({ s: a.s + d.smsSent, f: a.f + d.smsFailed, ai: a.ai + d.aiAnswered, e: a.e + d.errors }), { s: 0, f: 0, ai: 0, e: 0 });
    expect(tot).toEqual({ s: 2, f: 1, ai: 1, e: 1 });
    expect(row).toBeDefined();
  });

  test("old rows are rolled up into daily totals and deleted, history still counts them", async () => {
    await log(R.restaurantId, "sms_sent", "info", "old1", 120 * DAY, 100);
    await log(R.restaurantId, "sms_failed", "error", "old2", 120 * DAY);
    const deleted = await archiveOldActivity(90);
    expect(deleted).toBeGreaterThanOrEqual(2);
    const left = await pool.query("SELECT COUNT(*)::int AS n FROM activity_log WHERE restaurant_id = $1 AND detail LIKE 'old%'", [R.restaurantId]);
    expect(left.rows[0].n).toBe(0);
    const res = await admin.get(`/api/platform/history?days=365&restaurantId=${R.restaurantId}`);
    const tot = res.body.days.reduce((a, d) => ({ s: a.s + d.smsSent, f: a.f + d.smsFailed }), { s: 0, f: 0 });
    expect(tot).toEqual({ s: 3, f: 2 });
    // running it again must not double count
    await archiveOldActivity(90);
    const again = await admin.get(`/api/platform/history?days=365&restaurantId=${R.restaurantId}`);
    expect(again.body.days.reduce((a, d) => a + d.smsSent, 0)).toBe(3);
  });

  test("CSV exports download and neutralise spreadsheet formulas", async () => {
    await log(R.restaurantId, "note", "info", '=HYPERLINK("http://x")', 500);
    const res = await admin.get(`/api/platform/activity/export?restaurantId=${R.restaurantId}&from=${today()}&to=${today()}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(/attachment/);
    expect(res.text.split("\r\n")[0]).toBe("time_utc,time_local,restaurant,event_type,level,detail,duration_ms");
    expect(res.text).toContain("'=HYPERLINK");
    const hist = await admin.get(`/api/platform/history?days=7&format=csv`);
    expect(hist.status).toBe(200);
    expect(hist.text.split("\r\n")[0]).toBe("day,sms_sent,sms_failed,ai_answered,ai_failed,errors,total_events,sms_avg_ms,ai_avg_ms");
  });

  test("feed accepts a date range", async () => {
    const res = await admin.get(`/api/platform/activity?restaurantId=${R.restaurantId}&from=2000-01-01&to=2000-01-02`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
