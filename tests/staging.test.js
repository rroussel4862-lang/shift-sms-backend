const request = require("supertest");
const { app, pool, sendSms } = require("../server.js");

afterAll(async () => { await pool.end(); });

describe("staging copy safeguards", () => {
  const OLD = { STAGING: process.env.STAGING };
  afterEach(() => { if (OLD.STAGING === undefined) delete process.env.STAGING; else process.env.STAGING = OLD.STAGING; });

  test("the health check says whether this is the staging copy", async () => {
    delete process.env.STAGING;
    expect((await request(app).get("/api/health")).body.staging).toBe(false);
    process.env.STAGING = "true";
    expect((await request(app).get("/api/health")).body.staging).toBe(true);
  });

  test("the staging banner script is served", async () => {
    const res = await request(app).get("/staging-banner.js");
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/STAGING/);
  });

  test("with SMS_DISABLED set, no text is sent and the caller is told it was skipped", async () => {
    process.env.SMS_DISABLED = "true";
    try {
      const r = await sendSms("+15145550123", "hello", null);
      expect(r).toEqual({ to: "+15145550123", ok: true, skipped: true });
    } finally { delete process.env.SMS_DISABLED; }
  });
});
