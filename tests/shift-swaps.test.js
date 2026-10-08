const request = require("supertest");
const bcrypt = require("bcryptjs");
const { app, pool } = require("../server.js");
const { createRestaurant, uniquePhone, uniqueEmail } = require("./helpers");

let A, B, ann, bob, cat, dan, bea;
const future = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

async function makeStaff(restaurant, name, roles = ["Server"]) {
  const created = await restaurant.agent.post("/api/staff").send({ name, phone: uniquePhone(), roles });
  const email = uniqueEmail("swap");
  await pool.query("UPDATE staff SET email = $1, password_hash = $2 WHERE id = $3", [email, await bcrypt.hash("staffpassword123", 4), created.body.id]);
  const agent = request.agent(app);
  const login = await agent.post("/api/staff-auth/login").send({ email, password: "staffpassword123" });
  if (login.status !== 200) throw new Error("staff login failed");
  return { id: created.body.id, agent };
}
async function addShift(restaurant, staff, date, startTime, endTime, role = "Server") {
  const r = await restaurant.agent.post("/api/schedule").send({ staffId: staff.id, date, startTime, endTime, role });
  if (r.status !== 201) throw new Error("schedule failed " + JSON.stringify(r.body));
  return r.body.id;
}
const owner = async (staff, shiftId) => (await pool.query("SELECT staff_id FROM schedule_shifts WHERE id = $1", [shiftId])).rows[0].staff_id;

beforeAll(async () => {
  const factory = () => request.agent(app);
  A = await createRestaurant(factory);
  B = await createRestaurant(factory);
  ann = await makeStaff(A, "Ann");
  bob = await makeStaff(A, "Bob");
  cat = await makeStaff(A, "Cat", ["Line Cook"]);
  dan = await makeStaff(A, "Dan");
  bea = await makeStaff(B, "Bea");
});
afterAll(async () => { await pool.end(); });

describe("giving a shift away", () => {
  let shift, swapId;
  beforeAll(async () => { shift = await addShift(A, ann, future(3), "17:00", "23:00"); });

  test("staff can only post their own, upcoming shifts", async () => {
    expect((await bob.agent.post("/api/staff-auth/swaps").send({ shiftId: shift, kind: "give" })).status).toBe(404);
    expect((await ann.agent.post("/api/staff-auth/swaps").send({ shiftId: shift, kind: "nope" })).status).toBe(400);
    const past = await addShift(A, ann, future(-10), "10:00", "14:00");
    expect((await ann.agent.post("/api/staff-auth/swaps").send({ shiftId: past, kind: "give" })).status).toBe(400);
    expect((await request(app).post("/api/staff-auth/swaps").send({ shiftId: shift, kind: "give" })).status).toBe(401);
  });

  test("posting shows it to eligible coworkers and to the manager; a shift can't be posted twice", async () => {
    const res = await ann.agent.post("/api/staff-auth/swaps").send({ shiftId: shift, kind: "give", note: "Doctor appt" });
    expect(res.status).toBe(201);
    swapId = res.body.id;
    expect(res.body).toMatchObject({ kind: "give", status: "open", fromName: "Ann", note: "Doctor appt" });
    expect((await ann.agent.post("/api/staff-auth/swaps").send({ shiftId: shift, kind: "give" })).status).toBe(409);

    const bobView = await bob.agent.get("/api/staff-auth/swaps");
    expect(bobView.body.available.map((w) => w.id)).toContain(swapId);
    const catView = await cat.agent.get("/api/staff-auth/swaps"); // a Line Cook can't cover a Server shift
    expect(catView.body.available.map((w) => w.id)).not.toContain(swapId);
    const annView = await ann.agent.get("/api/staff-auth/swaps");
    expect(annView.body.available.map((w) => w.id)).not.toContain(swapId);
    expect(annView.body.mine.map((w) => w.id)).toContain(swapId);
    const bea1 = await bea.agent.get("/api/staff-auth/swaps");
    expect(JSON.stringify(bea1.body)).not.toContain(swapId);

    const mgr = await A.agent.get("/api/swaps");
    expect(mgr.body.find((w) => w.id === swapId)).toMatchObject({ status: "open", fromName: "Ann" });
    expect((await B.agent.get("/api/swaps")).body.find((w) => w.id === swapId)).toBeUndefined();
  });

  test("accepting moves it to pending; the schedule doesn't change until the manager approves", async () => {
    expect((await cat.agent.post(`/api/staff-auth/swaps/${swapId}/accept`).send({})).status).toBe(400);
    expect((await ann.agent.post(`/api/staff-auth/swaps/${swapId}/accept`).send({})).status).toBe(400);
    expect((await bea.agent.post(`/api/staff-auth/swaps/${swapId}/accept`).send({})).status).toBe(404);
    const ok = await bob.agent.post(`/api/staff-auth/swaps/${swapId}/accept`).send({});
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: "pending", toName: "Bob" });
    expect(await owner(ann, shift)).toBe(ann.id);
    expect((await dan.agent.post(`/api/staff-auth/swaps/${swapId}/accept`).send({})).status).toBe(400); // no longer open
    expect((await A.agent.get("/api/swaps")).body[0].id).toBe(swapId); // pending sorts first
  });

  test("only the manager of that restaurant can approve; approval reassigns the shift", async () => {
    expect((await B.agent.post(`/api/swaps/${swapId}/approve`)).status).toBe(404);
    expect((await ann.agent.post(`/api/swaps/${swapId}/approve`)).status).toBe(401);
    const res = await A.agent.post(`/api/swaps/${swapId}/approve`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
    expect(await owner(bob, shift)).toBe(bob.id);
    expect((await A.agent.post(`/api/swaps/${swapId}/approve`)).status).toBe(400); // can't approve twice
  });
});

