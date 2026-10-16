const request = require("supertest");
const jwt = require("jsonwebtoken");
const twilio = require("twilio");
const { app, pool } = require("../server.js");
const { createRestaurant, uniquePhone, uniqueEmail } = require("./helpers");

let A;
const savedEnv = {};
const setEnv = (k, v) => { if (!(k in savedEnv)) savedEnv[k] = process.env[k]; process.env[k] = v; };
const waitFor = async (fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } return null; };

beforeAll(async () => { A = await createRestaurant(() => request.agent(app)); });
afterAll(async () => {
  for (const k of Object.keys(savedEnv)) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  await pool.end();
});

describe("response headers", () => {
  test("every response carries the security headers and doesn't advertise Express", async () => {
    const res = await request(app).get("/api/health");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["content-security-policy"]).toMatch(/frame-ancestors 'none'/);
    expect(res.headers["referrer-policy"]).toBeTruthy();
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  test("static pages get them too, and HTTPS traffic gets HSTS", async () => {
    const res = await request(app).get("/").set("X-Forwarded-Proto", "https");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["strict-transport-security"]).toMatch(/max-age=/);
  });
});

describe("other websites can't use the API", () => {
  test("a request from a foreign origin is not granted cross-origin access", async () => {
    const res = await request(app).get("/api/health").set("Origin", "https://evil.example");
    expect(res.headers["access-control-allow-origin"]).not.toBe("https://evil.example");
    expect(res.headers["access-control-allow-origin"]).not.toBe("*");
  });
});

describe("inbound text webhook only accepts Twilio", () => {
  const url = "https://example.test/api/sms/inbound";
  const send = (sig) => {
    const r = request(app).post("/api/sms/inbound").set("Host", "example.test").set("X-Forwarded-Proto", "https").type("form");
    return (sig ? r.set("X-Twilio-Signature", sig) : r).send({ From: uniquePhone(), To: "+15550000000", Body: "hello" });
  };

  test("no signature or a wrong one is refused (and logged); the right one is accepted", async () => {
    setEnv("TWILIO_VALIDATE_SIGNATURE", "true");
    const noSig = await send(null);
    expect(noSig.status).toBe(403);
    expect((await send("not-a-real-signature")).status).toBe(403);
    const row = await waitFor(async () => (await pool.query("SELECT 1 FROM activity_log WHERE event_type = 'sms_inbound_rejected' AND created_at > $1", [Date.now() - 60000])).rows[0]);
    expect(row).toBeTruthy();

    const from = uniquePhone();
    const params = { From: from, To: "+15550000000", Body: "hello" };
    const good = twilio.getExpectedTwilioSignature(process.env.TWILIO_AUTH_TOKEN, url, params);
    const ok = await request(app).post("/api/sms/inbound").set("Host", "example.test").set("X-Forwarded-Proto", "https").set("X-Twilio-Signature", good).type("form").send(params);
    expect(ok.status).toBe(200);
  });

  test("the emergency off switch lets requests through", async () => {
    setEnv("TWILIO_VALIDATE_SIGNATURE", "false");
    expect((await send(null)).status).toBe(200);
  });
});

describe("login guessing is slowed per account, not just per address", () => {
  test("many failed logins for ONE account, even from different addresses, end in 429; other accounts are unaffected", async () => {
    const email = uniqueEmail("victim");
    let last;
    for (let i = 0; i < 16; i++) {
      last = await request(app).post("/api/auth/login").set("X-Forwarded-For", `10.20.30.${i + 1}`).send({ email, password: "wrong-password-" + i });
      if (i < 15) expect(last.status).toBe(401);
    }
    expect(last.status).toBe(429);
    expect(last.body.error).toMatch(/too many login attempts/i);
    const other = await request(app).post("/api/auth/login").set("X-Forwarded-For", "10.20.30.99").send({ email: uniqueEmail("other"), password: "nope-nope-nope" });
    expect(other.status).toBe(401);
  });
});

