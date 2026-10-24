const request = require("supertest");
const bcrypt = require("bcryptjs");
const { app, pool } = require("../server.js");
const { createRestaurant, uniquePhone, uniqueEmail } = require("./helpers");

let A, B, ann, agentAnn;
beforeAll(async () => {
  const factory = () => request.agent(app);
  A = await createRestaurant(factory);
  B = await createRestaurant(factory);
  ann = (await A.agent.post("/api/staff").send({ name: "Ann Link", phone: uniquePhone(), roles: ["Server"] })).body.id;
  const email = uniqueEmail("link");
  await pool.query("UPDATE staff SET email = $1, password_hash = $2 WHERE id = $3", [email, await bcrypt.hash("staffpassword123", 4), ann]);
  agentAnn = request.agent(app);
  await agentAnn.post("/api/staff-auth/login").send({ email, password: "staffpassword123" });
});
afterAll(async () => { await pool.end(); });

describe("training links", () => {
  test("a link can be added when creating an item and staff see it", async () => {
    const res = await A.agent.post("/api/training").send({ kind: "course", title: "Wine basics", minutes: 15, url: "https://www.youtube.com/watch?v=abc123" });
    expect(res.status).toBe(201);
    expect(res.body.link).toBe("https://www.youtube.com/watch?v=abc123");
    const mine = await agentAnn.get("/api/staff-auth/training");
    const it = mine.body.items.find((i) => i.id === res.body.id);
    expect(it.link).toBe("https://www.youtube.com/watch?v=abc123");
    expect(it.file).toBeNull();
  });

  test("a bare domain gets https, and anything but http(s) is refused", async () => {
    const ok = await A.agent.post("/api/training").send({ kind: "manual", title: "Menu", url: "example.com/menu" });
    expect(ok.status).toBe(201);
    expect(ok.body.link).toBe("https://example.com/menu");
    for (const bad of ["javascript:alert(1)", "data:text/html,hi", "ftp://x.com/a", "https://localhost", "http://" + "a".repeat(600) + ".com"]) {
      const r = await A.agent.post("/api/training").send({ kind: "manual", title: "Bad", url: bad });
      expect(r.status).toBe(400);
    }
  });

  test("an existing item can get, change and lose its link", async () => {
    const id = (await A.agent.post("/api/training").send({ kind: "manual", title: "Handbook" })).body.id;
    expect((await A.agent.put(`/api/training/${id}/link`).send({ url: "https://example.com/a" })).body.link).toBe("https://example.com/a");
    expect((await A.agent.put(`/api/training/${id}/link`).send({ url: "https://example.com/b" })).body.link).toBe("https://example.com/b");
    expect((await A.agent.put(`/api/training/${id}/link`).send({ url: "" })).body.link).toBeNull();
    expect((await A.agent.put(`/api/training/${id}/link`).send({ url: "javascript:alert(1)" })).status).toBe(400);
    const list = (await A.agent.get("/api/training")).body.find((i) => i.id === id);
    expect(list.link).toBeNull();
  });

  test("another restaurant cannot change the link", async () => {
    const id = (await A.agent.post("/api/training").send({ kind: "manual", title: "Mine", url: "https://example.com/mine" })).body.id;
    expect((await B.agent.put(`/api/training/${id}/link`).send({ url: "https://evil.example.com" })).status).toBe(404);
    expect((await A.agent.get("/api/training")).body.find((i) => i.id === id).link).toBe("https://example.com/mine");
  });
});