describe("trading shifts", () => {
  test("a swap needs the taker to offer one of their own shifts, and approval trades both", async () => {
    const annShift = await addShift(A, ann, future(5), "11:00", "16:00");
    const bobShift = await addShift(A, bob, future(6), "11:00", "16:00");
    const post = await ann.agent.post("/api/staff-auth/swaps").send({ shiftId: annShift, kind: "swap" });
    const swapId = post.body.id;

    expect((await bob.agent.post(`/api/staff-auth/swaps/${swapId}/accept`).send({})).status).toBe(400);
    const danShift = await addShift(A, dan, future(6), "11:00", "16:00");
    expect((await bob.agent.post(`/api/staff-auth/swaps/${swapId}/accept`).send({ swapShiftId: danShift })).status).toBe(400); // not Bob's

    const ok = await bob.agent.post(`/api/staff-auth/swaps/${swapId}/accept`).send({ swapShiftId: bobShift });
    expect(ok.status).toBe(200);
    expect(ok.body.swapShift.id).toBe(bobShift);

    expect((await A.agent.post(`/api/swaps/${swapId}/approve`)).status).toBe(200);
    expect(await owner(ann, annShift)).toBe(bob.id);
    expect(await owner(bob, bobShift)).toBe(ann.id);
  });

  test("a swapped-in shift can't be reused in another live request", async () => {
    const s1 = await addShift(A, ann, future(8), "09:00", "13:00");
    const s2 = await addShift(A, ann, future(9), "09:00", "13:00");
    const d1 = await addShift(A, dan, future(10), "09:00", "13:00");
    const first = (await ann.agent.post("/api/staff-auth/swaps").send({ shiftId: s1, kind: "swap" })).body.id;
    await dan.agent.post(`/api/staff-auth/swaps/${first}/accept`).send({ swapShiftId: d1 });
    const second = (await ann.agent.post("/api/staff-auth/swaps").send({ shiftId: s2, kind: "swap" })).body.id;
    const clash = await dan.agent.post(`/api/staff-auth/swaps/${second}/accept`).send({ swapShiftId: d1 });
    expect(clash.status).toBe(409);
    await A.agent.post(`/api/swaps/${first}/deny`);
  });
});

describe("conflicts, denial and cancelling", () => {
  test("a give that would double-book the taker is hidden and refused", async () => {
    const day = future(12);
    const annShift = await addShift(A, ann, day, "17:00", "23:00");
    await addShift(A, dan, day, "20:00", "23:30");
    const id = (await ann.agent.post("/api/staff-auth/swaps").send({ shiftId: annShift, kind: "give" })).body.id;
    expect((await dan.agent.get("/api/staff-auth/swaps")).body.available.map((w) => w.id)).not.toContain(id);
    expect((await dan.agent.post(`/api/staff-auth/swaps/${id}/accept`).send({})).status).toBe(400);
    await ann.agent.post(`/api/staff-auth/swaps/${id}/cancel`);
  });

  test("manager can deny; nothing moves", async () => {
    const sh = await addShift(A, ann, future(14), "10:00", "15:00");
    const id = (await ann.agent.post("/api/staff-auth/swaps").send({ shiftId: sh, kind: "give" })).body.id;
    await bob.agent.post(`/api/staff-auth/swaps/${id}/accept`).send({});
    const res = await A.agent.post(`/api/swaps/${id}/deny`);
    expect(res.body.status).toBe("denied");
    expect(await owner(ann, sh)).toBe(ann.id);
    // the shift can be posted again afterwards
    expect((await ann.agent.post("/api/staff-auth/swaps").send({ shiftId: sh, kind: "give" })).status).toBe(201);
  });

  test("the poster can cancel; the taker can withdraw and it goes back on the board", async () => {
    const sh = await addShift(A, ann, future(16), "10:00", "15:00");
    const id = (await ann.agent.post("/api/staff-auth/swaps").send({ shiftId: sh, kind: "give" })).body.id;
    await bob.agent.post(`/api/staff-auth/swaps/${id}/accept`).send({});
    expect((await dan.agent.post(`/api/staff-auth/swaps/${id}/withdraw`)).status).toBe(404);
    const back = await bob.agent.post(`/api/staff-auth/swaps/${id}/withdraw`);
    expect(back.body).toMatchObject({ status: "open", toStaffId: null });
    expect((await bob.agent.post(`/api/staff-auth/swaps/${id}/cancel`)).status).toBe(404);
    expect((await ann.agent.post(`/api/staff-auth/swaps/${id}/cancel`)).status).toBe(200);
    expect((await A.agent.get("/api/swaps")).body.find((w) => w.id === id)).toBeUndefined();
  });

  test("approval fails cleanly if the manager moved the shift in the meantime", async () => {
    const sh = await addShift(A, ann, future(18), "10:00", "15:00");
    const id = (await ann.agent.post("/api/staff-auth/swaps").send({ shiftId: sh, kind: "give" })).body.id;
    await bob.agent.post(`/api/staff-auth/swaps/${id}/accept`).send({});
    await A.agent.patch(`/api/schedule/${sh}`).send({ staffId: dan.id });
    expect((await A.agent.post(`/api/swaps/${id}/approve`)).status).toBe(409);
    expect(await owner(dan, sh)).toBe(dan.id);
  });
});
