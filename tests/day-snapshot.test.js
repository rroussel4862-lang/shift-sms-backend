// No real network: global.fetch is replaced for geocoding, weather and the events search.
process.env.ANTHROPIC_API_KEY = "test-key-not-real";

const request = require("supertest");
const { app, pool } = require("../server.js");
const { createRestaurant } = require("./helpers");

let A, B;
const realFetch = global.fetch;
let calls;
let eventsReply;

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });

function forecastForToday() {
  // hourly points covering the whole local day (America/Toronto), as MET Norway returns them
  const [y, m, d] = today().split("-").map(Number);
  const series = [];
  for (let h = 0; h < 24; h++) {
    // local midnight is 4 or 5 hours ahead of UTC depending on DST; take 5 and keep what falls on the day via the server's own conversion
    const t = new Date(Date.UTC(y, m - 1, d, h + 5));
    series.push({
      time: t.toISOString(),
      data: { instant: { details: { air_temperature: 8 + h / 2 } }, next_1_hours: { summary: { symbol_code: "lightrain_day" }, details: { precipitation_amount: 0.2 } } },
    });
  }
  return { properties: { timeseries: series } };
}

function fakeNetwork() {
  global.fetch = jest.fn(async (url, opts) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("nominatim")) return { ok: true, status: 200, json: async () => [{ lat: "45.5088", lon: "-73.5878", address: { city: "Montréal", state: "Québec", country: "Canada" } }] };
    if (u.includes("api.met.no")) return { ok: true, status: 200, json: async () => forecastForToday() };
    if (u.includes("api.anthropic.com")) {
      if (eventsReply === "fail") return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: eventsReply }] }) };
    }
    return realFetch(url, opts);
  });
}

beforeAll(async () => {
  const factory = () => request.agent(app);
  A = await createRestaurant(factory);
  B = await createRestaurant(factory);
});
beforeEach(() => { calls = []; eventsReply = '{"events":[{"name":"Canadiens game","when":"7:30 PM","where":"Bell Centre","impact":"high","note":"Big pre-game dinner rush"}]}'; fakeNetwork(); });
afterEach(() => { global.fetch = realFetch; });
afterAll(async () => { await pool.end(); });

async function pollUntil(agent, pred, tries = 30) {
  let res;
  for (let i = 0; i < tries; i++) {
    res = await agent.get("/api/day-snapshot");
    if (pred(res.body)) return res;
    await new Promise((r) => setTimeout(r, 50));
  }
  return res;
}

describe("daily snapshot", () => {
  test("without an address it still returns the sales figures and asks for an address", async () => {
    await A.agent.put("/api/sales-projections").send({ date: today(), projectedAmount: 6500, lunchAmount: 2000, lastYearAmount: 5900 });
    const res = await A.agent.get("/api/day-snapshot");
    expect(res.status).toBe(200);
    expect(res.body.location).toBe("no_address");
    expect(res.body.sales).toMatchObject({ projected: 6500, projectedByService: { lunch: 2000 }, lastYear: { amount: 5900, basis: "day" } });
    expect(res.body.weather).toBeNull();
    expect(calls.length).toBe(0);
  });

  test("with an address: geocodes once, returns weather, fetches events in the background", async () => {
    await A.agent.patch("/api/restaurant").send({ address: "1 Rue Sainte-Catherine, Montréal, QC" });
    const first = await A.agent.get("/api/day-snapshot");
    expect(first.body.location).toBe("ok");
    expect(first.body.place).toBe("Montréal, Québec, Canada");
    expect(first.body.weather).toMatchObject({ category: "rain", intensity: "light" });
    expect(typeof first.body.weather.tempMax).toBe("number");
    expect(first.body.eventsStatus).toBe("pending");

    const done = await pollUntil(A.agent, (b) => b.eventsStatus === "ok");
    expect(done.body.events).toEqual([expect.objectContaining({ name: "Canadiens game", impact: "high" })]);
    expect(calls.filter((u) => u.includes("nominatim")).length).toBe(1);
  });

  test("only the city goes to the search, and results are cached for the day", async () => {
    const before = calls.length;
    const res = await A.agent.get("/api/day-snapshot");
    expect(res.body.eventsStatus).toBe("ok");
    expect(calls.slice(before).filter((u) => u.includes("anthropic")).length).toBe(0);
    expect(calls.slice(before).filter((u) => u.includes("nominatim")).length).toBe(0);
  });

  test("a failed events search is reported, not fatal", async () => {
    await B.agent.patch("/api/restaurant").send({ address: "2 Rue Sherbrooke, Montréal, QC" });
    eventsReply = "fail";
    await B.agent.get("/api/day-snapshot");
    const res = await pollUntil(B.agent, (b) => b.eventsStatus === "failed");
    expect(res.body.eventsStatus).toBe("failed");
    expect(res.body.weather).not.toBeNull();
    expect(res.body.events).toBeNull();
  });

  test("a failed lookup can be retried on demand", async () => {
    // B's last failure was just now, so a retry inside the first minute is ignored; age the record to simulate time passing
    await pool.query("UPDATE day_context SET events_at = events_at - 120000 WHERE events_error IS NOT NULL");
    eventsReply = '{"events":[]}';
    const first = await B.agent.get("/api/day-snapshot?refreshEvents=1");
    expect(first.body.eventsStatus).toBe("pending");
    const res = await pollUntil(B.agent, (b) => b.eventsStatus === "ok");
    expect(res.body.events).toEqual([]);
  });

  test("falls back to last year's week average when no daily figure was typed", async () => {
    const [y, m, d] = today().split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7) - 364); // Monday of this week minus 364 days
    const lyMonday = dt.toISOString().slice(0, 10);
    await B.agent.put("/api/revenue-history").send({ weekStart: lyMonday, amount: 35000 });
    const res = await B.agent.get("/api/day-snapshot");
    expect(res.body.sales.lastYear).toEqual({ amount: 5000, basis: "weekAvg" });
  });

  test("?date= : out-of-range is rejected, a past day returns saved data only and never hits the network", async () => {
    const iso = (n) => { const [y, m, d] = today().split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
    expect((await A.agent.get("/api/day-snapshot?date=nonsense")).status).toBe(400);
    expect((await A.agent.get("/api/day-snapshot?date=" + iso(-61))).status).toBe(400);
    expect((await A.agent.get("/api/day-snapshot?date=" + iso(15))).status).toBe(400);
    const y = iso(-1);
    await A.agent.put("/api/actual-sales").send({ date: y, foodSales: 3000, beverageSales: 1000 });
    calls = [];
    const res = await A.agent.get("/api/day-snapshot?date=" + y);
    expect(res.status).toBe(200);
    expect(res.body.date).toBe(y);
    expect(res.body.eventsStatus).toBe("not_recorded");
    expect(calls.length).toBe(0);
  });
});
