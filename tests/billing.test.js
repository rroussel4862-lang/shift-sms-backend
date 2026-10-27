const request = require("supertest");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { app, pool, verifyStripeSignature } = require("../server.js");
const { createRestaurant, uniqueEmail } = require("./helpers");

const SECRET = "whsec_test_secret";
let admin, A;

// Builds a request the way Stripe sends it: JSON body plus a signed header.
function stripeEvent(type, object) {
  const body = JSON.stringify({ id: "evt_" + Math.random().toString(36).slice(2), type, data: { object } });
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex");
  return { body, header: `t=${t},v1=${sig}` };
}
const send = (ev) => request(app).post("/api/stripe/webhook").set("Content-Type", "application/json").set("Stripe-Signature", ev.header).send(ev.body);

beforeAll(async () => {
  A = await createRestaurant(() => request.agent(app), { restaurantName: "Billing Place" });
  const email = uniqueEmail("platform");
  await pool.query("INSERT INTO platform_admins (id, email, password_hash, created_at) VALUES ($1,$2,$3,$4)", ["pb" + Date.now(), email, await bcrypt.hash("adminpassword123", 4), Date.now()]);
  admin = request.agent(app);
  const login = await admin.post("/api/platform-auth/login").send({ email, password: "adminpassword123" });
  if (login.status !== 200) throw new Error("platform login failed");
});
afterAll(async () => {
  delete process.env.STRIPE_WEBHOOK_SECRET; delete process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_PRICE_ID;
  await pool.end();
});

describe("without Stripe set up", () => {
  test("restaurants are exempt and never held at a payment screen", async () => {
    const st = await A.agent.get("/api/billing/status");
    expect(st.status).toBe(200);
    expect(st.body).toMatchObject({ status: "exempt", blocked: false, configured: false });
    expect((await A.agent.get("/api/staff")).status).toBe(200);
    expect((await A.agent.post("/api/billing/checkout")).status).toBe(503);
  });
  test("the webhook is closed until a secret is set", async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const res = await request(app).post("/api/stripe/webhook").set("Content-Type", "application/json").send("{}");
    expect(res.status).toBe(503);
  });
});

describe("signature check", () => {
  const body = Buffer.from('{"a":1}');
  const sign = (t) => crypto.createHmac("sha256", SECRET).update(`${t}.`).update(body).digest("hex");
  const now = Math.floor(Date.now() / 1000);
  test("accepts a good signature, rejects a changed one, an old one, and a missing header", () => {
    expect(verifyStripeSignature(body, `t=${now},v1=${sign(now)}`, SECRET)).toBe(true);
    expect(verifyStripeSignature(Buffer.from('{"a":2}'), `t=${now},v1=${sign(now)}`, SECRET)).toBe(false);
    expect(verifyStripeSignature(body, `t=${now - 4000},v1=${sign(now - 4000)}`, SECRET)).toBe(false);
    expect(verifyStripeSignature(body, undefined, SECRET)).toBe(false);
  });
});

