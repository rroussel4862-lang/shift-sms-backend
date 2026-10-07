// The AI is never really called here: global.fetch is replaced, so these tests cost nothing and need no key.
process.env.ANTHROPIC_API_KEY = "test-key-not-real";

const request = require("supertest");
const bcrypt = require("bcryptjs");
const { app, pool } = require("../server.js");
const { createRestaurant, uniquePhone, uniqueEmail } = require("./helpers");

let A, B;
const realFetch = global.fetch;
let lastAnthropicBody = null;
let nextReply = null; // string the fake model answers with, or { status } for an API error

function fakeAnthropic() {
  global.fetch = jest.fn(async (url, opts) => {
    if (!String(url).includes("api.anthropic.com")) return realFetch(url, opts);
    lastAnthropicBody = JSON.parse(opts.body);
    if (nextReply && typeof nextReply === "object") {
      return { ok: false, status: nextReply.status, text: async () => "boom" };
    }
    return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: nextReply }] }) };
  });
}

beforeAll(async () => {
  const factory = () => request.agent(app);
  A = await createRestaurant(factory);
  B = await createRestaurant(factory);
});

beforeEach(() => { fakeAnthropic(); lastAnthropicBody = null; });
afterEach(() => { global.fetch = realFetch; });
afterAll(async () => { await pool.end(); });

const TRANSLATIONS = {
  en: { title: "Meeting", body: "Staff meeting Friday at 3 pm." },
  fr: { title: "Réunion", body: "Réunion d'équipe vendredi à 15 h." },
  es: { title: "Reunión", body: "Reunión del equipo el viernes a las 3 pm." },
};

describe("AI board drafting", () => {
  test("turns a rough idea into a title and body, tolerating code fences", async () => {
    nextReply = 'Here you go:\n```json\n{"title":"Friday meeting","body":"Staff meeting Friday at 3 pm."}\n```';
    const res = await A.agent.post("/api/ai/board-draft").send({ idea: "meeting fri 3pm", lang: "en" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ title: "Friday meeting", body: "Staff meeting Friday at 3 pm." });
    expect(lastAnthropicBody.system).toContain("English");
    expect(lastAnthropicBody.messages[0].content).toBe("meeting fri 3pm");
  });

  test("asks for French when the manager's language is French", async () => {
    nextReply = '{"title":"Réunion","body":"Réunion vendredi à 15 h."}';
    await A.agent.post("/api/ai/board-draft").send({ idea: "reunion ven 15h", lang: "fr" });
    expect(lastAnthropicBody.system).toContain("French");
  });

  test("requires an idea, and a login", async () => {
    expect((await A.agent.post("/api/ai/board-draft").send({ idea: "  " })).status).toBe(400);
    expect((await request(app).post("/api/ai/board-draft").send({ idea: "x" })).status).toBe(401);
  });

  test("a garbled reply or an API error becomes a clean 502, not a crash", async () => {
    nextReply = "sorry, no json";
    expect((await A.agent.post("/api/ai/board-draft").send({ idea: "x" })).status).toBe(502);
    nextReply = { status: 529 };
    const res = await A.agent.post("/api/ai/board-draft").send({ idea: "x" });
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain("boom");
  });
});

describe("AI board translation", () => {
  test("returns all three languages", async () => {
    nextReply = JSON.stringify(TRANSLATIONS);
    const res = await A.agent.post("/api/ai/board-translate").send({ title: "Meeting", body: "Staff meeting Friday at 3 pm." });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.translations).sort()).toEqual(["en", "es", "fr"]);
  });

  test("rejects an incomplete translation", async () => {
    nextReply = JSON.stringify({ en: TRANSLATIONS.en });
    expect((await A.agent.post("/api/ai/board-translate").send({ body: "Hello" })).status).toBe(502);
  });

  test("requires a message", async () => {
    expect((await A.agent.post("/api/ai/board-translate").send({ title: "Only a title" })).status).toBe(400);
  });
});

describe("translations stored on posts", () => {
  test("saved with a post and returned to staff", async () => {
    const created = await A.agent.post("/api/board").send({ title: "Meeting", body: TRANSLATIONS.en.body, translations: TRANSLATIONS });
    expect(created.status).toBe(201);
    expect(created.body.translations.fr.body).toContain("Réunion");

    const staff = await A.agent.post("/api/staff").send({ name: "Tess Reader", phone: uniquePhone(), roles: ["Server"] });
    const email = uniqueEmail("aiboard");
    await pool.query("UPDATE staff SET email = $1, password_hash = $2 WHERE id = $3", [email, await bcrypt.hash("staffpassword123", 4), staff.body.id]);
    const sagent = request.agent(app);
    expect((await sagent.post("/api/staff-auth/login").send({ email, password: "staffpassword123" })).status).toBe(200);
    const board = await sagent.get("/api/staff-auth/board");
    const post = board.body.posts.find((p) => p.id === created.body.id);
    expect(post.translations.es.body).toContain("Reunión");
  });

  test("editing the text drops stale translations; pinning keeps them", async () => {
    const created = await A.agent.post("/api/board").send({ body: "Original", translations: TRANSLATIONS });
    const pinned = await A.agent.patch(`/api/board/${created.body.id}`).send({ pinned: true });
    expect(pinned.body.translations).not.toBeNull();
    const edited = await A.agent.patch(`/api/board/${created.body.id}`).send({ body: "Changed text" });
    expect(edited.body.translations).toBeNull();
    const retranslated = await A.agent.patch(`/api/board/${created.body.id}`).send({ body: "Changed again", translations: TRANSLATIONS });
    expect(retranslated.body.translations.en.body).toBeTruthy();
  });

  test("malformed translations are discarded, not stored", async () => {
    const res = await A.agent.post("/api/board").send({ body: "Hi", translations: { fr: "oops", xx: { body: "nope" } } });
    expect(res.status).toBe(201);
    expect(res.body.translations).toBeNull();
  });
});

describe("AI assistant sees the board and sales", () => {
  test("board and sales data are included in the context, scoped to this restaurant", async () => {
    await A.agent.post("/api/board").send({ title: "Policy", body: "New phone policy for everyone." });
    await B.agent.post("/api/board").send({ title: "Secret B post", body: "Only restaurant B should know." });
    const today = new Date().toISOString().slice(0, 10);
    await A.agent.put("/api/actual-sales").send({ date: today, foodAmount: 1200, bevAmount: 800 });

    nextReply = "ok";
    const res = await A.agent.post("/api/ai/ask").send({ question: "Who hasn't read the policy?" });
    expect(res.status).toBe(200);
    const sys = lastAnthropicBody.system;
    expect(sys).toContain("New phone policy");
    expect(sys).toContain("teamMessageBoard");
    expect(sys).toContain('"foodSales": 1200');
    expect(sys).not.toContain("Secret B post");
  });
});
