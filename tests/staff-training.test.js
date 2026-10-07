const request = require("supertest");
const bcrypt = require("bcryptjs");
const { app, pool } = require("../server.js");
const { createRestaurant, uniquePhone, uniqueEmail } = require("./helpers");

let A, B, ann, bob, bea; // { id, agent }
let handbook, contract, notMine, otherRestaurantItem;
const PDF = Buffer.from("%PDF-1.4 handbook body");

async function makeStaff(restaurant, name) {
  const created = await restaurant.agent.post("/api/staff").send({ name, phone: uniquePhone(), roles: ["Server"] });
  const email = uniqueEmail("train");
  await pool.query("UPDATE staff SET email = $1, password_hash = $2 WHERE id = $3", [email, await bcrypt.hash("staffpassword123", 4), created.body.id]);
  const agent = request.agent(app);
  const login = await agent.post("/api/staff-auth/login").send({ email, password: "staffpassword123" });
  if (login.status !== 200) throw new Error("staff login failed");
  return { id: created.body.id, agent };
}

const raw = (r, cb) => { const c = []; r.on("data", (d) => c.push(d)); r.on("end", () => cb(null, Buffer.concat(c))); };

beforeAll(async () => {
  const factory = () => request.agent(app);
  A = await createRestaurant(factory);
  B = await createRestaurant(factory);
  ann = await makeStaff(A, "Ann Trainee");
  bob = await makeStaff(A, "Bob Trainee");
  bea = await makeStaff(B, "Bea Elsewhere");

  handbook = (await A.agent.post("/api/training").send({ kind: "manual", title: "Handbook" })).body.id; // everyone
  contract = (await A.agent.post("/api/training").send({ kind: "contract", title: "Contract", staffIds: [ann.id] })).body.id;
  notMine = (await A.agent.post("/api/training").send({ kind: "course", title: "Bob only", minutes: 20, staffIds: [bob.id] })).body.id;
  otherRestaurantItem = (await B.agent.post("/api/training").send({ kind: "manual", title: "B handbook" })).body.id;
  await A.agent.put(`/api/training/${handbook}/file?name=Handbook.pdf`).set("Content-Type", "application/octet-stream").send(PDF);
  await A.agent.put(`/api/training/${contract}/file?name=contract.docx`).set("Content-Type", "application/octet-stream").send(Buffer.from("PK docx"));
});

afterAll(async () => { await pool.end(); });

describe("staff training list", () => {
  test("shows only items assigned to me, with file info and a to-do count", async () => {
    const res = await ann.agent.get("/api/staff-auth/training");
    expect(res.status).toBe(200);
    expect(res.body.items.map((i) => i.title).sort()).toEqual(["Contract", "Handbook"]);
    const h = res.body.items.find((i) => i.id === handbook);
    expect(h.file).toEqual({ name: "Handbook.pdf", type: "application/pdf", size: PDF.length, viewable: true });
    expect(res.body.items.find((i) => i.id === contract).file.viewable).toBe(false);
    expect(res.body.todoCount).toBe(2);
    expect(JSON.stringify(res.body)).not.toContain("Bob only");
  });

  test("requires a staff login", async () => {
    expect((await request(app).get("/api/staff-auth/training")).status).toBe(401);
  });
});

describe("staff file access", () => {
  test("download works and is an attachment by default", async () => {
    const res = await ann.agent.get(`/api/staff-auth/training/${handbook}/file`).buffer(true).parse(raw);
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/^attachment/);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.body.equals(PDF)).toBe(true);
  });

  test("a PDF can be viewed inline, sandboxed; a Word file can't", async () => {
    const pdf = await ann.agent.get(`/api/staff-auth/training/${handbook}/file?view=1`).buffer(true).parse(raw);
    expect(pdf.headers["content-disposition"]).toMatch(/^inline/);
    expect(pdf.headers["content-security-policy"]).toBe("sandbox");
    const doc = await ann.agent.get(`/api/staff-auth/training/${contract}/file?view=1`).buffer(true).parse(raw);
    expect(doc.headers["content-disposition"]).toMatch(/^attachment/);
  });

  test("can't read an item assigned to someone else or to another restaurant", async () => {
    expect((await ann.agent.get(`/api/staff-auth/training/${notMine}/file`)).status).toBe(404);
    expect((await ann.agent.get(`/api/staff-auth/training/${otherRestaurantItem}/file`)).status).toBe(404);
    expect((await bea.agent.get(`/api/staff-auth/training/${handbook}/file`)).status).toBe(404);
    expect((await request(app).get(`/api/staff-auth/training/${handbook}/file`)).status).toBe(401);
  });
});

describe("marking done", () => {
  test("staff can mark done and undo; the manager sees it", async () => {
    expect((await ann.agent.post(`/api/staff-auth/training/${handbook}/done`).send({})).body.done).toBe(true);
    let list = await ann.agent.get("/api/staff-auth/training");
    expect(list.body.todoCount).toBe(1);
    expect(list.body.items.find((i) => i.id === handbook).done).toBe(true);

    const mgr = await A.agent.get("/api/training");
    expect(mgr.body.find((i) => i.id === handbook).assignments.find((a) => a.staffId === ann.id).done).toBe(true);
    expect(mgr.body.find((i) => i.id === handbook).assignments.find((a) => a.staffId === bob.id).done).toBe(false);

    expect((await ann.agent.post(`/api/staff-auth/training/${handbook}/done`).send({ done: false })).body.done).toBe(false);
    list = await ann.agent.get("/api/staff-auth/training");
    expect(list.body.todoCount).toBe(2);
  });

  test("can't mark someone else's item", async () => {
    expect((await ann.agent.post(`/api/staff-auth/training/${notMine}/done`).send({})).status).toBe(404);
    expect((await bea.agent.post(`/api/staff-auth/training/${handbook}/done`).send({})).status).toBe(404);
    const mgr = await A.agent.get("/api/training");
    expect(mgr.body.find((i) => i.id === notMine).assignments[0].done).toBe(false);
  });
});
