const request = require("supertest");
const bcrypt = require("bcryptjs");
const { app, pool } = require("../server.js");
const { createRestaurant, uniquePhone, uniqueEmail } = require("./helpers");

let A, B, ann, bob, itemId, otherItem;
const raw = (r, cb) => { const c = []; r.on("data", (d) => c.push(d)); r.on("end", () => cb(null, Buffer.concat(c))); };

async function makeStaff(restaurant, name) {
  const created = await restaurant.agent.post("/api/staff").send({ name, phone: uniquePhone(), roles: ["Server"] });
  const email = uniqueEmail("multi");
  await pool.query("UPDATE staff SET email = $1, password_hash = $2 WHERE id = $3", [email, await bcrypt.hash("staffpassword123", 4), created.body.id]);
  const agent = request.agent(app);
  const login = await agent.post("/api/staff-auth/login").send({ email, password: "staffpassword123" });
  if (login.status !== 200) throw new Error("staff login failed");
  return { id: created.body.id, agent };
}
const add = (agent, id, name, body) =>
  agent.post(`/api/training/${id}/files?name=${encodeURIComponent(name)}`).set("Content-Type", "application/octet-stream").send(body);

beforeAll(async () => {
  const factory = () => request.agent(app);
  A = await createRestaurant(factory);
  B = await createRestaurant(factory);
  ann = await makeStaff(A, "Ann Multi");
  bob = await makeStaff(A, "Bob Multi");
  itemId = (await A.agent.post("/api/training").send({ kind: "course", title: "Opening procedures", minutes: 30, staffIds: [ann.id] })).body.id;
  otherItem = (await B.agent.post("/api/training").send({ kind: "manual", title: "B manual" })).body.id;
});
afterAll(async () => { await pool.end(); });

describe("several files on one course or manual", () => {
  const PDF = Buffer.from("%PDF-1.4 first");
  const DOC = Buffer.from("PK second docx");
  const PNG = Buffer.from("third image bytes");
  let ids = [];

  test("files can be added one after another and are listed in order", async () => {
    for (const [n, b] of [["Checklist.pdf", PDF], ["Menu changes.docx", DOC], ["Floor plan.png", PNG]]) {
      const r = await add(A.agent, itemId, n, b);
      expect(r.status).toBe(201);
      expect(r.body.name).toBe(n);
      ids.push(r.body.id);
    }
    const item = (await A.agent.get("/api/training")).body.find((i) => i.id === itemId);
    expect(item.files.map((f) => f.name)).toEqual(["Checklist.pdf", "Menu changes.docx", "Floor plan.png"]);
    expect(item.files.map((f) => f.id)).toEqual(ids);
    expect(item.file).toEqual({ name: "Checklist.pdf", type: "application/pdf", size: PDF.length }); // older screens still see the first file
  });

  test("each file downloads on its own", async () => {
    const res = await A.agent.get(`/api/training/${itemId}/files/${ids[1]}`).buffer(true).parse(raw);
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.body.equals(DOC)).toBe(true);
  });

  test("a disallowed type or an empty file is refused", async () => {
    expect((await add(A.agent, itemId, "virus.exe", Buffer.from("x"))).status).toBe(400);
    expect((await add(A.agent, itemId, "empty.pdf", Buffer.alloc(0))).status).toBe(400);
  });

  test("another restaurant cannot add, read or remove files", async () => {
    expect((await add(B.agent, itemId, "x.pdf", PDF)).status).toBe(404);
    expect((await B.agent.get(`/api/training/${itemId}/files/${ids[0]}`)).status).toBe(404);
    expect((await B.agent.delete(`/api/training/${itemId}/files/${ids[0]}`)).status).toBe(404);
    // a file id from one item can't be fetched through another item of the same restaurant
    expect((await B.agent.get(`/api/training/${otherItem}/files/${ids[0]}`)).status).toBe(404);
    expect((await request(app).get(`/api/training/${itemId}/files/${ids[0]}`)).status).toBe(401);
  });

  test("staff assigned to the item see every file and can open each; others cannot", async () => {
    const list = await ann.agent.get("/api/staff-auth/training");
    const it = list.body.items.find((i) => i.id === itemId);
    expect(it.files.map((f) => f.name)).toEqual(["Checklist.pdf", "Menu changes.docx", "Floor plan.png"]);
    expect(it.files.map((f) => f.viewable)).toEqual([true, false, true]);
    const dl = await ann.agent.get(`/api/staff-auth/training/${itemId}/files/${ids[2]}`).buffer(true).parse(raw);
    expect(dl.status).toBe(200);
    expect(dl.body.equals(PNG)).toBe(true);
    const inline = await ann.agent.get(`/api/staff-auth/training/${itemId}/files/${ids[0]}?view=1`).buffer(true).parse(raw);
    expect(inline.headers["content-disposition"]).toMatch(/^inline/);
    expect(inline.headers["content-security-policy"]).toBe("sandbox");
    const word = await ann.agent.get(`/api/staff-auth/training/${itemId}/files/${ids[1]}?view=1`).buffer(true).parse(raw);
    expect(word.headers["content-disposition"]).toMatch(/^attachment/);
    expect((await bob.agent.get(`/api/staff-auth/training/${itemId}/files/${ids[0]}`)).status).toBe(404); // not assigned to Bob
  });

  test("removing one file leaves the others", async () => {
    expect((await A.agent.delete(`/api/training/${itemId}/files/${ids[0]}`)).status).toBe(200);
    const item = (await A.agent.get("/api/training")).body.find((i) => i.id === itemId);
    expect(item.files.map((f) => f.name)).toEqual(["Menu changes.docx", "Floor plan.png"]);
    expect(item.file.name).toBe("Menu changes.docx");
    expect((await A.agent.get(`/api/training/${itemId}/files/${ids[0]}`)).status).toBe(404);
  });

  test("the older single-file routes still work: upload replaces all, delete clears all", async () => {
    const up = await A.agent.put(`/api/training/${itemId}/file?name=Only.pdf`).set("Content-Type", "application/octet-stream").send(PDF);
    expect(up.status).toBe(200);
    let item = (await A.agent.get("/api/training")).body.find((i) => i.id === itemId);
    expect(item.files.map((f) => f.name)).toEqual(["Only.pdf"]);
    expect((await A.agent.delete(`/api/training/${itemId}/file`)).status).toBe(200);
    item = (await A.agent.get("/api/training")).body.find((i) => i.id === itemId);
    expect(item.files).toEqual([]);
    expect(item.file).toBeNull();
  });

  test("an item holds at most 15 files", async () => {
    const id2 = (await A.agent.post("/api/training").send({ kind: "manual", title: "Many" })).body.id;
    for (let i = 0; i < 15; i++) expect((await add(A.agent, id2, `f${i}.txt`, Buffer.from("x" + i))).status).toBe(201);
    const over = await add(A.agent, id2, "one-too-many.txt", Buffer.from("x"));
    expect(over.status).toBe(400);
    expect(over.body.error).toMatch(/15/);
  });

  test("deleting the item removes its files", async () => {
    const id3 = (await A.agent.post("/api/training").send({ kind: "manual", title: "Temp" })).body.id;
    await add(A.agent, id3, "t.txt", Buffer.from("t"));
    await A.agent.delete(`/api/training/${id3}`);
    const { rows } = await pool.query("SELECT 1 FROM training_files WHERE item_id = $1", [id3]);
    expect(rows.length).toBe(0);
  });
});
