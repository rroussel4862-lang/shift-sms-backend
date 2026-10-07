const request = require("supertest");
const { app, pool } = require("../server.js");
const { createRestaurant } = require("./helpers");

let A, B, itemId;

beforeAll(async () => {
  const factory = () => request.agent(app);
  A = await createRestaurant(factory);
  B = await createRestaurant(factory);
  const res = await A.agent.post("/api/training").send({ kind: "manual", title: "Handbook" });
  itemId = res.body.id;
});

afterAll(async () => {
  await pool.end();
});

const upload = (agent, id, name, body) =>
  agent.put(`/api/training/${id}/file?name=${encodeURIComponent(name)}`).set("Content-Type", "application/octet-stream").send(body);

describe("training file attachments", () => {
  test("new items have no file", async () => {
    const res = await A.agent.get("/api/training");
    expect(res.body.find((i) => i.id === itemId).file).toBeNull();
  });

  test("upload, list and download round-trip", async () => {
    const data = Buffer.from("%PDF-1.4 hello handbook");
    const up = await upload(A.agent, itemId, "Handbook é.pdf", data);
    expect(up.status).toBe(200);
    expect(up.body.size).toBe(data.length);

    const list = await A.agent.get("/api/training");
    const item = list.body.find((i) => i.id === itemId);
    expect(item.file).toEqual({ name: "Handbook é.pdf", type: "application/pdf", size: data.length });

    const dl = await A.agent.get(`/api/training/${itemId}/file`).buffer(true).parse((r, cb) => {
      const chunks = []; r.on("data", (c) => chunks.push(c)); r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(dl.status).toBe(200);
    expect(dl.headers["content-type"]).toContain("application/pdf");
    expect(dl.headers["content-disposition"]).toContain("attachment");
    expect(dl.body.equals(data)).toBe(true);
  });

  test("disallowed file types are rejected", async () => {
    const res = await upload(A.agent, itemId, "evil.html", Buffer.from("<script>1</script>"));
    expect(res.status).toBe(400);
    const res2 = await upload(A.agent, itemId, "noextension", Buffer.from("x"));
    expect(res2.status).toBe(400);
  });

  test("empty uploads are rejected", async () => {
    const res = await upload(A.agent, itemId, "empty.pdf", Buffer.alloc(0));
    expect(res.status).toBe(400);
  });

  test("another restaurant cannot upload to, download from or remove a file", async () => {
    expect((await upload(B.agent, itemId, "x.pdf", Buffer.from("x"))).status).toBe(404);
    expect((await B.agent.get(`/api/training/${itemId}/file`)).status).toBe(404);
    expect((await B.agent.delete(`/api/training/${itemId}/file`)).status).toBe(404);
    const list = await A.agent.get("/api/training");
    expect(list.body.find((i) => i.id === itemId).file).not.toBeNull();
  });

  test("login is required", async () => {
    expect((await request(app).get(`/api/training/${itemId}/file`)).status).toBe(401);
  });

  test("removing the file clears it", async () => {
    expect((await A.agent.delete(`/api/training/${itemId}/file`)).status).toBe(200);
    const list = await A.agent.get("/api/training");
    expect(list.body.find((i) => i.id === itemId).file).toBeNull();
    expect((await A.agent.get(`/api/training/${itemId}/file`)).status).toBe(404);
  });
});