describe("sessions", () => {
  test("a login token signed with a different algorithm is rejected", async () => {
    const forged = jwt.sign({ userId: "x", restaurantId: A.restaurantId }, process.env.JWT_SECRET, { algorithm: "HS512" });
    const res = await request(app).get("/api/auth/me").set("Cookie", `token=${forged}`);
    expect(res.status).toBe(401);
  });
});

describe("daily text limit per restaurant", () => {
  test("texts beyond the cap are blocked and logged", async () => {
    const R = await createRestaurant(() => request.agent(app));
    const previousCap = process.env.SMS_DAILY_CAP;
    process.env.SMS_DAILY_CAP = "2";
    try {
    const ids = [];
    for (const n of ["One", "Two", "Three"]) ids.push((await R.agent.post("/api/staff").send({ name: n + " Test", phone: uniquePhone(), roles: ["Server"] })).body.id);
    const sent = async () => (await pool.query("SELECT COUNT(*)::int AS n FROM activity_log WHERE restaurant_id = $1 AND event_type = 'sms_sent'", [R.restaurantId])).rows[0].n;
    expect((await R.agent.post(`/api/staff/${ids[0]}/send-login-setup`)).status).toBe(200);
    await waitFor(async () => (await sent()) >= 1);
    expect((await R.agent.post(`/api/staff/${ids[1]}/send-login-setup`)).status).toBe(200);
    await waitFor(async () => (await sent()) >= 2);
    const third = await R.agent.post(`/api/staff/${ids[2]}/send-login-setup`);
    expect(third.status).toBe(502);
    expect(third.body.error).toMatch(/daily text limit/i);
    const blocked = await waitFor(async () => (await pool.query("SELECT 1 FROM activity_log WHERE restaurant_id = $1 AND event_type = 'sms_blocked'", [R.restaurantId])).rows[0]);
    expect(blocked).toBeTruthy();
    } finally {
      if (previousCap === undefined) delete process.env.SMS_DAILY_CAP; else process.env.SMS_DAILY_CAP = previousCap;
    }
  });
});

describe("staff setup links expire", () => {
  test("a link older than 14 days stops working; a fresh one and an undated old one still work", async () => {
    const created = await A.agent.post("/api/staff").send({ name: "Link Test", phone: uniquePhone(), roles: ["Server"] });
    const sid = created.body.id;
    expect((await A.agent.post(`/api/staff/${sid}/send-login-setup`)).status).toBe(200);
    const { rows } = await pool.query("SELECT claim_token FROM staff WHERE id = $1", [sid]);
    const token = rows[0].claim_token;
    expect((await request(app).get(`/api/staff-auth/claim/${token}`)).status).toBe(200);

    await pool.query("UPDATE staff SET claim_token_at = $1 WHERE id = $2", [Date.now() - 15 * 24 * 60 * 60 * 1000, sid]);
    expect((await request(app).get(`/api/staff-auth/claim/${token}`)).status).toBe(404);
    const claim = await request(app).post("/api/staff-auth/claim").send({ token, email: uniqueEmail("late"), password: "longenoughpassword" });
    expect(claim.status).toBe(404);

    await pool.query("UPDATE staff SET claim_token_at = NULL WHERE id = $1", [sid]);
    expect((await request(app).get(`/api/staff-auth/claim/${token}`)).status).toBe(200);
  });
});

describe("platform sign-in attempts are recorded", () => {
  test("a failed platform login leaves a warning in the activity log", async () => {
    const email = uniqueEmail("nobody");
    const res = await request(app).post("/api/platform-auth/login").send({ email, password: "wrongwrongwrong" });
    expect(res.status).toBe(401);
    const row = await waitFor(async () => (await pool.query("SELECT level FROM activity_log WHERE event_type = 'platform_login_failed' AND detail LIKE $1", [`%${email}%`])).rows[0]);
    expect(row && row.level).toBe("warn");
  });
});
