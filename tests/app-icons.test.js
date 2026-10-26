const fs = require("fs");
const path = require("path");
const request = require("supertest");
const { app, pool } = require("../server.js");

afterAll(async () => { await pool.end(); });

const PAGES = ["index", "backoffice", "owner", "platform-dashboard", "demo", "staff-portal", "staff-claim", "apply"];

describe("home-screen app icon", () => {
  test("every icon file is served as a PNG without logging in", async () => {
    for (const f of ["apple-touch-icon", "icon-192", "icon-512", "icon-maskable-512", "favicon-32"]) {
      const res = await request(app).get(`/icons/${f}.png`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/image\/png/);
    }
  });

  test("both manifests are valid and use the same icons and name", async () => {
    const staff = (await request(app).get("/manifest-staff.json")).body;
    const mgr = (await request(app).get("/manifest-manager.json")).body;
    expect(staff.name).toBe("Open Shift Rail");
    expect(mgr.name).toBe("Open Shift Rail");
    expect(staff.short_name).toBe("Open Shift");
    expect(mgr.short_name).toBe("Open Shift");
    expect(staff.icons).toEqual(mgr.icons);
    expect(staff.start_url).toBe("/staff-portal.html");
    expect(mgr.start_url).toBe("/");
  });

  test("every page points at the same icon, so nobody gets a restaurant-specific one", () => {
    for (const p of PAGES) {
      const html = fs.readFileSync(path.join(__dirname, "..", "public", p + ".html"), "utf8");
      expect(html).toContain('rel="apple-touch-icon" href="/icons/apple-touch-icon.png"');
    }
  });
});
