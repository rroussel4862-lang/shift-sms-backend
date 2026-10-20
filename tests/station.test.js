const request = require("supertest");
const bcrypt = require("bcryptjs");
const { app, pool } = require("../server.js");
const { createRestaurant, uniquePhone, uniqueEmail } = require("./helpers");

let R, kim;
const future = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

beforeAll(async () => {
  R = await createRestaurant(() => request.agent(app));
  const created = await R.agent.post("/api/staff").send({ name: "Kim Cook", phone: uniquePhone(), roles: ["Line Cook"] });
  const email = uniqueEmail("station");
  await pool.query("UPDATE staff SET email = $1, password_hash = $2 WHERE id = $3", [email, await bcrypt.hash("staffpassword123", 4), created.body.id]);
  const agent = request.agent(app);
  expect((await agent.post("/api/staff-auth/login").send({ email, password: "staffpassword123" })).status).toBe(200);
  kim = { id: created.body.id, agent };
});
afterAll(async () => { await pool.end(); });

describe("kitchen stations on shifts", () => {
  const day = future(2);

  test("a shift can carry a station; shifts without one stay as they were", async () => {
    const plain = await R.agent.post("/api/schedule").send({ staffId: kim.id, date: day, startTime: "10:00", endTime: "14:00", role: "Line Cook" });
    expect(plain.status).toBe(201);
    expect(plain.body.station).toBe("");
    const withStation = await R.agent.post("/api/schedule").send({ staffId: kim.id, date: day, startTime: "16:00", endTime: "23:00", role: "Line Cook", station: "Fryer and Pans" });
    expect(withStation.status).toBe(201);
    expect(withStation.body.station).toBe("Fryer and Pans");
  });

  test("only the four stations are accepted", async () => {
    const bad = await R.agent.post("/api/schedule").send({ staffId: kim.id, date: future(3), startTime: "10:00", endTime: "14:00", role: "Line Cook", station: "Pastry" });
    expect(bad.status).toBe(400);
    for (const st of ["Grill", "Dishwasher", "Fryer and Pans", "Garde-Manger"]) {
      const ok = await R.agent.post("/api/schedule").send({ staffId: kim.id, date: future(4), startTime: "0" + (1 + ["Grill", "Dishwasher", "Fryer and Pans", "Garde-Manger"].indexOf(st)) + ":00", endTime: "0" + (1 + ["Grill", "Dishwasher", "Fryer and Pans", "Garde-Manger"].indexOf(st)) + ":30", role: "Line Cook", station: st });
      expect(ok.body.station).toBe(st);
    }
  });

  test("changing a shift's station, moving it, and clearing it", async () => {
    const mk = (await R.agent.post("/api/schedule").send({ staffId: kim.id, date: future(5), startTime: "10:00", endTime: "14:00", role: "Line Cook", station: "Grill" })).body;
    const moved = await R.agent.patch(`/api/schedule/${mk.id}`).send({ date: future(6) }); // a drag to another day keeps the station
    expect(moved.body.station).toBe("Grill");
    expect((await R.agent.patch(`/api/schedule/${mk.id}`).send({ station: "Garde-Manger" })).body.station).toBe("Garde-Manger");
    expect((await R.agent.patch(`/api/schedule/${mk.id}`).send({ station: "" })).body.station).toBe("");
    expect((await R.agent.patch(`/api/schedule/${mk.id}`).send({ station: "Nope" })).status).toBe(400);
  });

  test("copying a week keeps the stations", async () => {
    const res = await R.agent.post("/api/schedule/bulk").send({ shifts: [{ staffId: kim.id, date: future(20), startTime: "10:00", endTime: "14:00", role: "Line Cook", station: "Grill" }] });
    expect(res.status).toBe(201);
    expect(res.body.created[0].station).toBe("Grill");
  });

  test("the cook sees the station in their portal", async () => {
    const monday = (() => { const d = new Date(day + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); })();
    await R.agent.post("/api/schedule/publish").send({ weekStart: monday, house: "boh" }); // a future week stays hidden until its house is posted
    const res = await kim.agent.get(`/api/staff-auth/schedule?start=${day}&end=${day}`);
    expect(res.body.map((s) => s.station)).toEqual(expect.arrayContaining(["", "Fryer and Pans"]));
  });
});
