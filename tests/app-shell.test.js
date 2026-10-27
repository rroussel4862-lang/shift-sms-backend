const fs = require("fs");
const path = require("path");
const request = require("supertest");
const { app, pool } = require("../server.js");

afterAll(async () => { await pool.end(); });

describe("one-page app shell (demo restaurant)", () => {
  test("only our own two pages can be framed, only with ?embed=1, and only by our own site", async () => {
    for (const p of ["/index.html?embed=1", "/backoffice.html?embed=1"]) {
      const res = await request(app).get(p);
      expect(res.status).toBe(200);
      expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
      expect(res.headers["content-security-policy"]).toMatch(/frame-ancestors 'self'/);
    }
  });

  test("everything else stays unframeable, with or without the flag", async () => {
    for (const p of ["/index.html", "/backoffice.html", "/", "/staff-portal.html?embed=1", "/owner.html?embed=1", "/app.html", "/api/health?embed=1"]) {
      const res = await request(app).get(p);
      expect(res.headers["x-frame-options"]).toBe("DENY");
      expect(res.headers["content-security-policy"]).toMatch(/frame-ancestors 'none'/);
    }
  });

  test("the shell page is served and carries the home-screen icon like every other page", async () => {
    const res = await request(app).get("/app.html");
    expect(res.status).toBe(200);
    const html = fs.readFileSync(path.join(__dirname, "..", "public", "app.html"), "utf8");
    expect(html).toContain('rel="apple-touch-icon" href="/icons/apple-touch-icon.png"');
    expect(html).toContain('id="fMi"');
    expect(html).toContain('id="fBo"');
  });

  test("the shell and its scripts are public static files", async () => {
    for (const f of ["/app-shell.js", "/theme-early.js", "/theme-clean.js", "/theme-clean.css", "/theme-warm.css"]) {
      const res = await request(app).get(f);
      expect(res.status).toBe(200);
    }
  });
});
