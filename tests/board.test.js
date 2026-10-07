const request = require("supertest");
const bcrypt = require("bcryptjs");
const { app, pool } = require("../server.js");
const { createRestaurant, uniquePhone, uniqueEmail } = require("./helpers");

let A, B, staffA1, staffA2, staffB1; // each: { id, agent }

// Creates a staff member for a restaurant and logs them into the staff portal.
async function makeStaffWithLogin(restaurant, name) {
  const created = await restaurant.agent.post("/api/staff").send({ name, phone: uniquePhone(), roles: ["Server"] });
  const staffId = created.body.id;
  const email = uniqueEmail("board");
  const hash = await bcrypt.hash("staffpassword123", 4);
  await pool.query("UPDATE staff SET email = $1, password_hash = $2 WHERE id = $3", [email, hash, staffId]);
  const agent = request.agent(app);
  const login = await agent.post("/api/staff-auth/login").send({ email, password: "staffpassword123" });
  if (login.status !== 200) throw new Error(`staff login failed: ${login.status} ${JSON.stringify(login.body)}`);
  return { id: staffId, agent };
}

beforeAll(async () => {
  const factory = () => request.agent(app);
  A = await createRestaurant(factory);
  B = await createRestaurant(factory);
  staffA1 = await makeStaffWithLogin(A, "Ada Board");
  staffA2 = await makeStaffWithLogin(A, "Bo Board");
  staffB1 = await makeStaffWithLogin(B, "Cy Board");
});

afterAll(async () => {
  await pool.end();
});

describe("manager board", () => {
  let postId;

  test("a manager can post, and it lists newest first with pinned on top", async () => {
    const first = await A.agent.post("/api/board").send({ title: "Welcome", body: "Bienvenue / Welcome" });
    expect(first.status).toBe(201);
    postId = first.body.id;
    const second = await A.agent.post("/api/board").send({ body: "Second post" });
    expect(second.status).toBe(201);
    const pinned = await A.agent.post("/api/board").send({ title: "Fire exits", body: "Keep clear", pinned: true });
    expect(pinned.body.pinned).toBe(true);

    const list = await A.agent.get("/api/board");
    expect(list.status).toBe(200);
    expect(list.body.map((p) => p.title || p.body)).toEqual(["Fire exits", "Second post", "Welcome"]);
  });

  test("message is required and length limits are enforced", async () => {
    expect((await A.agent.post("/api/board").send({ title: "No body" })).status).toBe(400);
    expect((await A.agent.post("/api/board").send({ body: "   " })).status).toBe(400);
    expect((await A.agent.post("/api/board").send({ body: "x".repeat(2001) })).status).toBe(400);
    expect((await A.agent.post("/api/board").send({ title: "t".repeat(121), body: "ok" })).status).toBe(400);
  });

  test("a post can be edited and pinned", async () => {
    const res = await A.agent.patch(`/api/board/${postId}`).send({ body: "Edited body", pinned: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ body: "Edited body", pinned: true, title: "Welcome" });
    expect((await A.agent.patch(`/api/board/${postId}`).send({ body: "" })).status).toBe(400);
  });

  test("login is required", async () => {
    expect((await request(app).get("/api/board")).status).toBe(401);
    expect((await request(app).post("/api/board").send({ body: "x" })).status).toBe(401);
  });

  test("another restaurant cannot see, edit or delete these posts", async () => {
    expect((await B.agent.get("/api/board")).body).toEqual([]);
    expect((await B.agent.patch(`/api/board/${postId}`).send({ body: "Hijack" })).status).toBe(404);
    expect((await B.agent.delete(`/api/board/${postId}`)).status).toBe(404);
    const still = await A.agent.get("/api/board");
    expect(still.body.find((p) => p.id === postId).body).toBe("Edited body");
  });

  test("a post can be deleted", async () => {
    const created = await A.agent.post("/api/board").send({ body: "Temporary" });
    expect((await A.agent.delete(`/api/board/${created.body.id}`)).status).toBe(200);
    const list = await A.agent.get("/api/board");
    expect(list.body.some((p) => p.id === created.body.id)).toBe(false);
  });
});

describe("staff board", () => {
  let postId;

  test("staff see their own restaurant's posts, and only those", async () => {
    const created = await A.agent.post("/api/board").send({ title: "Staff meeting", body: "Friday 3pm" });
    postId = created.body.id;
    await B.agent.post("/api/board").send({ body: "Other restaurant only" });

    const res = await staffA1.agent.get("/api/staff-auth/board");
    expect(res.status).toBe(200);
    expect(res.body.posts.some((p) => p.id === postId)).toBe(true);
    expect(res.body.posts.some((p) => p.body === "Other restaurant only")).toBe(false);

    const resB = await staffB1.agent.get("/api/staff-auth/board");
    expect(resB.body.posts.some((p) => p.body === "Other restaurant only")).toBe(true);
    expect(resB.body.posts.some((p) => p.id === postId)).toBe(false);
  });

  test("new posts count as unread until the staff member opens the board", async () => {
    const before = await staffA1.agent.get("/api/staff-auth/board");
    expect(before.body.unreadCount).toBeGreaterThan(0);
    expect(before.body.posts.find((p) => p.id === postId).isNew).toBe(true);

    expect((await staffA1.agent.post("/api/staff-auth/board/seen")).status).toBe(200);
    const after = await staffA1.agent.get("/api/staff-auth/board");
    expect(after.body.unreadCount).toBe(0);
    expect(after.body.posts.every((p) => p.isNew === false)).toBe(true);

    // another staff member's unread state is independent
    const other = await staffA2.agent.get("/api/staff-auth/board");
    expect(other.body.unreadCount).toBeGreaterThan(0);
  });

  test("a post posted after opening the board is new again", async () => {
    await new Promise((r) => setTimeout(r, 5));
    await A.agent.post("/api/board").send({ body: "Fresh news" });
    const res = await staffA1.agent.get("/api/staff-auth/board");
    expect(res.body.unreadCount).toBe(1);
  });

  test("'Got it' is recorded once per person and shows to the manager", async () => {
    expect((await staffA1.agent.post(`/api/staff-auth/board/${postId}/ack`)).status).toBe(200);
    expect((await staffA1.agent.post(`/api/staff-auth/board/${postId}/ack`)).status).toBe(200); // idempotent

    const mine = await staffA1.agent.get("/api/staff-auth/board");
    expect(mine.body.posts.find((p) => p.id === postId).acked).toBe(true);
    const theirs = await staffA2.agent.get("/api/staff-auth/board");
    expect(theirs.body.posts.find((p) => p.id === postId).acked).toBe(false);

    const manager = await A.agent.get("/api/board");
    const post = manager.body.find((p) => p.id === postId);
    expect(post.ackCount).toBe(1);
    expect(post.ackedBy).toEqual([staffA1.id]);
    expect(post.loginCount).toBe(2);
  });

  test("staff cannot acknowledge another restaurant's post", async () => {
    const res = await staffB1.agent.post(`/api/staff-auth/board/${postId}/ack`);
    expect(res.status).toBe(404);
  });

  test("login is required", async () => {
    expect((await request(app).get("/api/staff-auth/board")).status).toBe(401);
    expect((await request(app).post(`/api/staff-auth/board/${postId}/ack`)).status).toBe(401);
  });

  test("a manager session cannot use the staff endpoints (and vice versa)", async () => {
    expect((await A.agent.get("/api/staff-auth/board")).status).toBe(401);
    expect((await staffA1.agent.get("/api/board")).status).toBe(401);
  });
});
