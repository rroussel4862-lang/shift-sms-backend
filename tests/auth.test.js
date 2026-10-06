const request = require("supertest");
const { app, pool } = require("../server.js");
const { uniqueEmail } = require("./helpers");

afterAll(async () => {
  await pool.end();
});

describe("manager signup", () => {
  test("creates a restaurant and logs the owner in", async () => {
    const email = uniqueEmail("signup");
    const res = await request(app).post("/api/auth/signup").send({
      restaurantName: "Ferro Test Kitchen",
      email,
      password: "testpassword123",
    });

    expect(res.status).toBe(201);
    expect(res.body.restaurant.name).toBe("Ferro Test Kitchen");
    expect(res.body.email).toBe(email.toLowerCase());
    // A session cookie should be set so the owner is immediately logged in.
    expect(res.headers["set-cookie"].some((c) => c.startsWith("token="))).toBe(true);
  });

  test("rejects a password under 8 characters", async () => {
    const res = await request(app).post("/api/auth/signup").send({
      restaurantName: "Too Short",
      email: uniqueEmail("short"),
      password: "abc123",
    });
    expect(res.status).toBe(400);
  });

  test("rejects a duplicate email", async () => {
    const email = uniqueEmail("dupe");
    await request(app).post("/api/auth/signup").send({
      restaurantName: "First One",
      email,
      password: "testpassword123",
    });
    const res = await request(app).post("/api/auth/signup").send({
      restaurantName: "Second One",
      email,
      password: "testpassword123",
    });
    expect(res.status).toBe(409);
  });
});

describe("manager login", () => {
  test("logs in with correct credentials", async () => {
    const email = uniqueEmail("login");
    const password = "testpassword123";
    await request(app).post("/api/auth/signup").send({ restaurantName: "Login Test", email, password });

    const res = await request(app).post("/api/auth/login").send({ email, password });
    expect(res.status).toBe(200);
    expect(res.headers["set-cookie"].some((c) => c.startsWith("token="))).toBe(true);
  });

  test("rejects an incorrect password without revealing which part was wrong", async () => {
    const email = uniqueEmail("wrongpass");
    await request(app).post("/api/auth/signup").send({ restaurantName: "Wrong Pass Test", email, password: "testpassword123" });

    const res = await request(app).post("/api/auth/login").send({ email, password: "wrongpassword" });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/incorrect email or password/i);
  });

  test("rejects a login for an email that was never signed up", async () => {
    const res = await request(app).post("/api/auth/login").send({ email: uniqueEmail("ghost"), password: "whatever123" });
    expect(res.status).toBe(401);
  });
});

describe("rate limiting on login", () => {
  test("blocks further attempts once the limit is exceeded", async () => {
    // The limiter buckets by IP, and every request in this file comes from the same
    // loopback address — so this bucket already has a few requests on it from the
    // "manager login" tests above. That's fine: once blocked, a window stays blocked,
    // so the last of these attempts is 429 regardless of the exact running count.
    const email = uniqueEmail("ratelimited");
    const attempts = [];
    for (let i = 0; i < 11; i++) {
      attempts.push(await request(app).post("/api/auth/login").send({ email, password: "wrongpassword" }));
    }
    const lastAttempt = attempts[attempts.length - 1];
    expect(lastAttempt.status).toBe(429);
    expect(lastAttempt.body.error).toMatch(/too many login attempts/i);
  });
});
