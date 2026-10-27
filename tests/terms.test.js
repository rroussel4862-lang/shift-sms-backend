const request = require("supertest");
const { app, pool } = require("../server.js");

afterAll(async () => { await pool.end(); });

describe("terms of service page", () => {
  test("is public and offered in French and English", async () => {
    const res = await request(app).get("/terms.html");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Conditions d'utilisation");
    expect(res.text).toContain("Terms of Service");
  });

  test("privacy policy is public, in both languages, and names the privacy contact", async () => {
    const res = await request(app).get("/privacy.html");
    expect(res.status).toBe(200);
    expect(res.text).toContain("Politique de confidentialité");
    expect(res.text).toContain("Privacy Policy");
    expect(res.text).toContain("privacy@openshiftrail.com");
  });

  test("has no leftover drafting placeholders or pilot wording", async () => {
    for (const page of ["/terms.html", "/privacy.html"]) {
      const res = await request(app).get(page);
      expect(res.text).not.toMatch(/\[[^\]\n]{2,40}\]/);   // [square-bracket placeholders]
      expect(res.text).not.toMatch(/pilot|pilote/i);
    }
  });
});