describe("webhook and payment screen", () => {
  beforeAll(() => { process.env.STRIPE_WEBHOOK_SECRET = SECRET; });

  test("rejects a bad signature", async () => {
    const ev = stripeEvent("invoice.paid", { customer: "cus_x" });
    const res = await request(app).post("/api/stripe/webhook").set("Content-Type", "application/json").set("Stripe-Signature", ev.header.replace(/.$/, "0")).send(ev.body);
    expect(res.status).toBe(400);
  });

  test("a completed checkout marks the restaurant as paying and remembers the Stripe ids", async () => {
    const res = await send(stripeEvent("checkout.session.completed", { mode: "subscription", payment_status: "paid", client_reference_id: A.restaurantId, customer: "cus_billing1", subscription: "sub_billing1" }));
    expect(res.status).toBe(200);
    const { rows } = await pool.query("SELECT billing_status, stripe_customer_id, stripe_subscription_id FROM restaurants WHERE id = $1", [A.restaurantId]);
    expect(rows[0]).toMatchObject({ billing_status: "active", stripe_customer_id: "cus_billing1", stripe_subscription_id: "sub_billing1" });
    const st = await A.agent.get("/api/billing/status");
    expect(st.body).toMatchObject({ status: "active", blocked: false, canManage: true });
  });

  test("a failed payment shows a warning but keeps the app open", async () => {
    await send(stripeEvent("invoice.payment_failed", { customer: "cus_billing1" }));
    const st = await A.agent.get("/api/billing/status");
    expect(st.body).toMatchObject({ status: "past_due", blocked: false });
    expect((await A.agent.get("/api/staff")).status).toBe(200);
  });

  test("an ended subscription holds managers at the payment screen, and paying again lets them back in", async () => {
    await send(stripeEvent("customer.subscription.deleted", { id: "sub_billing1", customer: "cus_billing1", status: "canceled", metadata: { restaurant_id: A.restaurantId } }));
    const blocked = await A.agent.get("/api/staff");
    expect(blocked.status).toBe(402);
    expect(blocked.body.code).toBe("payment_required");
    expect((await A.agent.get("/api/auth/me")).status).toBe(200);     // sign-in info and billing stay reachable
    expect((await A.agent.get("/api/billing/status")).body).toMatchObject({ status: "canceled", blocked: true });
    await send(stripeEvent("invoice.paid", { customer: "cus_billing1" }));
    expect((await A.agent.get("/api/staff")).status).toBe(200);
  });
});

describe("new sign-ups once Stripe is set up", () => {
  afterEach(() => { jest.restoreAllMocks(); });

  test("start unpaid, are held at payment, and get a checkout link", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    process.env.STRIPE_PRICE_ID = "price_test_100";
    const agent = request.agent(app);
    const su = await agent.post("/api/auth/signup").send({ restaurantName: "Pay First Place", email: uniqueEmail("payfirst"), password: "testpassword123", acceptTerms: true });
    expect(su.status).toBe(201);
    const rid = su.body.restaurant.id;
    expect((await agent.get("/api/billing/status")).body).toMatchObject({ status: "unpaid", blocked: true, configured: true });
    expect((await agent.get("/api/staff")).status).toBe(402);

    const calls = [];
    jest.spyOn(global, "fetch").mockImplementation(async (url, opts) => {
      calls.push({ url: String(url), body: String((opts && opts.body) || "") });
      const json = String(url).endsWith("/customers") ? { id: "cus_new1" } : { url: "https://checkout.stripe.com/c/pay/test" };
      return { ok: true, status: 200, json: async () => json };
    });
    const co = await agent.post("/api/billing/checkout").send({ locale: "fr" });
    expect(co.status).toBe(200);
    expect(co.body.url).toBe("https://checkout.stripe.com/c/pay/test");
    const session = calls.find((c) => c.url.endsWith("/checkout/sessions"));
    expect(session.body).toContain("mode=subscription");
    expect(session.body).toContain("price_test_100");
    expect(session.body).toContain("client_reference_id=" + rid);
    expect(session.body).toContain("customer=cus_new1");
  });

  test("a restaurant with free access until a past date is held, and one in the future is not", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const b = await createRestaurant(() => request.agent(app), { restaurantName: "Free Until Place" });
    const bad = await admin.patch(`/api/platform/restaurants/${b.restaurantId}/billing`).send({ mode: "free" });
    expect(bad.status).toBe(400);
    await admin.patch(`/api/platform/restaurants/${b.restaurantId}/billing`).send({ mode: "free", freeUntil: "2020-01-01" });
    expect((await b.agent.get("/api/billing/status")).body).toMatchObject({ status: "free_ended", blocked: true });
    expect((await b.agent.get("/api/staff")).status).toBe(402);
    await admin.patch(`/api/platform/restaurants/${b.restaurantId}/billing`).send({ mode: "free", freeUntil: "2099-01-01" });
    expect((await b.agent.get("/api/billing/status")).body).toMatchObject({ status: "free", blocked: false });
    await admin.patch(`/api/platform/restaurants/${b.restaurantId}/billing`).send({ mode: "exempt" });
    expect((await b.agent.get("/api/billing/status")).body).toMatchObject({ status: "exempt", blocked: false });
    const list = await admin.get("/api/platform/restaurants");
    expect(list.body.find((r) => r.id === b.restaurantId).billingStatus).toBe("exempt");
  });
});
