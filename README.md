# Shift SMS Backend

Multi-tenant: any restaurant can sign up, log in, and gets its own isolated
staff list and shift board. Posting a shift sends a real text to every
matching staff member, and they can claim it by texting back — no app
required on the staff side.

## How it works

1. A restaurant signs up (`POST /api/auth/signup`) and logs in — everything below is scoped to that restaurant automatically.
2. Manager posts a shift → `POST /api/shifts` → only staff whose `roles` include the shift's `role` get a text like:
   > Open shift: Line Cook — 5pm–close. Jordan called out sick. Can cover it? Reply YES 4F2A to claim.
3. A staffer texts back `YES 4F2A` → they're recorded as a responder for that shift.
4. Manager assigns the shift → `POST /api/shifts/:id/assign` → the winner gets a confirmation text, everyone else who replied gets a "covered" text.

## 1. Get a Twilio number

1. Create a free account at [twilio.com](https://www.twilio.com).
2. Buy a phone number with SMS capability (trial accounts get one free number, but can only text *verified* numbers until you upgrade — fine for testing, not for real staff).
3. From the [console dashboard](https://console.twilio.com), copy your **Account SID** and **Auth Token**.

## 2. Set up the database

This uses Postgres so data survives redeploys (unlike a local file, which most hosts wipe on every deploy).

1. Create a free account at [neon.com](https://neon.com).
2. Create a new project.
3. From the project dashboard, copy the **connection string** (looks like `postgresql://user:password@host.neon.tech/dbname?sslmode=require`).
4. That's your `DATABASE_URL`. Tables are created automatically the first time the server starts — no manual migration step.

## 3. Run it locally

```bash
npm install
cp env.example.txt .env
# edit .env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER,
# DATABASE_URL, and JWT_SECRET (generate one with the command in env.example.txt)
npm start
```

Server runs on `http://localhost:3000`. Open it in a browser and sign up as your first restaurant — that creates your account and logs you in via a session cookie. From there, add staff and post a shift from the page itself.

## 4. Deploy it somewhere public

Twilio needs to reach this server over the internet for inbound replies to
work, so it has to be deployed. Any Node host works; **Render** is the
simplest free option:

1. Push this folder to a GitHub repo.
2. On [render.com](https://render.com), New → Web Service → connect the repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Add your `.env` values under Environment (including `DATABASE_URL` and `JWT_SECRET`).
5. Deploy. Render gives you a URL like `https://your-app.onrender.com`.

(Railway and Fly.io work the same way if you prefer those.)

## 5. Wire up the inbound webhook

In the [Twilio console](https://console.twilio.com) → Phone Numbers → your
number → **Messaging** section → "A message comes in":

- Set it to **Webhook**
- URL: `https://your-app.onrender.com/api/sms/inbound`
- Method: `HTTP POST`

Now staff replies actually get processed instead of just landing in Twilio.

## API reference

Everything except auth and the Twilio webhook requires being logged in (session cookie set on signup/login).

| Method | Path | Body | Does |
|---|---|---|---|
| POST | `/api/auth/signup` | `{restaurantName, email, password}` | create a restaurant + account, logs in |
| POST | `/api/auth/login` | `{email, password}` | log in |
| POST | `/api/auth/logout` | — | clear session |
| GET | `/api/auth/me` | — | current restaurant + email |
| GET | `/api/staff` | — | list staff |
| POST | `/api/staff` | `{name, phone, roles: []}` | add staff |
| PATCH | `/api/staff/:id` | `{name?, phone?, roles?}` | edit staff |
| DELETE | `/api/staff/:id` | — | remove staff |
| GET | `/api/shifts` | — | list shifts |
| POST | `/api/shifts` | `{role, time, note}` | create shift + broadcast SMS |
| POST | `/api/shifts/:id/assign` | `{staffId}` | assign + send confirm/covered texts |
| DELETE | `/api/shifts/:id` | — | remove a shift |
| POST | `/api/sms/inbound` | (Twilio form data) | webhook Twilio calls on incoming texts |

## Scaling notes

- **Dedicated numbers per restaurant are supported.** Assign one in the Platform Dashboard (Restaurants table → "Twilio number" column) once you've purchased it in Twilio. Inbound texts are then resolved unambiguously by which number they arrived on. Any restaurant without a dedicated number assigned falls back to the shared default number, with best-effort phone-only lookup — fine for early restaurants, but a phone number shared by staff at two such restaurants could resolve to the wrong one. Assigning dedicated numbers removes that ambiguity entirely.
- **Database is already multi-tenant-shaped.** Every table has a `restaurant_id`, so growth here means more rows, not a redesign.
- **Passwords** are hashed with bcrypt; sessions are signed JWTs in an httpOnly cookie — standard, reasonable defaults for an early-stage product.

## Automated tests

A test suite covers authentication, the full shift lifecycle, and — most importantly — **tenant isolation**: that one restaurant's data can never be seen or modified by another, across staff, shifts, hiring, scheduling, and sales data.

### One-time setup

1. **Create a dedicated test database.** Never use your real one — the test suite wipes it clean every run. Easiest option: create a second, free Neon project named something like `shift-sms-backend-test`.
2. Copy `env.test.txt` to `.env.test`:
   ```bash
   cp env.test.txt .env.test
   ```
3. Edit `.env.test` and paste your test database's connection string into `DATABASE_URL`. Everything else in that file already has safe placeholder values — Twilio is fully mocked, so no real SMS is ever sent and no real Twilio account is needed.
4. Install the test tools:
   ```bash
   npm install
   ```

### Running tests

```bash
npm test
```

That's it — no server needs to be running separately; the test suite starts its own in-process copy of the app for each test file.

### What's covered

- **`tests/auth.test.js`** — manager signup/login, validation, and a real check that the login rate limiter actually blocks after repeated failures
- **`tests/tenant-isolation.test.js`** — the most important file: creates two separate restaurants and confirms neither can see, edit, or delete the other's staff, shifts, job postings, schedule, or sales data, even when directly guessing the other's IDs. Also specifically tests the dedicated-number scenario (same phone number staffed at two restaurants) that an earlier security audit found and fixed.
- **`tests/staff-and-shifts.test.js`** — staff validation and the full shift lifecycle: post → respond → assign → filled

This isn't exhaustive coverage of every endpoint — it's a strong foundation focused on the areas where a bug would be most costly (cross-restaurant data leaks) or most visible (core daily workflows). Adding a new endpoint later is a good moment to add a matching test alongside it, following the same patterns.

### Safety note

The test suite refuses to run at all unless `.env.test` explicitly sets `ALLOW_TEST_DB_WIPE=true` — a deliberate extra confirmation that whatever `DATABASE_URL` is set to really is a disposable test database, not your real one.

## Going to production

- **Webhook security**: the inbound endpoint currently trusts any POST to `/api/sms/inbound`. Before going live, verify requests are actually from Twilio using [`twilio.validateExpressRequest`](https://www.twilio.com/docs/usage/webhooks/webhooks-security) with your auth token.
- **Trial account limits**: a Twilio trial account can only text numbers you've manually verified in the console, and prepends "Sent from a Twilio trial account" to every message. Upgrade to a paid account to text real staff.
- **Costs**: each text costs a small amount (roughly $0.0079/segment in the US at time of writing) — check [Twilio's pricing](https://www.twilio.com/en-us/sms/pricing/us) for current rates. Neon's free tier covers a good number of small restaurants before you'd need to upgrade.
