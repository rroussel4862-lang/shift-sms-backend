const request = require("supertest");
const bcrypt = require("bcryptjs");
const { app, pool } = require("../server.js");
const { createRestaurant, uniqueEmail } = require("./helpers");

let admin, A;
const realFetch = global.fetch;

beforeAll(async () => {
  A = await createRestaurant(() => request.agent(app), { restaurantName: "POS Place" });
  const email = uniqueEmail("platform");
  await pool.query("INSERT INTO platform_admins (id, email, password_hash, created_at) VALUES ($1,$2,$3,$4)", ["pp" + Date.now(), email, await bcrypt.hash("adminpassword123", 4), Date.now()]);
  admin = request.agent(app);
  const login = await admin.post("/api/platform-auth/login").send({ email, password: "adminpassword123" });
  if (login.status !== 200) throw new Error("platform login failed");
});
afterAll(async () => { global.fetch = realFetch; delete process.env.POS_SECRET_KEY; await pool.end(); });

const url = (p) => `/api/platform/restaurants/${A.restaurantId}/pos${p || ""}`;
const body = { licenceNumber: "123456", email: "Veloce.User@example.com", password: "very-secret-pass" };

describe("POS connection", () => {
  test("refuses to save until the encryption key is set", async () => {
    delete process.env.POS_SECRET_KEY;
    const r = await admin.put(url()).send(body);
    expect(r.status).toBe(503);
  });

  test("saves the login encrypted and never returns the password", async () => {
    process.env.POS_SECRET_KEY = "ab".repeat(32);
    const r = await admin.put(url()).send(body);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ connected: true, licenceNumber: "123456", email: "veloce.user@example.com" });
    expect(JSON.stringify(r.body)).not.toContain("very-secret-pass");
    const { rows } = await pool.query("SELECT password_enc FROM pos_connections WHERE restaurant_id = $1", [A.restaurantId]);
    expect(rows[0].password_enc.startsWith("v1:")).toBe(true);
    expect(rows[0].password_enc).not.toContain("very-secret-pass");
    expect(JSON.stringify((await admin.get(url())).body)).not.toContain("v1:");
  });

  test("validates input, and restaurant managers cannot use these routes", async () => {
    expect((await admin.put(url()).send({ ...body, licenceNumber: "abc" })).status).toBe(400);
    expect((await admin.put(url()).send({ ...body, email: "nope" })).status).toBe(400);
    expect((await A.agent.get(url())).status).toBe(401);
    expect((await A.agent.put(url()).send(body)).status).toBe(401);
  });

  test("test connection logs in, finds the location by licence, then reads net sales", async () => {
    const calls = [];
    global.fetch = jest.fn(async (u, opts = {}) => {
      const s = String(u);
      if (!s.startsWith("https://api.posveloce.com/")) return realFetch(u, opts);
      calls.push({ url: s, method: opts.method, auth: opts.headers && opts.headers.Authorization });
      const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
      if (s.endsWith("/users/authenticate")) {
        expect(JSON.parse(opts.body)).toEqual({ email: "veloce.user@example.com", password: "very-secret-pass" });
        return json({ token: "jwt.fake.token" });
      }
      if (s.includes("/locations")) return json({ content: [{ id: "11111111-1111-1111-1111-111111111111", licenceNumber: 123456, name: "SHAY", reportingDisplayName: "Shay Resto" }] });
      if (s.includes("/sales/net")) return json({ sales: [{ netSales: 1000.5, grossSales: 1200, checks: 40, customers: 60 }, { netSales: 99.5, grossSales: 100, checks: 3, customers: 4 }], totals: { netSales: 1100, grossSales: 1300, checks: 43, customers: 64 } });
      return json({}, 404);
    });
    const t = await admin.post(url("/test"));
    expect(t.status).toBe(200);
    expect(t.body).toMatchObject({ status: "ok", locationName: "Shay Resto" });
    const p = await admin.post(url("/preview-sales")).send({ date: "2026-10-26" });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ date: "2026-10-26", netSales: 1100, checks: 43, customers: 64 });
    const sales = calls.find((c) => c.url.includes("/sales/net"));
    expect(sales.auth).toBe("Bearer jwt.fake.token");
    expect(sales.url).toContain("locationId=11111111-1111-1111-1111-111111111111");
    expect(calls.filter((c) => c.url.endsWith("/users/authenticate")).length).toBe(1); // token is reused, not re-requested
    // nothing was written into the app's own sales
    const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM actual_sales WHERE restaurant_id = $1", [A.restaurantId]);
    expect(rows[0].n).toBe(0);
  });

  test("a wrong password shows a clear, secret-free error", async () => {
    await admin.put(url()).send({ ...body, password: "another-wrong-pass" });
    global.fetch = jest.fn(async (u, opts = {}) => {
      if (!String(u).startsWith("https://api.posveloce.com/")) return realFetch(u, opts);
      return { ok: false, status: 401, json: async () => ({ message: "bad credentials" }) };
    });
    const t = await admin.post(url("/test"));
    expect(t.status).toBe(502);
    expect(t.body.error).toMatch(/refused the email or password \(HTTP 401\) — Veloce says: bad credentials/);
    expect(JSON.stringify(t.body)).not.toContain("another-wrong-pass");
    const st = (await admin.get(url())).body;
    expect(st.status).toBe("error");
  });
});
