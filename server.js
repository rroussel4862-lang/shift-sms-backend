// Shift SMS backend
// -------------------
// Multi-tenant: any restaurant can sign up, log in, and gets its own
// isolated staff list and shift board. Every restaurant-owned table has a
// restaurant_id column, scoped automatically from whoever's logged in.
//
// What it does:
//   - Manager posts a shift  -> every staff member gets a text immediately.
//   - Staff reply "YES 4F2A" -> they're recorded as available for that shift.
//   - Manager assigns a shift -> the winner gets a confirmation text,
//                                everyone else who replied gets a "covered" text.
//
// Twilio note: all restaurants currently share ONE Twilio number (kept
// simple + free to start). Inbound replies are routed to the right
// restaurant by looking up which restaurant that phone number's staffer
// belongs to — so a given phone number can only be staff at one restaurant
// in the whole system for now. Dedicated numbers per restaurant is a
// natural upsell later (see README "Scaling notes").

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const twilio = require("twilio");
const { Pool } = require("pg");
const rateLimit = require("express-rate-limit");

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  DATABASE_URL,
  JWT_SECRET,
  ANTHROPIC_API_KEY,
  PLATFORM_SETUP_KEY,
  PORT = 3000,
  PUBLIC_URL = "",
  ALLOWED_ORIGINS = "",
} = process.env;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
  console.error(
    "Missing Twilio env vars. Copy .env.example to .env and fill in TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER."
  );
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL. Set it to your Postgres connection string (see README "Database setup").');
  process.exit(1);
}
if (!JWT_SECRET) {
  console.error("Missing JWT_SECRET. Set it to any long random string (used to sign login sessions).");
  process.exit(1);
}

if (String(JWT_SECRET).length < 32 && process.env.NODE_ENV !== "test") {
  console.warn("WARNING: JWT_SECRET is shorter than 32 characters — use a long random string (anyone who learns it can forge logins).");
}

const demo = require("./demo");
// Ids of demo restaurants (made-up restaurants shown to prospects): they never send real texts, never log to the live activity feed and never search the web.
const demoIds = new Set([demo.DEMO_RESTAURANT_ID]);
async function loadDemoIds() {
  const { rows } = await pool.query("SELECT id FROM restaurants WHERE is_demo = true");
  rows.forEach((r) => demoIds.add(r.id));
}

const smsClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS restaurants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
  `);
  await pool.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS address TEXT;`);
  await pool.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS twilio_phone_number TEXT UNIQUE;`);
  await pool.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS demo_seeded_on TEXT;`);
  // Terms of Service acceptance at sign-up: when, and which version of the text they agreed to.
  await pool.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS terms_accepted_at BIGINT;`);
  await pool.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS terms_version TEXT;`);
  // Billing (Stripe). Every restaurant that existed before billing is 'exempt' (no charge, no cut-off) until you change it from the dashboard.
  // billing_status: exempt | free (free until free_until) | unpaid (signed up, not paid yet) | active | past_due | canceled
  await pool.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS billing_status TEXT NOT NULL DEFAULT 'exempt';`);
  await pool.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS free_until BIGINT;`);
  await pool.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;`);
  await pool.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;`);
  await pool.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS billing_period_end BIGINT;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pos_connections (
      restaurant_id TEXT PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
      provider TEXT NOT NULL DEFAULT 'veloce',
      licence_number TEXT,
      location_id TEXT,
      location_name TEXT,
      email TEXT,
      password_enc TEXT,
      token_enc TEXT,
      token_expires BIGINT,
      status TEXT NOT NULL DEFAULT 'new',
      last_error TEXT,
      last_ok_at BIGINT,
      updated_at BIGINT
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
  `);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      roles JSONB NOT NULL DEFAULT '[]'::jsonb
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS staff_restaurant_idx ON staff (restaurant_id);`);
  await pool.query(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS hourly_rate NUMERIC;`);
  await pool.query(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS hire_date TEXT;`);
  await pool.query(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS address TEXT;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS staff_phone_idx ON staff (phone);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS shifts (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      time TEXT,
      note TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      posted_at BIGINT NOT NULL,
      filled_at BIGINT,
      assigned_to TEXT,
      responders JSONB NOT NULL DEFAULT '[]'::jsonb
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS shifts_restaurant_idx ON shifts (restaurant_id);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS job_postings (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      role TEXT,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at BIGINT NOT NULL
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS postings_restaurant_idx ON job_postings (restaurant_id);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS applications (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      posting_id TEXT NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      note TEXT,
      stage TEXT NOT NULL DEFAULT 'applied',
      interview_time TEXT,
      created_at BIGINT NOT NULL
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS applications_restaurant_idx ON applications (restaurant_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS applications_posting_idx ON applications (posting_id);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schedule_shifts (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
      shift_date DATE NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      role TEXT,
      created_at BIGINT NOT NULL
    );
  `);
  // Punch clock: what the person really worked. Applying a punch rewrites start_time / end_time (so the grid, payroll
  // and labor numbers all follow) and keeps the originally scheduled times so a punch can be undone.
  await pool.query(`ALTER TABLE schedule_shifts ADD COLUMN IF NOT EXISTS punch_in TEXT;`);
  await pool.query(`ALTER TABLE schedule_shifts ADD COLUMN IF NOT EXISTS punch_out TEXT;`);
  await pool.query(`ALTER TABLE schedule_shifts ADD COLUMN IF NOT EXISTS scheduled_start TEXT;`);
  await pool.query(`ALTER TABLE schedule_shifts ADD COLUMN IF NOT EXISTS scheduled_end TEXT;`);
  await pool.query(`ALTER TABLE schedule_shifts ADD COLUMN IF NOT EXISTS station TEXT;`); // kitchen station for the shift (Grill, ...), optional
  // Publishing: a FUTURE week stays hidden from staff until the manager publishes it. The current and past weeks are always live.
  // The first time this table is created, every week that already has shifts is marked published so nothing vanishes from staff.
  const { rows: pubExists } = await pool.query(`SELECT to_regclass('schedule_published') AS t`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schedule_published (
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      week_start TEXT NOT NULL,
      published_at BIGINT NOT NULL,
      PRIMARY KEY (restaurant_id, week_start)
    );
  `);
  if (!pubExists[0].t) {
    await pool.query(`
      INSERT INTO schedule_published (restaurant_id, week_start, published_at)
      SELECT DISTINCT restaurant_id, to_char(shift_date - ((EXTRACT(ISODOW FROM shift_date)::int - 1) * INTERVAL '1 day'), 'YYYY-MM-DD'), $1::bigint
      FROM schedule_shifts
      ON CONFLICT DO NOTHING
    `, [Date.now()]);
  }
  // Front of House and Back of House are posted separately. Every week that was already posted counts as posted for BOTH houses,
  // so nothing disappears from anyone's portal when this ships. (Runs once: the "house" column doesn't exist yet the first time.)
  {
    const { rows: hasHouse } = await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'schedule_published' AND column_name = 'house'`);
    if (!hasHouse.length) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`ALTER TABLE schedule_published ADD COLUMN house TEXT NOT NULL DEFAULT 'foh'`);
        await client.query(`ALTER TABLE schedule_published DROP CONSTRAINT IF EXISTS schedule_published_pkey`);
        await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS schedule_published_house_uq ON schedule_published (restaurant_id, week_start, house)`);
        await client.query(`INSERT INTO schedule_published (restaurant_id, week_start, published_at, house) SELECT restaurant_id, week_start, published_at, 'boh' FROM schedule_published WHERE house = 'foh' ON CONFLICT DO NOTHING`);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    }
  }
  // A copy of each house's week at the moment it was posted, so "copy last week" can bring back exactly what was posted
  // (a shift cancelled later in the week is gone from the grid but is still in here).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schedule_snapshots (
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      week_start DATE NOT NULL,
      house TEXT NOT NULL,
      taken_at BIGINT NOT NULL,
      shifts JSONB NOT NULL,
      PRIMARY KEY (restaurant_id, week_start, house)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS schedule_shifts_restaurant_idx ON schedule_shifts (restaurant_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS schedule_shifts_date_idx ON schedule_shifts (shift_date);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sales_projections (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      proj_date DATE NOT NULL,
      projected_amount NUMERIC,
      created_at BIGINT NOT NULL,
      UNIQUE(restaurant_id, proj_date)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS sales_projections_restaurant_idx ON sales_projections (restaurant_id);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS actual_sales (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      sale_date DATE NOT NULL,
      amount NUMERIC,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at BIGINT NOT NULL,
      UNIQUE(restaurant_id, sale_date)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS actual_sales_restaurant_idx ON actual_sales (restaurant_id);`);
  // Food / beverage split of each day's sales. `amount` stays the day's total (food + beverage, or a POS total with no split).
  await pool.query(`ALTER TABLE actual_sales ADD COLUMN IF NOT EXISTS food_amount NUMERIC;`);
  await pool.query(`ALTER TABLE actual_sales ADD COLUMN IF NOT EXISTS bev_amount NUMERIC;`);
  // Lunch/brunch share of the day's sales (dinner = day total minus lunch/brunch). Same idea for the projection.
  await pool.query(`ALTER TABLE actual_sales ADD COLUMN IF NOT EXISTS lunch_amount NUMERIC;`);
  await pool.query(`ALTER TABLE sales_projections ADD COLUMN IF NOT EXISTS lunch_amount NUMERIC;`);
  // What the restaurant sold on the same weekday a year earlier (typed in from POS history; shown on the manager's daily snapshot).
  await pool.query(`ALTER TABLE sales_projections ADD COLUMN IF NOT EXISTS last_year_amount NUMERIC;`);
  // Forecast = lunch/brunch + dinner (typed by the manager); projected_amount stays the day's total so every older consumer keeps working.
  await pool.query(`ALTER TABLE sales_projections ADD COLUMN IF NOT EXISTS dinner_amount NUMERIC;`);
  await pool.query(`ALTER TABLE sales_projections ADD COLUMN IF NOT EXISTS ai_amount NUMERIC;`);
  await pool.query(`ALTER TABLE actual_sales ADD COLUMN IF NOT EXISTS dinner_amount NUMERIC;`);
  // Each restaurant defines its own services (breakfast / lunch / dinner / ...). Sales per service live in a JSON map
  // {serviceId: amount}; the old lunch/dinner columns are migrated into it once and no longer written.
  await pool.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS services JSONB;`);
  // "Getting started" walk-through progress, one row per person and tour (manager / staff). Managers who existed before the
  // tour shipped are marked done the first time the table is created, so they are not surprised by it.
  const { rows: tourExists } = await pool.query(`SELECT to_regclass('public.tour_progress') IS NOT NULL AS t`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tour_progress (
      subject TEXT NOT NULL,
      tour TEXT NOT NULL,
      status TEXT NOT NULL,
      step INTEGER NOT NULL DEFAULT 0,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (subject, tour)
    );
  `);
  if (!tourExists[0].t) {
    await pool.query(
      `INSERT INTO tour_progress (subject, tour, status, step, updated_at) SELECT 'user:' || id, 'manager', 'done', 0, $1::bigint FROM users ON CONFLICT DO NOTHING`,
      [Date.now()]
    );
  }
  await pool.query(`ALTER TABLE sales_projections ADD COLUMN IF NOT EXISTS service_amounts JSONB;`);
  await pool.query(`ALTER TABLE actual_sales ADD COLUMN IF NOT EXISTS service_amounts JSONB;`);
  // Food / beverage split PER SERVICE: {serviceId: {food, bev}}. The day's food_amount / bev_amount / amount stay the sums of it.
  await pool.query(`ALTER TABLE actual_sales ADD COLUMN IF NOT EXISTS service_split JSONB;`);
  await pool.query(`UPDATE sales_projections SET service_amounts = jsonb_strip_nulls(jsonb_build_object('lunch', lunch_amount, 'dinner', dinner_amount))
                    WHERE service_amounts IS NULL AND (lunch_amount IS NOT NULL OR dinner_amount IS NOT NULL)`);
  await pool.query(`UPDATE actual_sales SET service_amounts = jsonb_strip_nulls(jsonb_build_object('lunch', lunch_amount, 'dinner', dinner_amount))
                    WHERE service_amounts IS NULL AND (lunch_amount IS NOT NULL OR dinner_amount IS NOT NULL)`);
  // Where the restaurant is (geocoded from its address) and a per-day cache of weather / nearby events for the daily snapshot.
  await pool.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS geo_lat DOUBLE PRECISION;`);
  await pool.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS geo_lon DOUBLE PRECISION;`);
  await pool.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS geo_for TEXT;`);
  await pool.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS geo_place TEXT;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS day_context (
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      day DATE NOT NULL,
      weather JSONB,
      weather_at BIGINT,
      events JSONB,
      events_at BIGINT,
      events_error TEXT,
      PRIMARY KEY (restaurant_id, day)
    );
  `);

  // Food / beverage cost as a percent of sales (entered by the manager until a POS/inventory integration exists)
  await pool.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS food_cost_pct NUMERIC;`);
  await pool.query(`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS bev_cost_pct NUMERIC;`);

  // Training: courses, manuals and contracts, each assigned to staff with per-person completion
  await pool.query(`
    CREATE TABLE IF NOT EXISTS training_items (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      minutes INTEGER,
      created_at BIGINT NOT NULL
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS training_items_restaurant_idx ON training_items (restaurant_id);`);
  // Optional attached file (course video, manual PDF, contract...) stored in the database so it survives Render redeploys
  await pool.query(`ALTER TABLE training_items ADD COLUMN IF NOT EXISTS file_name TEXT;`);
  await pool.query(`ALTER TABLE training_items ADD COLUMN IF NOT EXISTS file_type TEXT;`);
  await pool.query(`ALTER TABLE training_items ADD COLUMN IF NOT EXISTS file_size INTEGER;`);
  await pool.query(`ALTER TABLE training_items ADD COLUMN IF NOT EXISTS file_data BYTEA;`);
  await pool.query(`ALTER TABLE training_items ADD COLUMN IF NOT EXISTS link_url TEXT;`); // a web link (video, article) instead of, or next to, a file
  // Several files per course / manual / contract. (The single-file columns above are the old storage; their files are moved here once.)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS training_files (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL REFERENCES training_items(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      size INTEGER NOT NULL,
      data BYTEA NOT NULL,
      created_at BIGINT NOT NULL
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS training_files_item_idx ON training_files (item_id);`);
  await pool.query(`
    WITH moved AS (
      INSERT INTO training_files (id, item_id, name, type, size, data, created_at)
      SELECT md5(random()::text || id), id, file_name, COALESCE(file_type, 'application/octet-stream'), COALESCE(file_size, octet_length(file_data)), file_data, created_at
        FROM training_items WHERE file_data IS NOT NULL AND file_name IS NOT NULL
      RETURNING item_id
    )
    UPDATE training_items SET file_name = NULL, file_type = NULL, file_size = NULL, file_data = NULL WHERE id IN (SELECT item_id FROM moved);
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS training_assignments (
      item_id TEXT NOT NULL REFERENCES training_items(id) ON DELETE CASCADE,
      staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
      completed_at BIGINT,
      PRIMARY KEY (item_id, staff_id)
    );
  `);

  // Team message board: manager posts shown to every staff member, with a per-person "Got it"
  await pool.query(`
    CREATE TABLE IF NOT EXISTS board_posts (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL,
      pinned BOOLEAN NOT NULL DEFAULT FALSE,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS board_posts_restaurant_idx ON board_posts (restaurant_id);`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS board_acks (
      post_id TEXT NOT NULL REFERENCES board_posts(id) ON DELETE CASCADE,
      staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
      acked_at BIGINT NOT NULL,
      PRIMARY KEY (post_id, staff_id)
    );
  `);
  await pool.query(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS board_seen_at BIGINT;`);
  await pool.query(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS schedule_seen_at BIGINT;`);
  await pool.query(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS archived_at BIGINT;`);
  await pool.query(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS hide_from_schedule BOOLEAN NOT NULL DEFAULT FALSE;`); // has a role (e.g. manager login) but is never scheduled
  await pool.query(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS manager_owner_id TEXT;`); // the manager login (owners row) given to this person // removed from the app but kept for shift and payroll history
  await pool.query(`ALTER TABLE board_posts ADD COLUMN IF NOT EXISTS translations JSONB;`);

  // Manually entered weekly sales for past years (keyed by that week's Monday) so this year can be compared to last year
  await pool.query(`
    CREATE TABLE IF NOT EXISTS weekly_sales_history (
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      week_start DATE NOT NULL,
      amount NUMERIC NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (restaurant_id, week_start)
    );
  `);

  await pool.query(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS email TEXT UNIQUE;`);
  await pool.query(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS password_hash TEXT;`);
  await pool.query(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS claim_token TEXT UNIQUE;`);
  await pool.query(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS claim_token_at BIGINT;`); // when the setup link was sent (links expire after 14 days)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff_availability (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      staff_id TEXT NOT NULL UNIQUE REFERENCES staff(id) ON DELETE CASCADE,
      availability JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at BIGINT NOT NULL
    );
  `);

  // What staff submit waits in `pending` until a manager approves it; only `availability` (approved) is used for scheduling.
  // One-time unavailability (a specific date, all day or between two times). Each one is a request a manager approves.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff_time_off (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
      off_date TEXT NOT NULL,
      from_time TEXT,
      to_time TEXT,
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at BIGINT NOT NULL,
      decided_at BIGINT
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS staff_time_off_restaurant_date ON staff_time_off (restaurant_id, off_date);`);
  await pool.query(`ALTER TABLE staff_availability ADD COLUMN IF NOT EXISTS pending JSONB;`);
  await pool.query(`ALTER TABLE staff_availability ADD COLUMN IF NOT EXISTS pending_at BIGINT;`);
  await pool.query(`ALTER TABLE staff_availability ADD COLUMN IF NOT EXISTS decision TEXT;`);
  await pool.query(`ALTER TABLE staff_availability ADD COLUMN IF NOT EXISTS decision_at BIGINT;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS shift_swaps (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      shift_id TEXT NOT NULL REFERENCES schedule_shifts(id) ON DELETE CASCADE,
      from_staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      note TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      to_staff_id TEXT REFERENCES staff(id) ON DELETE CASCADE,
      swap_shift_id TEXT REFERENCES schedule_shifts(id) ON DELETE CASCADE,
      created_at BIGINT NOT NULL,
      accepted_at BIGINT,
      resolved_at BIGINT
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS shift_swaps_restaurant_idx ON shift_swaps (restaurant_id, status);`);
  await pool.query(`ALTER TABLE shift_swaps ADD COLUMN IF NOT EXISTS from_hidden BOOLEAN NOT NULL DEFAULT false;`); // the person who offered cleared this finished ticket
  await pool.query(`ALTER TABLE shift_swaps ADD COLUMN IF NOT EXISTS to_hidden BOOLEAN NOT NULL DEFAULT false;`);   // the person who took it did
  await pool.query(`ALTER TABLE shift_swaps ADD COLUMN IF NOT EXISTS manager_hidden BOOLEAN NOT NULL DEFAULT false;`); // a manager cleared this finished ticket from their list

  // ---------- restaurant owners (own one or more restaurants; read-only snapshot across all of them) ----------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS owners (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      last_login_at BIGINT
    );
  `);
  await pool.query(`ALTER TABLE owners ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'owner';`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS owner_restaurants (
      owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      PRIMARY KEY (owner_id, restaurant_id)
    );
  `);

  // ---------- platform-owner layer (you / devs — not tied to any one restaurant) ----------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform_admins (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT REFERENCES restaurants(id) ON DELETE SET NULL,
      event_type TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'info',
      detail TEXT,
      duration_ms INTEGER,
      created_at BIGINT NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_usage (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT REFERENCES restaurants(id) ON DELETE SET NULL,
      feature TEXT NOT NULL,
      model TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      searches INTEGER NOT NULL DEFAULT 0,
      cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS ai_usage_restaurant_idx ON ai_usage (restaurant_id, created_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ai_usage_created_idx ON ai_usage (created_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS activity_log_restaurant_idx ON activity_log (restaurant_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS activity_log_created_idx ON activity_log (created_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS activity_log_type_idx ON activity_log (event_type);`);
  // Long-term daily totals. Raw activity_log rows older than the retention window
  // are rolled up into this table (per local day / restaurant / event type) and deleted.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS activity_daily (
      day DATE NOT NULL,
      restaurant_id TEXT NOT NULL DEFAULT '',
      event_type TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'info',
      n INTEGER NOT NULL DEFAULT 0,
      dur_total BIGINT NOT NULL DEFAULT 0,
      dur_n INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, restaurant_id, event_type, level)
    );
  `);
  await loadDemoIds();
}

// ---------- helpers ----------

function id() {
  return crypto.randomBytes(6).toString("hex");
}

// Lightweight activity/event logging for the platform-owner dashboard.
// Never throws — a logging failure should never break the actual request.
async function logActivity({ restaurantId = null, eventType, level = "info", detail = "", durationMs = null }) {
  if (restaurantId && demoIds.has(restaurantId)) return; // the demo restaurant stays out of the live feed
  try {
    await pool.query(
      "INSERT INTO activity_log (id, restaurant_id, event_type, level, detail, duration_ms, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [id(), restaurantId, eventType, level, detail, durationMs, Date.now()]
    );
  } catch (e) {
    console.error("logActivity failed:", e.message);
  }
}
function shortCode(shiftId) {
  return shiftId.slice(0, 4).toUpperCase();
}
function normalizePhone(raw) {
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
// Every SMS goes out in French first, then English, separated by a blank line.
function bilingual(fr, en) {
  return `${fr}\n\n${en}`;
}

async function sendSms(to, body, restaurantId = null) {
  if (restaurantId && demoIds.has(restaurantId)) return { to, ok: true, demo: true }; // demo restaurant: pretend, never text anyone
  const startedAt = Date.now();
  let fromNumber = TWILIO_PHONE_NUMBER;
  if (restaurantId) {
    try {
      const { rows } = await pool.query("SELECT twilio_phone_number FROM restaurants WHERE id = $1", [restaurantId]);
      if (rows[0] && rows[0].twilio_phone_number) fromNumber = rows[0].twilio_phone_number;
    } catch (e) {
      console.error("Couldn't look up restaurant's dedicated number, using shared default:", e.message);
    }
  }
  // Safety net against runaway or abusive texting (every text costs money and reaches a real person): a daily cap per restaurant.
  if (restaurantId) {
    try {
      const cap = Number(process.env.SMS_DAILY_CAP) || 300;
      const { rows: sentRows } = await pool.query("SELECT COUNT(*)::int AS n FROM activity_log WHERE restaurant_id = $1 AND event_type = 'sms_sent' AND created_at > $2", [restaurantId, Date.now() - 24 * 60 * 60 * 1000]);
      if (sentRows[0].n >= cap) {
        logActivity({ restaurantId, eventType: "sms_blocked", level: "error", detail: `Daily text limit (${cap}) reached — not texting ${to}` });
        return { to, ok: false, error: "daily text limit reached" };
      }
    } catch (e) {
      console.error("SMS cap check failed (sending anyway):", e.message);
    }
  }
  try {
    await smsClient.messages.create({ to, from: fromNumber, body });
    const durationMs = Date.now() - startedAt;
    logActivity({ restaurantId, eventType: "sms_sent", level: "info", detail: `Texted ${to} from ${fromNumber}`, durationMs });
    return { to, ok: true };
  } catch (e) {
    console.error(`SMS to ${to} failed:`, e.message);
    const durationMs = Date.now() - startedAt;
    logActivity({ restaurantId, eventType: "sms_failed", level: "error", detail: `${to}: ${e.message}`, durationMs });
    return { to, ok: false, error: e.message };
  }
}
// Texts one staff member about a manager's decision. Never blocks or fails the request: a failed text is only logged.
async function notifyStaff(restaurantId, staffId, fr, en) {
  try {
    const { rows } = await pool.query("SELECT phone FROM staff WHERE id = $1 AND restaurant_id = $2 AND archived_at IS NULL", [staffId, restaurantId]);
    if (rows[0] && rows[0].phone) await sendSms(rows[0].phone, bilingual(fr, en), restaurantId);
  } catch (e) {
    console.error("Couldn't notify staff:", e.message);
  }
}
function staffRowToJson(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    roles: row.roles,
    archived: !!row.archived_at,
    hideFromSchedule: !!row.hide_from_schedule,
    hasManagerAccess: !!row.manager_owner_id,
    hourlyRate: row.hourly_rate !== null && row.hourly_rate !== undefined ? Number(row.hourly_rate) : null,
    hireDate: row.hire_date || "",
    address: row.address || "",
    email: row.email || "",
    hasLogin: !!row.password_hash,
  };
}
function shiftRowToJson(row) {
  return {
    id: row.id,
    role: row.role,
    time: row.time || "",
    note: row.note || "",
    status: row.status,
    postedAt: Number(row.posted_at),
    filledAt: row.filled_at ? Number(row.filled_at) : undefined,
    assignedTo: row.assigned_to || null,
    responders: row.responders || [],
  };
}
function postingRowToJson(row) {
  return {
    id: row.id,
    title: row.title,
    role: row.role || "",
    description: row.description || "",
    status: row.status,
    createdAt: Number(row.created_at),
  };
}
function applicationRowToJson(row) {
  return {
    id: row.id,
    postingId: row.posting_id,
    name: row.name,
    email: row.email || "",
    phone: row.phone || "",
    note: row.note || "",
    stage: row.stage,
    interviewTime: row.interview_time || "",
    createdAt: Number(row.created_at),
  };
}
function scheduleShiftRowToJson(row) {
  return {
    id: row.id,
    staffId: row.staff_id,
    date: row.shift_date instanceof Date ? row.shift_date.toISOString().slice(0, 10) : row.shift_date,
    startTime: row.start_time,
    endTime: row.end_time,
    role: row.role || "",
    punchIn: row.punch_in || "",
    punchOut: row.punch_out || "",
    scheduledStart: row.scheduled_start || "",
    scheduledEnd: row.scheduled_end || "",
    station: row.station || "",
  };
}

// Kitchen stations a shift can be assigned to (the same names in every language). Anything else is ignored.
const STATIONS = ["Grill", "Dishwasher", "Fryer and Pans", "Garde-Manger"];
const cleanStation = (v) => (STATIONS.includes(v) ? v : null);
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { algorithm: "HS256", expiresIn: "30d" });
}
const COOKIE_OPTS = {
  httpOnly: true,
  // Defaults to true (required for real HTTPS traffic on Render) — only ever
  // turned off by an explicit COOKIE_SECURE=false in .env.test, since test runs
  // happen over plain HTTP with no real TLS. Production behavior is unchanged
  // unless this is deliberately set.
  secure: process.env.COOKIE_SECURE !== "false",
  sameSite: "lax",
  maxAge: 30 * 24 * 60 * 60 * 1000,
};

async function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies.token;
  if (!token) return res.status(401).json({ error: "not logged in" });
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
  } catch (e) {
    return res.status(401).json({ error: "session expired — please log in again" });
  }
  if (payload.ownerId) {
    // an owner/manager login is only good while that account still has this restaurant (so removing manager access cuts the session at once)
    try {
      const { rows } = await pool.query("SELECT 1 FROM owner_restaurants WHERE owner_id = $1 AND restaurant_id = $2", [payload.ownerId, payload.restaurantId]);
      if (!rows.length) return res.status(401).json({ error: "not logged in" });
    } catch (e) {
      console.error("Owner session check failed:", e.message);
    }
  }
  req.restaurantId = payload.restaurantId;
  req.userId = payload.userId;
  req.ownerId = payload.ownerId || null; // set when an owner is acting as manager of one of their restaurants
  // A restaurant that hasn't paid (or whose subscription ended) is held at the payment screen. Sign-in, sign-out and billing stay open.
  const url = req.originalUrl.split("?")[0];
  if (!/^\/api\/(auth|billing|owner)\//.test(url)) {
    try {
      const b = await getBilling(req.restaurantId);
      if (b.blocked) return res.status(402).json({ error: "payment required — open Billing to continue", code: "payment_required" });
    } catch (e) {
      console.error("Billing check failed:", e.message);
    }
  }
  next();
}

async function requireStaffAuth(req, res, next) {
  const token = req.cookies && req.cookies.staff_token;
  if (!token) return res.status(401).json({ error: "not logged in" });
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
  } catch (e) {
    return res.status(401).json({ error: "session expired — please log in again" });
  }
  try {
    // someone who was removed from the app loses access straight away, even with a login cookie that hasn't expired
    const { rows } = await pool.query("SELECT archived_at FROM staff WHERE id = $1", [payload.staffId]);
    if (rows[0] && rows[0].archived_at) return res.status(401).json({ error: "not logged in" });
  } catch (e) {
    console.error("Staff session check failed:", e.message);
  }
  // A restaurant that hasn't paid is held back from staff too, with a neutral answer: staff never see anything about payment.
  try {
    if ((await getBilling(payload.restaurantId)).blocked) return res.status(402).json({ error: "unavailable", code: "restaurant_unavailable" });
  } catch (e) {
    console.error("Billing check failed:", e.message);
  }
  req.staffId = payload.staffId;
  req.restaurantId = payload.restaurantId;
  next();
}

function requirePlatformAuth(req, res, next) {
  const token = req.cookies && req.cookies.platform_token;
  if (!token) return res.status(401).json({ error: "not logged in" });
  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
    if (!payload.platformAdminId) throw new Error("not a platform token");
    req.platformAdminId = payload.platformAdminId;
    next();
  } catch (e) {
    return res.status(401).json({ error: "session expired — please log in again" });
  }
}

function requireOwnerAuth(req, res, next) {
  const token = req.cookies && req.cookies.owner_token;
  if (!token) return res.status(401).json({ error: "not logged in" });
  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
    if (!payload.ownerId) throw new Error("not an owner token");
    req.ownerId = payload.ownerId;
    next();
  } catch (e) {
    return res.status(401).json({ error: "session expired — please log in again" });
  }
}

// ---------- app setup ----------

const app = express();

// Express 4 does not catch errors thrown inside async route handlers: the request just hangs and the error shows up as an
// "unhandled rejection". Wrap every route handler so a failure goes to the error handler at the bottom of this file instead.
function wrapAsync(fn) {
  if (typeof fn !== "function" || fn.length >= 4) return fn; // leave error-handling middleware alone
  return function (req, res, next) {
    try {
      const out = fn(req, res, next);
      if (out && typeof out.catch === "function") out.catch(next);
    } catch (e) {
      next(e);
    }
  };
}
const wrapHandlers = (args) => args.map((a) => (Array.isArray(a) ? wrapHandlers(a) : wrapAsync(a)));
for (const verb of ["get", "post", "put", "patch", "delete"]) {
  const original = app[verb].bind(app);
  app[verb] = (...args) => (verb === "get" && args.length === 1 ? original(...args) : original(...wrapHandlers(args))); // app.get("setting") is a settings lookup
}

// A short reference code for each unexpected error — shown to the person and written to the activity log, so one code finds one error.
function makeErrorCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O or 1/I to misread
  const bytes = crypto.randomBytes(6);
  return "E-" + Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

app.disable("x-powered-by");
// Security headers on every response: no content sniffing, no embedding in other sites' frames, HTTPS only once seen over HTTPS,
// and a minimal Content-Security-Policy that blocks framing, plugins and form posts to other sites (it does not restrict scripts).
app.use((req, res, next) => {
  // The one exception: our own app shell (/app.html) shows the main app and the Back Office in frames of the same site.
  // Only those two pages, only when asked for with ?embed=1, and only by pages from our own origin.
  const ownFrame = req.query.embed === "1" && (req.path === "/index.html" || req.path === "/backoffice.html");
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": ownFrame ? "SAMEORIGIN" : "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "Content-Security-Policy": `frame-ancestors ${ownFrame ? "'self'" : "'none'"}; base-uri 'self'; object-src 'none'; form-action 'self'`,
  });
  if (req.secure) res.set("Strict-Transport-Security", "max-age=15552000");
  next();
});
app.set("trust proxy", 1); // Render sits in front of this app — without this, every visitor looks like the same IP to rate limiting
// API answers are always live data: never let a browser or home-screen app reuse an old copy.
app.use("/api", (req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

// ---------- billing (Stripe) ----------
// Nothing here does anything until STRIPE_SECRET_KEY is set. We talk to Stripe's REST API directly (no extra package).
const stripeConfigured = () => !!process.env.STRIPE_SECRET_KEY;

function stripeForm(obj, prefix = "", out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (x !== null && typeof x === "object" ? stripeForm(x, `${key}[${i}]`, out) : out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(x)}`)));
    else if (typeof v === "object") stripeForm(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out;
}

async function stripeApi(pathName, params = {}) {
  const res = await fetch(`https://api.stripe.com/v1/${pathName}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": "2025-03-31.basil",
    },
    body: stripeForm(params).join("&"),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || `Stripe error ${res.status}`;
    const err = new Error(msg);
    err.stripe = true;
    throw err;
  }
  return data;
}

// Checks the Stripe-Signature header on a webhook: HMAC-SHA256 of "timestamp.body", within 5 minutes.
function verifyStripeSignature(rawBody, header, secret, toleranceSec = 300, nowMs = Date.now()) {
  if (!rawBody || !header || !secret) return false;
  const parts = String(header).split(",").map((x) => x.trim().split("="));
  const t = (parts.find((p) => p[0] === "t") || [])[1];
  const sigs = parts.filter((p) => p[0] === "v1").map((p) => p[1]);
  if (!t || !sigs.length || !/^\d+$/.test(t)) return false;
  if (Math.abs(nowMs / 1000 - Number(t)) > toleranceSec) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.`).update(rawBody).digest("hex");
  const eb = Buffer.from(expected);
  return sigs.some((sig) => {
    const sb = Buffer.from(sig);
    return sb.length === eb.length && crypto.timingSafeEqual(sb, eb);
  });
}

// What a restaurant's billing looks like right now. blocked = the managers must pay before using the app.
const billingCache = new Map(); // restaurantId -> { at, row }
function clearBillingCache(restaurantId) { if (restaurantId) billingCache.delete(restaurantId); else billingCache.clear(); }
function billingFromRow(r) {
  const status = (r && r.billing_status) || "exempt";
  const freeUntil = r && r.free_until ? Number(r.free_until) : null;
  const periodEnd = r && r.billing_period_end ? Number(r.billing_period_end) : null;
  const freeOver = status === "free" && freeUntil !== null && freeUntil < Date.now();
  const blocked = status === "unpaid" || status === "canceled" || freeOver;
  return { status: freeOver ? "free_ended" : status, blocked, freeUntil, periodEnd, hasCustomer: !!(r && r.stripe_customer_id), configured: stripeConfigured() };
}
async function getBilling(restaurantId) {
  if (!restaurantId || demoIds.has(restaurantId)) return billingFromRow(null);
  const hit = billingCache.get(restaurantId);
  if (hit && Date.now() - hit.at < 30000) return billingFromRow(hit.row);
  const { rows } = await pool.query("SELECT billing_status, free_until, billing_period_end, stripe_customer_id FROM restaurants WHERE id = $1", [restaurantId]);
  billingCache.set(restaurantId, { at: Date.now(), row: rows[0] || null });
  return billingFromRow(rows[0] || null);
}

const SUBSCRIPTION_STATUS = { active: "active", trialing: "active", past_due: "past_due", unpaid: "unpaid", incomplete: "unpaid", canceled: "canceled", incomplete_expired: "canceled", paused: "canceled" };

async function restaurantForStripe({ restaurantId, customerId }) {
  if (restaurantId) {
    const { rows } = await pool.query("SELECT id FROM restaurants WHERE id = $1", [restaurantId]);
    if (rows[0]) return rows[0].id;
  }
  if (customerId) {
    const { rows } = await pool.query("SELECT id FROM restaurants WHERE stripe_customer_id = $1", [customerId]);
    if (rows[0]) return rows[0].id;
  }
  return null;
}

async function applyStripeEvent(event) {
  const obj = (event.data && event.data.object) || {};
  const type = event.type;
  let status = null, restaurantId = null, extra = {};
  if (type === "checkout.session.completed") {
    restaurantId = await restaurantForStripe({ restaurantId: obj.client_reference_id, customerId: obj.customer });
    if (obj.mode === "subscription" && (obj.payment_status === "paid" || obj.payment_status === "no_payment_required")) status = "active";
    extra = { customer: obj.customer || null, subscription: obj.subscription || null };
  } else if (type === "customer.subscription.created" || type === "customer.subscription.updated" || type === "customer.subscription.deleted") {
    restaurantId = await restaurantForStripe({ restaurantId: obj.metadata && obj.metadata.restaurant_id, customerId: obj.customer });
    status = type === "customer.subscription.deleted" ? "canceled" : SUBSCRIPTION_STATUS[obj.status] || null;
    extra = { customer: obj.customer || null, subscription: obj.id || null, periodEnd: (() => { const t = obj.current_period_end || (obj.items && obj.items.data && obj.items.data[0] && obj.items.data[0].current_period_end); return t ? t * 1000 : null; })() };
  } else if (type === "invoice.payment_failed" || type === "invoice.paid") {
    restaurantId = await restaurantForStripe({ customerId: obj.customer });
    status = type === "invoice.paid" ? "active" : "past_due";
  }
  if (!restaurantId || !status) return false;
  await pool.query(
    `UPDATE restaurants SET billing_status = $1,
       stripe_customer_id = COALESCE($2, stripe_customer_id),
       stripe_subscription_id = COALESCE($3, stripe_subscription_id),
       billing_period_end = COALESCE($4, billing_period_end)
     WHERE id = $5`,
    [status, extra.customer || null, extra.subscription || null, extra.periodEnd || null, restaurantId]
  );
  clearBillingCache(restaurantId);
  logActivity({ restaurantId, eventType: "billing_" + status, level: status === "past_due" ? "warn" : "info", detail: `Stripe: ${type} -> ${status}` });
  return true;
}

// Stripe calls this when a payment succeeds, fails, or a subscription changes. It must read the raw body, so it sits before express.json().
app.post("/api/stripe/webhook", express.raw({ type: "application/json", limit: "1mb" }), async (req, res) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return res.status(503).json({ error: "billing is not set up" });
  if (!verifyStripeSignature(req.body, req.get("Stripe-Signature"), secret)) return res.status(400).json({ error: "bad signature" });
  let event;
  try { event = JSON.parse(req.body.toString("utf8")); } catch (e) { return res.status(400).json({ error: "bad body" }); }
  try {
    await applyStripeEvent(event);
  } catch (e) {
    console.error("Stripe webhook failed:", e.message);
    return res.status(500).json({ error: "could not process" }); // Stripe retries
  }
  res.json({ received: true });
});

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

const allowedOrigins = ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
// The app and its API are served from the same address, so no other website needs access. Without ALLOWED_ORIGINS, send no CORS headers at all.
app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : false, credentials: true }));

app.use(express.static(path.join(__dirname, "public")));

// ---------- rate limiting ----------
// Login endpoints: a real person mistypes their password once or twice; a brute-force
// attempt tries hundreds of times per minute. This gap is wide enough that a tight limit
// never bothers a real user while making guessing attacks impractically slow.
// "iPhone · Safari", "Mac · Chrome" ... from the User-Agent, so the activity log shows which device a login came from.
function deviceLabel(req) {
  const ua = String((req && req.headers && req.headers["user-agent"]) || "");
  if (!ua) return "unknown device";
  const device = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Macintosh|Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows PC" : /CrOS/.test(ua) ? "Chromebook" : /Linux/.test(ua) ? "Linux" : "other device";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /Firefox|FxiOS/.test(ua) ? "Firefox" : /CriOS|Chrome/.test(ua) ? "Chrome" : /Safari/.test(ua) ? "Safari" : "other browser";
  return `${device} · ${browser}`;
}

const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Please wait a few minutes and try again." },
});

// Same idea per ACCOUNT: only failed attempts count, so a guessing attack spread over many addresses still can't try more than a
// handful of passwords per account every 15 minutes (the real person's correct logins are never counted).
const loginEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => "login:" + String((req.body && req.body.email) || "").trim().toLowerCase().slice(0, 200),
  message: { error: "Too many login attempts. Please wait a few minutes and try again." },
});

// Signup/account-setup endpoints: looser than login (legitimate retries happen here —
// mistyped email, chosen password rejected for length, etc.) but still capped against
// automated account-creation spam.
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please wait a bit and try again." },
});

// AI agent: each question costs real money (Anthropic API usage). This caps the worst case
// per restaurant rather than per visitor, so one restaurant's heavy use — or a bug firing
// repeated requests — can't run up unbounded costs or affect other restaurants.
const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: (req) => (demoIds.has(req.restaurantId) ? 8 : 30), // the demo is open to prospects, so it gets a smaller AI allowance
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.restaurantId || req.ip,
  message: { error: "This restaurant has reached the hourly limit for AI questions. Please try again later." },
});

// ---------- auth endpoints ----------

// Bump this whenever public/terms.html changes in a way customers must re-accept.
const TERMS_VERSION = "2026-10-27";

app.post("/api/auth/signup", signupLimiter, async (req, res) => {
  const { restaurantName, email, password, acceptTerms } = req.body || {};
  if (!restaurantName || !restaurantName.trim()) return res.status(400).json({ error: "restaurant name is required" });
  if (!email || !isValidEmail(email)) return res.status(400).json({ error: "a valid email is required" });
  if (!password || password.length < 8) return res.status(400).json({ error: "password must be at least 8 characters" });
  if (acceptTerms !== true) return res.status(400).json({ error: "you must agree to the Terms of Service to create an account", code: "terms_required" });

  const { rows: existing } = await pool.query("SELECT id FROM users WHERE email = $1", [email.toLowerCase()]);
  if (existing.length > 0) return res.status(409).json({ error: "an account with that email already exists" });

  const restaurantId = id();
  const userId = id();
  const passwordHash = await bcrypt.hash(password, 10);
  const now = Date.now();

  // With billing set up, a new restaurant starts unpaid and goes straight to checkout; without it, the app stays open as before.
  await pool.query("INSERT INTO restaurants (id, name, created_at, terms_accepted_at, terms_version, billing_status) VALUES ($1,$2,$3,$4,$5,$6)", [restaurantId, restaurantName.trim(), now, now, TERMS_VERSION, stripeConfigured() ? "unpaid" : "exempt"]);
  await pool.query(
    "INSERT INTO users (id, restaurant_id, email, password_hash, created_at) VALUES ($1,$2,$3,$4,$5)",
    [userId, restaurantId, email.toLowerCase(), passwordHash, now]
  );

  const token = signToken({ userId, restaurantId });
  res.cookie("token", token, COOKIE_OPTS);
  logActivity({ restaurantId, eventType: "restaurant_signup", detail: `${restaurantName.trim()} (${email.toLowerCase()}) accepted Terms ${TERMS_VERSION}` });
  res.status(201).json({ restaurant: { id: restaurantId, name: restaurantName.trim() }, email: email.toLowerCase(), demo: false, newDesign: true });
});

app.post("/api/auth/login", loginLimiter, loginEmailLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email and password are required" });

  const { rows } = await pool.query(
    `SELECT users.*, restaurants.name AS restaurant_name, restaurants.address AS restaurant_address FROM users
     JOIN restaurants ON restaurants.id = users.restaurant_id
     WHERE users.email = $1`,
    [email.toLowerCase()]
  );
  const user = rows[0];
  if (!user) {
    // Logins made from the dashboard (managers and owners) live in the owners table. Accept them here too, so the
    // main page works as well as /owner.html: one restaurant opens straight away, several go to the owner page.
    const { rows: orows } = await pool.query("SELECT * FROM owners WHERE email = $1", [String(email).trim().toLowerCase()]);
    const owner = orows[0];
    if (owner && (await bcrypt.compare(password, owner.password_hash))) {
      await pool.query("UPDATE owners SET last_login_at = $1 WHERE id = $2", [Date.now(), owner.id]);
      res.cookie("owner_token", signToken({ ownerId: owner.id }), COOKIE_OPTS);
      const { rows: rs } = await pool.query(
        "SELECT r.id, r.name, r.address FROM owner_restaurants x JOIN restaurants r ON r.id = x.restaurant_id WHERE x.owner_id = $1 ORDER BY r.name",
        [owner.id]
      );
      logActivity({ restaurantId: rs.length === 1 ? rs[0].id : null, eventType: "login_success", detail: `${owner.role === "manager" ? "manager" : "owner"} login via main page: ${owner.email} [${deviceLabel(req)}]` });
      if (rs.length !== 1) return res.json({ redirect: "/owner.html" });
      res.cookie("token", signToken({ restaurantId: rs[0].id, ownerId: owner.id }), COOKIE_OPTS);
      return res.json({ restaurant: { id: rs[0].id, name: rs[0].name, address: rs[0].address || "" }, email: owner.email, viaOwner: true, canSwitch: false, demo: demoIds.has(rs[0].id), newDesign: true });
    }
    logActivity({ eventType: "login_failed", level: "warn", detail: `manager login failed: ${email.toLowerCase()} (${owner ? "wrong password" : "no such account"}) [main page, ${deviceLabel(req)}]` });
    return res.status(401).json({ error: "incorrect email or password" });
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    logActivity({ restaurantId: user.restaurant_id, eventType: "login_failed", level: "warn", detail: `manager login failed: ${email.toLowerCase()} (wrong password) [main page, ${deviceLabel(req)}]` });
    return res.status(401).json({ error: "incorrect email or password" });
  }

  const token = signToken({ userId: user.id, restaurantId: user.restaurant_id });
  res.cookie("token", token, COOKIE_OPTS);
  logActivity({ restaurantId: user.restaurant_id, eventType: "login_success", detail: `manager login: ${email.toLowerCase()} [main page, ${deviceLabel(req)}]` });
  res.json({ restaurant: { id: user.restaurant_id, name: user.restaurant_name, address: user.restaurant_address || "" }, email: user.email, demo: demoIds.has(user.restaurant_id), newDesign: true });
});

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("token", { ...COOKIE_OPTS, maxAge: undefined });
  res.status(204).end();
});

// ----- billing routes (managers) -----
app.get("/api/billing/status", requireAuth, async (req, res) => {
  const b = await getBilling(req.restaurantId);
  res.json({ status: b.status, blocked: b.blocked, freeUntil: b.freeUntil, periodEnd: b.periodEnd, canManage: b.hasCustomer, configured: b.configured });
});

// Starts a Stripe Checkout page for this restaurant's subscription: $100 CAD/month (the price set in STRIPE_PRICE_ID), card, charged every month.
app.post("/api/billing/checkout", requireAuth, async (req, res) => {
  if (!stripeConfigured() || !process.env.STRIPE_PRICE_ID) return res.status(503).json({ error: "billing is not set up yet" });
  const rid = req.restaurantId;
  if (demoIds.has(rid)) return res.status(400).json({ error: "the demo restaurant has no billing" });
  try {
    const { rows } = await pool.query("SELECT name, billing_status, free_until, stripe_customer_id FROM restaurants WHERE id = $1", [rid]);
    const r = rows[0];
    if (!r) return res.status(404).json({ error: "restaurant not found" });
    if (r.billing_status === "active" || r.billing_status === "past_due") return res.status(409).json({ error: "this restaurant already has a subscription — use Manage billing" });
    let email = "";
    if (req.userId) email = ((await pool.query("SELECT email FROM users WHERE id = $1", [req.userId])).rows[0] || {}).email || "";
    else if (req.ownerId) email = ((await pool.query("SELECT email FROM owners WHERE id = $1", [req.ownerId])).rows[0] || {}).email || "";
    let customerId = r.stripe_customer_id;
    if (!customerId) {
      const c = await stripeApi("customers", { name: r.name, email: email || undefined, metadata: { restaurant_id: rid } });
      customerId = c.id;
      await pool.query("UPDATE restaurants SET stripe_customer_id = $1 WHERE id = $2", [customerId, rid]);
    }
    const base = (PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
    const taxRates = (process.env.STRIPE_TAX_RATE_IDS || "").split(",").map((x) => x.trim()).filter(Boolean);
    const lang = ["fr", "en"].includes(req.body && req.body.locale) ? req.body.locale : "auto";
    const params = {
      mode: "subscription",
      customer: customerId,
      client_reference_id: rid,
      locale: lang,
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1, ...(taxRates.length ? { tax_rates: taxRates } : {}) }],
      subscription_data: { metadata: { restaurant_id: rid } },
      success_url: `${base}/?billing=success`,
      cancel_url: `${base}/?billing=canceled`,
    };
    if (taxRates.length) params.automatic_tax = { enabled: false }; // manual rates and automatic tax can't be mixed; newer Stripe accounts may default automatic tax on
    if (!taxRates.length && process.env.STRIPE_AUTOMATIC_TAX === "1") {
      params.automatic_tax = { enabled: true };
      params.billing_address_collection = "required";
      params.customer_update = { address: "auto" };
    }
    // Free until a later date: collect the card now, and Stripe makes the first charge on that date (Checkout needs it 2+ days away).
    if (r.billing_status === "free" && r.free_until && Number(r.free_until) > Date.now() + 49 * 3600 * 1000) {
      params.subscription_data.trial_end = Math.floor(Number(r.free_until) / 1000);
    }
    const session = await stripeApi("checkout/sessions", params);
    res.json({ url: session.url });
  } catch (e) {
    console.error("Checkout failed:", e.message);
    res.status(502).json({ error: "Could not reach the payment page. Please try again in a moment." });
  }
});

// Stripe's own page where the restaurant updates its card, sees invoices, or cancels.
app.post("/api/billing/portal", requireAuth, async (req, res) => {
  if (!stripeConfigured()) return res.status(503).json({ error: "billing is not set up yet" });
  const { rows } = await pool.query("SELECT stripe_customer_id FROM restaurants WHERE id = $1", [req.restaurantId]);
  if (!rows[0] || !rows[0].stripe_customer_id) return res.status(404).json({ error: "no subscription yet" });
  try {
    const base = (PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
    const session = await stripeApi("billing_portal/sessions", { customer: rows[0].stripe_customer_id, return_url: `${base}/` });
    res.json({ url: session.url });
  } catch (e) {
    console.error("Billing portal failed:", e.message);
    res.status(502).json({ error: "Could not open the billing page. Please try again in a moment." });
  }
});

app.get("/api/auth/me", requireAuth, async (req, res) => {
  if (req.ownerId) {
    // An owner opened one of their restaurants: same access as the manager login.
    const { rows } = await pool.query(
      `SELECT o.email, o.name AS user_name, r.id AS restaurant_id, r.name AS restaurant_name, r.address AS restaurant_address
       FROM owners o JOIN owner_restaurants x ON x.owner_id = o.id JOIN restaurants r ON r.id = x.restaurant_id
       WHERE o.id = $1 AND r.id = $2`,
      [req.ownerId, req.restaurantId]
    );
    if (rows.length === 0) return res.status(401).json({ error: "not logged in" });
    return res.json({
      restaurant: { id: rows[0].restaurant_id, name: rows[0].restaurant_name, address: rows[0].restaurant_address || "" },
      email: rows[0].email,
      name: rows[0].user_name || "",
      viaOwner: true,
      demo: demoIds.has(rows[0].restaurant_id),
      newDesign: true,
      canSwitch: (await pool.query("SELECT COUNT(*) AS n FROM owner_restaurants WHERE owner_id = $1", [req.ownerId])).rows[0].n > 1,
    });
  }
  const { rows } = await pool.query(
    `SELECT users.email, users.name AS user_name, restaurants.id AS restaurant_id, restaurants.name AS restaurant_name, restaurants.address AS restaurant_address
     FROM users JOIN restaurants ON restaurants.id = users.restaurant_id
     WHERE users.id = $1`,
    [req.userId]
  );
  if (rows.length === 0) return res.status(401).json({ error: "not logged in" });
  res.json({
    restaurant: { id: rows[0].restaurant_id, name: rows[0].restaurant_name, address: rows[0].restaurant_address || "" },
    email: rows[0].email,
    name: rows[0].user_name || "",
    demo: demoIds.has(rows[0].restaurant_id),
    newDesign: true,
  });
});

// The name shown in the Overview greeting.
app.patch("/api/auth/me", requireAuth, async (req, res) => {
  const name = String((req.body && req.body.name) || "").trim().replace(/\s+/g, " ");
  if (!name || name.length > 60) return res.status(400).json({ error: "name must be 1-60 characters" });
  if (req.ownerId) await pool.query("UPDATE owners SET name = $1 WHERE id = $2", [name, req.ownerId]);
  else await pool.query("UPDATE users SET name = $1 WHERE id = $2 AND restaurant_id = $3", [name, req.userId, req.restaurantId]);
  res.json({ name });
});

// ---------- restaurant settings ----------

app.get("/api/restaurant", requireAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT id, name, address FROM restaurants WHERE id = $1", [req.restaurantId]);
  if (rows.length === 0) return res.status(404).json({ error: "restaurant not found" });
  res.json({ id: rows[0].id, name: rows[0].name, address: rows[0].address || "" });
});

// ---------- training: courses, manuals, contracts (scoped to the logged-in restaurant) ----------

const TRAINING_KINDS = ["course", "manual", "contract"];

// A training link must be a normal web address. Returns the cleaned URL, "" for empty, or null when it isn't acceptable
// (only http and https, so nothing like javascript: can ever be saved and then clicked by staff).
function cleanTrainingUrl(raw) {
  let u = String(raw === undefined || raw === null ? "" : raw).trim();
  if (!u) return "";
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = "https://" + u;
  if (u.length > 500) return null;
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    if (!parsed.hostname.includes(".")) return null;
    return parsed.href;
  } catch (e) {
    return null;
  }
}

async function loadTrainingItems(restaurantId) {
  const { rows: items } = await pool.query("SELECT id, kind, title, minutes, created_at, link_url FROM training_items WHERE restaurant_id = $1 ORDER BY created_at DESC", [restaurantId]);
  if (items.length === 0) return [];
  const { rows: assigns } = await pool.query(
    `SELECT a.item_id, a.staff_id, a.completed_at FROM training_assignments a
     JOIN training_items i ON i.id = a.item_id WHERE i.restaurant_id = $1`,
    [restaurantId]
  );
  const { rows: fileRows } = await pool.query(
    `SELECT f.id, f.item_id, f.name, f.type, f.size FROM training_files f
     JOIN training_items i ON i.id = f.item_id WHERE i.restaurant_id = $1 ORDER BY f.created_at, f.id`,
    [restaurantId]
  );
  return items.map((it) => {
    const files = fileRows.filter((f) => f.item_id === it.id).map((f) => ({ id: f.id, name: f.name, type: f.type, size: f.size }));
    return {
      id: it.id,
      kind: it.kind,
      title: it.title,
      minutes: it.minutes,
      createdAt: Number(it.created_at),
      file: files.length ? { name: files[0].name, type: files[0].type, size: files[0].size } : null, // the first file (older screens only know about one)
      files,
      link: it.link_url || null,
      assignments: assigns
        .filter((a) => a.item_id === it.id)
        .map((a) => ({ staffId: a.staff_id, done: !!a.completed_at })),
    };
  });
}

app.get("/api/training", requireAuth, async (req, res) => {
  res.json(await loadTrainingItems(req.restaurantId));
});

app.post("/api/training", requireAuth, async (req, res) => {
  const { kind, title, minutes, staffIds, url } = req.body || {};
  const link = cleanTrainingUrl(url);
  if (link === null) return res.status(400).json({ error: "that link doesn't look right — use a full web address like https://…" });
  if (!TRAINING_KINDS.includes(kind)) return res.status(400).json({ error: "kind must be course, manual or contract" });
  if (!title || !String(title).trim()) return res.status(400).json({ error: "title is required" });
  let mins = null;
  if (kind === "course" && minutes !== undefined && minutes !== null && minutes !== "") {
    mins = Math.round(Number(minutes));
    if (isNaN(mins) || mins < 0) return res.status(400).json({ error: "minutes must be a positive number" });
  }

  // Only staff belonging to this restaurant can be assigned. Omitting staffIds assigns everyone.
  const { rows: staffRows } = await pool.query("SELECT id FROM staff WHERE restaurant_id = $1 AND archived_at IS NULL", [req.restaurantId]);
  const validIds = new Set(staffRows.map((s) => s.id));
  const targets = Array.isArray(staffIds) ? staffIds.filter((sid) => validIds.has(sid)) : [...validIds];

  const newId = id();
  await pool.query(
    "INSERT INTO training_items (id, restaurant_id, kind, title, minutes, created_at, link_url) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [newId, req.restaurantId, kind, String(title).trim(), mins, Date.now(), link || null]
  );
  await Promise.all(targets.map((sid) =>
    pool.query("INSERT INTO training_assignments (item_id, staff_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [newId, sid])
  ));
  const items = await loadTrainingItems(req.restaurantId);
  res.status(201).json(items.find((i) => i.id === newId));
});

// Add, change or clear the link on an existing item (an empty url clears it).
app.put("/api/training/:id/link", requireAuth, async (req, res) => {
  const link = cleanTrainingUrl(req.body && req.body.url);
  if (link === null) return res.status(400).json({ error: "that link doesn't look right — use a full web address like https://…" });
  const { rowCount } = await pool.query("UPDATE training_items SET link_url = $1 WHERE id = $2 AND restaurant_id = $3", [link || null, req.params.id, req.restaurantId]);
  if (rowCount === 0) return res.status(404).json({ error: "training item not found" });
  res.json({ link: link || null });
});

// ----- attached files -----
const TRAINING_FILE_MAX_BYTES = 25 * 1024 * 1024; // 25 MB
const TRAINING_FILE_TYPES = {
  pdf: "application/pdf", doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
};

const TRAINING_FILES_MAX = 15; // files per course / manual / contract

// Check the upload (type, size, name) and return what to store, or send the error and return null.
function readTrainingUpload(req, res) {
  const name = String(req.query.name || "").replace(/[\\/\r\n"]/g, "_").slice(0, 150).trim();
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (!name || !TRAINING_FILE_TYPES[ext]) {
    res.status(400).json({ error: "File type not allowed. Use PDF, Word, Excel, PowerPoint, text, image or video (mp4/mov/webm)." });
    return null;
  }
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) { res.status(400).json({ error: "file is empty" }); return null; }
  return { name, type: TRAINING_FILE_TYPES[ext], size: req.body.length, data: req.body };
}
async function ownTrainingItem(req) {
  const { rows } = await pool.query("SELECT id FROM training_items WHERE id = $1 AND restaurant_id = $2", [req.params.id, req.restaurantId]);
  return rows.length > 0;
}
function sendTrainingFile(res, f, inline) {
  res.set({
    "Content-Type": f.type || "application/octet-stream",
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${f.name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox",
  });
  res.send(f.data);
}

// Add one more file to an item (call it once per file).
app.post(
  "/api/training/:id/files",
  requireAuth,
  express.raw({ type: () => true, limit: TRAINING_FILE_MAX_BYTES }),
  async (req, res) => {
    if (!(await ownTrainingItem(req))) return res.status(404).json({ error: "item not found" });
    const f = readTrainingUpload(req, res); if (!f) return;
    const { rows: cnt } = await pool.query("SELECT COUNT(*)::int AS n FROM training_files WHERE item_id = $1", [req.params.id]);
    if (cnt[0].n >= TRAINING_FILES_MAX) return res.status(400).json({ error: `Up to ${TRAINING_FILES_MAX} files per item.` });
    const fid = id();
    await pool.query("INSERT INTO training_files (id, item_id, name, type, size, data, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)", [fid, req.params.id, f.name, f.type, f.size, f.data, Date.now()]);
    res.status(201).json({ id: fid, name: f.name, type: f.type, size: f.size });
  }
);
app.get("/api/training/:id/files/:fileId", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT f.name, f.type, f.data FROM training_files f JOIN training_items i ON i.id = f.item_id
      WHERE f.id = $1 AND i.id = $2 AND i.restaurant_id = $3`,
    [req.params.fileId, req.params.id, req.restaurantId]
  );
  if (rows.length === 0) return res.status(404).json({ error: "no such file" });
  sendTrainingFile(res, rows[0], false);
});
app.delete("/api/training/:id/files/:fileId", requireAuth, async (req, res) => {
  const result = await pool.query(
    `DELETE FROM training_files f USING training_items i WHERE f.id = $1 AND f.item_id = i.id AND i.id = $2 AND i.restaurant_id = $3`,
    [req.params.fileId, req.params.id, req.restaurantId]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: "no such file" });
  res.json({ ok: true });
});

// Older single-file routes, kept so nothing that still uses them breaks: upload replaces all files with this one,
// download returns the first file, delete removes every file.
app.put(
  "/api/training/:id/file",
  requireAuth,
  express.raw({ type: () => true, limit: TRAINING_FILE_MAX_BYTES }),
  async (req, res) => {
    if (!(await ownTrainingItem(req))) return res.status(404).json({ error: "item not found" });
    const f = readTrainingUpload(req, res); if (!f) return;
    await pool.query("DELETE FROM training_files WHERE item_id = $1", [req.params.id]);
    await pool.query("INSERT INTO training_files (id, item_id, name, type, size, data, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)", [id(), req.params.id, f.name, f.type, f.size, f.data, Date.now()]);
    res.json({ name: f.name, type: f.type, size: f.size });
  }
);

app.get("/api/training/:id/file", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT f.name, f.type, f.data FROM training_files f JOIN training_items i ON i.id = f.item_id
      WHERE i.id = $1 AND i.restaurant_id = $2 ORDER BY f.created_at, f.id LIMIT 1`,
    [req.params.id, req.restaurantId]
  );
  if (rows.length === 0) return res.status(404).json({ error: "no file attached" });
  sendTrainingFile(res, rows[0], false);
});

app.delete("/api/training/:id/file", requireAuth, async (req, res) => {
  if (!(await ownTrainingItem(req))) return res.status(404).json({ error: "item not found" });
  await pool.query("DELETE FROM training_files WHERE item_id = $1", [req.params.id]);
  res.json({ ok: true });
});

app.patch("/api/training/:id/assignments/:staffId", requireAuth, async (req, res) => {
  const { done } = req.body || {};
  const { rows: item } = await pool.query("SELECT id FROM training_items WHERE id = $1 AND restaurant_id = $2", [req.params.id, req.restaurantId]);
  if (item.length === 0) return res.status(404).json({ error: "item not found" });
  const { rows } = await pool.query(
    "UPDATE training_assignments SET completed_at = $1 WHERE item_id = $2 AND staff_id = $3 RETURNING staff_id, completed_at",
    [done ? Date.now() : null, req.params.id, req.params.staffId]
  );
  if (rows.length === 0) return res.status(404).json({ error: "assignment not found" });
  res.json({ staffId: rows[0].staff_id, done: !!rows[0].completed_at });
});

app.delete("/api/training/:id", requireAuth, async (req, res) => {
  await pool.query("DELETE FROM training_items WHERE id = $1 AND restaurant_id = $2", [req.params.id, req.restaurantId]);
  res.json({ ok: true });
});

app.patch("/api/restaurant", requireAuth, async (req, res) => {
  const { name, address } = req.body || {};
  const { rows: existing } = await pool.query("SELECT * FROM restaurants WHERE id = $1", [req.restaurantId]);
  if (existing.length === 0) return res.status(404).json({ error: "restaurant not found" });
  const updates = { name: existing[0].name, address: existing[0].address };
  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: "name can't be empty" });
    updates.name = name.trim();
  }
  if (address !== undefined) updates.address = address.trim();
  const { rows } = await pool.query(
    "UPDATE restaurants SET name=$1, address=$2 WHERE id=$3 RETURNING id, name, address",
    [updates.name, updates.address, req.restaurantId]
  );
  res.json({ id: rows[0].id, name: rows[0].name, address: rows[0].address || "" });
});

// ---------- staff endpoints (scoped to the logged-in restaurant) ----------

app.get("/api/staff", requireAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM staff WHERE restaurant_id = $1 ORDER BY name ASC", [req.restaurantId]);
  res.json(rows.map(staffRowToJson));
});

app.post("/api/staff", requireAuth, async (req, res) => {
  const { name, phone, roles, hourlyRate, hireDate, address } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "name is required" });
  const roleList = Array.isArray(roles) ? roles.map((r) => String(r).trim()).filter(Boolean) : [];
  const normalized = normalizePhone(phone || "");
  if (!normalized) {
    return res.status(400).json({ error: "phone is missing or not recognizable — include country code if outside the US, e.g. +44..." });
  }
  let rate = null;
  if (hourlyRate !== undefined && hourlyRate !== "" && hourlyRate !== null) {
    rate = Number(hourlyRate);
    if (isNaN(rate) || rate < 0) return res.status(400).json({ error: "hourly rate must be a positive number" });
  }
  const newId = id();
  const { rows } = await pool.query(
    "INSERT INTO staff (id, restaurant_id, name, phone, roles, hourly_rate, hire_date, address) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
    [newId, req.restaurantId, name.trim(), normalized, JSON.stringify(roleList), rate, (hireDate || "").trim() || null, (address || "").trim() || null]
  );
  logActivity({ restaurantId: req.restaurantId, eventType: "staff_created", detail: name.trim() });
  res.status(201).json(staffRowToJson(rows[0]));
});

app.patch("/api/staff/:id", requireAuth, async (req, res) => {
  const { rows: existingRows } = await pool.query("SELECT * FROM staff WHERE id = $1 AND restaurant_id = $2 AND archived_at IS NULL", [req.params.id, req.restaurantId]);
  if (existingRows.length === 0) return res.status(404).json({ error: "staff not found" });

  const { name, phone, roles, hourlyRate, hireDate, address, hideFromSchedule } = req.body || {};
  const updates = {
    hide: existingRows[0].hide_from_schedule,
    name: existingRows[0].name,
    phone: existingRows[0].phone,
    roles: existingRows[0].roles,
    hourly_rate: existingRows[0].hourly_rate,
    hire_date: existingRows[0].hire_date,
    address: existingRows[0].address,
  };

  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: "name can't be empty" });
    updates.name = name.trim();
  }
  if (phone !== undefined) {
    const normalized = normalizePhone(phone || "");
    if (!normalized) return res.status(400).json({ error: "phone is missing or not recognizable — include country code if outside the US, e.g. +44..." });
    updates.phone = normalized;
  }
  if (roles !== undefined) {
    updates.roles = Array.isArray(roles) ? roles.map((r) => String(r).trim()).filter(Boolean) : [];
  }
  if (hourlyRate !== undefined) {
    if (hourlyRate === "" || hourlyRate === null) {
      updates.hourly_rate = null;
    } else {
      const rate = Number(hourlyRate);
      if (isNaN(rate) || rate < 0) return res.status(400).json({ error: "hourly rate must be a positive number" });
      updates.hourly_rate = rate;
    }
  }
  // The edit form sends null for an empty hire date / address — treat that as "clear it" (null.trim() used to crash with a 500).
  if (hireDate !== undefined) {
    const hd = String(hireDate === null ? "" : hireDate).trim();
    if (hd && !isIsoDate(hd)) return res.status(400).json({ error: "hire date must be YYYY-MM-DD" });
    updates.hire_date = hd || null;
  }
  if (address !== undefined) updates.address = String(address === null ? "" : address).trim() || null;
  if (hideFromSchedule !== undefined) updates.hide = !!hideFromSchedule;

  const { rows } = await pool.query(
    "UPDATE staff SET name=$1, phone=$2, roles=$3, hourly_rate=$4, hire_date=$5, address=$6, hide_from_schedule=$9 WHERE id=$7 AND restaurant_id=$8 RETURNING *",
    [updates.name, updates.phone, JSON.stringify(updates.roles), updates.hourly_rate, updates.hire_date, updates.address, req.params.id, req.restaurantId, updates.hide]
  );
  res.json(staffRowToJson(rows[0]));
});

// "Removing" someone keeps them in the database, so their past shifts, hours and payroll stay intact. They lose their login, stop
// getting texts, and leave every upcoming shift and open swap; they disappear from the staff list and the schedule grid.
app.delete("/api/staff/:id", requireAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT id, name FROM staff WHERE id = $1 AND restaurant_id = $2 AND archived_at IS NULL", [req.params.id, req.restaurantId]);
  if (!rows[0]) return res.status(204).end();
  const now = Date.now();
  await pool.query(
    "UPDATE shift_swaps SET status = 'cancelled', resolved_at = $3 WHERE restaurant_id = $1 AND status IN ('open','pending') AND (from_staff_id = $2 OR to_staff_id = $2)",
    [req.restaurantId, rows[0].id, now]
  );
  await pool.query("DELETE FROM schedule_shifts WHERE restaurant_id = $1 AND staff_id = $2 AND shift_date >= $3", [req.restaurantId, rows[0].id, ownerToday()]);
  await revokeManagerAccess(rows[0].id, req.restaurantId);
  await pool.query(
    "UPDATE staff SET archived_at = $3, email = NULL, password_hash = NULL, claim_token = NULL, claim_token_at = NULL WHERE id = $1 AND restaurant_id = $2",
    [rows[0].id, req.restaurantId, now]
  );
  logActivity({ restaurantId: req.restaurantId, eventType: "staff_removed", detail: `staff removed: ${rows[0].name}` });
  res.status(204).end();
});

// ---- manager login for a staff member ----
// Uses the same manager accounts the dashboard creates (owners, role 'manager'), so they sign in on the normal login page
// and get the same screens. Only the restaurant's own account (or an owner) can hand this out, never another manager.
async function canGrantManagerAccess(req) {
  if (!req.ownerId) return true;
  const { rows } = await pool.query("SELECT role FROM owners WHERE id = $1", [req.ownerId]);
  return !!rows[0] && rows[0].role !== "manager";
}
async function revokeManagerAccess(staffId, restaurantId) {
  const { rows } = await pool.query("SELECT manager_owner_id FROM staff WHERE id = $1 AND restaurant_id = $2", [staffId, restaurantId]);
  const ownerId = rows[0] && rows[0].manager_owner_id;
  if (!ownerId) return false;
  await pool.query("DELETE FROM owners WHERE id = $1 AND role = 'manager'", [ownerId]);
  await pool.query("UPDATE staff SET manager_owner_id = NULL WHERE id = $1 AND restaurant_id = $2", [staffId, restaurantId]);
  return true;
}

app.post("/api/staff/:id/manager-access", requireAuth, async (req, res) => {
  if (!(await canGrantManagerAccess(req))) return res.status(403).json({ error: "only the restaurant's main account or an owner can give manager access" });
  const { rows } = await pool.query("SELECT * FROM staff WHERE id = $1 AND restaurant_id = $2 AND archived_at IS NULL", [req.params.id, req.restaurantId]);
  const person = rows[0];
  if (!person) return res.status(404).json({ error: "staff not found" });
  if (person.manager_owner_id) return res.status(409).json({ error: "this person already has manager access" });
  const email = String((req.body && req.body.email) || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "a valid email is required" });
  const { rows: dup } = await pool.query("SELECT 1 FROM owners WHERE email = $1 UNION SELECT 1 FROM users WHERE email = $1", [email]);
  if (dup.length) return res.status(409).json({ error: "that email already has a manager or owner login" });
  const ownerId = id();
  const password = tempPassword();
  await pool.query("INSERT INTO owners (id, name, email, password_hash, created_at, role) VALUES ($1,$2,$3,$4,$5,'manager')", [ownerId, person.name, email, await bcrypt.hash(password, 10), Date.now()]);
  await pool.query("INSERT INTO owner_restaurants (owner_id, restaurant_id) VALUES ($1,$2)", [ownerId, req.restaurantId]);
  await pool.query("UPDATE staff SET manager_owner_id = $1 WHERE id = $2 AND restaurant_id = $3", [ownerId, person.id, req.restaurantId]);
  logActivity({ restaurantId: req.restaurantId, eventType: "manager_access_granted", detail: `manager access given to ${person.name} (${email})` });
  res.status(201).json({ email, tempPassword: password });
});

app.delete("/api/staff/:id/manager-access", requireAuth, async (req, res) => {
  if (!(await canGrantManagerAccess(req))) return res.status(403).json({ error: "only the restaurant's main account or an owner can remove manager access" });
  const { rows } = await pool.query("SELECT name FROM staff WHERE id = $1 AND restaurant_id = $2", [req.params.id, req.restaurantId]);
  if (!rows[0]) return res.status(404).json({ error: "staff not found" });
  if (await revokeManagerAccess(req.params.id, req.restaurantId)) {
    logActivity({ restaurantId: req.restaurantId, eventType: "manager_access_removed", detail: `manager access removed from ${rows[0].name}` });
  }
  res.status(204).end();
});

// Bring a removed person back (they need a new login link; their upcoming shifts are not restored).
app.post("/api/staff/:id/restore", requireAuth, async (req, res) => {
  const { rows } = await pool.query("UPDATE staff SET archived_at = NULL WHERE id = $1 AND restaurant_id = $2 AND archived_at IS NOT NULL RETURNING *", [req.params.id, req.restaurantId]);
  if (!rows[0]) return res.status(404).json({ error: "removed staff member not found" });
  logActivity({ restaurantId: req.restaurantId, eventType: "staff_restored", detail: `staff restored: ${rows[0].name}` });
  res.json(staffRowToJson(rows[0]));
});

app.post("/api/staff/:id/send-login-setup", requireAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM staff WHERE id = $1 AND restaurant_id = $2 AND archived_at IS NULL", [req.params.id, req.restaurantId]);
  if (rows.length === 0) return res.status(404).json({ error: "staff not found" });
  const staffer = rows[0];

  const token = id() + id(); // longer, single-use token
  await pool.query("UPDATE staff SET claim_token = $1, claim_token_at = $4 WHERE id = $2 AND restaurant_id = $3", [token, staffer.id, req.restaurantId, Date.now()]);

  const restaurantRows = await pool.query("SELECT name FROM restaurants WHERE id = $1", [req.restaurantId]);
  const restaurantName = restaurantRows.rows[0] ? restaurantRows.rows[0].name : "your restaurant";
  const baseUrl = PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
  const link = `${baseUrl}/staff-claim.html?token=${token}`;
  const firstName = staffer.name.split(" ")[0];
  const text = bilingual(
    `Bonjour ${firstName} — configurez votre accès employé ${restaurantName} ici : ${link}`,
    `Hi ${firstName} — set up your ${restaurantName} staff login here: ${link}`
  );

  const result = await sendSms(staffer.phone, text, req.restaurantId);
  if (result.ok) {
    res.json({ sent: true });
  } else {
    res.status(502).json({ error: `Couldn't text the link: ${result.error}` });
  }
});

// ---------- shift endpoints (scoped to the logged-in restaurant) ----------

app.get("/api/shifts", requireAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM shifts WHERE restaurant_id = $1 ORDER BY posted_at DESC", [req.restaurantId]);
  res.json(rows.map(shiftRowToJson));
});

app.post("/api/shifts", requireAuth, async (req, res) => {
  const { role, time, note } = req.body || {};
  if (!role || !role.trim()) return res.status(400).json({ error: "role is required" });

  const newId = id();
  const postedAt = Date.now();
  const { rows } = await pool.query(
    `INSERT INTO shifts (id, restaurant_id, role, time, note, status, posted_at, responders)
     VALUES ($1,$2,$3,$4,$5,'open',$6,'[]'::jsonb) RETURNING *`,
    [newId, req.restaurantId, role.trim(), (time || "").trim(), (note || "").trim(), postedAt]
  );
  const shift = shiftRowToJson(rows[0]);

  const code = shortCode(shift.id);
  const text = bilingual(
    [
      `Quart ouvert : ${shift.role}${shift.time ? ` — ${shift.time}` : ""}.`,
      shift.note ? shift.note : null,
      `Vous pouvez le couvrir ? Répondez OUI ${code} pour le prendre.`,
    ].filter(Boolean).join(" "),
    [
      `Open shift: ${shift.role}${shift.time ? ` — ${shift.time}` : ""}.`,
      shift.note ? shift.note : null,
      `Can cover it? Reply YES ${code} to claim.`,
    ].filter(Boolean).join(" ")
  );

  const { rows: recipientRows } = await pool.query(
    `SELECT * FROM staff WHERE restaurant_id = $1 AND archived_at IS NULL
     AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(roles) r WHERE lower(r) = lower($2))`,
    [req.restaurantId, shift.role]
  );
  const recipients = recipientRows.map(staffRowToJson);
  const results = await Promise.all(recipients.map((s) => sendSms(s.phone, text, req.restaurantId)));
  const sent = results.filter((r) => r.ok).length;

  logActivity({ restaurantId: req.restaurantId, eventType: "shift_posted", detail: `${shift.role}${shift.time ? " — " + shift.time : ""} (texted ${sent}/${recipients.length})` });
  res.status(201).json({ shift, sms: { sent, total: recipients.length, failures: results.filter((r) => !r.ok) } });
});

app.post("/api/shifts/:id/respond", requireAuth, async (req, res) => {
  const { staffId } = req.body || {};
  const { rows: shiftRows } = await pool.query("SELECT * FROM shifts WHERE id = $1 AND restaurant_id = $2", [req.params.id, req.restaurantId]);
  if (shiftRows.length === 0) return res.status(404).json({ error: "shift not found" });
  const shift = shiftRowToJson(shiftRows[0]);

  const { rows: staffRows } = await pool.query("SELECT * FROM staff WHERE id = $1 AND restaurant_id = $2 AND archived_at IS NULL", [staffId, req.restaurantId]);
  if (staffRows.length === 0) return res.status(404).json({ error: "staff not found" });
  const staffer = staffRowToJson(staffRows[0]);

  if (shift.status !== "open") return res.status(400).json({ error: "shift is not open" });

  const already = shift.responders.some((r) => r.staffId === staffId);
  const responders = already ? shift.responders : [...shift.responders, { staffId, name: staffer.name, ts: Date.now() }];

  const { rows } = await pool.query(
    "UPDATE shifts SET responders = $1 WHERE id = $2 AND restaurant_id = $3 RETURNING *",
    [JSON.stringify(responders), req.params.id, req.restaurantId]
  );
  res.json(shiftRowToJson(rows[0]));
});

app.post("/api/shifts/:id/assign", requireAuth, async (req, res) => {
  const { staffId } = req.body || {};
  const { rows: shiftRows } = await pool.query("SELECT * FROM shifts WHERE id = $1 AND restaurant_id = $2", [req.params.id, req.restaurantId]);
  if (shiftRows.length === 0) return res.status(404).json({ error: "shift not found" });
  const shift = shiftRowToJson(shiftRows[0]);

  const { rows: staffRows } = await pool.query("SELECT * FROM staff WHERE restaurant_id = $1 AND archived_at IS NULL", [req.restaurantId]);
  const allStaff = staffRows.map(staffRowToJson);
  const winner = allStaff.find((s) => s.id === staffId);
  if (!winner) return res.status(404).json({ error: "staff not found" });

  const filledAt = Date.now();
  const { rows } = await pool.query(
    "UPDATE shifts SET status='filled', assigned_to=$1, filled_at=$2 WHERE id=$3 AND restaurant_id=$4 RETURNING *",
    [staffId, filledAt, req.params.id, req.restaurantId]
  );
  const updated = shiftRowToJson(rows[0]);

  const confirmText = bilingual(
    `C'est confirmé : ${updated.role}${updated.time ? ` — ${updated.time}` : ""}. Merci de couvrir le quart !`,
    `You're confirmed: ${updated.role}${updated.time ? ` — ${updated.time}` : ""}. Thanks for covering!`
  );
  const filledText = bilingual(
    `Info — le quart de ${updated.role}${updated.time ? ` (${updated.time})` : ""} est déjà comblé. Merci d'avoir répondu !`,
    `Heads up — the ${updated.role}${updated.time ? ` (${updated.time})` : ""} shift has been covered. Thanks for responding!`
  );

  const others = shift.responders.filter((r) => r.staffId !== staffId);
  await sendSms(winner.phone, confirmText, req.restaurantId);
  await Promise.all(others.map((r) => allStaff.find((s) => s.id === r.staffId)).filter(Boolean).map((s) => sendSms(s.phone, filledText, req.restaurantId)));

  res.json(updated);
});

app.delete("/api/shifts/:id", requireAuth, async (req, res) => {
  await pool.query("DELETE FROM shifts WHERE id = $1 AND restaurant_id = $2", [req.params.id, req.restaurantId]);
  res.status(204).end();
});

// ---------- inbound SMS webhook (public — Twilio calls this, no cookie) ----------
// All restaurants share one Twilio number right now, so we find the right
// restaurant by looking up which restaurant this phone number is staff at.

// Only Twilio may post to the inbound-text webhook: Twilio signs every request with the account's auth token. Without this check
// anyone who knew the address could fake a staff member's reply. Tests skip it (NODE_ENV=test) unless TWILIO_VALIDATE_SIGNATURE=true;
// TWILIO_VALIDATE_SIGNATURE=false is an emergency off switch if the signature check ever blocks real replies.
function twilioRequestIsGenuine(req) {
  const force = process.env.TWILIO_VALIDATE_SIGNATURE;
  if (force === "false") return true;
  if (force !== "true" && process.env.NODE_ENV === "test") return true;
  const signature = req.get("X-Twilio-Signature");
  if (!signature) return false;
  const urls = new Set();
  if (PUBLIC_URL) urls.add(PUBLIC_URL.replace(/\/+$/, "") + "/api/sms/inbound");
  urls.add(`${req.protocol}://${req.get("host")}${req.originalUrl}`);
  try {
    return [...urls].some((u) => twilio.validateRequest(TWILIO_AUTH_TOKEN, signature, u, req.body || {}));
  } catch (e) {
    return false;
  }
}

app.post("/api/sms/inbound", async (req, res) => {
  if (!twilioRequestIsGenuine(req)) {
    logActivity({ eventType: "sms_inbound_rejected", level: "warn", detail: `Rejected an inbound text with a missing or wrong Twilio signature (from ${String((req.body && req.body.From) || "unknown").slice(0, 30)})` });
    return res.status(403).type("text/plain").send("forbidden");
  }
  const from = req.body.From;
  const to = req.body.To;
  const body = (req.body.Body || "").trim();
  const twiml = new twilio.twiml.MessagingResponse();

  // Resolve the restaurant by which dedicated number received this text — unambiguous
  // once a restaurant has its own number, since Twilio tells us exactly which number
  // the message came in on. Falls back to a phone-only lookup for any restaurant still
  // on the shared default number (safe during the transition to dedicated numbers).
  let staffer = null;
  let restaurantId = null;

  if (to) {
    const { rows: restRows } = await pool.query("SELECT id FROM restaurants WHERE twilio_phone_number = $1", [to]);
    if (restRows.length > 0) {
      restaurantId = restRows[0].id;
      const { rows: staffRows } = await pool.query("SELECT * FROM staff WHERE phone = $1 AND restaurant_id = $2 AND archived_at IS NULL LIMIT 1", [from, restaurantId]);
      if (staffRows[0]) staffer = staffRowToJson(staffRows[0]);
    }
  }

  if (!staffer) {
    // Fallback: shared default number, or no dedicated-number match — best-effort phone lookup.
    const { rows: staffRows } = await pool.query("SELECT * FROM staff WHERE phone = $1 AND archived_at IS NULL LIMIT 1", [from]);
    if (staffRows[0]) {
      staffer = staffRowToJson(staffRows[0]);
      restaurantId = staffRows[0].restaurant_id;
    }
  }

  if (!staffer) {
    twiml.message(bilingual(
      "Ce numéro n'est sur aucune liste d'employés — demandez à votre gestionnaire de vous ajouter.",
      "This number isn't on any staff list — ask your manager to add you."
    ));
    res.type("text/xml").send(twiml.toString());
    return;
  }

  const match = body.match(/(?:YES|OUI)\s*([A-Z0-9]{4})/i);
  if (!match) {
    twiml.message(bilingual(
      'Pour prendre un quart ouvert, répondez « OUI » suivi du code de 4 caractères du message.',
      'To claim an open shift, reply "YES" followed by the 4-character code from the shift text.'
    ));
    res.type("text/xml").send(twiml.toString());
    return;
  }

  const code = match[1].toUpperCase();
  const { rows: openShiftRows } = await pool.query("SELECT * FROM shifts WHERE restaurant_id = $1 AND status = 'open'", [restaurantId]);
  const shiftRow = openShiftRows.find((r) => shortCode(r.id) === code);

  if (!shiftRow) {
    twiml.message(bilingual(
      "Ce quart est déjà comblé ou le code ne correspond à aucun quart ouvert. Désolé !",
      "That shift's already filled or the code doesn't match an open shift. Sorry!"
    ));
    res.type("text/xml").send(twiml.toString());
    return;
  }

  const shift = shiftRowToJson(shiftRow);
  const already = shift.responders.some((r) => r.staffId === staffer.id);
  if (!already) {
    const responders = [...shift.responders, { staffId: staffer.id, name: staffer.name, ts: Date.now() }];
    await pool.query("UPDATE shifts SET responders = $1 WHERE id = $2 AND restaurant_id = $3", [JSON.stringify(responders), shift.id, restaurantId]);
  }

  const replyName = staffer.name.split(" ")[0];
  twiml.message(bilingual(
    `Reçu, ${replyName} — vous êtes inscrit pour ${shift.role}. Votre gestionnaire confirmera sous peu.`,
    `Got it, ${replyName} — you're down for ${shift.role}. Your manager will confirm shortly.`
  ));
  res.type("text/xml").send(twiml.toString());
});

// ---------- staff portal: account setup & login (public) ----------

const CLAIM_LINK_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const claimLinkExpired = (row) => row.claim_token_at !== null && row.claim_token_at !== undefined && Date.now() - Number(row.claim_token_at) > CLAIM_LINK_MAX_AGE_MS; // older links (no date) stay valid until re-sent

app.get("/api/staff-auth/claim/:token", async (req, res) => {
  const { rows } = await pool.query("SELECT staff.*, restaurants.name AS restaurant_name FROM staff JOIN restaurants ON restaurants.id = staff.restaurant_id WHERE staff.claim_token = $1", [req.params.token]);
  if (rows.length === 0 || claimLinkExpired(rows[0])) return res.status(404).json({ error: "This setup link isn't valid — ask your manager to send a new one." });
  res.json({ name: rows[0].name, restaurantName: rows[0].restaurant_name });
});

app.post("/api/staff-auth/claim", signupLimiter, async (req, res) => {
  const { token, email, password } = req.body || {};
  if (!token) return res.status(400).json({ error: "token is required" });
  if (!email || !isValidEmail(email)) return res.status(400).json({ error: "a valid email is required" });
  if (!password || password.length < 8) return res.status(400).json({ error: "password must be at least 8 characters" });

  const { rows } = await pool.query("SELECT * FROM staff WHERE claim_token = $1", [token]);
  if (rows.length === 0 || claimLinkExpired(rows[0])) return res.status(404).json({ error: "This setup link isn't valid — ask your manager to send a new one." });
  const staffer = rows[0];

  const { rows: emailTaken } = await pool.query("SELECT id FROM staff WHERE email = $1 AND id != $2", [email.toLowerCase(), staffer.id]);
  if (emailTaken.length > 0) return res.status(409).json({ error: "An account with that email already exists" });

  const passwordHash = await bcrypt.hash(password, 10);
  await pool.query("UPDATE staff SET email = $1, password_hash = $2, claim_token = NULL WHERE id = $3", [email.toLowerCase(), passwordHash, staffer.id]);

  const sessionToken = signToken({ staffId: staffer.id, restaurantId: staffer.restaurant_id });
  res.cookie("staff_token", sessionToken, COOKIE_OPTS);
  logActivity({ restaurantId: staffer.restaurant_id, eventType: "staff_account_setup", detail: `${staffer.name} (${email.toLowerCase()})` });
  res.status(201).json({ name: staffer.name });
});

app.post("/api/staff-auth/login", loginLimiter, loginEmailLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email and password are required" });

  const { rows } = await pool.query("SELECT * FROM staff WHERE email = $1", [email.toLowerCase()]);
  const staffer = rows[0];
  if (!staffer || !staffer.password_hash) {
    logActivity({ eventType: "login_failed", level: "warn", detail: `staff login failed: ${email.toLowerCase()} (no such account) [${deviceLabel(req)}]` });
    return res.status(401).json({ error: "incorrect email or password" });
  }

  const valid = await bcrypt.compare(password, staffer.password_hash);
  if (!valid) {
    logActivity({ restaurantId: staffer.restaurant_id, eventType: "login_failed", level: "warn", detail: `staff login failed: ${email.toLowerCase()} (wrong password) [${deviceLabel(req)}]` });
    return res.status(401).json({ error: "incorrect email or password" });
  }

  try {
    if ((await getBilling(staffer.restaurant_id)).blocked) return res.status(402).json({ error: "unavailable", code: "restaurant_unavailable" });
  } catch (e) {
    console.error("Billing check failed:", e.message);
  }
  const sessionToken = signToken({ staffId: staffer.id, restaurantId: staffer.restaurant_id });
  res.cookie("staff_token", sessionToken, COOKIE_OPTS);
  logActivity({ restaurantId: staffer.restaurant_id, eventType: "login_success", detail: `staff login: ${email.toLowerCase()} [${deviceLabel(req)}]` });
  res.json({ name: staffer.name, id: staffer.id });
});

app.post("/api/staff-auth/logout", (req, res) => {
  res.clearCookie("staff_token", { ...COOKIE_OPTS, maxAge: undefined });
  res.status(204).end();
});

app.get("/api/staff-auth/me", requireStaffAuth, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT staff.*, restaurants.name AS restaurant_name FROM staff JOIN restaurants ON restaurants.id = staff.restaurant_id WHERE staff.id = $1",
    [req.staffId]
  );
  if (rows.length === 0) return res.status(401).json({ error: "not logged in" });
  res.json({ ...staffRowToJson(rows[0]), restaurantName: rows[0].restaurant_name, demo: demoIds.has(rows[0].restaurant_id), newDesign: true });
});

// ---------- staff portal: schedule, availability, open shifts (staff, authenticated) ----------

// A future week is hidden from staff until the manager publishes it (the current and past weeks are always visible).
// Front of House and Back of House are posted separately: a shift belongs to BOH when its role is a kitchen role. A shift with no
// kitchen/floor role (Manager, or none) follows the person: BOH only if all their roles are kitchen roles, otherwise FOH.
function shiftHouse(role, personRoles) {
  if (BOH_ROLES.includes(role)) return "boh";
  if (FOH_ROLES.includes(role)) return "foh";
  const mine = personRoles || [];
  return mine.some((r) => BOH_ROLES.includes(r)) && !mine.some((r) => FOH_ROLES.includes(r)) ? "boh" : "foh";
}
const parseHouse = (v) => (v === undefined || v === null || v === "" ? "foh" : v === "foh" || v === "boh" ? v : null);

async function onlyPublishedForStaff(restaurantId, shifts) {
  const thisMonday = mondayOfIso(ownerToday());
  if (!shifts.some((sh) => mondayOfIso(sh.date) > thisMonday)) return shifts;
  const { rows } = await pool.query("SELECT week_start, house FROM schedule_published WHERE restaurant_id = $1", [restaurantId]);
  const published = new Set(rows.map((r) => `${r.house}|${r.week_start}`));
  const { rows: people } = await pool.query("SELECT id, roles FROM staff WHERE restaurant_id = $1 AND id = ANY($2)", [restaurantId, [...new Set(shifts.map((sh) => sh.staffId))]]);
  const rolesOf = Object.fromEntries(people.map((p) => [p.id, p.roles]));
  return shifts.filter((sh) => {
    const wk = mondayOfIso(sh.date);
    return wk <= thisMonday || published.has(`${shiftHouse(sh.role, rolesOf[sh.staffId])}|${wk}`);
  });
}

app.get("/api/staff-auth/schedule", requireStaffAuth, async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: "start and end date query params are required (YYYY-MM-DD)" });
  const { rows } = await pool.query(
    "SELECT * FROM schedule_shifts WHERE staff_id = $1 AND restaurant_id = $2 AND shift_date >= $3 AND shift_date <= $4 ORDER BY shift_date ASC, start_time ASC",
    [req.staffId, req.restaurantId, start, end]
  );
  res.json(await onlyPublishedForStaff(req.restaurantId, rows.map(scheduleShiftRowToJson)));
});

const AVAIL_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
// keep only known weekdays, a true/false/null flag and a short note
function cleanAvailability(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw || {})) {
    if (!AVAIL_DAYS.includes(k) || !v || typeof v !== "object") continue;
    const available = v.available === true ? true : v.available === false ? false : null;
    const note = String(v.note || "").slice(0, 120);
    if (available === null && !note) continue;
    out[k] = { available, note };
    // hours: on a busy day they are the hours the person can't work (none = all day);
    // on a free day they are the only hours the person can work (none = any time)
    if (available === false || available === true) {
      const hhmm = (x) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(x || "")) ? String(x) : "");
      const from = hhmm(v.from), to = hhmm(v.to);
      if (from) out[k].from = from;
      if (to) out[k].to = to;
    }
  }
  return out;
}
const availJson = (r) => ({
  availability: r ? r.availability : {},
  pending: r && r.pending ? r.pending : null,
  pendingAt: r && r.pending_at ? Number(r.pending_at) : null,
  decision: r && r.decision ? r.decision : null,
  decisionAt: r && r.decision_at ? Number(r.decision_at) : null,
});

app.get("/api/staff-auth/availability", requireStaffAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM staff_availability WHERE staff_id = $1", [req.staffId]);
  res.json(availJson(rows[0]));
});

// A submission is a request: it does not change what the schedule uses until a manager approves it.
app.put("/api/staff-auth/availability", requireStaffAuth, async (req, res) => {
  const { availability } = req.body || {};
  if (!availability || typeof availability !== "object") return res.status(400).json({ error: "availability object is required" });
  const now = Date.now();
  const { rows } = await pool.query(
    `INSERT INTO staff_availability (id, restaurant_id, staff_id, availability, pending, pending_at, decision, decision_at, updated_at)
     VALUES ($1,$2,$3,'{}'::jsonb,$4,$5,NULL,NULL,$5)
     ON CONFLICT (staff_id) DO UPDATE SET pending = EXCLUDED.pending, pending_at = EXCLUDED.pending_at, decision = NULL, decision_at = NULL, updated_at = EXCLUDED.updated_at
     RETURNING *`,
    [id(), req.restaurantId, req.staffId, JSON.stringify(cleanAvailability(availability)), now]
  );
  logActivity({ restaurantId: req.restaurantId, eventType: "availability_requested", detail: "availability change submitted" });
  pool.query("SELECT name FROM staff WHERE id = $1", [req.staffId]).then(({ rows }) => {
    const who = (rows[0] && rows[0].name) || "A staff member";
    return textManagers(req.restaurantId, bilingual(
      `${who} a demandé un changement de disponibilités. Approuvez ou refusez dans Open Shift Rail > Employés.`,
      `${who} asked to change their availability. Approve or deny it in Open Shift Rail > Staff.`));
  }).catch(() => {});
  res.json(availJson(rows[0]));
});

// ---------- manager: review availability requests ----------

// Approved availability of everyone in the restaurant (the schedule grid draws it).
app.get("/api/availability", requireAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT staff_id, availability FROM staff_availability WHERE restaurant_id = $1", [req.restaurantId]);
  const out = {};
  rows.forEach((r) => { out[r.staff_id] = r.availability || {}; });
  res.json(out);
});

app.get("/api/availability-requests", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.*, s.name, s.roles FROM staff_availability a JOIN staff s ON s.id = a.staff_id
     WHERE a.restaurant_id = $1 AND a.pending IS NOT NULL ORDER BY a.pending_at`,
    [req.restaurantId]
  );
  res.json(rows.map((r) => ({ staffId: r.staff_id, name: r.name, roles: r.roles || [], current: r.availability || {}, requested: r.pending, requestedAt: Number(r.pending_at) })));
});

app.post("/api/availability-requests/:staffId/:action", requireAuth, async (req, res) => {
  const { staffId, action } = req.params;
  if (action !== "approve" && action !== "decline") return res.status(404).json({ error: "unknown action" });
  const now = Date.now();
  const { rows } = await pool.query(
    action === "approve"
      ? `UPDATE staff_availability SET availability = pending, pending = NULL, pending_at = NULL, decision = 'approved', decision_at = $3, updated_at = $3
         WHERE staff_id = $1 AND restaurant_id = $2 AND pending IS NOT NULL RETURNING *`
      : `UPDATE staff_availability SET pending = NULL, pending_at = NULL, decision = 'declined', decision_at = $3, updated_at = $3
         WHERE staff_id = $1 AND restaurant_id = $2 AND pending IS NOT NULL RETURNING *`,
    [staffId, req.restaurantId, now]
  );
  if (!rows[0]) return res.status(404).json({ error: "no pending request for this person" });
  logActivity({ restaurantId: req.restaurantId, eventType: "availability_" + action + "d", detail: `availability ${action}d` });
  const okNow = action === "approve";
  notifyStaff(req.restaurantId, staffId,
    okNow ? "Vos disponibilités ont été approuvées." : "Votre demande de disponibilités a été refusée; vos disponibilités précédentes s'appliquent toujours.",
    okNow ? "Your availability was approved." : "Your availability request was declined; your previous availability still applies.");
  res.json(availJson(rows[0]));
});

// ---------- one-time unavailability (time off) ----------

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const timeOffJson = (r) => ({
  id: r.id, staffId: r.staff_id, date: r.off_date, from: r.from_time || "", to: r.to_time || "",
  note: r.note || "", status: r.status, createdAt: Number(r.created_at), decidedAt: r.decided_at ? Number(r.decided_at) : null,
});

app.get("/api/staff-auth/time-off", requireStaffAuth, async (req, res) => {
  const today = ownerToday();
  const { rows } = await pool.query(
    "SELECT * FROM staff_time_off WHERE staff_id = $1 AND off_date >= $2 ORDER BY off_date, from_time NULLS FIRST",
    [req.staffId, today]
  );
  res.json(rows.map(timeOffJson));
});

app.post("/api/staff-auth/time-off", requireStaffAuth, async (req, res) => {
  const { date, from, to, note } = req.body || {};
  if (!isIsoDate(date)) return res.status(400).json({ error: "a valid date is required" });
  const today = ownerToday();
  if (date < today) return res.status(400).json({ error: "that date has already passed" });
  if (date > addDaysIso(today, 366)) return res.status(400).json({ error: "that date is too far ahead" });
  const f = from ? String(from) : "", t = to ? String(to) : "";
  if ((f && !TIME_RE.test(f)) || (t && !TIME_RE.test(t))) return res.status(400).json({ error: "times must look like 17:00" });
  const { rows: dup } = await pool.query(
    "SELECT id FROM staff_time_off WHERE staff_id = $1 AND off_date = $2 AND COALESCE(from_time,'') = $3 AND COALESCE(to_time,'') = $4",
    [req.staffId, date, f, t]
  );
  if (dup.length) return res.status(409).json({ error: "you already have that one" });
  const { rows } = await pool.query(
    "INSERT INTO staff_time_off (id, restaurant_id, staff_id, off_date, from_time, to_time, note, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8) RETURNING *",
    [id(), req.restaurantId, req.staffId, date, f || null, t || null, String(note || "").trim().slice(0, 200), Date.now()]
  );
  logActivity({ restaurantId: req.restaurantId, eventType: "time_off_requested", detail: `time off requested for ${date}` });
  pool.query("SELECT name FROM staff WHERE id = $1", [req.staffId]).then(({ rows }) => {
    const who = (rows[0] && rows[0].name) || "A staff member";
    const hrs = f || t ? ` (${f || "…"}–${t || "…"})` : "";
    return textManagers(req.restaurantId, bilingual(
      `${who} demande congé le ${date}${hrs}. Approuvez ou refusez dans Open Shift Rail > Employés.`,
      `${who} requested time off on ${date}${hrs}. Approve or deny it in Open Shift Rail > Staff.`));
  }).catch(() => {});
  res.status(201).json(timeOffJson(rows[0]));
});

// Staff can take back any of their own entries (waiting or approved); it simply disappears from the schedule.
app.delete("/api/staff-auth/time-off/:id", requireStaffAuth, async (req, res) => {
  const { rowCount } = await pool.query("DELETE FROM staff_time_off WHERE id = $1 AND staff_id = $2", [req.params.id, req.staffId]);
  if (rowCount === 0) return res.status(404).json({ error: "not found" });
  res.status(204).end();
});

// Manager: approved time off in a date range (the schedule grid draws it).
app.get("/api/time-off", requireAuth, async (req, res) => {
  const { start, end } = req.query;
  if (!isIsoDate(start) || !isIsoDate(end)) return res.status(400).json({ error: "start and end dates are required" });
  const { rows } = await pool.query(
    "SELECT * FROM staff_time_off WHERE restaurant_id = $1 AND status = 'approved' AND off_date >= $2 AND off_date <= $3 ORDER BY off_date",
    [req.restaurantId, start, end]
  );
  res.json(rows.map(timeOffJson));
});

app.get("/api/time-off-requests", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT t.*, s.name, s.roles FROM staff_time_off t JOIN staff s ON s.id = t.staff_id
     WHERE t.restaurant_id = $1 AND t.status = 'pending' AND t.off_date >= $2 ORDER BY t.off_date, t.created_at`,
    [req.restaurantId, ownerToday()]
  );
  res.json(rows.map((r) => ({ ...timeOffJson(r), name: r.name, roles: r.roles || [] })));
});

app.post("/api/time-off-requests/:id/:action", requireAuth, async (req, res) => {
  const { id: reqId, action } = req.params;
  if (action !== "approve" && action !== "decline") return res.status(404).json({ error: "unknown action" });
  const { rows } = await pool.query(
    "UPDATE staff_time_off SET status = $3, decided_at = $4 WHERE id = $1 AND restaurant_id = $2 AND status = 'pending' RETURNING *",
    [reqId, req.restaurantId, action === "approve" ? "approved" : "declined", Date.now()]
  );
  if (!rows[0]) return res.status(404).json({ error: "no pending request found" });
  logActivity({ restaurantId: req.restaurantId, eventType: "time_off_" + action + "d", detail: `time off ${action}d for ${rows[0].off_date}` });
  const when = (loc) => new Date(rows[0].off_date + "T12:00:00").toLocaleDateString(loc, { weekday: "short", month: "short", day: "numeric" })
    + (rows[0].from_time || rows[0].to_time ? ` (${rows[0].from_time || "00:00"}–${rows[0].to_time || "24:00"})` : "");
  const okNow = action === "approve";
  notifyStaff(req.restaurantId, rows[0].staff_id,
    okNow ? `Votre absence du ${when("fr-CA")} a été approuvée.` : `Votre demande d'absence du ${when("fr-CA")} a été refusée.`,
    okNow ? `Your time off on ${when("en-CA")} was approved.` : `Your time off request for ${when("en-CA")} was declined.`);
  res.json(timeOffJson(rows[0]));
});

app.get("/api/staff-auth/open-shifts", requireStaffAuth, async (req, res) => {
  const { rows: staffRows } = await pool.query("SELECT roles FROM staff WHERE id = $1", [req.staffId]);
  const myRoles = (staffRows[0] && staffRows[0].roles) || [];
  const { rows } = await pool.query("SELECT * FROM shifts WHERE restaurant_id = $1 AND status = 'open' ORDER BY posted_at DESC", [req.restaurantId]);
  const matching = rows
    .map(shiftRowToJson)
    .filter((s) => myRoles.some((r) => r.trim().toLowerCase() === s.role.trim().toLowerCase()));
  res.json(matching);
});

app.post("/api/staff-auth/open-shifts/:id/claim", requireStaffAuth, async (req, res) => {
  const { rows: shiftRows } = await pool.query("SELECT * FROM shifts WHERE id = $1 AND restaurant_id = $2", [req.params.id, req.restaurantId]);
  if (shiftRows.length === 0) return res.status(404).json({ error: "shift not found" });
  const shift = shiftRowToJson(shiftRows[0]);
  if (shift.status !== "open") return res.status(400).json({ error: "This shift is no longer open" });

  const { rows: staffRows } = await pool.query("SELECT * FROM staff WHERE id = $1", [req.staffId]);
  const staffer = staffRowToJson(staffRows[0]);

  const already = shift.responders.some((r) => r.staffId === req.staffId);
  const responders = already ? shift.responders : [...shift.responders, { staffId: req.staffId, name: staffer.name, ts: Date.now() }];

  const { rows } = await pool.query(
    "UPDATE shifts SET responders = $1 WHERE id = $2 AND restaurant_id = $3 RETURNING *",
    [JSON.stringify(responders), req.params.id, req.restaurantId]
  );
  res.json(shiftRowToJson(rows[0]));
});

// ---------- shift swaps / gives ----------
// A staff member offers one of their scheduled shifts ("give" = hand it off, "swap" = trade for one of the taker's).
// Another staff member accepts -> status "pending". Nothing changes on the schedule until the manager approves.

const SWAP_SELECT = `
  SELECT w.*, s.shift_date::text AS shift_date, s.start_time, s.end_time, s.role AS shift_role,
         f.name AS from_name, t.name AS to_name,
         s2.shift_date::text AS swap_date, s2.start_time AS swap_start, s2.end_time AS swap_end, s2.role AS swap_role
  FROM shift_swaps w
  JOIN schedule_shifts s ON s.id = w.shift_id
  JOIN staff f ON f.id = w.from_staff_id
  LEFT JOIN staff t ON t.id = w.to_staff_id
  LEFT JOIN schedule_shifts s2 ON s2.id = w.swap_shift_id`;

function swapRowToJson(r) {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    note: r.note || "",
    fromStaffId: r.from_staff_id,
    fromName: r.from_name,
    toStaffId: r.to_staff_id || null,
    toName: r.to_name || null,
    shift: { id: r.shift_id, date: r.shift_date, startTime: r.start_time, endTime: r.end_time, role: r.shift_role || "" },
    swapShift: r.swap_shift_id ? { id: r.swap_shift_id, date: r.swap_date, startTime: r.swap_start, endTime: r.swap_end, role: r.swap_role || "" } : null,
    createdAt: Number(r.created_at),
    acceptedAt: r.accepted_at ? Number(r.accepted_at) : null,
    resolvedAt: r.resolved_at ? Number(r.resolved_at) : null,
  };
}

async function loadSwap(swapId, restaurantId, db = pool) {
  const { rows } = await db.query(`${SWAP_SELECT} WHERE w.id = $1 AND w.restaurant_id = $2`, [swapId, restaurantId]);
  return rows[0] ? swapRowToJson(rows[0]) : null;
}

function roleMatches(roles, shiftRole) {
  if (!shiftRole) return true;
  return (roles || []).some((r) => String(r).trim().toLowerCase() === String(shiftRole).trim().toLowerCase());
}

// Would `staffId` end up double-booked if they took `incoming` (and, for a swap, gave away `outgoingShiftId`)?
async function swapOverlaps(db, restaurantId, staffId, incoming, outgoingShiftId) {
  const { rows } = await db.query(
    "SELECT id, start_time, end_time FROM schedule_shifts WHERE restaurant_id = $1 AND staff_id = $2 AND shift_date = $3",
    [restaurantId, staffId, incoming.date]
  );
  const inc = shiftRange(incoming.startTime, incoming.endTime);
  return rows.some((r) => r.id !== outgoingShiftId && r.id !== incoming.id && rangesOverlap(inc, shiftRange(r.start_time, r.end_time)));
}

function swapTodayFloor() {
  return addDaysIso(ownerToday(), -1);
}

function textSwapParty(staffId, restaurantId, body) {
  pool.query("SELECT phone FROM staff WHERE id = $1 AND archived_at IS NULL", [staffId])
    .then(({ rows }) => rows[0] && sendSms(rows[0].phone, body, restaurantId))
    .catch((e) => console.error("swap SMS failed:", e.message));
}

function swapWhenText(sh) {
  return `${sh.date} ${sh.startTime}-${sh.endTime}`;
}

// Everyone who manages the restaurant: staff with the Manager role, plus anyone who was given a manager login.
function textManagers(restaurantId, body) {
  return pool.query(
    `SELECT DISTINCT phone FROM staff WHERE restaurant_id = $1 AND archived_at IS NULL
       AND (roles @> '["Manager"]'::jsonb OR manager_owner_id IS NOT NULL)`, [restaurantId])
    .then(({ rows }) => Promise.all(rows.map((m) => sendSms(m.phone, body, restaurantId))))
    .catch((e) => console.error("manager SMS failed:", e.message));
}

// Two people agreed on a give/swap: text every manager (staff with the Manager role) so it doesn't sit unseen.
function textManagersAboutSwap(swap, restaurantId) {
  if (!swap) return;
  const what = swap.kind === "swap" && swap.swapShift
    ? `${swap.fromName} (${swapWhenText(swap.shift)}) ↔ ${swap.toName || "?"} (${swapWhenText(swap.swapShift)})`
    : `${swap.fromName} gives ${swapWhenText(swap.shift)} to ${swap.toName || "?"}`;
  const body = `Shift ${swap.kind === "swap" ? "swap" : "give-away"} waiting for your approval: ${what}. Approve or deny it in Open Shift Rail > Scheduling.`;
  textManagers(restaurantId, body);
}

app.post("/api/staff-auth/swaps", requireStaffAuth, async (req, res) => {
  const { shiftId, kind, note } = req.body || {};
  if (kind !== "give" && kind !== "swap") return res.status(400).json({ error: "kind must be 'give' or 'swap'" });
  if (!shiftId) return res.status(400).json({ error: "shiftId is required" });
  const { rows } = await pool.query(
    "SELECT * FROM schedule_shifts WHERE id = $1 AND restaurant_id = $2 AND staff_id = $3",
    [shiftId, req.restaurantId, req.staffId]
  );
  if (rows.length === 0) return res.status(404).json({ error: "That isn't one of your scheduled shifts" });
  const sh = scheduleShiftRowToJson(rows[0]);
  if (sh.date < swapTodayFloor()) return res.status(400).json({ error: "That shift is already in the past" });
  const { rows: active } = await pool.query("SELECT 1 FROM shift_swaps WHERE shift_id = $1 AND status IN ('open','pending')", [shiftId]);
  if (active.length > 0) return res.status(409).json({ error: "This shift is already posted" });
  const newId = id();
  await pool.query(
    "INSERT INTO shift_swaps (id, restaurant_id, shift_id, from_staff_id, kind, note, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,'open',$7)",
    [newId, req.restaurantId, shiftId, req.staffId, kind, String(note || "").trim().slice(0, 300) || null, Date.now()]
  );
  logActivity({ restaurantId: req.restaurantId, eventType: "shift_swap_posted", detail: `${kind} ${swapWhenText(sh)}` });
  res.status(201).json(await loadSwap(newId, req.restaurantId));
});

app.get("/api/staff-auth/swaps", requireStaffAuth, async (req, res) => {
  const { rows: me } = await pool.query("SELECT roles FROM staff WHERE id = $1", [req.staffId]);
  const myRoles = (me[0] && me[0].roles) || [];
  const floor = swapTodayFloor();
  const { rows } = await pool.query(
    `${SWAP_SELECT} WHERE w.restaurant_id = $1 AND s.shift_date >= $2 AND (w.status IN ('open','pending') OR (w.status IN ('approved','denied') AND w.resolved_at > $3))
       AND NOT (w.from_staff_id = $4 AND w.from_hidden) AND NOT (w.to_staff_id = $4 AND w.to_hidden)
     ORDER BY s.shift_date ASC, s.start_time ASC`,
    [req.restaurantId, floor, Date.now() - 14 * 24 * 3600 * 1000, req.staffId]
  );
  const all = rows.map(swapRowToJson);
  const mine = all.filter((w) => w.fromStaffId === req.staffId || w.toStaffId === req.staffId);
  const { rows: myShiftRows } = await pool.query(
    "SELECT * FROM schedule_shifts WHERE restaurant_id = $1 AND staff_id = $2 AND shift_date >= $3 ORDER BY shift_date ASC, start_time ASC",
    [req.restaurantId, req.staffId, floor]
  );
  const myShifts = await onlyPublishedForStaff(req.restaurantId, myShiftRows.map(scheduleShiftRowToJson));
  const busy = new Set(all.filter((w) => w.status === "open" || w.status === "pending").flatMap((w) => [w.shift.id, ...(w.swapShift ? [w.swapShift.id] : [])]));
  const available = [];
  for (const w of all) {
    if (w.status !== "open" || w.fromStaffId === req.staffId) continue;
    if (!roleMatches(myRoles, w.shift.role)) continue;
    // For a plain give, hide it if it would double-book me; for a swap I can pick which of my shifts to trade, so keep it.
    if (w.kind === "give" && (await swapOverlaps(pool, req.restaurantId, req.staffId, w.shift, null))) continue;
    available.push(w);
  }
  res.json({ mine, available, offerable: myShifts.filter((s) => !busy.has(s.id)) });
});

app.post("/api/staff-auth/swaps/:id/accept", requireStaffAuth, async (req, res) => {
  const swap = await loadSwap(req.params.id, req.restaurantId);
  if (!swap) return res.status(404).json({ error: "request not found" });
  if (swap.status !== "open") return res.status(400).json({ error: "This request is no longer open" });
  if (swap.fromStaffId === req.staffId) return res.status(400).json({ error: "You can't accept your own request" });
  const { rows: me } = await pool.query("SELECT roles FROM staff WHERE id = $1", [req.staffId]);
  if (!roleMatches(me[0] && me[0].roles, swap.shift.role)) return res.status(400).json({ error: "That shift is for a different position" });

  let swapShiftId = null;
  let offered = null;
  if (swap.kind === "swap") {
    swapShiftId = (req.body || {}).swapShiftId;
    if (!swapShiftId) return res.status(400).json({ error: "Pick one of your shifts to trade" });
    const { rows } = await pool.query("SELECT * FROM schedule_shifts WHERE id = $1 AND restaurant_id = $2 AND staff_id = $3", [swapShiftId, req.restaurantId, req.staffId]);
    if (rows.length === 0) return res.status(400).json({ error: "That isn't one of your scheduled shifts" });
    offered = scheduleShiftRowToJson(rows[0]);
    if (offered.date < swapTodayFloor()) return res.status(400).json({ error: "That shift is already in the past" });
    const { rows: busy } = await pool.query("SELECT 1 FROM shift_swaps WHERE (shift_id = $1 OR swap_shift_id = $1) AND status IN ('open','pending')", [swapShiftId]);
    if (busy.length > 0) return res.status(409).json({ error: "That shift is already part of another request" });
    if (await swapOverlaps(pool, req.restaurantId, swap.fromStaffId, offered, swap.shift.id)) return res.status(400).json({ error: "That would double-book the other person" });
  }
  if (await swapOverlaps(pool, req.restaurantId, req.staffId, swap.shift, swapShiftId)) return res.status(400).json({ error: "That overlaps one of your shifts" });

  const { rowCount } = await pool.query(
    "UPDATE shift_swaps SET status = 'pending', to_staff_id = $1, swap_shift_id = $2, accepted_at = $3 WHERE id = $4 AND restaurant_id = $5 AND status = 'open'",
    [req.staffId, swapShiftId, Date.now(), swap.id, req.restaurantId]
  );
  if (rowCount === 0) return res.status(409).json({ error: "Someone else just accepted this" });
  logActivity({ restaurantId: req.restaurantId, eventType: "shift_swap_accepted", detail: `${swap.fromName} → ${swap.kind} ${swapWhenText(swap.shift)}` });
  const updated = await loadSwap(swap.id, req.restaurantId);
  textManagersAboutSwap(updated, req.restaurantId);
  res.json(updated);
});

app.post("/api/staff-auth/swaps/:id/cancel", requireStaffAuth, async (req, res) => {
  const swap = await loadSwap(req.params.id, req.restaurantId);
  if (!swap || swap.fromStaffId !== req.staffId) return res.status(404).json({ error: "request not found" });
  if (swap.status !== "open" && swap.status !== "pending") return res.status(400).json({ error: "This request is already closed" });
  await pool.query("UPDATE shift_swaps SET status = 'cancelled', resolved_at = $1 WHERE id = $2", [Date.now(), swap.id]);
  res.json({ ok: true });
});

// Once the manager has decided, either person can clear the finished ticket from their own list (the other person's list and the manager's are untouched).
app.post("/api/staff-auth/swaps/:id/dismiss", requireStaffAuth, async (req, res) => {
  const swap = await loadSwap(req.params.id, req.restaurantId);
  if (!swap || (swap.fromStaffId !== req.staffId && swap.toStaffId !== req.staffId)) return res.status(404).json({ error: "request not found" });
  if (swap.status !== "approved" && swap.status !== "denied") return res.status(400).json({ error: "Only a finished request can be removed" });
  const col = swap.fromStaffId === req.staffId ? "from_hidden" : "to_hidden";
  await pool.query(`UPDATE shift_swaps SET ${col} = true WHERE id = $1 AND restaurant_id = $2`, [swap.id, req.restaurantId]);
  res.json({ ok: true });
});

// The person who accepted can back out while the manager hasn't decided; the request goes back on the board.
app.post("/api/staff-auth/swaps/:id/withdraw", requireStaffAuth, async (req, res) => {
  const swap = await loadSwap(req.params.id, req.restaurantId);
  if (!swap || swap.toStaffId !== req.staffId) return res.status(404).json({ error: "request not found" });
  if (swap.status !== "pending") return res.status(400).json({ error: "Nothing to withdraw" });
  await pool.query("UPDATE shift_swaps SET status = 'open', to_staff_id = NULL, swap_shift_id = NULL, accepted_at = NULL WHERE id = $1", [swap.id]);
  res.json(await loadSwap(swap.id, req.restaurantId));
});

app.get("/api/swaps", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `${SWAP_SELECT} WHERE w.restaurant_id = $1 AND NOT w.manager_hidden AND (w.status IN ('open','pending') OR (w.status IN ('approved','denied') AND w.resolved_at > $2))
     ORDER BY CASE w.status WHEN 'pending' THEN 0 WHEN 'open' THEN 1 ELSE 2 END, s.shift_date ASC, s.start_time ASC LIMIT 100`,
    [req.restaurantId, Date.now() - 7 * 24 * 3600 * 1000]
  );
  res.json(rows.map(swapRowToJson));
});

app.post("/api/swaps/:id/approve", requireAuth, async (req, res) => {
  const client = await pool.connect();
  let swap;
  try {
    await client.query("BEGIN");
    const { rows: lock } = await client.query("SELECT id FROM shift_swaps WHERE id = $1 AND restaurant_id = $2 FOR UPDATE", [req.params.id, req.restaurantId]);
    swap = lock.length ? await loadSwap(req.params.id, req.restaurantId, client) : null;
    if (!swap) { await client.query("ROLLBACK"); return res.status(404).json({ error: "request not found" }); }
    if (swap.status !== "pending") { await client.query("ROLLBACK"); return res.status(400).json({ error: "Only an accepted request can be approved" }); }
    const { rows: a } = await client.query("SELECT staff_id FROM schedule_shifts WHERE id = $1 FOR UPDATE", [swap.shift.id]);
    if (a.length === 0 || a[0].staff_id !== swap.fromStaffId) { await client.query("ROLLBACK"); return res.status(409).json({ error: "The schedule changed — that shift isn't with the original person anymore" }); }
    if (swap.kind === "swap") {
      if (!swap.swapShift) { await client.query("ROLLBACK"); return res.status(409).json({ error: "The traded shift is gone" }); }
      const { rows: b } = await client.query("SELECT staff_id FROM schedule_shifts WHERE id = $1 FOR UPDATE", [swap.swapShift.id]);
      if (b.length === 0 || b[0].staff_id !== swap.toStaffId) { await client.query("ROLLBACK"); return res.status(409).json({ error: "The schedule changed — the traded shift moved" }); }
    }
    const outgoing = swap.swapShift ? swap.swapShift.id : null;
    if (await swapOverlaps(client, req.restaurantId, swap.toStaffId, swap.shift, outgoing)) { await client.query("ROLLBACK"); return res.status(400).json({ error: `${swap.toName} would be double-booked` }); }
    if (swap.swapShift && (await swapOverlaps(client, req.restaurantId, swap.fromStaffId, swap.swapShift, swap.shift.id))) { await client.query("ROLLBACK"); return res.status(400).json({ error: `${swap.fromName} would be double-booked` }); }
    await client.query("UPDATE schedule_shifts SET staff_id = $1 WHERE id = $2", [swap.toStaffId, swap.shift.id]);
    if (swap.swapShift) await client.query("UPDATE schedule_shifts SET staff_id = $1 WHERE id = $2", [swap.fromStaffId, swap.swapShift.id]);
    const now = Date.now();
    await client.query("UPDATE shift_swaps SET status = 'approved', resolved_at = $1 WHERE id = $2", [now, swap.id]);
    // Any other live request touching these shifts is now stale.
    await client.query(
      "UPDATE shift_swaps SET status = 'cancelled', resolved_at = $1 WHERE id <> $2 AND status IN ('open','pending') AND (shift_id = ANY($3) OR swap_shift_id = ANY($3))",
      [now, swap.id, [swap.shift.id, ...(swap.swapShift ? [swap.swapShift.id] : [])]]
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("swap approve failed:", e.message);
    return res.status(500).json({ error: "Couldn't approve that request" });
  } finally {
    client.release();
  }
  logActivity({ restaurantId: req.restaurantId, eventType: "shift_swap_approved", detail: `${swap.fromName} ↔ ${swap.toName} ${swapWhenText(swap.shift)}` });
  textSwapParty(swap.fromStaffId, req.restaurantId, swap.swapShift
    ? `Your shift swap is approved: you now work ${swapWhenText(swap.swapShift)} instead of ${swapWhenText(swap.shift)}.`
    : `Your shift on ${swapWhenText(swap.shift)} was approved to be taken by ${swap.toName}. You're off.`);
  textSwapParty(swap.toStaffId, req.restaurantId, swap.swapShift
    ? `Your shift swap is approved: you now work ${swapWhenText(swap.shift)} instead of ${swapWhenText(swap.swapShift)}.`
    : `You're now scheduled on ${swapWhenText(swap.shift)}.`);
  res.json(await loadSwap(swap.id, req.restaurantId));
});

app.post("/api/swaps/:id/deny", requireAuth, async (req, res) => {
  const swap = await loadSwap(req.params.id, req.restaurantId);
  if (!swap) return res.status(404).json({ error: "request not found" });
  if (swap.status !== "pending" && swap.status !== "open") return res.status(400).json({ error: "This request is already closed" });
  await pool.query("UPDATE shift_swaps SET status = 'denied', resolved_at = $1 WHERE id = $2", [Date.now(), swap.id]);
  logActivity({ restaurantId: req.restaurantId, eventType: "shift_swap_denied", detail: `${swap.fromName} ${swapWhenText(swap.shift)}` });
  if (swap.status === "pending") {
    textSwapParty(swap.fromStaffId, req.restaurantId, `Your shift change for ${swapWhenText(swap.shift)} wasn't approved — you're still on the schedule.`);
    textSwapParty(swap.toStaffId, req.restaurantId, `The shift change for ${swapWhenText(swap.shift)} wasn't approved.`);
  }
  res.json(await loadSwap(swap.id, req.restaurantId));
});

// Remove a ticket from the board. A live one (open or waiting for approval) is cancelled and disappears for staff too, with no decision made;
// a finished one (approved or denied) is only cleared from the manager's list, so staff keep their record of what was decided.
app.delete("/api/swaps/:id", requireAuth, async (req, res) => {
  const swap = await loadSwap(req.params.id, req.restaurantId);
  if (!swap) return res.status(404).json({ error: "request not found" });
  if (swap.status === "open" || swap.status === "pending") {
    await pool.query("UPDATE shift_swaps SET status = 'cancelled', resolved_at = $1, manager_hidden = true WHERE id = $2 AND restaurant_id = $3", [Date.now(), swap.id, req.restaurantId]);
    logActivity({ restaurantId: req.restaurantId, eventType: "shift_swap_removed", detail: `${swap.fromName} ${swapWhenText(swap.shift)}` });
    if (swap.status === "pending") {
      textSwapParty(swap.fromStaffId, req.restaurantId, `Your shift change request for ${swapWhenText(swap.shift)} was removed by a manager — you're still on the schedule.`);
      textSwapParty(swap.toStaffId, req.restaurantId, `The shift change request for ${swapWhenText(swap.shift)} was removed by a manager.`);
    }
  } else {
    await pool.query("UPDATE shift_swaps SET manager_hidden = true WHERE id = $1 AND restaurant_id = $2", [swap.id, req.restaurantId]);
  }
  res.status(204).end();
});

// ---------- hiring: postings (manager, authenticated) ----------

app.get("/api/hiring/postings", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.*, (SELECT COUNT(*) FROM applications a WHERE a.posting_id = p.id) AS applicant_count
     FROM job_postings p WHERE p.restaurant_id = $1 ORDER BY p.created_at DESC`,
    [req.restaurantId]
  );
  res.json(rows.map((r) => ({ ...postingRowToJson(r), applicantCount: Number(r.applicant_count) })));
});

app.post("/api/hiring/postings", requireAuth, async (req, res) => {
  const { title, role, description } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: "title is required" });
  const newId = id();
  const { rows } = await pool.query(
    "INSERT INTO job_postings (id, restaurant_id, title, role, description, status, created_at) VALUES ($1,$2,$3,$4,$5,'open',$6) RETURNING *",
    [newId, req.restaurantId, title.trim(), (role || "").trim(), (description || "").trim(), Date.now()]
  );
  res.status(201).json(postingRowToJson(rows[0]));
});

app.patch("/api/hiring/postings/:id", requireAuth, async (req, res) => {
  const { status } = req.body || {};
  if (!["open", "closed"].includes(status)) return res.status(400).json({ error: "status must be 'open' or 'closed'" });
  const { rows } = await pool.query(
    "UPDATE job_postings SET status=$1 WHERE id=$2 AND restaurant_id=$3 RETURNING *",
    [status, req.params.id, req.restaurantId]
  );
  if (rows.length === 0) return res.status(404).json({ error: "posting not found" });
  res.json(postingRowToJson(rows[0]));
});

app.delete("/api/hiring/postings/:id", requireAuth, async (req, res) => {
  await pool.query("DELETE FROM job_postings WHERE id = $1 AND restaurant_id = $2", [req.params.id, req.restaurantId]);
  res.status(204).end();
});

// ---------- hiring: applications (manager, authenticated) ----------

app.get("/api/hiring/applications", requireAuth, async (req, res) => {
  const { postingId } = req.query;
  const params = [req.restaurantId];
  let query = "SELECT * FROM applications WHERE restaurant_id = $1";
  if (postingId) {
    params.push(postingId);
    query += " AND posting_id = $2";
  }
  query += " ORDER BY created_at DESC";
  const { rows } = await pool.query(query, params);
  res.json(rows.map(applicationRowToJson));
});

app.patch("/api/hiring/applications/:id", requireAuth, async (req, res) => {
  const { rows: existing } = await pool.query(
    "SELECT * FROM applications WHERE id = $1 AND restaurant_id = $2",
    [req.params.id, req.restaurantId]
  );
  if (existing.length === 0) return res.status(404).json({ error: "application not found" });

  const { stage, interviewTime, note } = req.body || {};
  const validStages = ["applied", "screening", "interview", "offer", "rejected"];
  const updates = {
    stage: existing[0].stage,
    interview_time: existing[0].interview_time,
    note: existing[0].note,
  };
  if (stage !== undefined) {
    if (!validStages.includes(stage)) return res.status(400).json({ error: "invalid stage" });
    updates.stage = stage;
  }
  if (interviewTime !== undefined) updates.interview_time = interviewTime;
  if (note !== undefined) updates.note = note;

  const { rows } = await pool.query(
    "UPDATE applications SET stage=$1, interview_time=$2, note=$3 WHERE id=$4 AND restaurant_id=$5 RETURNING *",
    [updates.stage, updates.interview_time, updates.note, req.params.id, req.restaurantId]
  );
  const updated = applicationRowToJson(rows[0]);

  let notified = null;
  const interviewTimeChanged = interviewTime !== undefined && interviewTime.trim() && interviewTime.trim() !== (existing[0].interview_time || "").trim();
  if (interviewTimeChanged) {
    if (updated.phone) {
      const [postingRows, restaurantRows] = await Promise.all([
        pool.query("SELECT title FROM job_postings WHERE id = $1", [updated.postingId]),
        pool.query("SELECT name FROM restaurants WHERE id = $1", [req.restaurantId]),
      ]);
      const postingTitle = postingRows.rows[0] ? postingRows.rows[0].title : "the position";
      const restaurantName = restaurantRows.rows[0] ? restaurantRows.rows[0].name : "the restaurant";
      const applicantFirst = updated.name.split(" ")[0];
      const text = bilingual(
        `Bonjour ${applicantFirst}, votre entrevue pour ${postingTitle} chez ${restaurantName} est prévue : ${updated.interviewTime}. Répondez si vous avez des questions.`,
        `Hi ${applicantFirst}, your interview for ${postingTitle} at ${restaurantName} is scheduled: ${updated.interviewTime}. Reply if you have any questions.`
      );
      const result = await sendSms(updated.phone, text, req.restaurantId);
      notified = { ok: result.ok, method: "sms", error: result.error };
    } else {
      notified = { ok: false, method: "none", error: "No phone number on file for this applicant" };
    }
  }

  res.json({ ...updated, notified });
});

app.delete("/api/hiring/applications/:id", requireAuth, async (req, res) => {
  await pool.query("DELETE FROM applications WHERE id = $1 AND restaurant_id = $2", [req.params.id, req.restaurantId]);
  res.status(204).end();
});

// ---------- hiring: public candidate-facing endpoints (no auth) ----------

app.get("/api/public/postings/:id", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.*, r.name AS restaurant_name, r.address AS restaurant_address FROM job_postings p
     JOIN restaurants r ON r.id = p.restaurant_id
     WHERE p.id = $1 AND p.status = 'open'`,
    [req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: "This posting isn't available." });
  const p = rows[0];
  res.json({
    id: p.id,
    title: p.title,
    role: p.role || "",
    description: p.description || "",
    restaurantName: p.restaurant_name,
    restaurantAddress: p.restaurant_address || "",
    createdAt: Number(p.created_at),
  });
});

app.post("/api/public/applications", async (req, res) => {
  const { postingId, name, email, phone, note } = req.body || {};
  if (!postingId) return res.status(400).json({ error: "postingId is required" });
  if (!name || !name.trim()) return res.status(400).json({ error: "name is required" });
  if (!email && !phone) return res.status(400).json({ error: "an email or phone number is required" });

  const { rows: postingRows } = await pool.query(
    "SELECT * FROM job_postings WHERE id = $1 AND status = 'open'",
    [postingId]
  );
  if (postingRows.length === 0) return res.status(404).json({ error: "This posting isn't accepting applications right now." });
  const posting = postingRows[0];

  const newId = id();
  const { rows } = await pool.query(
    `INSERT INTO applications (id, restaurant_id, posting_id, name, email, phone, note, stage, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'applied',$8) RETURNING *`,
    [newId, posting.restaurant_id, postingId, name.trim(), (email || "").trim(), (phone || "").trim(), (note || "").trim(), Date.now()]
  );
  logActivity({ restaurantId: posting.restaurant_id, eventType: "application_received", detail: `${name.trim()} applied for ${posting.title}` });
  res.status(201).json(applicationRowToJson(rows[0]));
});

// ---------- weekly schedule grid (manager, authenticated) ----------

app.get("/api/schedule", requireAuth, async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: "start and end date query params are required (YYYY-MM-DD)" });
  const { rows } = await pool.query(
    "SELECT * FROM schedule_shifts WHERE restaurant_id = $1 AND shift_date >= $2 AND shift_date <= $3 ORDER BY shift_date ASC, start_time ASC",
    [req.restaurantId, start, end]
  );
  res.json(rows.map(scheduleShiftRowToJson));
});

// ---- publishing a week to staff ----
const isMondayIso = (d) => isIsoDate(d) && new Date(d + "T00:00:00Z").getUTCDay() === 1;

app.get("/api/schedule/publish", requireAuth, async (req, res) => {
  const weekStart = String(req.query.weekStart || "");
  if (!isMondayIso(weekStart)) return res.status(400).json({ error: "weekStart must be a Monday (YYYY-MM-DD)" });
  const house = parseHouse(req.query.house);
  if (!house) return res.status(400).json({ error: "house must be 'foh' or 'boh'" });
  const { rows } = await pool.query("SELECT published_at FROM schedule_published WHERE restaurant_id = $1 AND week_start = $2 AND house = $3", [req.restaurantId, weekStart, house]);
  const alwaysLive = weekStart <= mondayOfIso(ownerToday());
  res.json({ weekStart, house, published: rows.length > 0, alwaysLive, visibleToStaff: alwaysLive || rows.length > 0 });
});

// Post a week for one house (Front of House or Back of House): that house's staff can see it in their portal from now on,
// and everyone in that house who works that week gets a text. (Posting a week that is already posted doesn't text again.)
app.post("/api/schedule/publish", requireAuth, async (req, res) => {
  const weekStart = String((req.body && req.body.weekStart) || "");
  if (!isMondayIso(weekStart)) return res.status(400).json({ error: "weekStart must be a Monday (YYYY-MM-DD)" });
  const house = parseHouse(req.body && req.body.house);
  if (!house) return res.status(400).json({ error: "house must be 'foh' or 'boh'" });
  const ins = await pool.query(
    "INSERT INTO schedule_published (restaurant_id, week_start, published_at, house) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
    [req.restaurantId, weekStart, Date.now(), house]
  );
  logActivity({ restaurantId: req.restaurantId, eventType: "schedule_published", detail: `week of ${weekStart} (${house.toUpperCase()})` });
  let texted = 0;
  if (ins.rowCount === 1) {
    await snapshotWeek(req.restaurantId, weekStart, house);
    texted = await textSchedulePosted(req, weekStart, house);
  }
  res.json({ weekStart, house, published: true, visibleToStaff: true, texted });
});

// Remember the week as posted. A punched shift is kept with the times it was SCHEDULED for, not the times actually worked.
async function snapshotWeek(restaurantId, weekStart, house) {
  try {
    const { rows } = await pool.query(
      `SELECT s.*, st.roles AS person_roles FROM schedule_shifts s JOIN staff st ON st.id = s.staff_id
       WHERE s.restaurant_id = $1 AND s.shift_date >= $2 AND s.shift_date <= $3`,
      [restaurantId, weekStart, addDaysIso(weekStart, 6)]
    );
    const shifts = rows.filter((r) => shiftHouse(r.role, r.person_roles) === house).map((r) => ({
      staffId: r.staff_id, date: r.shift_date instanceof Date ? r.shift_date.toISOString().slice(0, 10) : String(r.shift_date).slice(0, 10),
      startTime: r.scheduled_start || r.start_time, endTime: r.scheduled_end || r.end_time, role: r.role || "", station: r.station || "",
    }));
    await pool.query(
      `INSERT INTO schedule_snapshots (restaurant_id, week_start, house, taken_at, shifts) VALUES ($1,$2,$3,$4,$5::jsonb)
       ON CONFLICT (restaurant_id, week_start, house) DO UPDATE SET taken_at = EXCLUDED.taken_at, shifts = EXCLUDED.shifts`,
      [restaurantId, weekStart, house, Date.now(), JSON.stringify(shifts)]
    );
  } catch (e) {
    console.error("Couldn't save the posted-schedule snapshot:", e.message);
  }
}

// The week exactly as it was posted (404 when this week was never posted through the app, e.g. posted before this existed).
app.get("/api/schedule/snapshot", requireAuth, async (req, res) => {
  const weekStart = String(req.query.weekStart || "");
  if (!isMondayIso(weekStart)) return res.status(400).json({ error: "weekStart must be a Monday (YYYY-MM-DD)" });
  const house = parseHouse(req.query.house);
  if (!house) return res.status(400).json({ error: "house must be 'foh' or 'boh'" });
  const { rows } = await pool.query("SELECT taken_at, shifts FROM schedule_snapshots WHERE restaurant_id = $1 AND week_start = $2 AND house = $3", [req.restaurantId, weekStart, house]);
  if (!rows[0]) return res.status(404).json({ error: "no posted copy of that week" });
  res.json({ weekStart, house, takenAt: Number(rows[0].taken_at), shifts: rows[0].shifts });
});

async function textSchedulePosted(req, weekStart, house) {
  try {
    const { rows: shiftRows } = await pool.query(
      `SELECT s.staff_id, s.role, st.roles AS person_roles FROM schedule_shifts s JOIN staff st ON st.id = s.staff_id
       WHERE s.restaurant_id = $1 AND st.archived_at IS NULL AND s.shift_date >= $2 AND s.shift_date <= $3`,
      [req.restaurantId, weekStart, addDaysIso(weekStart, 6)]
    );
    const counts = new Map();
    shiftRows.filter((r) => shiftHouse(r.role, r.person_roles) === house).forEach((r) => counts.set(r.staff_id, (counts.get(r.staff_id) || 0) + 1));
    const who = [...counts].map(([staff_id, n]) => ({ staff_id, n }));
    if (!who.length) return 0;
    const { rows: r } = await pool.query("SELECT name FROM restaurants WHERE id = $1", [req.restaurantId]);
    const restaurantName = r[0] ? r[0].name : "your restaurant";
    const baseUrl = PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
    const link = `${baseUrl}/staff-portal.html`;
    const range = (loc) => {
      const f = (iso) => new Date(iso + "T12:00:00Z").toLocaleDateString(loc, { month: "short", day: "numeric", timeZone: "UTC" });
      return `${f(weekStart)} – ${f(addDaysIso(weekStart, 6))}`;
    };
    const frRange = range("fr-CA"), enRange = range("en-CA");
    // fire and forget: the manager shouldn't wait on 15 texts
    Promise.all(who.map((w) => notifyStaff(
      req.restaurantId, w.staff_id,
      `${restaurantName} : votre horaire du ${frRange} est publié (${w.n} quart${w.n === 1 ? "" : "s"}). Consultez-le : ${link}`,
      `${restaurantName}: your schedule for ${enRange} is posted (${w.n} shift${w.n === 1 ? "" : "s"}). View it: ${link}`
    ))).catch((e) => console.error("schedule-posted texts failed:", e.message));
    return who.length;
  } catch (e) {
    console.error("Couldn't text the posted schedule:", e.message);
    return 0;
  }
}

// Take a future week back to draft (staff stop seeing it). The current and past weeks can't be hidden.
app.delete("/api/schedule/publish/:weekStart", requireAuth, async (req, res) => {
  const weekStart = req.params.weekStart;
  if (!isMondayIso(weekStart)) return res.status(400).json({ error: "weekStart must be a Monday (YYYY-MM-DD)" });
  const house = parseHouse(req.query.house);
  if (!house) return res.status(400).json({ error: "house must be 'foh' or 'boh'" });
  if (weekStart <= mondayOfIso(ownerToday())) return res.status(400).json({ error: "The current week is always visible to staff." });
  await pool.query("DELETE FROM schedule_published WHERE restaurant_id = $1 AND week_start = $2 AND house = $3", [req.restaurantId, weekStart, house]);
  await pool.query("DELETE FROM schedule_snapshots WHERE restaurant_id = $1 AND week_start = $2 AND house = $3", [req.restaurantId, weekStart, house]); // back to draft: the next post takes a fresh copy
  res.json({ weekStart, house, published: false, visibleToStaff: false });
});

app.post("/api/schedule", requireAuth, async (req, res) => {
  const { staffId, date, startTime, endTime, role, station } = req.body || {};
  if (!staffId) return res.status(400).json({ error: "staffId is required" });
  if (!date) return res.status(400).json({ error: "date is required" });
  if (!startTime || !endTime) return res.status(400).json({ error: "startTime and endTime are required" });
  if (station && !STATIONS.includes(station)) return res.status(400).json({ error: `station must be one of: ${STATIONS.join(", ")}` });

  const { rows: staffRows } = await pool.query("SELECT id FROM staff WHERE id = $1 AND restaurant_id = $2 AND archived_at IS NULL", [staffId, req.restaurantId]);
  if (staffRows.length === 0) return res.status(404).json({ error: "staff not found" });

  const newId = id();
  const { rows } = await pool.query(
    "INSERT INTO schedule_shifts (id, restaurant_id, staff_id, shift_date, start_time, end_time, role, created_at, station) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
    [newId, req.restaurantId, staffId, date, startTime, endTime, (role || "").trim() || null, Date.now(), cleanStation(station)]
  );
  res.status(201).json(scheduleShiftRowToJson(rows[0]));
});

// ---------- bulk schedule helpers (used by the AI scheduler and its Apply / Undo) ----------

const SCHEDULE_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const SCHEDULE_BULK_MAX = 250;
const todayLine = () => { const d = ownerToday(); return `${DAY_NAMES_EN[new Date(d + "T12:00:00Z").getUTCDay()]} ${d}`; };
const DAY_NAMES_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]; // index = Date#getUTCDay()

function isIsoDate(v) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

function weekdayKey(dateStr) {
  return WEEKDAY_KEYS[new Date(dateStr + "T00:00:00Z").getUTCDay()];
}

function addDaysIso(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// [startMinute, endMinute) with overnight shifts running past 24:00.
function shiftRange(start, end) {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const a = sh * 60 + sm;
  let b = eh * 60 + em;
  if (b <= a) b += 24 * 60;
  return [a, b];
}

function rangesOverlap(r1, r2) {
  return r1[0] < r2[1] && r2[0] < r1[1];
}

// Checks candidate shifts against the staff list, week window, availability and existing shifts.
// Returns { ok: [...], skipped: [{code, staffName, date}] }. Pure — it writes nothing.
// A busy day blocks the whole day unless it carries hours (from / to); then only shifts overlapping those hours are blocked.
function unavailableOverlaps(entry, shiftRangeMin) {
  if (!entry.from && !entry.to) return true;
  const mins = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
  const f = entry.from ? mins(entry.from) : 0;
  let t = entry.to ? mins(entry.to) : 1440;
  if (t <= f) t = 1440;
  return rangesOverlap([f, t], shiftRangeMin);
}

// True when a shift breaks a day's availability. Busy days block their hours (or the whole day); free days with
// hours ("only from 16:00") block everything outside the window.
function dayConflict(entry, shiftRangeMin) {
  if (!entry) return false;
  if (entry.available === false) return unavailableOverlaps(entry, shiftRangeMin);
  if (entry.available === true && (entry.from || entry.to)) {
    const mins = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
    const f = entry.from ? mins(entry.from) : 0;
    let t = Infinity;
    if (entry.to) { t = mins(entry.to); if (t <= f) t += 1440; }
    return !(shiftRangeMin[0] >= f && shiftRangeMin[1] <= t);
  }
  return false;
}

function checkScheduleCandidates(candidates, { staffById, existing, availabilityByStaff, timeOffByStaff, windowStart, windowEnd }) {
  const ok = [];
  const skipped = [];
  const taken = {}; // `${staffId}|${date}` -> ranges already on the grid or accepted so far
  existing.forEach((e) => {
    const k = `${e.staffId}|${e.date}`;
    (taken[k] = taken[k] || []).push(shiftRange(e.startTime, e.endTime));
  });
  for (const c of candidates) {
    const person = staffById[c && c.staffId];
    if (!person) { skipped.push({ code: "unknown_staff", staffName: "", date: (c && c.date) || "" }); continue; }
    const base = { staffName: person.name, date: c.date };
    if (!isIsoDate(c.date) || (windowStart && c.date < windowStart) || (windowEnd && c.date > windowEnd)) { skipped.push({ ...base, code: "bad_date" }); continue; }
    if (!SCHEDULE_TIME_RE.test(String(c.startTime)) || !SCHEDULE_TIME_RE.test(String(c.endTime)) || c.startTime === c.endTime) { skipped.push({ ...base, code: "bad_time" }); continue; }
    const range = shiftRange(c.startTime, c.endTime);
    if (range[1] - range[0] > 16 * 60) { skipped.push({ ...base, code: "bad_time" }); continue; }
    const avail = availabilityByStaff && availabilityByStaff[c.staffId];
    const dayEntry = avail && avail[weekdayKey(c.date)];
    if (dayEntry && dayConflict(dayEntry, range)) { skipped.push({ ...base, code: "unavailable" }); continue; }
    const offToday = (timeOffByStaff && timeOffByStaff[c.staffId] && timeOffByStaff[c.staffId][c.date]) || [];
    if (offToday.some((o) => unavailableOverlaps(o, range))) { skipped.push({ ...base, code: "unavailable" }); continue; }
    const k = `${c.staffId}|${c.date}`;
    if ((taken[k] || []).some((r) => rangesOverlap(r, range))) { skipped.push({ ...base, code: "overlap" }); continue; }
    (taken[k] = taken[k] || []).push(range);
    const roles = person.roles || [];
    const role = roles.includes(c.role) ? c.role : (roles[0] || "");
    ok.push({ staffId: c.staffId, staffName: person.name, date: c.date, startTime: c.startTime, endTime: c.endTime, role, station: cleanStation(c.station) });
  }
  return { ok, skipped };
}

async function loadAvailabilityMap(restaurantId, staffIds) {
  if (staffIds.length === 0) return {};
  const { rows } = await pool.query("SELECT staff_id, availability FROM staff_availability WHERE restaurant_id = $1 AND staff_id = ANY($2)", [restaurantId, staffIds]);
  const map = {};
  rows.forEach((r) => { map[r.staff_id] = r.availability || {}; });
  return map;
}

// Approved one-time time off: staffId -> date -> [{from, to, note}] (empty from/to = all day).
async function loadTimeOffMap(restaurantId, staffIds, start, end) {
  if (staffIds.length === 0) return {};
  const { rows } = await pool.query(
    "SELECT * FROM staff_time_off WHERE restaurant_id = $1 AND status = 'approved' AND staff_id = ANY($2) AND off_date >= $3 AND off_date <= $4",
    [restaurantId, staffIds, start, end]
  );
  const map = {};
  rows.forEach((r) => {
    ((map[r.staff_id] = map[r.staff_id] || {})[r.off_date] = map[r.staff_id][r.off_date] || []).push({ from: r.from_time || "", to: r.to_time || "", note: r.note || "" });
  });
  return map;
}

// Insert several shifts at once (all or nothing). Conflicts with what's already on the grid are skipped, not errors.
app.post("/api/schedule/bulk", requireAuth, async (req, res) => {
  const list = req.body && req.body.shifts;
  if (!Array.isArray(list) || list.length === 0) return res.status(400).json({ error: "shifts must be a non-empty array" });
  if (list.length > SCHEDULE_BULK_MAX) return res.status(400).json({ error: `at most ${SCHEDULE_BULK_MAX} shifts at a time` });
  const dates = list.map((c) => c && c.date).filter(isIsoDate).sort();
  if (dates.length === 0) return res.status(400).json({ error: "valid dates are required" });
  const { rows: staffRows } = await pool.query("SELECT id, name, roles FROM staff WHERE restaurant_id = $1 AND archived_at IS NULL", [req.restaurantId]);
  const staffById = {};
  staffRows.forEach((r) => { staffById[r.id] = { name: r.name, roles: r.roles || [] }; });
  const { rows: existingRows } = await pool.query(
    "SELECT * FROM schedule_shifts WHERE restaurant_id = $1 AND shift_date >= $2 AND shift_date <= $3",
    [req.restaurantId, dates[0], dates[dates.length - 1]]
  );
  const existing = existingRows.map(scheduleShiftRowToJson);
  const { ok, skipped } = checkScheduleCandidates(
    list.map((c) => ({ staffId: c && c.staffId, date: c && c.date, startTime: c && c.startTime, endTime: c && c.endTime, role: c && c.role, station: c && c.station })),
    { staffById, existing, availabilityByStaff: null }
  );
  const client = await pool.connect();
  const created = [];
  try {
    await client.query("BEGIN");
    for (const sh of ok) {
      const { rows } = await client.query(
        "INSERT INTO schedule_shifts (id, restaurant_id, staff_id, shift_date, start_time, end_time, role, created_at, station) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
        [id(), req.restaurantId, sh.staffId, sh.date, sh.startTime, sh.endTime, sh.role || null, Date.now(), sh.station || null]
      );
      created.push(scheduleShiftRowToJson(rows[0]));
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  res.status(201).json({ created, skipped });
});

// Undo for a bulk insert: removes exactly the shifts that were created.
app.post("/api/schedule/bulk-delete", requireAuth, async (req, res) => {
  const ids = req.body && req.body.ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > SCHEDULE_BULK_MAX) return res.status(400).json({ error: "ids must be a non-empty array" });
  const result = await pool.query("DELETE FROM schedule_shifts WHERE restaurant_id = $1 AND id = ANY($2)", [req.restaurantId, ids.map(String)]);
  res.json({ deleted: result.rowCount });
});

app.patch("/api/schedule/:id", requireAuth, async (req, res) => {
  const { rows: existing } = await pool.query("SELECT * FROM schedule_shifts WHERE id = $1 AND restaurant_id = $2", [req.params.id, req.restaurantId]);
  if (existing.length === 0) return res.status(404).json({ error: "shift not found" });

  const { startTime, endTime, role, date, staffId, station } = req.body || {};
  if (station && !STATIONS.includes(station)) return res.status(400).json({ error: `station must be one of: ${STATIONS.join(", ")}` });
  const updates = {
    station: existing[0].station || null,
    start_time: existing[0].start_time,
    end_time: existing[0].end_time,
    role: existing[0].role,
    shift_date: existing[0].shift_date,
    staff_id: existing[0].staff_id,
  };
  if (startTime !== undefined) updates.start_time = startTime;
  if (endTime !== undefined) updates.end_time = endTime;
  if (role !== undefined) updates.role = role.trim() || null;
  if (date !== undefined) updates.shift_date = date;
  if (staffId !== undefined) updates.staff_id = staffId;
  if (station !== undefined) updates.station = cleanStation(station);

  const { rows } = await pool.query(
    "UPDATE schedule_shifts SET staff_id=$1, shift_date=$2, start_time=$3, end_time=$4, role=$5, station=$6 WHERE id=$7 AND restaurant_id=$8 RETURNING *",
    [updates.staff_id, updates.shift_date, updates.start_time, updates.end_time, updates.role, updates.station, req.params.id, req.restaurantId]
  );
  res.json(scheduleShiftRowToJson(rows[0]));
});

// Punch clock: apply what people really worked to the schedule. Each entry is { id, punchIn?, punchOut?, reset? }.
// A time left empty keeps the current value; reset:true puts the originally scheduled times back. All or nothing.
app.post("/api/schedule/punch", requireAuth, async (req, res) => {
  const entries = req.body && req.body.entries;
  if (!Array.isArray(entries) || entries.length === 0) return res.status(400).json({ error: "entries must be a non-empty array" });
  if (entries.length > 200) return res.status(400).json({ error: "too many entries" });
  const ids = entries.map((e) => e && e.id);
  const { rows } = await pool.query("SELECT * FROM schedule_shifts WHERE restaurant_id = $1 AND id = ANY($2)", [req.restaurantId, ids]);
  const byId = {};
  rows.forEach((r) => { byId[r.id] = r; });
  const plan = [];
  for (const e of entries) {
    const row = byId[e && e.id];
    if (!row) return res.status(404).json({ error: "shift not found" });
    if (e.reset) {
      if (!row.scheduled_start) continue; // never punched: nothing to undo
      plan.push({ id: row.id, start: row.scheduled_start, end: row.scheduled_end || row.end_time, punchIn: null, punchOut: null, schedStart: null, schedEnd: null });
      continue;
    }
    const pin = e.punchIn ? String(e.punchIn) : "", pout = e.punchOut ? String(e.punchOut) : "";
    if ((pin && !SCHEDULE_TIME_RE.test(pin)) || (pout && !SCHEDULE_TIME_RE.test(pout))) return res.status(400).json({ error: "times must look like 17:00" });
    if (!pin && !pout) continue;
    const start = pin || row.start_time, end = pout || row.end_time;
    if (start === end) return res.status(400).json({ error: "start and end can't be the same time" });
    plan.push({
      id: row.id, start, end,
      punchIn: pin || row.punch_in || null, punchOut: pout || row.punch_out || null,
      schedStart: row.scheduled_start || row.start_time, schedEnd: row.scheduled_end || row.end_time,
    });
  }
  const client = await pool.connect();
  const out = [];
  try {
    await client.query("BEGIN");
    for (const u of plan) {
      const { rows: done } = await client.query(
        "UPDATE schedule_shifts SET start_time=$1, end_time=$2, punch_in=$3, punch_out=$4, scheduled_start=$5, scheduled_end=$6 WHERE id=$7 AND restaurant_id=$8 RETURNING *",
        [u.start, u.end, u.punchIn, u.punchOut, u.schedStart, u.schedEnd, u.id, req.restaurantId]
      );
      out.push(scheduleShiftRowToJson(done[0]));
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  if (out.length) logActivity({ restaurantId: req.restaurantId, eventType: "punch_applied", detail: `${out.length} shift${out.length === 1 ? "" : "s"} updated from punch times` });
  res.json({ updated: out });
});

app.delete("/api/schedule/:id", requireAuth, async (req, res) => {
  // ?notify=1 (the punch clock's "Cancel shift") also texts the person, but only for a shift that hasn't happened yet.
  const { rows } = req.query.notify === "1"
    ? await pool.query("SELECT * FROM schedule_shifts WHERE id = $1 AND restaurant_id = $2", [req.params.id, req.restaurantId])
    : { rows: [] };
  await pool.query("DELETE FROM schedule_shifts WHERE id = $1 AND restaurant_id = $2", [req.params.id, req.restaurantId]);
  if (rows[0]) {
    const sh = scheduleShiftRowToJson(rows[0]);
    if (sh.date >= ownerToday()) {
      const when = (loc) => `${new Date(sh.date + "T12:00:00").toLocaleDateString(loc, { weekday: "short", month: "short", day: "numeric" })} (${sh.startTime}–${sh.endTime})`;
      notifyStaff(req.restaurantId, sh.staffId, `Votre quart du ${when("fr-CA")} a été annulé.`, `Your shift on ${when("en-CA")} has been cancelled.`);
    }
  }
  res.status(204).end();
});

// ---------- projected sales (manual daily entry) ----------

// ---------- "Getting started" walk-through (bubble tour + checklist) ----------

const TOUR_STATUSES = ["active", "done", "skipped"];
const TOUR_MAX_STEP = 40;

async function readTour(subject, tour, defaultStatus) {
  const { rows } = await pool.query("SELECT status, step FROM tour_progress WHERE subject = $1 AND tour = $2", [subject, tour]);
  return rows[0] ? { status: rows[0].status, step: rows[0].step } : { status: defaultStatus, step: 0 };
}
async function writeTour(subject, tour, body) {
  const status = String((body && body.status) || "");
  if (!TOUR_STATUSES.includes(status)) return { error: "status must be active, done or skipped" };
  let step = Number(body && body.step);
  if (!Number.isInteger(step) || step < 0 || step > TOUR_MAX_STEP) step = 0;
  await pool.query(
    `INSERT INTO tour_progress (subject, tour, status, step, updated_at) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (subject, tour) DO UPDATE SET status = EXCLUDED.status, step = EXCLUDED.step, updated_at = EXCLUDED.updated_at`,
    [subject, tour, status, step, Date.now()]
  );
  return { tour: { status, step } };
}
// A manager (or an owner opening one of their restaurants) — one tour each, per restaurant for owners.
function managerTourSubject(req) {
  return req.ownerId ? `owner:${req.ownerId}:${req.restaurantId}` : `user:${req.userId}`;
}

// The setup checklist is worked out from what actually exists, so it ticks itself off.
async function setupChecklist(restaurantId) {
  const one = async (sql) => (await pool.query(sql, [restaurantId])).rows[0].ok;
  const items = [
    { key: "staff", done: await one("SELECT EXISTS(SELECT 1 FROM staff WHERE restaurant_id = $1) AS ok") },
    { key: "login", done: await one("SELECT EXISTS(SELECT 1 FROM staff WHERE restaurant_id = $1 AND (password_hash IS NOT NULL OR claim_token IS NOT NULL)) AS ok") },
    { key: "services", done: await one("SELECT (services IS NOT NULL) AS ok FROM restaurants WHERE id = $1") },
    { key: "schedule", done: await one("SELECT EXISTS(SELECT 1 FROM schedule_shifts WHERE restaurant_id = $1) AS ok") },
    { key: "sales", done: await one("SELECT EXISTS(SELECT 1 FROM actual_sales WHERE restaurant_id = $1 AND amount IS NOT NULL) AS ok") },
    { key: "post", done: await one("SELECT EXISTS(SELECT 1 FROM schedule_published WHERE restaurant_id = $1) AS ok") },
  ];
  return { items, allDone: items.every((i) => i.done) };
}

app.get("/api/tour", requireAuth, async (req, res) => {
  // New restaurants start the tour; an owner just peeking at a restaurant does not get it forced on them.
  const tour = await readTour(managerTourSubject(req), "manager", req.ownerId ? "done" : "new");
  res.json({ tour, checklist: await setupChecklist(req.restaurantId) });
});
app.put("/api/tour", requireAuth, async (req, res) => {
  const r = await writeTour(managerTourSubject(req), "manager", req.body);
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ tour: r.tour });
});
app.get("/api/staff-auth/tour", requireStaffAuth, async (req, res) => {
  res.json({ tour: await readTour(`staff:${req.staffId}`, "staff", "new") });
});
app.put("/api/staff-auth/tour", requireStaffAuth, async (req, res) => {
  const r = await writeTour(`staff:${req.staffId}`, "staff", req.body);
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ tour: r.tour });
});

// ---------- services (breakfast / lunch / dinner ... per restaurant) ----------
// A service starts at `from` (HH:MM) and runs until the next service starts. A shift belongs to the last service whose
// `from` is at or before the shift's start time; shifts that start before the first service belong to the first one.

const DEFAULT_SERVICES = [
  { id: "lunch", name: "Lunch / Brunch", from: "00:00" },
  { id: "dinner", name: "Dinner", from: "15:00" },
];

function normalizeServices(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 4) return { error: "Add between 1 and 4 services." };
  const out = [];
  const usedIds = new Set();
  for (const raw of input) {
    const name = String((raw && raw.name) || "").trim().slice(0, 30);
    const from = String((raw && raw.from) || "");
    if (!name) return { error: "Every service needs a name." };
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(from)) return { error: `"${name}" needs a start time like 11:00.` };
    let sid = String((raw && raw.id) || "");
    if (!/^[a-z0-9_-]{1,20}$/.test(sid) || usedIds.has(sid)) sid = "s" + crypto.randomBytes(3).toString("hex");
    usedIds.add(sid);
    out.push({ id: sid, name, from });
  }
  out.sort((x, y) => x.from.localeCompare(y.from));
  for (let i = 1; i < out.length; i++) if (out[i].from === out[i - 1].from) return { error: "Two services can't start at the same time." };
  return { services: out };
}

async function getServices(restaurantId) {
  const { rows } = await pool.query("SELECT services FROM restaurants WHERE id = $1", [restaurantId]);
  const sv = rows[0] && rows[0].services;
  return Array.isArray(sv) && sv.length ? sv : DEFAULT_SERVICES;
}

app.get("/api/services", requireAuth, async (req, res) => {
  res.json({ services: await getServices(req.restaurantId) });
});

app.put("/api/services", requireAuth, async (req, res) => {
  const r = normalizeServices((req.body || {}).services);
  if (r.error) return res.status(400).json({ error: r.error });
  await pool.query("UPDATE restaurants SET services = $1::jsonb WHERE id = $2", [JSON.stringify(r.services), req.restaurantId]);
  logActivity({ restaurantId: req.restaurantId, eventType: "services_updated", detail: r.services.map((x) => `${x.name} ${x.from}`).join(" · ") });
  res.json({ services: r.services });
});

const parseMoneyField = (raw, label) => {
  if (raw === undefined) return { provided: false };
  if (raw === null || raw === "") return { provided: true, value: null };
  const n = Number(raw);
  if (isNaN(n) || n < 0) return { error: `${label} must be a positive number` };
  return { provided: true, value: n };
};

// Reads per-service amounts from a request body: `serviceAmounts: {id: value}` (and the older lunchAmount / dinnerAmount keys).
function parseServiceAmounts(body, services) {
  const ids = new Set(services.map((x) => x.id));
  const provided = new Map();
  const add = (sid, raw, label) => {
    if (!ids.has(sid)) return { error: `unknown service "${sid}"` };
    const p = parseMoneyField(raw, label);
    if (p.error) return p;
    if (p.provided) provided.set(sid, p.value);
    return {};
  };
  const sa = body && body.serviceAmounts;
  if (sa && typeof sa === "object" && !Array.isArray(sa)) {
    for (const k of Object.keys(sa)) { const r = add(k, sa[k], `${k} amount`); if (r.error) return r; }
  }
  if (body && body.lunchAmount !== undefined) { const r = add("lunch", body.lunchAmount, "lunch amount"); if (r.error) return r; }
  if (body && body.dinnerAmount !== undefined) { const r = add("dinner", body.dinnerAmount, "dinner amount"); if (r.error) return r; }
  return { provided };
}

function mergeServiceAmounts(prev, provided) {
  const out = { ...(prev && typeof prev === "object" ? prev : {}) };
  provided.forEach((v, k) => { if (v === null) delete out[k]; else out[k] = v; });
  return out;
}
function sumServiceAmounts(amounts, services) {
  let any = false, sum = 0;
  for (const sv of services) {
    const v = amounts && amounts[sv.id];
    if (v !== undefined && v !== null) { any = true; sum += Number(v); }
  }
  return any ? Math.round(sum * 100) / 100 : null;
}
const cleanAmounts = (a) => {
  const out = {};
  if (a && typeof a === "object") Object.keys(a).forEach((k) => { if (a[k] !== null && a[k] !== undefined) out[k] = Number(a[k]); });
  return out;
};

// ---------- projected sales (manual daily entry) ----------

function projectionRowToJson(r) {
  const num = (v) => (v !== null && v !== undefined ? Number(v) : null);
  const serviceAmounts = cleanAmounts(r.service_amounts);
  return {
    date: r.proj_date instanceof Date ? r.proj_date.toISOString().slice(0, 10) : r.proj_date,
    projectedAmount: num(r.projected_amount),
    serviceAmounts,
    lunchAmount: serviceAmounts.lunch !== undefined ? serviceAmounts.lunch : null,
    dinnerAmount: serviceAmounts.dinner !== undefined ? serviceAmounts.dinner : null,
    lastYearAmount: num(r.last_year_amount),
    aiAmount: num(r.ai_amount),
  };
}

app.get("/api/sales-projections", requireAuth, async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: "start and end date query params are required (YYYY-MM-DD)" });
  const { rows } = await pool.query(
    "SELECT * FROM sales_projections WHERE restaurant_id = $1 AND proj_date >= $2 AND proj_date <= $3",
    [req.restaurantId, start, end]
  );
  res.json(rows.map(projectionRowToJson));
});

app.put("/api/sales-projections", requireAuth, async (req, res) => {
  const { date, projectedAmount, lastYearAmount } = req.body || {};
  if (!date) return res.status(400).json({ error: "date is required" });
  const services = await getServices(req.restaurantId);
  const total = parseMoneyField(projectedAmount, "projected amount");
  const lastYear = parseMoneyField(lastYearAmount, "last year amount");
  const sa = parseServiceAmounts(req.body, services);
  for (const p of [total, lastYear, sa]) if (p.error) return res.status(400).json({ error: p.error });
  if (!total.provided && !sa.provided.size && !lastYear.provided) return res.status(400).json({ error: "projectedAmount, serviceAmounts or lastYearAmount is required" });

  const { rows: existing } = await pool.query("SELECT service_amounts FROM sales_projections WHERE restaurant_id = $1 AND proj_date = $2", [req.restaurantId, date]);
  const merged = sa.provided.size ? mergeServiceAmounts(existing[0] && existing[0].service_amounts, sa.provided) : null;
  // Typing a service forecast makes the day's total = the sum of the services (unless the total itself was sent).
  const setTotal = total.provided || !!merged;
  const totalVal = total.provided ? total.value : merged ? sumServiceAmounts(merged, services) : null;

  const { rows } = await pool.query(
    `INSERT INTO sales_projections (id, restaurant_id, proj_date, projected_amount, service_amounts, last_year_amount, created_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
     ON CONFLICT (restaurant_id, proj_date) DO UPDATE SET
       projected_amount = CASE WHEN $8 THEN EXCLUDED.projected_amount ELSE sales_projections.projected_amount END,
       service_amounts = CASE WHEN $9 THEN EXCLUDED.service_amounts ELSE sales_projections.service_amounts END,
       last_year_amount = CASE WHEN $10 THEN EXCLUDED.last_year_amount ELSE sales_projections.last_year_amount END
     RETURNING *`,
    [id(), req.restaurantId, date, setTotal ? totalVal : null, merged ? JSON.stringify(merged) : null, lastYear.provided ? lastYear.value : null, Date.now(),
     setTotal, !!merged, lastYear.provided]
  );
  res.json(projectionRowToJson(rows[0]));
});

// ---------- actual sales (empty until a POS integration exists; this is the slot it will write into) ----------

// The per-service food/beverage split of a day. Days entered before services had their own rows (a whole-day food / beverage
// pair and no split) are shown under the LAST service of the day (normally dinner) until the manager edits them.
function effectiveServiceSplit(r, services) {
  const out = {};
  const sp = r && r.service_split;
  if (sp && typeof sp === "object") {
    Object.keys(sp).forEach((k) => {
      const f = sp[k] && sp[k].food, b = sp[k] && sp[k].bev;
      if ((f !== null && f !== undefined) || (b !== null && b !== undefined)) out[k] = { food: f !== null && f !== undefined ? Number(f) : null, bev: b !== null && b !== undefined ? Number(b) : null };
    });
    if (Object.keys(out).length) return out;
  }
  const hasF = r && r.food_amount !== null && r.food_amount !== undefined, hasB = r && r.bev_amount !== null && r.bev_amount !== undefined;
  if ((hasF || hasB) && services && services.length) out[services[services.length - 1].id] = { food: hasF ? Number(r.food_amount) : null, bev: hasB ? Number(r.bev_amount) : null };
  return out;
}

function actualSalesRowToJson(r, services) {
  const num = (v) => (v !== null && v !== undefined ? Number(v) : null);
  return {
    serviceSplit: effectiveServiceSplit(r, services),
    date: r.sale_date instanceof Date ? r.sale_date.toISOString().slice(0, 10) : r.sale_date,
    amount: num(r.amount),
    foodAmount: num(r.food_amount),
    bevAmount: num(r.bev_amount),
    serviceAmounts: cleanAmounts(r.service_amounts),
    lunchAmount: r.service_amounts && r.service_amounts.lunch !== undefined && r.service_amounts.lunch !== null ? Number(r.service_amounts.lunch) : null,
    dinnerAmount: r.service_amounts && r.service_amounts.dinner !== undefined && r.service_amounts.dinner !== null ? Number(r.service_amounts.dinner) : null,
    source: r.source,
  };
}

app.get("/api/actual-sales", requireAuth, async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: "start and end date query params are required (YYYY-MM-DD)" });
  const { rows } = await pool.query(
    "SELECT * FROM actual_sales WHERE restaurant_id = $1 AND sale_date >= $2 AND sale_date <= $3",
    [req.restaurantId, start, end]
  );
  const services = await getServices(req.restaurantId);
  res.json(rows.map((r) => actualSalesRowToJson(r, services)));
});

// Ways to write a day's sales:
//  - foodAmount and/or bevAmount: the manager's entry (or a POS that reports categories). The day's total is food + beverage.
//  - amount only: a POS total with no split. The food/beverage split is cleared so the total stays authoritative.
//  - serviceSplit: {serviceId: {food, bev}} — the Sales tab's rows. Each service's amount (what the schedule grid shows) is its
//    food + beverage, and the day's food / beverage / total are the sums across services.
// Empty string or null clears a value.
app.put("/api/actual-sales", requireAuth, async (req, res) => {
  const { date, amount, foodAmount, bevAmount, source } = req.body || {};
  if (!date) return res.status(400).json({ error: "date is required" });

  const services = await getServices(req.restaurantId);
  const total = parseMoneyField(amount, "amount");
  const food = parseMoneyField(foodAmount, "foodAmount");
  const bev = parseMoneyField(bevAmount, "bevAmount");
  const sa = parseServiceAmounts(req.body, services);
  for (const p of [total, food, bev, sa]) if (p.error) return res.status(400).json({ error: p.error });

  // Per-service food / beverage cells (the Sales tab).
  if (req.body && req.body.serviceSplit !== undefined) {
    const ss = req.body.serviceSplit;
    if (!ss || typeof ss !== "object" || Array.isArray(ss)) return res.status(400).json({ error: "serviceSplit must be an object" });
    const ids = new Set(services.map((x) => x.id));
    const edits = [];
    for (const sid of Object.keys(ss)) {
      if (!ids.has(sid)) return res.status(400).json({ error: `unknown service "${sid}"` });
      const f = parseMoneyField(ss[sid] && ss[sid].food, `${sid} food`), b = parseMoneyField(ss[sid] && ss[sid].bev, `${sid} beverage`);
      if (f.error) return res.status(400).json({ error: f.error });
      if (b.error) return res.status(400).json({ error: b.error });
      edits.push([sid, f, b]);
    }
    const { rows: existing } = await pool.query("SELECT * FROM actual_sales WHERE restaurant_id = $1 AND sale_date = $2", [req.restaurantId, date]);
    const prev = existing[0] || {};
    const split = effectiveServiceSplit(prev, services);
    const sAmts = cleanAmounts(prev.service_amounts);
    for (const [sid, f, b] of edits) {
      const cur = split[sid] || { food: null, bev: null };
      if (f.provided) cur.food = f.value;
      if (b.provided) cur.bev = b.value;
      if (cur.food === null && cur.bev === null) { delete split[sid]; delete sAmts[sid]; } else split[sid] = cur;
    }
    // every service that has a split is food + beverage; the others keep whatever amount they had
    Object.keys(split).forEach((sid) => { sAmts[sid] = Math.round(((split[sid].food || 0) + (split[sid].bev || 0)) * 100) / 100; });
    const keys = Object.keys(split);
    const foodSum = keys.some((k) => split[k].food !== null) ? Math.round(keys.reduce((n, k) => n + (split[k].food || 0), 0) * 100) / 100 : null;
    const bevSum = keys.some((k) => split[k].bev !== null) ? Math.round(keys.reduce((n, k) => n + (split[k].bev || 0), 0) * 100) / 100 : null;
    const amt = sumServiceAmounts(sAmts, services);
    const { rows } = await pool.query(
      `INSERT INTO actual_sales (id, restaurant_id, sale_date, amount, food_amount, bev_amount, service_amounts, service_split, source, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10)
       ON CONFLICT (restaurant_id, sale_date) DO UPDATE
         SET amount = EXCLUDED.amount, food_amount = EXCLUDED.food_amount, bev_amount = EXCLUDED.bev_amount,
             service_amounts = EXCLUDED.service_amounts, service_split = EXCLUDED.service_split, source = EXCLUDED.source
       RETURNING *`,
      [id(), req.restaurantId, date, amt, foodSum, bevSum, JSON.stringify(sAmts), JSON.stringify(split), (source || "manual").trim(), Date.now()]
    );
    return res.json(actualSalesRowToJson(rows[0], services));
  }

  // Per-service amounts only (the schedule grid's boxes): the day's total becomes the sum of the services,
  // unless the day already has a food/beverage split — then that split stays the authority for the total.
  if (sa.provided.size && !total.provided && !food.provided && !bev.provided) {
    const { rows: existing } = await pool.query("SELECT * FROM actual_sales WHERE restaurant_id = $1 AND sale_date = $2", [req.restaurantId, date]);
    const prev = existing[0] || {};
    const prevNum = (v) => (v !== null && v !== undefined ? Number(v) : null);
    const merged = mergeServiceAmounts(prev.service_amounts, sa.provided);
    const hasCategorySplit = (prev.food_amount !== null && prev.food_amount !== undefined) || (prev.bev_amount !== null && prev.bev_amount !== undefined);
    const amt2 = hasCategorySplit ? prevNum(prev.amount) : sumServiceAmounts(merged, services);
    const { rows } = await pool.query(
      `INSERT INTO actual_sales (id, restaurant_id, sale_date, amount, service_amounts, source, created_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
       ON CONFLICT (restaurant_id, sale_date) DO UPDATE SET amount = EXCLUDED.amount, service_amounts = EXCLUDED.service_amounts
       RETURNING *`,
      [id(), req.restaurantId, date, amt2, JSON.stringify(merged), (source || "manual").trim(), Date.now()]
    );
    return res.json(actualSalesRowToJson(rows[0], services));
  }

  let foodVal = null, bevVal = null, amt = null;
  if (food.provided || bev.provided) {
    // Keep whichever half the request didn't mention.
    const { rows: existing } = await pool.query(
      "SELECT food_amount, bev_amount FROM actual_sales WHERE restaurant_id = $1 AND sale_date = $2",
      [req.restaurantId, date]
    );
    const prev = existing[0] || {};
    foodVal = food.provided ? food.value : (prev.food_amount !== undefined && prev.food_amount !== null ? Number(prev.food_amount) : null);
    bevVal = bev.provided ? bev.value : (prev.bev_amount !== undefined && prev.bev_amount !== null ? Number(prev.bev_amount) : null);
    amt = foodVal === null && bevVal === null ? null : (foodVal || 0) + (bevVal || 0);
  } else {
    amt = total.provided ? total.value : null;
  }

  const newId = id();
  const { rows } = await pool.query(
    `INSERT INTO actual_sales (id, restaurant_id, sale_date, amount, food_amount, bev_amount, source, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (restaurant_id, sale_date) DO UPDATE
       SET amount = EXCLUDED.amount, food_amount = EXCLUDED.food_amount, bev_amount = EXCLUDED.bev_amount, source = EXCLUDED.source, service_split = NULL
     RETURNING *`,
    [newId, req.restaurantId, date, amt, foodVal, bevVal, (source || "manual").trim(), Date.now()]
  );
  if (sa.provided.size) {
    const merged = mergeServiceAmounts(rows[0].service_amounts, sa.provided);
    const upd = await pool.query(
      "UPDATE actual_sales SET service_amounts = $1::jsonb WHERE restaurant_id = $2 AND sale_date = $3 RETURNING *",
      [JSON.stringify(merged), req.restaurantId, date]
    );
    return res.json(actualSalesRowToJson(upd.rows[0], services));
  }
  res.json(actualSalesRowToJson(rows[0], services));
});

// ---------- revenue history: this year (from daily sales) vs last year (entered weekly) ----------
// Weeks run Monday–Sunday. A week belongs to the year and month that contain its THURSDAY (ISO rule), so the
// 52/53 weeks of a year line up with the same weeks a year earlier (this week's Monday minus 364 days).

function isoWeekMondays(year) {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const first = new Date(jan4);
  first.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7));
  const out = [];
  for (let d = new Date(first); ; d.setUTCDate(d.getUTCDate() + 7)) {
    const thursday = new Date(d);
    thursday.setUTCDate(d.getUTCDate() + 3);
    if (thursday.getUTCFullYear() !== year) break;
    out.push({ weekStart: d.toISOString().slice(0, 10), month: thursday.getUTCMonth() + 1 });
  }
  return out;
}

const pctChange = (now, before) => (before > 0 && now !== null ? Math.round(((now - before) / before) * 1000) / 10 : null);

// weeks: [{weekStart, month}], thisYearByWeek: {weekStart: {amount, days}}, lastYearByWeek: {weekStart: amount}
function buildRevenueSummary({ year, today, weeks, thisYearByWeek, lastYearByWeek }) {
  const rows = weeks.map((w) => {
    const weekEnd = addDaysIso(w.weekStart, 6);
    const lastYearWeekStart = addDaysIso(w.weekStart, -364);
    const mine = thisYearByWeek[w.weekStart];
    return {
      weekStart: w.weekStart,
      weekEnd,
      month: w.month,
      completed: weekEnd < today,
      thisYear: mine ? mine.amount : null,
      daysEntered: mine ? mine.days : 0,
      lastYearWeekStart,
      lastYear: lastYearByWeek[lastYearWeekStart] !== undefined ? lastYearByWeek[lastYearWeekStart] : null,
    };
  });
  // Only finished weeks count toward comparisons; a week is "comparable" when both years have a number.
  const counted = rows.filter((r) => r.completed && r.thisYear !== null);
  const comparable = counted.filter((r) => r.lastYear !== null);
  const sum = (list, f) => list.reduce((n, r) => n + f(r), 0);

  const months = Array.from({ length: 12 }, (_, i) => {
    const m = i + 1;
    const inMonth = rows.filter((r) => r.month === m);
    const cnt = counted.filter((r) => r.month === m);
    const cmp = comparable.filter((r) => r.month === m);
    return {
      month: m,
      complete: inMonth.length > 0 && inMonth.every((r) => r.completed),
      thisYear: cnt.length ? sum(cnt, (r) => r.thisYear) : null,
      lastYear: inMonth.some((r) => r.lastYear !== null) ? sum(inMonth, (r) => r.lastYear || 0) : null,
      weeksCompared: cmp.length,
      changePct: cmp.length ? pctChange(sum(cmp, (r) => r.thisYear), sum(cmp, (r) => r.lastYear)) : null,
      _cmpThis: sum(cmp, (r) => r.thisYear),
      _cmpLast: sum(cmp, (r) => r.lastYear),
    };
  });

  const lastWeek = [...comparable].pop() || null;
  const doneMonths = months.filter((m) => m.complete && m.weeksCompared > 0);
  const lastMonth = doneMonths.length ? doneMonths[doneMonths.length - 1] : null;
  const ytdMonthsList = doneMonths;

  const cards = {
    yoy: {
      lastWeek: lastWeek && { weekStart: lastWeek.weekStart, thisYear: lastWeek.thisYear, lastYear: lastWeek.lastYear, changePct: pctChange(lastWeek.thisYear, lastWeek.lastYear) },
      lastMonth: lastMonth && { month: lastMonth.month, thisYear: lastMonth._cmpThis, lastYear: lastMonth._cmpLast, changePct: lastMonth.changePct },
    },
    ytd: {
      weeks: {
        weeksCompared: comparable.length,
        thisYear: sum(comparable, (r) => r.thisYear),
        lastYear: sum(comparable, (r) => r.lastYear),
        changePct: pctChange(sum(comparable, (r) => r.thisYear), sum(comparable, (r) => r.lastYear)),
      },
      months: {
        monthsCompared: ytdMonthsList.length,
        thisYear: sum(ytdMonthsList, (m) => m._cmpThis),
        lastYear: sum(ytdMonthsList, (m) => m._cmpLast),
        changePct: pctChange(sum(ytdMonthsList, (m) => m._cmpThis), sum(ytdMonthsList, (m) => m._cmpLast)),
      },
    },
  };
  months.forEach((m) => { delete m._cmpThis; delete m._cmpLast; });
  return { year, weeks: rows, months, cards };
}

app.get("/api/revenue-history", requireAuth, async (req, res) => {
  const year = req.query.year ? parseInt(req.query.year, 10) : new Date().getUTCFullYear();
  if (!(year >= 2000 && year <= 2100)) return res.status(400).json({ error: "year must be between 2000 and 2100" });
  const weeks = isoWeekMondays(year);
  const first = weeks[0].weekStart;
  const last = addDaysIso(weeks[weeks.length - 1].weekStart, 6);
  const { rows: sales } = await pool.query(
    "SELECT sale_date::text AS d, amount FROM actual_sales WHERE restaurant_id = $1 AND sale_date >= $2 AND sale_date <= $3 AND amount IS NOT NULL",
    [req.restaurantId, first, last]
  );
  const thisYearByWeek = {};
  sales.forEach((r) => {
    const wk = mondayOfIso(r.d);
    const e = (thisYearByWeek[wk] = thisYearByWeek[wk] || { amount: 0, days: 0 });
    e.amount += Number(r.amount);
    e.days += 1;
  });
  const { rows: hist } = await pool.query(
    "SELECT week_start::text AS w, amount FROM weekly_sales_history WHERE restaurant_id = $1 AND week_start >= $2 AND week_start <= $3",
    [req.restaurantId, addDaysIso(first, -364), addDaysIso(last, -364)]
  );
  const lastYearByWeek = {};
  hist.forEach((r) => { lastYearByWeek[r.w] = Number(r.amount); });
  // A week with last year's figure typed for all seven days (daily box) counts as that week's total unless a weekly total was typed.
  const { rows: dly } = await pool.query(
    "SELECT proj_date::text AS d, last_year_amount FROM sales_projections WHERE restaurant_id = $1 AND proj_date >= $2 AND proj_date <= $3 AND last_year_amount IS NOT NULL",
    [req.restaurantId, first, last]
  );
  const dailyByWeek = {};
  dly.forEach((r) => { const wk = mondayOfIso(r.d); const e = (dailyByWeek[wk] = dailyByWeek[wk] || { amount: 0, days: 0 }); e.amount += Number(r.last_year_amount); e.days += 1; });
  Object.keys(dailyByWeek).forEach((wk) => {
    const key = addDaysIso(wk, -364);
    if (dailyByWeek[wk].days === 7 && lastYearByWeek[key] === undefined) lastYearByWeek[key] = dailyByWeek[wk].amount;
  });
  const today = ownerToday();
  res.json({ today, ...buildRevenueSummary({ year, today, weeks, thisYearByWeek, lastYearByWeek }) });
});

// Enter (or clear) one past week's total. weekStart is that past week's Monday.
app.put("/api/revenue-history", requireAuth, async (req, res) => {
  const { weekStart, amount } = req.body || {};
  if (!isIsoDate(weekStart) || new Date(weekStart + "T00:00:00Z").getUTCDay() !== 1) return res.status(400).json({ error: "weekStart must be a Monday (YYYY-MM-DD)" });
  if (weekStart < "2000-01-03" || weekStart > addDaysIso(ownerToday(), 7)) return res.status(400).json({ error: "weekStart is out of range" });
  if (amount === null || amount === "" || amount === undefined) {
    await pool.query("DELETE FROM weekly_sales_history WHERE restaurant_id = $1 AND week_start = $2", [req.restaurantId, weekStart]);
    return res.json({ weekStart, amount: null });
  }
  const n = Number(String(amount).replace(/[$,\s]/g, ""));
  if (isNaN(n) || n < 0 || n > 1e9) return res.status(400).json({ error: "amount must be a positive number" });
  await pool.query(
    `INSERT INTO weekly_sales_history (restaurant_id, week_start, amount, updated_at) VALUES ($1,$2,$3,$4)
     ON CONFLICT (restaurant_id, week_start) DO UPDATE SET amount = EXCLUDED.amount, updated_at = EXCLUDED.updated_at`,
    [req.restaurantId, weekStart, n, Date.now()]
  );
  res.json({ weekStart, amount: n });
});

// ---------- AI sales forecast: fills the "AI forecasted sales" row of the schedule grid ----------
// Looks at recent daily sales by weekday plus last year's numbers; never invents a basis — days without one stay empty.
app.post("/api/ai/sales-forecast", requireAuth, aiLimiter, async (req, res) => {
  if (!aiBoardGuard(req, res)) return;
  const weekStart = String((req.body && req.body.weekStart) || "");
  if (!isIsoDate(weekStart) || new Date(weekStart + "T00:00:00Z").getUTCDay() !== 1) return res.status(400).json({ error: "weekStart must be a Monday (YYYY-MM-DD)" });
  const rid = req.restaurantId;
  const days = [0, 1, 2, 3, 4, 5, 6].map((i) => addDaysIso(weekStart, i));
  try {
    const { rows: recent } = await pool.query(
      "SELECT sale_date::text AS d, amount FROM actual_sales WHERE restaurant_id = $1 AND sale_date >= $2 AND sale_date < $3 AND amount IS NOT NULL ORDER BY sale_date",
      [rid, addDaysIso(weekStart, -84), weekStart]
    );
    const { rows: lyDaily } = await pool.query(
      "SELECT proj_date::text AS d, last_year_amount FROM sales_projections WHERE restaurant_id = $1 AND proj_date >= $2 AND proj_date <= $3 AND last_year_amount IS NOT NULL",
      [rid, days[0], days[6]]
    );
    const { rows: lyWeek } = await pool.query("SELECT amount FROM weekly_sales_history WHERE restaurant_id = $1 AND week_start = $2", [rid, addDaysIso(weekStart, -364)]);
    if (recent.length < 3 && lyDaily.length === 0 && lyWeek.length === 0) {
      return res.status(400).json({ error: "Not enough sales history yet — enter some actual sales, or last year's figures, and try again." });
    }
    // Worked-out figures so the model has a real starting point instead of echoing last year:
    // same-weekday average of recent actuals, and how this year has been running against last year lately.
    const wdOf = (d) => new Date(d + "T00:00:00Z").getUTCDay();
    const recentByDow = {};
    recent.forEach((r) => { (recentByDow[wdOf(r.d)] = recentByDow[wdOf(r.d)] || []).push(Number(r.amount)); });
    const { rows: lyPast } = await pool.query(
      "SELECT proj_date::text AS d, last_year_amount FROM sales_projections WHERE restaurant_id = $1 AND proj_date >= $2 AND proj_date < $3 AND last_year_amount IS NOT NULL",
      [rid, addDaysIso(weekStart, -56), weekStart]
    );
    const actualByDate = {};
    recent.forEach((r) => { actualByDate[r.d] = Number(r.amount); });
    let cmpThis = 0, cmpLast = 0, cmpDays = 0;
    lyPast.forEach((r) => { const a = actualByDate[r.d], l = Number(r.last_year_amount); if (a !== undefined && l > 0) { cmpThis += a; cmpLast += l; cmpDays++; } });
    const trend = cmpDays >= 5 && cmpLast > 0 ? Math.min(1.4, Math.max(0.6, cmpThis / cmpLast)) : null;
    const lyByDate = {};
    lyDaily.forEach((r) => { lyByDate[r.d] = Number(r.last_year_amount); });
    const baselines = days.map((d) => {
      const arr = (recentByDow[wdOf(d)] || []).slice(-6);
      const recentAvg = arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
      const ly = lyByDate[d] !== undefined ? lyByDate[d] : null;
      const lyAdj = ly !== null ? ly * (trend || 1) : null;
      let base = null;
      if (recentAvg !== null && lyAdj !== null) base = arr.length >= 2 ? 0.6 * recentAvg + 0.4 * lyAdj : 0.5 * recentAvg + 0.5 * lyAdj;
      else if (recentAvg !== null) base = recentAvg;
      else if (lyAdj !== null) base = lyAdj;
      return { date: d, recentSameWeekdayAvg: recentAvg === null ? null : Math.round(recentAvg), recentSameWeekdayCount: arr.length, lastYearSameDay: ly, suggestedBaseline: base === null ? null : Math.round(base / 10) * 10 };
    });
    const baseByDate = {};
    baselines.forEach((b) => { baseByDate[b.date] = b.suggestedBaseline; });
    const facts = {
      thisYearVsLastYearRecently: trend === null ? null : { ratio: Math.round(trend * 100) / 100, comparedDays: cmpDays },
      perDay: baselines,
      weekdaysOfTargetWeek: days.map((d) => ({ date: d, weekday: WEEKDAY_KEYS[new Date(d + "T00:00:00Z").getUTCDay()] })),
      recentDailySales: recent.map((r) => ({ date: r.d, weekday: WEEKDAY_KEYS[new Date(r.d + "T00:00:00Z").getUTCDay()], sales: Number(r.amount) })),
      lastYearSameDay: lyDaily.map((r) => ({ date: r.d, sales: Number(r.last_year_amount) })),
      lastYearSameWeekTotal: lyWeek[0] ? Number(lyWeek[0].amount) : null,
    };
    const { text, durationMs } = await callClaude({
      restaurantId: rid, feature: "sales-forecast",
      system: "You forecast a restaurant's total daily sales (dollars) for the seven dates of one week. Use only the data given. For each day start from perDay.suggestedBaseline (it blends the recent same-weekday average with last year's figure scaled by how this year has been running against last year). Adjust it only for a clear reason in the data (a visible weekday pattern, an upward or downward trend in recentDailySales); the days must reflect their own weekday — do not return last year's number unchanged, and do not return the same value for every day. If a day has no baseline and no reasonable basis, return null — never guess wildly. Round to the nearest 10 dollars. Reply with ONLY a JSON object: {\"days\":[{\"date\":\"YYYY-MM-DD\",\"amount\":number|null}]} covering the seven dates.",
      user: JSON.stringify(facts),
      maxTokens: 800,
    });
    const parsed = extractJsonObject(text);
    if (!parsed || !Array.isArray(parsed.days)) {
      logActivity({ restaurantId: rid, eventType: "ai_failed", level: "error", detail: "sales-forecast: unparseable reply", durationMs });
      return res.status(502).json({ error: "The AI agent couldn't build a forecast — try again." });
    }
    const out = [];
    for (const d of parsed.days) {
      if (!d || !days.includes(d.date)) continue;
      let amount = d.amount === null || d.amount === undefined ? null : Number(d.amount);
      if (amount !== null && (isNaN(amount) || amount < 0 || amount > 1e7)) continue;
      // keep the model inside a sane band around the worked-out baseline
      const base = baseByDate[d.date];
      if (amount !== null && base && (amount < base * 0.6 || amount > base * 1.4)) amount = base;
      out.push({ date: d.date, amount: amount === null ? null : Math.round(amount) });
    }
    for (const d of out) {
      await pool.query(
        `INSERT INTO sales_projections (id, restaurant_id, proj_date, ai_amount, created_at) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (restaurant_id, proj_date) DO UPDATE SET ai_amount = EXCLUDED.ai_amount`,
        [id(), rid, d.date, d.amount, Date.now()]
      );
    }
    logActivity({ restaurantId: rid, eventType: "ai_answered", detail: `sales-forecast: week of ${weekStart}`, durationMs });
    res.json({ days: out });
  } catch (e) {
    handleAiBoardError(res, req, "ai_failed", e);
  }
});

// ---------- today's snapshot for the Manager interface: weather, nearby events, last year's figure ----------
// Weather: MET Norway's free Locationforecast (needs an identifying User-Agent). Location: OpenStreetMap Nominatim (also needs one).
// Events: one cached web search a day through the Anthropic API — it only ever sees the restaurant's city, never staff or sales data.

const SNAPSHOT_TZ = "America/Toronto";
const HTTP_UA = "OpenShiftRail/1.0 (https://openshiftrail.com)";
const WEATHER_TTL_MS = 3 * 60 * 60 * 1000;
const EVENTS_TTL_MS = 12 * 60 * 60 * 1000;
const EVENTS_RETRY_MS = 30 * 60 * 1000;
const geoFailedAt = new Map();      // restaurantId -> last failed geocode (don't hammer Nominatim)
const eventsInFlight = new Map();   // `${restaurantId}|${day}` -> promise

async function fetchJsonTimeout(url, options = {}, ms = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { ...options, signal: ctl.signal });
    if (!r.ok) {
      let detail = "";
      try { detail = (await r.text()).slice(0, 400); } catch (e) { /* ignore */ }
      throw new Error(`HTTP ${r.status} ${detail}`.trim());
    }
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

async function geocodeAddress(address) {
  const url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&addressdetails=1&q=" + encodeURIComponent(address);
  const data = await fetchJsonTimeout(url, { headers: { "User-Agent": HTTP_UA, "Accept-Language": "en" } });
  const hit = Array.isArray(data) ? data[0] : null;
  if (!hit) return null;
  const a = hit.address || {};
  const city = a.city || a.town || a.village || a.municipality || a.suburb || "";
  const place = [city, a.state || a.province || "", a.country || ""].filter(Boolean).join(", ");
  return { lat: Number(hit.lat), lon: Number(hit.lon), place };
}

async function ensureRestaurantLocation(restaurantId) {
  const { rows } = await pool.query("SELECT address, geo_lat, geo_lon, geo_for, geo_place FROM restaurants WHERE id = $1", [restaurantId]);
  const r = rows[0];
  if (!r || !r.address || !r.address.trim()) return { status: "no_address" };
  const address = r.address.trim();
  if (r.geo_lat !== null && r.geo_for === address) return { status: "ok", lat: r.geo_lat, lon: r.geo_lon, place: r.geo_place || "" };
  const failed = geoFailedAt.get(restaurantId);
  if (failed && Date.now() - failed < EVENTS_RETRY_MS) return { status: "geocode_failed" };
  try {
    const g = await geocodeAddress(address);
    if (!g || isNaN(g.lat) || isNaN(g.lon)) { geoFailedAt.set(restaurantId, Date.now()); return { status: "geocode_failed" }; }
    await pool.query("UPDATE restaurants SET geo_lat=$1, geo_lon=$2, geo_for=$3, geo_place=$4 WHERE id=$5", [g.lat, g.lon, address, g.place, restaurantId]);
    geoFailedAt.delete(restaurantId);
    return { status: "ok", lat: g.lat, lon: g.lon, place: g.place };
  } catch (e) {
    console.error("Geocode failed:", e.message);
    geoFailedAt.set(restaurantId, Date.now());
    return { status: "geocode_failed" };
  }
}

function localParts(iso, tz) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  const g = (t) => parts.find((p) => p.type === t).value;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, hour: Number(g("hour")) };
}

function weatherCategory(symbol) {
  const base = String(symbol || "").replace(/_(day|night|polartwilight)$/, "");
  let category = "cloudy", intensity = "";
  if (base.includes("thunder")) category = "thunder";
  else if (base.includes("snow")) category = "snow";
  else if (base.includes("sleet")) category = "sleet";
  else if (base.includes("rain")) category = "rain";
  else if (base === "fog") category = "fog";
  else if (base === "clearsky") category = "clear";
  else if (base === "fair") category = "fair";
  else if (base === "partlycloudy") category = "partly";
  if (base.startsWith("light")) intensity = "light";
  else if (base.startsWith("heavy")) intensity = "heavy";
  return { category, intensity };
}

// Pulls the restaurant's local day out of MET Norway's hourly series.
function parseMetNoForecast(json, day, tz) {
  const series = (json && json.properties && json.properties.timeseries) || [];
  const hours = {};
  series.forEach((e) => {
    const lp = localParts(e.time, tz);
    if (lp.date !== day) return;
    const inst = e.data && e.data.instant && e.data.instant.details;
    if (!inst || typeof inst.air_temperature !== "number") return;
    const n1 = e.data.next_1_hours || e.data.next_6_hours || e.data.next_12_hours;
    hours[lp.hour] = {
      temp: inst.air_temperature,
      symbol: n1 && n1.summary ? n1.summary.symbol_code : null,
      precip: e.data.next_1_hours && e.data.next_1_hours.details ? e.data.next_1_hours.details.precipitation_amount || 0 : 0,
    };
  });
  const hrs = Object.keys(hours).map(Number).sort((a, b) => a - b);
  if (!hrs.length) return null;
  const temps = hrs.map((h) => hours[h].temp);
  const nearest = (target, lo, hi) => {
    const cands = hrs.filter((h) => h >= lo && h <= hi).sort((a, b) => Math.abs(a - target) - Math.abs(b - target));
    return cands.length ? hours[cands[0]] : null;
  };
  const lunch = nearest(12, 10, 14);
  const dinner = nearest(19, 17, 21);
  const rep = nearest(15, 9, 21) || hours[hrs[0]];
  const wc = weatherCategory(rep.symbol);
  const round = (v) => (v === null || v === undefined ? null : Math.round(v));
  return {
    tempMax: round(Math.max(...temps)),
    tempMin: round(Math.min(...temps)),
    lunchTemp: lunch ? round(lunch.temp) : null,
    dinnerTemp: dinner ? round(dinner.temp) : null,
    byHour: Object.fromEntries(hrs.map((h) => [h, round(hours[h].temp)])),
    precipMm: Math.round(hrs.reduce((a, h) => a + (hours[h].precip || 0), 0) * 10) / 10,
    category: wc.category,
    intensity: wc.intensity,
  };
}

async function fetchWeather(lat, lon, day) {
  const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`;
  const json = await fetchJsonTimeout(url, { headers: { "User-Agent": HTTP_UA } });
  return parseMetNoForecast(json, day, SNAPSHOT_TZ);
}

function cleanEvents(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .filter((e) => e && typeof e.name === "string" && e.name.trim())
    .slice(0, 6)
    .map((e) => ({
      name: e.name.trim().slice(0, 120),
      when: typeof e.when === "string" ? e.when.trim().slice(0, 60) : "",
      where: typeof e.where === "string" ? e.where.trim().slice(0, 120) : "",
      impact: ["high", "medium", "low"].includes(e.impact) ? e.impact : "low",
      note: typeof e.note === "string" ? e.note.trim().slice(0, 160) : "",
    }));
}

async function fetchNearbyEvents(place, day, restaurantId = null) {
  if (!ANTHROPIC_API_KEY) { const e = new Error("not_configured"); e.code = "not_configured"; throw e; }
  const system = "You help a restaurant manager anticipate how many customers will come in (customer attendance — not road or vehicle traffic). Search the web for events happening on the given date in the given city that could bring more or fewer guests to restaurants (concerts, sports games, festivals, conferences, parades, big markets, holidays). Ignore road closures and traffic conditions. Only list events you actually found in search results for that exact date; never guess or invent. Reply with ONLY a JSON object: {\"events\":[{\"name\":\"\",\"when\":\"e.g. 7:30 PM\",\"where\":\"venue or area\",\"impact\":\"high|medium|low\",\"note\":\"one short line on how it may affect customer attendance\"}]}. Use an empty array if nothing relevant was found. At most 5 events, most impactful first.";
  const messages = [{ role: "user", content: `Date: ${day}. City: ${place}.` }];
  // A long search can pause the turn; keep going (a few times) until the model gives its final answer.
  for (let round = 0; round < 4; round++) {
    const data = await fetchJsonTimeout("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
        max_tokens: 2000,
        system,
        messages,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
      }),
    }, 90000);
    recordAiUsage(restaurantId, "events", data);
    if (data.stop_reason === "pause_turn") { messages.push({ role: "assistant", content: data.content }); continue; }
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    const parsed = extractJsonObject(text);
    if (!parsed) throw new Error("unreadable events answer: " + text.slice(0, 200));
    return cleanEvents(parsed.events);
  }
  throw new Error("events search did not finish");
}

async function refreshEvents(restaurantId, day, place) {
  if (demoIds.has(restaurantId)) return; // the demo's nearby events are seeded; never pay for a web search for it
  const key = `${restaurantId}|${day}`;
  if (eventsInFlight.has(key)) return eventsInFlight.get(key);
  const work = (async () => {
    let events = null, error = null;
    try { events = await fetchNearbyEvents(place, day, restaurantId); }
    catch (e) { error = e.code === "not_configured" ? "not_configured" : "failed"; if (!e.code) console.error("Events lookup failed:", e.message); }
    await pool.query(
      `INSERT INTO day_context (restaurant_id, day, events, events_at, events_error) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (restaurant_id, day) DO UPDATE SET events = EXCLUDED.events, events_at = EXCLUDED.events_at, events_error = EXCLUDED.events_error`,
      [restaurantId, day, events ? JSON.stringify(events) : null, Date.now(), error]
    );
  })().finally(() => eventsInFlight.delete(key));
  eventsInFlight.set(key, work);
  return work;
}

// Last year's figure for today: the daily number the manager typed in, else last year's matching week averaged per day.
async function lastYearForDay(restaurantId, day, dailyValue) {
  if (dailyValue !== null && dailyValue !== undefined) return { amount: Number(dailyValue), basis: "day" };
  const { rows } = await pool.query("SELECT amount FROM weekly_sales_history WHERE restaurant_id = $1 AND week_start = $2", [restaurantId, addDaysIso(mondayOfIso(day), -364)]);
  if (rows[0]) return { amount: Math.round((Number(rows[0].amount) / 7) * 100) / 100, basis: "weekAvg" };
  return { amount: null, basis: null };
}

// ?date=YYYY-MM-DD shows another day (yesterday, tomorrow ... within 60 days back / 14 days ahead); default is today.
// Past days never trigger a new weather or events lookup: they show what was already saved on that day, if anything.
app.get("/api/day-snapshot", requireAuth, async (req, res) => {
  try {
    const todayDay = ownerToday();
    let day = todayDay;
    if (req.query.date !== undefined && req.query.date !== "") {
      if (!isIsoDate(String(req.query.date)) || req.query.date < addDaysIso(todayDay, -60) || req.query.date > addDaysIso(todayDay, 14)) {
        return res.status(400).json({ error: "date must be YYYY-MM-DD, within 60 days back and 14 days ahead" });
      }
      day = String(req.query.date);
    }
    const isPast = day < todayDay;
    const rid = req.restaurantId;
    const num = (v) => (v !== null && v !== undefined ? Number(v) : null);

    const services = await getServices(rid);
    const { rows: pr } = await pool.query("SELECT projected_amount, service_amounts, last_year_amount, ai_amount FROM sales_projections WHERE restaurant_id = $1 AND proj_date = $2", [rid, day]);
    const { rows: ar } = await pool.query("SELECT amount, service_amounts FROM actual_sales WHERE restaurant_id = $1 AND sale_date = $2", [rid, day]);
    const p = pr[0] || {};
    const a = ar[0] || {};
    const sales = {
      projected: num(p.projected_amount),
      projectedByService: cleanAmounts(p.service_amounts),
      ai: num(p.ai_amount),
      actual: num(a.amount),
      actualByService: cleanAmounts(a.service_amounts),
      lastYear: await lastYearForDay(rid, day, num(p.last_year_amount)),
    };

    const loc = await ensureRestaurantLocation(rid);
    const out = { date: day, services, sales, location: loc.status, place: loc.place || "", weather: null, events: null, eventsStatus: null };
    if (loc.status !== "ok") return res.json(out);

    let { rows: cr } = await pool.query("SELECT * FROM day_context WHERE restaurant_id = $1 AND day = $2", [rid, day]);
    let ctx = cr[0] || {};

    if (isPast) {
      out.weather = ctx.weather || null;
      if (ctx.events && !ctx.events_error) { out.events = ctx.events; out.eventsStatus = "ok"; }
      else out.eventsStatus = "not_recorded";
      return res.json(out);
    }

    // weather (quick)
    if (ctx.weather && ctx.weather_at && Date.now() - Number(ctx.weather_at) < WEATHER_TTL_MS) {
      out.weather = ctx.weather;
    } else {
      try {
        const w = await fetchWeather(loc.lat, loc.lon, day);
        out.weather = w || ctx.weather || null;
        await pool.query(
          `INSERT INTO day_context (restaurant_id, day, weather, weather_at) VALUES ($1,$2,$3,$4)
           ON CONFLICT (restaurant_id, day) DO UPDATE SET weather = EXCLUDED.weather, weather_at = EXCLUDED.weather_at`,
          [rid, day, w ? JSON.stringify(w) : null, Date.now()]
        );
      } catch (e) {
        console.error("Weather lookup failed:", e.message);
        out.weather = ctx.weather || null;
      }
    }

    // events (slow: refreshed in the background, the page asks again while it's pending)
    const evAge = ctx.events_at ? Date.now() - Number(ctx.events_at) : Infinity;
    let evFresh = ctx.events_error ? evAge < EVENTS_RETRY_MS : evAge < EVENTS_TTL_MS;
    // "Try again" from the card: re-run the lookup now, but not more than once a minute.
    if (req.query.refreshEvents === "1" && evAge > 60 * 1000 && !demoIds.has(rid)) evFresh = false;
    if (demoIds.has(rid) && ctx.events) evFresh = true;
    if (evFresh) {
      if (ctx.events_error) out.eventsStatus = ctx.events_error;
      else { out.events = ctx.events || []; out.eventsStatus = "ok"; }
    } else {
      refreshEvents(rid, day, loc.place || "").catch((e) => console.error("Events refresh error:", e.message));
      out.eventsStatus = "pending";
      if (ctx.events && !ctx.events_error) out.events = ctx.events; // show yesterday-ish data while refreshing
    }
    res.json(out);
  } catch (e) {
    console.error("day-snapshot error:", e);
    res.status(500).json({ error: "Could not build today's snapshot." });
  }
});

// ---------- team message board (managers post, every staff member reads) ----------

const BOARD_TITLE_MAX = 120;
const BOARD_BODY_MAX = 2000;

function boardPostToJson(row, extra = {}) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    pinned: row.pinned,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    translations: row.translations || null,
    ...extra,
  };
}

const LANG_NAMES = { en: "English", fr: "French", es: "Spanish" };
const BOARD_LANGS = ["en", "fr", "es"];

// {en:{title,body}, fr:{...}, es:{...}} — anything malformed is dropped rather than stored.
function cleanTranslations(input) {
  if (!input || typeof input !== "object") return null;
  const out = {};
  for (const code of BOARD_LANGS) {
    const v = input[code];
    if (!v || typeof v !== "object") continue;
    const title = String(v.title || "").trim().slice(0, BOARD_TITLE_MAX);
    const body = String(v.body || "").trim().slice(0, BOARD_BODY_MAX);
    if (body) out[code] = { title, body };
  }
  return Object.keys(out).length ? out : null;
}

function parseBoardFields(body, { requireBody }) {
  const out = {};
  const { title, body: text, pinned } = body || {};
  if (title !== undefined) {
    const t = String(title || "").trim();
    if (t.length > BOARD_TITLE_MAX) return { error: `title must be ${BOARD_TITLE_MAX} characters or fewer` };
    out.title = t;
  }
  if (text !== undefined || requireBody) {
    const b = String(text || "").trim();
    if (!b) return { error: "message is required" };
    if (b.length > BOARD_BODY_MAX) return { error: `message must be ${BOARD_BODY_MAX} characters or fewer` };
    out.body = b;
  }
  if (pinned !== undefined) out.pinned = !!pinned;
  if (body && body.translations !== undefined) out.translations = cleanTranslations(body.translations);
  return { fields: out };
}

// Manager: every post, pinned first, with how many staff have tapped "Got it".
app.get("/api/board", requireAuth, async (req, res) => {
  const { rows: posts } = await pool.query(
    "SELECT * FROM board_posts WHERE restaurant_id = $1 ORDER BY pinned DESC, created_at DESC",
    [req.restaurantId]
  );
  const { rows: acks } = await pool.query(
    `SELECT a.post_id, a.staff_id FROM board_acks a JOIN board_posts p ON p.id = a.post_id WHERE p.restaurant_id = $1`,
    [req.restaurantId]
  );
  const { rows: counts } = await pool.query(
    "SELECT COUNT(*) AS n FROM staff WHERE restaurant_id = $1 AND password_hash IS NOT NULL",
    [req.restaurantId]
  );
  const loginCount = Number(counts[0].n);
  res.json(
    posts.map((p) => {
      const ackedBy = acks.filter((a) => a.post_id === p.id).map((a) => a.staff_id);
      return boardPostToJson(p, { ackedBy, ackCount: ackedBy.length, loginCount });
    })
  );
});

app.post("/api/board", requireAuth, async (req, res) => {
  const parsed = parseBoardFields(req.body, { requireBody: true });
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const f = parsed.fields;
  const now = Date.now();
  const { rows } = await pool.query(
    "INSERT INTO board_posts (id, restaurant_id, title, body, pinned, translations, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING *",
    [id(), req.restaurantId, f.title || "", f.body, !!f.pinned, f.translations ? JSON.stringify(f.translations) : null, now]
  );
  res.status(201).json(boardPostToJson(rows[0], { ackedBy: [], ackCount: 0 }));
});

app.patch("/api/board/:id", requireAuth, async (req, res) => {
  const parsed = parseBoardFields(req.body, { requireBody: false });
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const f = parsed.fields;
  const { rows: existing } = await pool.query("SELECT * FROM board_posts WHERE id = $1 AND restaurant_id = $2", [req.params.id, req.restaurantId]);
  if (existing.length === 0) return res.status(404).json({ error: "post not found" });
  const cur = existing[0];
  // Editing the text makes old translations stale, so they're dropped unless fresh ones are sent along.
  const textChanged = (f.title !== undefined && f.title !== cur.title) || (f.body !== undefined && f.body !== cur.body);
  let newTranslations;
  if (f.translations !== undefined) newTranslations = f.translations ? JSON.stringify(f.translations) : null;
  else newTranslations = textChanged ? null : (cur.translations ? JSON.stringify(cur.translations) : null);
  const { rows } = await pool.query(
    "UPDATE board_posts SET title = $1, body = $2, pinned = $3, translations = $4, updated_at = $5 WHERE id = $6 AND restaurant_id = $7 RETURNING *",
    [f.title !== undefined ? f.title : cur.title, f.body !== undefined ? f.body : cur.body, f.pinned !== undefined ? f.pinned : cur.pinned, newTranslations, Date.now(), req.params.id, req.restaurantId]
  );
  res.json(boardPostToJson(rows[0]));
});

app.delete("/api/board/:id", requireAuth, async (req, res) => {
  const result = await pool.query("DELETE FROM board_posts WHERE id = $1 AND restaurant_id = $2", [req.params.id, req.restaurantId]);
  if (result.rowCount === 0) return res.status(404).json({ error: "post not found" });
  res.json({ ok: true });
});

// Staff: the board for their own restaurant. Posts newer than the last time they opened the board are "new".
app.get("/api/staff-auth/board", requireStaffAuth, async (req, res) => {
  const { rows: me } = await pool.query("SELECT board_seen_at FROM staff WHERE id = $1 AND restaurant_id = $2", [req.staffId, req.restaurantId]);
  if (me.length === 0) return res.status(401).json({ error: "not logged in" });
  const seenAt = me[0].board_seen_at !== null ? Number(me[0].board_seen_at) : 0;
  const { rows: posts } = await pool.query(
    "SELECT * FROM board_posts WHERE restaurant_id = $1 ORDER BY pinned DESC, created_at DESC",
    [req.restaurantId]
  );
  const { rows: mine } = await pool.query(
    `SELECT a.post_id FROM board_acks a JOIN board_posts p ON p.id = a.post_id WHERE a.staff_id = $1 AND p.restaurant_id = $2`,
    [req.staffId, req.restaurantId]
  );
  const acked = new Set(mine.map((a) => a.post_id));
  const out = posts.map((p) => boardPostToJson(p, { isNew: Number(p.updated_at) > seenAt, acked: acked.has(p.id) }));
  res.json({ posts: out, unreadCount: out.filter((p) => p.isNew).length });
});

app.post("/api/staff-auth/board/seen", requireStaffAuth, async (req, res) => {
  await pool.query("UPDATE staff SET board_seen_at = $1 WHERE id = $2 AND restaurant_id = $3", [Date.now(), req.staffId, req.restaurantId]);
  res.json({ ok: true });
});

// "New schedule posted": weeks the manager published (for the house this person works in) since they last tapped "Got it".
app.get("/api/staff-auth/schedule-news", requireStaffAuth, async (req, res) => {
  const { rows: me } = await pool.query("SELECT schedule_seen_at, roles FROM staff WHERE id = $1 AND restaurant_id = $2", [req.staffId, req.restaurantId]);
  if (!me.length) return res.status(404).json({ error: "not found" });
  const seenAt = me[0].schedule_seen_at !== null ? Number(me[0].schedule_seen_at) : 0;
  const { rows: pubs } = await pool.query(
    "SELECT week_start, house, published_at FROM schedule_published WHERE restaurant_id = $1 AND published_at > $2 AND week_start >= $3 ORDER BY week_start",
    [req.restaurantId, seenAt, mondayOfIso(ownerToday())]
  );
  const byWeek = new Map();
  for (const p of pubs) {
    const { rows: mine } = await pool.query(
      "SELECT role FROM schedule_shifts WHERE restaurant_id = $1 AND staff_id = $2 AND shift_date >= $3 AND shift_date <= $4",
      [req.restaurantId, req.staffId, p.week_start, addDaysIso(p.week_start, 6)]
    );
    const n = mine.filter((m) => shiftHouse(m.role, me[0].roles) === p.house).length;
    if (n === 0) continue;
    const cur = byWeek.get(p.week_start) || { weekStart: p.week_start, shiftCount: 0, publishedAt: 0 };
    cur.shiftCount += n;
    cur.publishedAt = Math.max(cur.publishedAt, Number(p.published_at));
    byWeek.set(p.week_start, cur);
  }
  res.json({ weeks: [...byWeek.values()] });
});

app.post("/api/staff-auth/schedule-news/seen", requireStaffAuth, async (req, res) => {
  await pool.query("UPDATE staff SET schedule_seen_at = $1 WHERE id = $2 AND restaurant_id = $3", [Date.now(), req.staffId, req.restaurantId]);
  res.json({ ok: true });
});

app.post("/api/staff-auth/board/:id/ack", requireStaffAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT id FROM board_posts WHERE id = $1 AND restaurant_id = $2", [req.params.id, req.restaurantId]);
  if (rows.length === 0) return res.status(404).json({ error: "post not found" });
  await pool.query(
    "INSERT INTO board_acks (post_id, staff_id, acked_at) VALUES ($1,$2,$3) ON CONFLICT (post_id, staff_id) DO NOTHING",
    [req.params.id, req.staffId, Date.now()]
  );
  res.json({ ok: true, acked: true });
});

// ---------- staff portal: my training (items assigned to me, file download, mark done) ----------

const INLINE_VIEW_TYPES = /^(application\/pdf|image\/(png|jpeg)|video\/(mp4|quicktime|webm))$/;

app.get("/api/staff-auth/training", requireStaffAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT i.id, i.kind, i.title, i.minutes, i.created_at, i.link_url, a.completed_at
       FROM training_assignments a JOIN training_items i ON i.id = a.item_id
      WHERE a.staff_id = $1 AND i.restaurant_id = $2
      ORDER BY (a.completed_at IS NOT NULL) ASC, i.created_at DESC`,
    [req.staffId, req.restaurantId]
  );
  const ids = rows.map((r) => r.id);
  const { rows: fileRows } = ids.length
    ? await pool.query("SELECT id, item_id, name, type, size FROM training_files WHERE item_id = ANY($1) ORDER BY created_at, id", [ids])
    : { rows: [] };
  const items = rows.map((r) => {
    const files = fileRows.filter((f) => f.item_id === r.id).map((f) => ({ id: f.id, name: f.name, type: f.type, size: f.size, viewable: INLINE_VIEW_TYPES.test(f.type || "") }));
    return {
      id: r.id,
      kind: r.kind,
      title: r.title,
      minutes: r.minutes,
      file: files.length ? { name: files[0].name, type: files[0].type, size: files[0].size, viewable: files[0].viewable } : null,
      files,
      link: r.link_url || null,
      done: !!r.completed_at,
    };
  });
  res.json({ items, todoCount: items.filter((i) => !i.done).length });
});

// Only items actually assigned to this person can be downloaded. One file by id, or (older screens) the first file.
async function staffTrainingFile(req, res) {
  const params = [req.params.id, req.restaurantId, req.staffId];
  let where = "";
  if (req.params.fileId) { params.push(req.params.fileId); where = "AND f.id = $4"; }
  const { rows } = await pool.query(
    `SELECT f.name, f.type, f.data FROM training_files f
       JOIN training_items i ON i.id = f.item_id
       JOIN training_assignments a ON a.item_id = i.id
      WHERE i.id = $1 AND i.restaurant_id = $2 AND a.staff_id = $3 ${where}
      ORDER BY f.created_at, f.id LIMIT 1`,
    params
  );
  if (rows.length === 0) return res.status(404).json({ error: "no file attached" });
  sendTrainingFile(res, rows[0], req.query.view === "1" && INLINE_VIEW_TYPES.test(rows[0].type || ""));
}
app.get("/api/staff-auth/training/:id/file", requireStaffAuth, staffTrainingFile);
app.get("/api/staff-auth/training/:id/files/:fileId", requireStaffAuth, staffTrainingFile);

app.post("/api/staff-auth/training/:id/done", requireStaffAuth, async (req, res) => {
  const done = !(req.body && req.body.done === false);
  const { rows } = await pool.query(
    `UPDATE training_assignments a SET completed_at = $1
       FROM training_items i
      WHERE a.item_id = i.id AND i.id = $2 AND i.restaurant_id = $3 AND a.staff_id = $4
      RETURNING a.completed_at`,
    [done ? Date.now() : null, req.params.id, req.restaurantId, req.staffId]
  );
  if (rows.length === 0) return res.status(404).json({ error: "training item not found" });
  res.json({ done: !!rows[0].completed_at });
});

// ---------- AI agent (Communications) ----------

app.post("/api/ai/ask", requireAuth, aiLimiter, async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: "The AI agent isn't configured yet — ask your developer to set ANTHROPIC_API_KEY." });
  }
  const { question } = req.body || {};
  if (!question || !question.trim()) return res.status(400).json({ error: "question is required" });

  try {
    // Dates are the restaurant's local calendar days (not UTC), so "today" stays correct in the evening.
    const today = ownerToday();
    const weekAgo = addDaysIso(today, -7);
    const twoWeeksOut = addDaysIso(today, 14);
    const twoWeeksAgo = addDaysIso(today, -14);
    const toDate = (d) => d;

    const [staffRows, openShiftRows, scheduleRows, postingRows, appRows, projRows, boardRows, ackRows, salesRows] = await Promise.all([
      pool.query("SELECT * FROM staff WHERE restaurant_id = $1", [req.restaurantId]),
      pool.query("SELECT * FROM shifts WHERE restaurant_id = $1 AND status = 'open'", [req.restaurantId]),
      pool.query("SELECT * FROM schedule_shifts WHERE restaurant_id = $1 AND shift_date >= $2 AND shift_date <= $3", [req.restaurantId, toDate(weekAgo), toDate(twoWeeksOut)]),
      pool.query("SELECT * FROM job_postings WHERE restaurant_id = $1 AND status = 'open'", [req.restaurantId]),
      pool.query("SELECT a.*, p.title AS posting_title FROM applications a JOIN job_postings p ON p.id = a.posting_id WHERE a.restaurant_id = $1 ORDER BY a.created_at DESC LIMIT 25", [req.restaurantId]),
      pool.query("SELECT * FROM sales_projections WHERE restaurant_id = $1 AND proj_date >= $2 AND proj_date <= $3", [req.restaurantId, toDate(weekAgo), toDate(twoWeeksOut)]),
      pool.query("SELECT * FROM board_posts WHERE restaurant_id = $1 ORDER BY pinned DESC, created_at DESC LIMIT 15", [req.restaurantId]),
      pool.query("SELECT a.post_id, a.staff_id FROM board_acks a JOIN board_posts p ON p.id = a.post_id WHERE p.restaurant_id = $1", [req.restaurantId]),
      pool.query("SELECT * FROM actual_sales WHERE restaurant_id = $1 AND sale_date >= $2 AND sale_date <= $3 ORDER BY sale_date", [req.restaurantId, toDate(twoWeeksAgo), toDate(today)]),
    ]);

    const staffSummary = staffRows.rows.map((s) => ({
      name: s.name,
      roles: s.roles,
      hourlyRate: s.hourly_rate !== null ? Number(s.hourly_rate) : null,
      hireDate: s.hire_date || null,
    }));
    const openShiftSummary = openShiftRows.rows.map((s) => ({
      role: s.role,
      time: s.time,
      note: s.note,
      responderCount: (s.responders || []).length,
    }));
    const scheduleSummary = scheduleRows.rows.map((s) => {
      const staffer = staffRows.rows.find((p) => p.id === s.staff_id);
      return {
        staff: staffer ? staffer.name : "unknown",
        date: s.shift_date instanceof Date ? s.shift_date.toISOString().slice(0, 10) : s.shift_date,
        start: s.start_time,
        end: s.end_time,
        role: s.role,
      };
    });
    const postingSummary = postingRows.rows.map((p) => ({ title: p.title, role: p.role }));
    const appSummary = appRows.rows.map((a) => ({ name: a.name, posting: a.posting_title, stage: a.stage, interviewTime: a.interview_time }));
    const projSummary = projRows.rows.map((p) => ({
      date: p.proj_date instanceof Date ? p.proj_date.toISOString().slice(0, 10) : p.proj_date,
      projectedSales: p.projected_amount !== null ? Number(p.projected_amount) : null,
    }));

    const staffWithLogin = staffRows.rows.filter((s) => s.password_hash);
    const boardSummary = boardRows.rows.map((p) => {
      const ackedIds = new Set(ackRows.rows.filter((a) => a.post_id === p.id).map((a) => a.staff_id));
      return {
        title: p.title || null,
        message: String(p.body).slice(0, 500),
        pinned: p.pinned,
        postedOn: new Date(Number(p.created_at)).toISOString().slice(0, 10),
        gotItCount: ackedIds.size,
        staffWithLoginCount: staffWithLogin.length,
        notYetGotIt: staffWithLogin.filter((s) => !ackedIds.has(s.id)).map((s) => s.name),
      };
    });
    const salesSummary = salesRows.rows.map((r) => ({
      date: r.sale_date instanceof Date ? r.sale_date.toISOString().slice(0, 10) : r.sale_date,
      totalSales: r.amount !== null ? Number(r.amount) : null,
      foodSales: r.food_amount !== null ? Number(r.food_amount) : null,
      beverageSales: r.bev_amount !== null ? Number(r.bev_amount) : null,
    }));

    const contextBlock = JSON.stringify(
      {
        today,
        todayWeekday: new Date(today + "T00:00:00Z").toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" }),
        teamMessageBoard: boardSummary,
        actualSalesLast14Days: salesSummary,
        staff: staffSummary,
        openReplacementShifts: openShiftSummary,
        weeklySchedule: scheduleSummary,
        openJobPostings: postingSummary,
        recentApplicants: appSummary,
        projectedSales: projSummary,
      },
      null,
      2
    );

    const thisMonday = mondayOfIso(toDate(today));
    const systemPrompt = `You are a helpful operations assistant for a restaurant manager, built into their staff/scheduling/hiring app. Answer the manager's question using ONLY the restaurant data provided below — don't invent numbers or people that aren't in it. If the data doesn't cover what they're asking, say so plainly rather than guessing. Keep answers short and concrete (a few sentences, or a tight list when listing people or shifts — always finish your answer), like a sharp assistant who already knows the business, not a generic chatbot. Dates are in YYYY-MM-DD format; "today" tells you the current date for relative reasoning. Reply in the language the manager writes in.

SCHEDULING: if (and only if) the manager is asking you to CREATE, FILL, BUILD or ADD TO a work schedule (for example "fill next week", "schedule 3 servers on Friday night"), do not answer in prose. Reply with ONLY this JSON object: {"action":"schedule","weekStart":"YYYY-MM-DD","house":"foh"|"boh"|"all","request":"<the manager's scheduling instructions, restated clearly and completely>"}. weekStart must be a Monday: this week's Monday is ${thisMonday} and next week's is ${addDaysIso(thisMonday, 7)}. Use "foh" for front of house (servers, hosts, bartenders, bussers), "boh" for kitchen, otherwise "all". Questions ABOUT the schedule ("who works Friday?") are normal questions — answer them in prose.

RESTAURANT DATA:
${contextBlock}`;

    const aiStartedAt = Date.now();
    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{ role: "user", content: question.trim() }],
      }),
    });
    const aiDurationMs = Date.now() - aiStartedAt;

    if (!aiRes.ok) {
      const errBody = await aiRes.text();
      console.error("Anthropic API error:", aiRes.status, errBody);
      logActivity({ restaurantId: req.restaurantId, eventType: "ai_failed", level: "error", detail: `HTTP ${aiRes.status}: ${errBody.slice(0, 300)}`, durationMs: aiDurationMs });
      return res.status(502).json({ error: "The AI agent couldn't respond right now — try again shortly." });
    }

    const aiData = await aiRes.json();
    recordAiUsage(req.restaurantId, "ask", aiData);
    const textBlock = (aiData.content || []).find((b) => b.type === "text");
    let answer = textBlock ? textBlock.text : "I couldn't generate a response for that.";
    if (aiData.stop_reason === "max_tokens") answer = answer.trimEnd() + "\n\n[…answer cut short — ask me to continue or narrow the question.]";

    logActivity({ restaurantId: req.restaurantId, eventType: "ai_answered", detail: question.trim().slice(0, 200), durationMs: aiDurationMs });

    // The model flags scheduling requests with a JSON action. We validate it ourselves, then build a PROPOSAL
    // (never saved here) for the manager to preview and apply — same as the Back Office scheduler.
    const trimmed = answer.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("```")) {
      const action = extractJsonObject(trimmed);
      if (action && action.action === "schedule" && isIsoDate(action.weekStart)) {
        const roles = action.house === "foh" ? FOH_ROLES : action.house === "boh" ? BOH_ROLES : null;
        const staffIds = roles ? staffRows.rows.filter((p) => (p.roles || [])[0] && roles.includes(p.roles[0])).map((p) => p.id) : null;
        try {
          const proposal = await buildScheduleProposal({
            restaurantId: req.restaurantId,
            prompt: String(action.request || question).trim().slice(0, 1500),
            weekStart: mondayOfIso(action.weekStart),
            staffIds,
            lang: req.body.lang,
          });
          return res.json({ answer: proposal.summary || "", proposal });
        } catch (e) {
          if (e.http) return res.status(e.http.status).json({ error: e.http.message });
          throw e;
        }
      }
    }
    res.json({ answer });
  } catch (e) {
    console.error("AI agent error:", e.message);
    logActivity({ restaurantId: req.restaurantId, eventType: "ai_failed", level: "error", detail: e.message });
    res.status(500).json({ error: "Something went wrong answering that question." });
  }
});

// AI cost tracking: every Anthropic answer is logged per restaurant with its token counts and an estimated cost.
// Prices are USD per million tokens and can be corrected with AI_PRICE_INPUT / AI_PRICE_OUTPUT (the defaults are an estimate,
// so compare the dashboard total with the Anthropic console's usage page). A web search costs about AI_PRICE_SEARCH dollars.
function aiCostUsd(usage) {
  const inP = Number(process.env.AI_PRICE_INPUT) || 3, outP = Number(process.env.AI_PRICE_OUTPUT) || 15;
  const searchP = process.env.AI_PRICE_SEARCH !== undefined && process.env.AI_PRICE_SEARCH !== "" ? Number(process.env.AI_PRICE_SEARCH) : 0.01;
  const u = usage || {};
  const input = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) * 1.25 + (u.cache_read_input_tokens || 0) * 0.1;
  const searches = (u.server_tool_use && u.server_tool_use.web_search_requests) || 0;
  return (input * inP + (u.output_tokens || 0) * outP) / 1e6 + searches * searchP;
}
function recordAiUsage(restaurantId, feature, data) {
  try {
    const u = (data && data.usage) || {};
    const searches = (u.server_tool_use && u.server_tool_use.web_search_requests) || 0;
    pool.query(
      "INSERT INTO ai_usage (id, restaurant_id, feature, model, input_tokens, output_tokens, searches, cost_usd, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [id(), restaurantId || null, feature, (data && data.model) || process.env.ANTHROPIC_MODEL || null,
       (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0), u.output_tokens || 0, searches, aiCostUsd(u).toFixed(6), Date.now()]
    ).catch((e) => console.error("AI usage log failed:", e.message));
  } catch (e) { console.error("AI usage log failed:", e.message); }
}

// One place that talks to Anthropic for the board helpers. Throws an Error with .status for the caller to map.
async function callClaude({ system, user, maxTokens = 700, restaurantId = null, feature = "other" }) {
  const startedAt = Date.now();
  const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  const durationMs = Date.now() - startedAt;
  if (!aiRes.ok) {
    const errBody = await aiRes.text();
    console.error("Anthropic API error:", aiRes.status, errBody);
    const err = new Error(`HTTP ${aiRes.status}: ${errBody.slice(0, 300)}`);
    err.upstream = true;
    err.durationMs = durationMs;
    throw err;
  }
  const data = await aiRes.json();
  recordAiUsage(restaurantId, feature, data);
  const block = (data.content || []).find((b) => b.type === "text");
  return { text: block ? block.text : "", durationMs };
}

// Models sometimes wrap JSON in prose or code fences; take the outermost {...}.
function extractJsonObject(text) {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a === -1 || b <= a) return null;
  try { return JSON.parse(text.slice(a, b + 1)); } catch (e) { return null; }
}

function aiBoardGuard(req, res) {
  if (!ANTHROPIC_API_KEY) {
    res.status(503).json({ error: "The AI agent isn't configured yet — ask your developer to set ANTHROPIC_API_KEY." });
    return false;
  }
  return true;
}

function handleAiBoardError(res, req, eventType, e) {
  logActivity({ restaurantId: req.restaurantId, eventType, level: "error", detail: e.message, durationMs: e.durationMs || null });
  if (e.upstream) return res.status(502).json({ error: "The AI agent couldn't respond right now — try again shortly." });
  return res.status(500).json({ error: "Something went wrong with the AI request." });
}

// Manager types a rough idea; the AI returns a clean announcement they can edit before posting.
app.post("/api/ai/board-draft", requireAuth, aiLimiter, async (req, res) => {
  if (!aiBoardGuard(req, res)) return;
  const idea = String((req.body && req.body.idea) || "").trim();
  if (!idea) return res.status(400).json({ error: "idea is required" });
  if (idea.length > 1500) return res.status(400).json({ error: "idea must be 1500 characters or fewer" });
  const langCode = BOARD_LANGS.includes(req.body.lang) ? req.body.lang : "en";
  const langName = { en: "English", fr: "French", es: "Spanish" }[langCode];
  try {
    const { text, durationMs } = await callClaude({
      restaurantId: req.restaurantId, feature: "board-draft",
      system: `Today is ${todayLine()} (restaurant time). Use it to turn words like "tomorrow" or "this Friday" into the actual day and date. You help a restaurant manager write announcements for the team message board that every staff member reads on their phone. Turn the manager's rough note into a clear, friendly, direct announcement in ${langName}. Keep every fact the manager gave (dates, times, names, numbers) and do not invent any new ones. Short sentences, no emojis, no hashtags, at most ${Math.min(BOARD_BODY_MAX, 900)} characters in the body. Reply with ONLY a JSON object: {"title": "<short title, max 60 characters>", "body": "<the announcement>"}.`,
      user: idea,
    });
    const parsed = extractJsonObject(text);
    if (!parsed || !String(parsed.body || "").trim()) {
      logActivity({ restaurantId: req.restaurantId, eventType: "ai_failed", level: "error", detail: "board-draft: unparseable reply", durationMs });
      return res.status(502).json({ error: "The AI agent couldn't draft that — try rephrasing." });
    }
    logActivity({ restaurantId: req.restaurantId, eventType: "ai_answered", detail: `board-draft: ${idea.slice(0, 150)}`, durationMs });
    res.json({
      title: String(parsed.title || "").trim().slice(0, BOARD_TITLE_MAX),
      body: String(parsed.body).trim().slice(0, BOARD_BODY_MAX),
    });
  } catch (e) {
    handleAiBoardError(res, req, "ai_failed", e);
  }
});

// Translate a post into English, French and Spanish so each staff member reads it in their own language.
app.post("/api/ai/board-translate", requireAuth, aiLimiter, async (req, res) => {
  if (!aiBoardGuard(req, res)) return;
  const title = String((req.body && req.body.title) || "").trim();
  const body = String((req.body && req.body.body) || "").trim();
  if (!body) return res.status(400).json({ error: "message is required" });
  if (title.length > BOARD_TITLE_MAX || body.length > BOARD_BODY_MAX) return res.status(400).json({ error: "post is too long" });
  try {
    const { text, durationMs } = await callClaude({
      restaurantId: req.restaurantId, feature: "board-translate",
      system: `You translate restaurant team announcements. Translate the post into English (en), Canadian French (fr) and Spanish (es). Keep the meaning, tone, names, dates, times and numbers exactly; a language the post is already in is returned unchanged. Reply with ONLY a JSON object: {"en":{"title":"","body":""},"fr":{"title":"","body":""},"es":{"title":"","body":""}}. If the title is empty, keep it empty.`,
      user: JSON.stringify({ title, body }),
      maxTokens: 1800,
    });
    const translations = cleanTranslations(extractJsonObject(text));
    if (!translations || !BOARD_LANGS.every((c) => translations[c])) {
      logActivity({ restaurantId: req.restaurantId, eventType: "ai_failed", level: "error", detail: "board-translate: unparseable reply", durationMs });
      return res.status(502).json({ error: "The AI agent couldn't translate that — try again." });
    }
    logActivity({ restaurantId: req.restaurantId, eventType: "ai_answered", detail: "board-translate", durationMs });
    res.json({ translations });
  } catch (e) {
    handleAiBoardError(res, req, "ai_failed", e);
  }
});

// Builds a schedule PROPOSAL for one week (nothing is saved). Throws an Error carrying .http = { status, message }
// for problems the manager should see. Used by the Back Office scheduler and by the Comms chat.
const FOH_ROLES = ["Server", "Host", "Bartender", "Busser"];
const BOH_ROLES = ["Line Cook", "Dishwasher", "Prep Cook", "Expo"];

function httpError(status, message) {
  const e = new Error(message);
  e.http = { status, message };
  return e;
}

function mondayOfIso(dateStr) {
  const dow = new Date(dateStr + "T00:00:00Z").getUTCDay(); // 0 = Sunday
  return addDaysIso(dateStr, -((dow + 6) % 7));
}

// Turns sales history + the manager's projections into what the AI needs to size crews:
// expected sales per day of the target week, plus how much labor this group has historically used per sales dollar.
function buildSalesPlan({ weekStart, projections, pastSales, pastShifts, staffById }) {
  const iso = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v);
  const num = (v) => (v === null || v === undefined ? null : Number(v));

  // Typical sales by weekday over the history window.
  const byWeekday = {};
  pastSales.forEach((r) => {
    const total = num(r.amount);
    if (!total || total <= 0) return;
    const k = weekdayKey(iso(r.sale_date));
    const w = (byWeekday[k] = byWeekday[k] || { n: 0, total: 0, food: 0, foodN: 0, bev: 0, bevN: 0 });
    w.n += 1; w.total += total;
    if (num(r.food_amount) !== null) { w.food += num(r.food_amount); w.foodN += 1; }
    if (num(r.bev_amount) !== null) { w.bev += num(r.bev_amount); w.bevN += 1; }
  });

  const projByDate = {};
  projections.forEach((r) => { if (num(r.projected_amount) !== null) projByDate[iso(r.proj_date)] = num(r.projected_amount); });

  const salesPlan = Array.from({ length: 7 }, (_, i) => {
    const date = addDaysIso(weekStart, i);
    const wk = weekdayKey(date);
    const avg = byWeekday[wk];
    const avgTotal = avg ? avg.total / avg.n : null;
    let expectedSales = null, basis = null;
    if (projByDate[date] !== undefined) { expectedSales = projByDate[date]; basis = "manager projection"; }
    else if (avgTotal !== null) { expectedSales = Math.round(avgTotal); basis = `average of ${avg.n} recent ${wk} day${avg.n === 1 ? "" : "s"}`; }
    let foodShare = null;
    if (avg && avg.foodN > 0 && avg.bevN > 0) {
      const f = avg.food / avg.foodN, b = avg.bev / avg.bevN;
      if (f + b > 0) foodShare = Math.round((f / (f + b)) * 100);
    }
    return {
      date, weekday: wk, expectedSales, basis,
      foodPercent: foodShare, beveragePercent: foodShare === null ? null : 100 - foodShare,
    };
  });

  // How many sales dollars this staff group has historically produced per labor hour, on days with both sales and shifts.
  const hoursByDate = {}, costByDate = {};
  pastShifts.forEach((sh) => {
    const [a, b] = shiftRange(sh.startTime, sh.endTime);
    const h = (b - a) / 60;
    hoursByDate[sh.date] = (hoursByDate[sh.date] || 0) + h;
    costByDate[sh.date] = (costByDate[sh.date] || 0) + h * (staffById[sh.staffId].rate || 0);
  });
  let sales = 0, hours = 0, cost = 0, days = 0;
  pastSales.forEach((r) => {
    const d = iso(r.sale_date), total = num(r.amount);
    if (total && total > 0 && hoursByDate[d] > 0) { sales += total; hours += hoursByDate[d]; cost += costByDate[d]; days += 1; }
  });
  const benchmarks = { daysOfHistory: days, salesPerLaborHour: null, laborPercentOfSales: null, suggestedLaborHours: null };
  if (days >= 3 && hours > 0) {
    const splh = sales / hours;
    benchmarks.salesPerLaborHour = Math.round(splh);
    benchmarks.laborPercentOfSales = cost > 0 ? Math.round((cost / sales) * 1000) / 10 : null;
    benchmarks.suggestedLaborHours = Object.fromEntries(
      salesPlan.filter((d) => d.expectedSales > 0).map((d) => [d.date, Math.round((d.expectedSales / splh) * 10) / 10])
    );
  }
  return { salesPlan, benchmarks };
}

async function buildScheduleProposal({ restaurantId, prompt, weekStart, staffIds, lang }) {
  if (!prompt) throw httpError(400, "prompt is required");
  if (prompt.length > 1500) throw httpError(400, "prompt must be 1500 characters or fewer");
  if (!isIsoDate(weekStart)) throw httpError(400, "weekStart (YYYY-MM-DD) is required");
  const weekEnd = addDaysIso(weekStart, 6);
  const wanted = Array.isArray(staffIds) ? new Set(staffIds.map(String)) : null;

  const { rows: allStaff } = await pool.query("SELECT * FROM staff WHERE restaurant_id = $1 AND archived_at IS NULL", [restaurantId]);
  const pool_ = allStaff.filter((p) => !p.hideFromSchedule && (!wanted || wanted.has(p.id)));
  if (pool_.length === 0) throw httpError(400, "There is no staff to schedule here yet.");
  const staffById = {};
  pool_.forEach((p) => { staffById[p.id] = { name: p.name, roles: p.roles || [], rate: p.hourly_rate !== null ? Number(p.hourly_rate) : 0 }; });
  const availabilityByStaff = await loadAvailabilityMap(restaurantId, pool_.map((p) => p.id));
  const timeOffByStaff = await loadTimeOffMap(restaurantId, pool_.map((p) => p.id), weekStart, weekEnd);
  const historyStart = addDaysIso(weekStart, -56); // 8 weeks of history
  const prevStart = addDaysIso(weekStart, -7);
  const [existingRes, projRes, salesRes, pastShiftRes, prevWeekRes] = await Promise.all([
    pool.query("SELECT * FROM schedule_shifts WHERE restaurant_id = $1 AND shift_date >= $2 AND shift_date <= $3", [restaurantId, weekStart, weekEnd]),
    pool.query("SELECT * FROM sales_projections WHERE restaurant_id = $1 AND proj_date >= $2 AND proj_date <= $3", [restaurantId, weekStart, weekEnd]),
    pool.query("SELECT * FROM actual_sales WHERE restaurant_id = $1 AND sale_date >= $2 AND sale_date < $3 ORDER BY sale_date", [restaurantId, historyStart, weekStart]),
    pool.query("SELECT * FROM schedule_shifts WHERE restaurant_id = $1 AND shift_date >= $2 AND shift_date < $3", [restaurantId, historyStart, weekStart]),
    pool.query("SELECT * FROM schedule_shifts WHERE restaurant_id = $1 AND shift_date >= $2 AND shift_date < $3 ORDER BY shift_date, start_time", [restaurantId, prevStart, weekStart]),
  ]);
  const existing = existingRes.rows.map(scheduleShiftRowToJson);
  const previousWeek = prevWeekRes.rows.map(scheduleShiftRowToJson).filter((e) => staffById[e.staffId]);
  const plan = buildSalesPlan({
    weekStart,
    projections: projRes.rows,
    pastSales: salesRes.rows,
    pastShifts: pastShiftRes.rows.map(scheduleShiftRowToJson).filter((sh) => staffById[sh.staffId]),
    staffById,
  });

  const context = {
    today: { date: ownerToday(), dayName: DAY_NAMES_EN[new Date(ownerToday() + "T12:00:00Z").getUTCDay()] },
    tomorrow: { date: addDaysIso(ownerToday(), 1), dayName: DAY_NAMES_EN[new Date(addDaysIso(ownerToday(), 1) + "T12:00:00Z").getUTCDay()] },
    week: Array.from({ length: 7 }, (_, i) => { const d = addDaysIso(weekStart, i); return { date: d, weekday: weekdayKey(d), dayName: DAY_NAMES_EN[new Date(d + "T12:00:00Z").getUTCDay()], isToday: d === ownerToday() }; }),
    staff: pool_.map((p) => ({
      id: p.id, name: p.name, roles: p.roles || [],
      hourlyRate: p.hourly_rate !== null ? Number(p.hourly_rate) : null,
      timeOff: Object.entries(timeOffByStaff[p.id] || {}).flatMap(([date, list]) => list.map((o) => ({ date, ...(o.from || o.to ? { unavailableFrom: o.from || "00:00", unavailableTo: o.to || "24:00" } : {}) }))),
      availability: Object.fromEntries(Object.entries(availabilityByStaff[p.id] || {}).map(([k, v]) => [k, { free: v.available, note: v.note || "", ...(v.available === false && (v.from || v.to) ? { unavailableFrom: v.from || "00:00", unavailableTo: v.to || "24:00" } : {}), ...(v.available === true && (v.from || v.to) ? { onlyAvailableFrom: v.from || "00:00", onlyAvailableUntil: v.to || "24:00" } : {}) }])),
    })),
    previousWeek: {
      weekStart: prevStart,
      shifts: previousWeek.map((e) => ({ staffId: e.staffId, date: e.date, dayName: DAY_NAMES_EN[new Date(e.date + "T12:00:00Z").getUTCDay()], start: e.scheduledStart || e.startTime, end: e.scheduledEnd || e.endTime, role: e.role })),
    },
    alreadyScheduledThisWeek: existing.filter((e) => staffById[e.staffId]).map((e) => ({ staffId: e.staffId, date: e.date, start: e.startTime, end: e.endTime, role: e.role })),
    salesPlan: plan.salesPlan,
    staffingBenchmarks: plan.benchmarks,
  };

  const system = `You build weekly shift schedules for a restaurant manager. Follow the manager's request exactly, using ONLY the staff and dates in the data.
Rules:
- Use each person's id exactly as given. Never invent staff.
- A staff member's "role" must be one of their listed roles.
- Never schedule someone on a date listed in their "timeOff" (one-time unavailability); if unavailableFrom/unavailableTo are given, only that part of the day is blocked.
- Never schedule someone on a weekday where their availability free is false; if unavailableFrom/unavailableTo are given, only avoid shifts overlapping those hours. If a free day has onlyAvailableFrom/onlyAvailableUntil, the whole shift must fall inside those hours (e.g. only from 16:00 means no shift may start before 16:00). Respect availability notes (e.g. "after 5pm") as best you can.
- Do not duplicate or overlap shifts in "alreadyScheduledThisWeek"; fill around them.
- One shift per person per day unless asked otherwise. Keep shifts between 3 and 12 hours. Avoid more than 40 hours a week per person unless asked.
- Size crews to expected sales. "salesPlan" gives each day's expected sales (the manager's projection when set, otherwise that weekday's recent average) with the food / beverage split. Busier days get more people; food sales drive the kitchen and beverage sales drive bartenders and bussers. When "staffingBenchmarks.suggestedLaborHours" is present, aim for each day's total shift hours to land near that number (and mention it in the summary). Headcounts or hours the manager states explicitly always win over these suggestions. If there is no sales data, spread staff evenly and say that in the summary.
- The data gives today's and tomorrow's real dates ("today", "tomorrow") and the dayName of every date in "week". Resolve words like today, tomorrow, tonight, this Friday or Saturday from them. If the manager asks for a day that is not inside "week", schedule nothing for it and say so in "summary" (they need to open that week in the grid).
- "previousWeek" lists the shifts of the week just before the target week (original scheduled times). When the manager asks to copy, repeat, duplicate or reuse last week's / the previous / this week's schedule for the target week, reproduce those shifts exactly one week later (same person, weekday, times and role: add 7 days to each date), skipping only what conflicts with timeOff, availability or "alreadyScheduledThisWeek", and mention anything you skipped in "summary". If previousWeek.shifts is empty, say last week had no shifts for this group of staff.
- Times are 24-hour "HH:MM". Dates are YYYY-MM-DD and must fall inside the week.
- If the request can't be fully met (not enough staff, conflicts), schedule what you can and say so briefly in "summary".
Reply with ONLY a JSON object: {"summary":"<one or two sentences, in ${LANG_NAMES[lang] || "English"}>","shifts":[{"staffId":"","date":"","startTime":"","endTime":"","role":""}]}.

DATA:
${JSON.stringify(context)}`;

  const { text, durationMs } = await callClaude({ system, user: prompt, maxTokens: 6000, restaurantId, feature: "schedule" });
  const parsed = extractJsonObject(text);
  if (!parsed || !Array.isArray(parsed.shifts)) {
    logActivity({ restaurantId, eventType: "ai_failed", level: "error", detail: "schedule: unparseable reply", durationMs });
    throw httpError(502, "The AI agent couldn't build that schedule — try rephrasing.");
  }
  const candidates = parsed.shifts.slice(0, SCHEDULE_BULK_MAX).map((c) => ({
    staffId: c && c.staffId, date: c && c.date, startTime: c && c.startTime, endTime: c && c.endTime, role: c && c.role,
  }));
  const { ok, skipped } = checkScheduleCandidates(candidates, { staffById, existing, availabilityByStaff, timeOffByStaff, windowStart: weekStart, windowEnd: weekEnd });
  logActivity({ restaurantId, eventType: "ai_answered", detail: `schedule: ${prompt.slice(0, 120)} (${ok.length} shifts)`, durationMs });
  let totalHours = 0, estCost = 0;
  ok.forEach((sh) => {
    const [a, b] = shiftRange(sh.startTime, sh.endTime);
    const h = (b - a) / 60;
    totalHours += h;
    estCost += h * (staffById[sh.staffId].rate || 0);
  });
  // Per-day labor against expected sales, counting what's already on the grid plus the new shifts (this staff group only).
  const days = plan.salesPlan.map((d) => {
    let hours = 0, cost = 0;
    [...existing.filter((e) => staffById[e.staffId]), ...ok].filter((sh) => sh.date === d.date).forEach((sh) => {
      const [a, b] = shiftRange(sh.startTime, sh.endTime);
      hours += (b - a) / 60;
      cost += ((b - a) / 60) * (staffById[sh.staffId].rate || 0);
    });
    return {
      date: d.date,
      hours: Math.round(hours * 10) / 10,
      cost: Math.round(cost),
      expectedSales: d.expectedSales,
      laborPct: d.expectedSales > 0 && hours > 0 ? Math.round((cost / d.expectedSales) * 1000) / 10 : null,
    };
  });
  const weekSales = days.reduce((n, d) => n + (d.expectedSales || 0), 0);
  const weekCost = days.reduce((n, d) => n + d.cost, 0);
  return {
    weekStart,
    summary: String(parsed.summary || "").slice(0, 600),
    shifts: ok,
    skipped,
    totalHours: Math.round(totalHours * 10) / 10,
    estCost: Math.round(estCost),
    days,
    weekLaborPct: weekSales > 0 && weekCost > 0 ? Math.round((weekCost / weekSales) * 1000) / 10 : null,
  };
}

function scheduleErrorResponse(res, req, e) {
  if (e.http) return res.status(e.http.status).json({ error: e.http.message });
  return handleAiBoardError(res, req, "ai_failed", e);
}

// Manager describes the week in plain words; the AI proposes shifts. NOTHING is saved here — the manager
// previews the proposal and applies it through /api/schedule/bulk.
app.post("/api/ai/schedule", requireAuth, aiLimiter, async (req, res) => {
  if (!aiBoardGuard(req, res)) return;
  try {
    const proposal = await buildScheduleProposal({
      restaurantId: req.restaurantId,
      prompt: String((req.body && req.body.prompt) || "").trim(),
      weekStart: req.body && req.body.weekStart,
      staffIds: req.body && req.body.staffIds,
      lang: req.body && req.body.lang,
    });
    res.json(proposal);
  } catch (e) {
    scheduleErrorResponse(res, req, e);
  }
});

// ---------- platform-owner auth (you / devs) ----------

app.post("/api/platform-auth/signup", signupLimiter, async (req, res) => {
  const { email, password, setupKey } = req.body || {};
  if (!PLATFORM_SETUP_KEY) return res.status(503).json({ error: "Platform account creation isn't configured — set PLATFORM_SETUP_KEY first." });
  const keyA = Buffer.from(String(setupKey || "")), keyB = Buffer.from(String(PLATFORM_SETUP_KEY));
  if (keyA.length !== keyB.length || !crypto.timingSafeEqual(keyA, keyB)) {
    logActivity({ eventType: "platform_signup_failed", level: "warn", detail: `platform account setup refused (wrong setup key) [${deviceLabel(req)}]` });
    return res.status(403).json({ error: "Invalid setup key" });
  }
  if (!email || !isValidEmail(email)) return res.status(400).json({ error: "a valid email is required" });
  if (!password || password.length < 8) return res.status(400).json({ error: "password must be at least 8 characters" });

  const { rows: existing } = await pool.query("SELECT id FROM platform_admins WHERE email = $1", [email.toLowerCase()]);
  if (existing.length > 0) return res.status(409).json({ error: "an account with that email already exists" });

  const adminId = id();
  const passwordHash = await bcrypt.hash(password, 10);
  await pool.query("INSERT INTO platform_admins (id, email, password_hash, created_at) VALUES ($1,$2,$3,$4)", [adminId, email.toLowerCase(), passwordHash, Date.now()]);

  const token = signToken({ platformAdminId: adminId });
  res.cookie("platform_token", token, COOKIE_OPTS);
  res.status(201).json({ email: email.toLowerCase() });
});

app.post("/api/platform-auth/login", loginLimiter, loginEmailLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email and password are required" });

  const { rows } = await pool.query("SELECT * FROM platform_admins WHERE email = $1", [email.toLowerCase()]);
  const admin = rows[0];
  const valid = admin ? await bcrypt.compare(password, admin.password_hash) : false;
  if (!valid) {
    logActivity({ eventType: "platform_login_failed", level: "warn", detail: `platform login failed: ${String(email).toLowerCase().slice(0, 100)} [${deviceLabel(req)}]` });
    return res.status(401).json({ error: "incorrect email or password" });
  }

  const token = signToken({ platformAdminId: admin.id });
  res.cookie("platform_token", token, COOKIE_OPTS);
  logActivity({ eventType: "platform_login_success", detail: `platform login: ${admin.email} [${deviceLabel(req)}]` });
  res.json({ email: admin.email });
});

app.post("/api/platform-auth/logout", (req, res) => {
  res.clearCookie("platform_token", { ...COOKIE_OPTS, maxAge: undefined });
  res.status(204).end();
});

app.get("/api/platform-auth/me", requirePlatformAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT email FROM platform_admins WHERE id = $1", [req.platformAdminId]);
  if (rows.length === 0) return res.status(401).json({ error: "not logged in" });
  res.json({ email: rows[0].email });
});

// ---------- platform dashboard data (you / devs) ----------

app.get("/api/platform/restaurants", requirePlatformAuth, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      r.id, r.name, r.created_at, r.twilio_phone_number, r.is_demo, r.billing_status, r.free_until,
      (SELECT COUNT(*) FROM staff s WHERE s.restaurant_id = r.id AND s.archived_at IS NULL) AS staff_count,
      (SELECT COUNT(*) FROM shifts sh WHERE sh.restaurant_id = r.id) AS shift_count,
      (SELECT COUNT(*) FROM shifts sh WHERE sh.restaurant_id = r.id AND sh.status = 'open') AS open_shift_count,
      (SELECT COUNT(*) FROM job_postings jp WHERE jp.restaurant_id = r.id AND jp.status = 'open') AS open_posting_count,
      (SELECT MAX(created_at) FROM activity_log a WHERE a.restaurant_id = r.id) AS last_activity_at,
      (SELECT COUNT(*) FROM activity_log a WHERE a.restaurant_id = r.id AND a.created_at > $1) AS activity_last_7d
    FROM restaurants r
    ORDER BY r.created_at DESC
  `, [Date.now() - 7 * 24 * 60 * 60 * 1000]);

  res.json(rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: Number(r.created_at),
    twilioPhoneNumber: r.twilio_phone_number || "",
    isDemo: !!r.is_demo,
    billingStatus: r.billing_status || "exempt",
    freeUntil: r.free_until ? Number(r.free_until) : null,
    staffCount: Number(r.staff_count),
    shiftCount: Number(r.shift_count),
    openShiftCount: Number(r.open_shift_count),
    openPostingCount: Number(r.open_posting_count),
    lastActivityAt: r.last_activity_at ? Number(r.last_activity_at) : null,
    activityLast7d: Number(r.activity_last_7d),
  })));
});

// What the AI features have cost, per restaurant, over the last N days (an estimate; see aiCostUsd).
app.get("/api/platform/ai-usage", requirePlatformAuth, async (req, res) => {
  const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
  const since = Date.now() - days * 24 * 3600 * 1000;
  const { rows } = await pool.query(
    `SELECT u.restaurant_id, r.name, u.feature, COUNT(*) AS calls, COALESCE(SUM(u.input_tokens),0) AS input_tokens,
            COALESCE(SUM(u.output_tokens),0) AS output_tokens, COALESCE(SUM(u.searches),0) AS searches, COALESCE(SUM(u.cost_usd),0) AS cost
     FROM ai_usage u LEFT JOIN restaurants r ON r.id = u.restaurant_id
     WHERE u.created_at >= $1 GROUP BY u.restaurant_id, r.name, u.feature`, [since]);
  const byRestaurant = new Map();
  for (const x of rows) {
    const key = x.restaurant_id || "none";
    const cur = byRestaurant.get(key) || { id: x.restaurant_id, name: x.name || (x.restaurant_id ? "(deleted restaurant)" : "(no restaurant)"), calls: 0, inputTokens: 0, outputTokens: 0, searches: 0, costUsd: 0, byFeature: [] };
    cur.calls += Number(x.calls); cur.inputTokens += Number(x.input_tokens); cur.outputTokens += Number(x.output_tokens);
    cur.searches += Number(x.searches); cur.costUsd += Number(x.cost);
    cur.byFeature.push({ feature: x.feature, calls: Number(x.calls), costUsd: Number(x.cost) });
    byRestaurant.set(key, cur);
  }
  const list = [...byRestaurant.values()].sort((a, b) => b.costUsd - a.costUsd);
  list.forEach((r) => { r.byFeature.sort((a, b) => b.costUsd - a.costUsd); r.costPerDayUsd = r.costUsd / days; });
  const totalUsd = list.reduce((s, r) => s + r.costUsd, 0);
  res.json({ days, totalUsd, perDayUsd: totalUsd / days, restaurants: list });
});

// ---------- demo restaurant ----------

let demoSeeding = null;
function seedDemoNow() {
  if (!demoSeeding) {
    demoSeeding = demo.seedDemo(pool, { today: ownerToday(), addDaysIso, mondayOfIso })
      .then(async (r) => { demoIds.add(demo.DEMO_RESTAURANT_ID); return r; })
      .finally(() => { demoSeeding = null; });
  }
  return demoSeeding;
}
// Rebuild the demo when it has never been built or when it was built on an earlier day (so "today" and "this week" are always right).
async function ensureFreshDemo() {
  const { rows } = await pool.query("SELECT demo_seeded_on FROM restaurants WHERE id = $1", [demo.DEMO_RESTAURANT_ID]);
  if (!rows[0] || rows[0].demo_seeded_on !== ownerToday()) return seedDemoNow();
  return null;
}

const demoEnterLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many demo visits from this connection. Please try again later." },
});

// Anyone can open the demo as its manager or as one of its staff. The session only ever reaches the demo restaurant.
app.post("/api/demo/enter", demoEnterLimiter, async (req, res) => {
  const role = req.body && req.body.role === "staff" ? "staff" : "manager";
  try {
    await ensureFreshDemo();
    if (role === "manager") {
      res.cookie("token", signToken({ userId: demo.DEMO_USER_ID, restaurantId: demo.DEMO_RESTAURANT_ID }), COOKIE_OPTS);
      res.cookie("staff_token", "", { ...COOKIE_OPTS, maxAge: 0 });
      return res.json({ ok: true, next: "/index.html" });
    }
    res.cookie("staff_token", signToken({ staffId: demo.DEMO_STAFF_VIEW_ID, restaurantId: demo.DEMO_RESTAURANT_ID }), COOKIE_OPTS);
    res.json({ ok: true, next: "/staff-portal.html" });
  } catch (e) {
    console.error("Demo entry failed:", e.message);
    res.status(500).json({ error: "The demo isn't available right now. Please try again in a moment." });
  }
});

app.post("/api/platform/demo/reset", requirePlatformAuth, async (req, res) => {
  try {
    const r = await seedDemoNow();
    logActivity({ eventType: "demo_reset", detail: `demo rebuilt: ${r.staff} staff, ${r.shifts} shifts` });
    res.json({ ok: true, ...r });
  } catch (e) {
    console.error("Demo reset failed:", e.message);
    res.status(500).json({ error: "Could not rebuild the demo: " + e.message });
  }
});

// Permanently deletes a restaurant and everything under it (staff, shifts, schedule, sales, logins). The exact
// restaurant name must be sent back as confirmation, so a stray click or a look-alike name ("Shay" vs "SHAY") can't wipe real data.
// Create a restaurant from the dashboard, together with its owner login. A brand-new owner gets a temporary password (shown once);
// an owner who already exists just gets the new restaurant added to their account.
app.post("/api/platform/restaurants", requirePlatformAuth, async (req, res) => {
  const { name, ownerName, ownerEmail } = req.body || {};
  const restaurantName = String(name || "").trim();
  if (!restaurantName || restaurantName.length > 100) return res.status(400).json({ error: "restaurant name is required (up to 100 characters)" });
  const email = String(ownerEmail || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "a valid owner email is required" });
  const { rows: ownerRows } = await pool.query("SELECT * FROM owners WHERE email = $1", [email]);
  let owner = ownerRows[0] || null;
  if (owner && owner.role === "manager") return res.status(409).json({ error: "that email belongs to a manager login; use an owner's email" });
  if (!owner) {
    if (!String(ownerName || "").trim()) return res.status(400).json({ error: "the owner's name is required" });
    const { rows: userClash } = await pool.query("SELECT 1 FROM users WHERE email = $1", [email]);
    if (userClash.length) return res.status(409).json({ error: "that email already signs in to another restaurant directly" });
  }
  const { rows: nameClash } = await pool.query("SELECT 1 FROM restaurants WHERE LOWER(name) = LOWER($1)", [restaurantName]);
  if (nameClash.length) return res.status(409).json({ error: "a restaurant with that name already exists" });

  const restaurantId = id();
  const now = Date.now();
  let password = null;
  await pool.query("INSERT INTO restaurants (id, name, created_at) VALUES ($1,$2,$3)", [restaurantId, restaurantName, now]);
  if (!owner) {
    password = tempPassword();
    const ownerId = id();
    await pool.query("INSERT INTO owners (id, name, email, password_hash, created_at, role) VALUES ($1,$2,$3,$4,$5,'owner')", [ownerId, String(ownerName).trim(), email, await bcrypt.hash(password, 10), now]);
    owner = { id: ownerId };
  }
  await pool.query("INSERT INTO owner_restaurants (owner_id, restaurant_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [owner.id, restaurantId]);
  logActivity({ restaurantId, eventType: "restaurant_created", detail: `restaurant created from dashboard: ${restaurantName} (${email})` });
  res.status(201).json({ restaurant: { id: restaurantId, name: restaurantName }, owner: await ownerWithRestaurants(owner.id), tempPassword: password });
});

app.delete("/api/platform/restaurants/:id", requirePlatformAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT id, name FROM restaurants WHERE id = $1", [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: "restaurant not found" });
  const confirmName = String((req.body && req.body.confirmName) || "");
  if (confirmName !== rows[0].name) return res.status(400).json({ error: "the confirmation name doesn't match exactly" });
  await pool.query("DELETE FROM restaurants WHERE id = $1", [rows[0].id]);
  logActivity({ eventType: "restaurant_deleted", level: "warn", detail: `restaurant deleted from dashboard: ${rows[0].name}` });
  res.status(204).end();
});

app.patch("/api/platform/restaurants/:id/twilio-number", requirePlatformAuth, async (req, res) => {
  const { twilioPhoneNumber } = req.body || {};
  const normalized = twilioPhoneNumber ? normalizePhone(twilioPhoneNumber) : null;
  if (twilioPhoneNumber && !normalized) {
    return res.status(400).json({ error: "that doesn't look like a valid phone number — include country code, e.g. +15145551234" });
  }
  try {
    const { rows } = await pool.query(
      "UPDATE restaurants SET twilio_phone_number = $1 WHERE id = $2 RETURNING id, twilio_phone_number",
      [normalized, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "restaurant not found" });
    logActivity({ restaurantId: req.params.id, eventType: "twilio_number_assigned", detail: normalized ? `Assigned dedicated number ${normalized}` : "Dedicated number removed — back to shared default" });
    res.json({ id: rows[0].id, twilioPhoneNumber: rows[0].twilio_phone_number || "" });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "that number is already assigned to another restaurant" });
    console.error("Error assigning Twilio number:", e.message);
    res.status(500).json({ error: "Something went wrong saving that number." });
  }
});

// Billing exceptions from the dashboard: 'exempt' (never charged, never cut off) or 'free' until a date (then the restaurant must pay).
app.patch("/api/platform/restaurants/:id/billing", requirePlatformAuth, async (req, res) => {
  const { mode, freeUntil } = req.body || {};
  if (mode !== "exempt" && mode !== "free") return res.status(400).json({ error: "mode must be exempt or free" });
  let until = null;
  if (mode === "free") {
    until = /^\d{4}-\d{2}-\d{2}$/.test(String(freeUntil || "")) ? Date.parse(freeUntil + "T23:59:59-04:00") : NaN;
    if (!Number.isFinite(until)) return res.status(400).json({ error: "free access needs an end date (YYYY-MM-DD)" });
  }
  const { rows: cur } = await pool.query("SELECT billing_status FROM restaurants WHERE id = $1", [req.params.id]);
  if (cur.length === 0) return res.status(404).json({ error: "restaurant not found" });
  if (cur[0].billing_status === "active" || cur[0].billing_status === "past_due") return res.status(409).json({ error: "this restaurant has a live subscription; cancel it in Stripe first" });
  await pool.query("UPDATE restaurants SET billing_status = $1, free_until = $2 WHERE id = $3", [mode, until, req.params.id]);
  clearBillingCache(req.params.id);
  logActivity({ restaurantId: req.params.id, eventType: "billing_set", detail: mode === "free" ? `Free access until ${freeUntil}` : "Billing exempt" });
  res.json({ id: req.params.id, billingStatus: mode, freeUntil: until });
});

// ---------- POS connection (Veloce) ----------
// Each restaurant has its own Veloce login + licence number. The password is encrypted (AES-256-GCM) with POS_SECRET_KEY, which lives only in Render,
// and it is never sent to a browser. Nothing here runs until POS_SECRET_KEY is set and a connection is saved.
const VELOCE_BASE = "https://api.posveloce.com/v2";
function posKey() {
  const k = String(process.env.POS_SECRET_KEY || "").trim();
  if (!k) return null;
  const b = /^[0-9a-f]{64}$/i.test(k) ? Buffer.from(k, "hex") : Buffer.from(k, "base64");
  return b.length === 32 ? b : null;
}
function posEncrypt(text) {
  const key = posKey();
  if (!key) throw new Error("POS_SECRET_KEY is not set");
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(String(text), "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}
function posDecrypt(blob) {
  const key = posKey();
  if (!key) throw new Error("POS_SECRET_KEY is not set");
  const [v, iv, tag, ct] = String(blob || "").split(":");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("stored credentials are unreadable");
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
}

async function veloceRequest(method, path, { token, body, query } = {}) {
  const url = new URL(VELOCE_BASE + path);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(url, {
      method,
      signal: ctl.signal,
      headers: { "Content-Type": "application/json", Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (e) {}
    return { status: res.status, ok: res.ok, data };
  } catch (e) {
    const err = new Error(e.name === "AbortError" ? "Veloce did not answer in time" : "could not reach Veloce");
    err.network = true;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Logs in with the saved email + password and keeps the 7-day token (encrypted) so we don't log in on every request.
async function veloceLogin(conn) {
  const r = await veloceRequest("POST", "/users/authenticate", { body: { email: conn.email, password: posDecrypt(conn.password_enc) } });
  if (!r.ok || !r.data || !r.data.token) {
    const said = r.data && (r.data.message || r.data.error || r.data.detail || r.data.title);
    const why = typeof said === "string" ? ` — Veloce says: ${said.replace(/\s+/g, " ").slice(0, 160)}` : "";
    const err = new Error(r.status === 401 || r.status === 403 || r.status === 400 ? `Veloce refused the email or password (HTTP ${r.status})${why}` : `Veloce login failed (HTTP ${r.status})${why}`);
    err.status = r.status;
    throw err;
  }
  const expires = Date.now() + 6 * 24 * 3600 * 1000;
  await pool.query("UPDATE pos_connections SET token_enc = $1, token_expires = $2 WHERE restaurant_id = $3", [posEncrypt(r.data.token), expires, conn.restaurant_id]);
  conn.token_enc = null;
  return r.data.token;
}
async function veloceGet(conn, path, query) {
  let token = null;
  if (conn.token_enc && Number(conn.token_expires) > Date.now() + 3600 * 1000) { try { token = posDecrypt(conn.token_enc); } catch (e) {} }
  if (!token) token = await veloceLogin(conn);
  let r = await veloceRequest("GET", path, { token, query });
  if (r.status === 401) { token = await veloceLogin(conn); r = await veloceRequest("GET", path, { token, query }); }
  return r;
}
async function loadPosConnection(restaurantId) {
  const { rows } = await pool.query("SELECT * FROM pos_connections WHERE restaurant_id = $1", [restaurantId]);
  return rows[0] || null;
}
function posPublic(c) {
  if (!c) return { configured: !!posKey(), connected: false };
  return { configured: !!posKey(), connected: !!(c.email && c.password_enc), provider: c.provider, licenceNumber: c.licence_number || "", email: c.email || "", locationName: c.location_name || "", status: c.status, lastError: c.last_error || "", lastOkAt: c.last_ok_at ? Number(c.last_ok_at) : null };
}
async function posFail(restaurantId, message) {
  await pool.query("UPDATE pos_connections SET status = 'error', last_error = $1, updated_at = $2 WHERE restaurant_id = $3", [String(message).slice(0, 300), Date.now(), restaurantId]);
}
// "2026-10-27" in Toronto time -> RFC 3339 with the right UTC offset (handles daylight saving)
function torontoDateTime(day, plusDays = 0) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + plusDays);
  const ymd = d.toISOString().slice(0, 10);
  const part = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", timeZoneName: "longOffset" }).formatToParts(new Date(`${ymd}T12:00:00Z`)).find((p) => p.type === "timeZoneName");
  const off = (part && part.value.replace("GMT", "")) || "-05:00";
  return `${ymd}T00:00:00${off === "" ? "Z" : off}`;
}
function torontoYesterday() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const d = new Date(`${parts}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

app.get("/api/platform/restaurants/:id/pos", requirePlatformAuth, async (req, res) => {
  res.json(posPublic(await loadPosConnection(req.params.id)));
});
app.put("/api/platform/restaurants/:id/pos", requirePlatformAuth, async (req, res) => {
  if (!posKey()) return res.status(503).json({ error: "POS_SECRET_KEY is not set in Render yet (it must be 64 hex characters)" });
  const { rows: r } = await pool.query("SELECT id FROM restaurants WHERE id = $1", [req.params.id]);
  if (!r.length) return res.status(404).json({ error: "restaurant not found" });
  const licence = String((req.body || {}).licenceNumber || "").trim();
  const email = String((req.body || {}).email || "").trim().toLowerCase();
  const password = String((req.body || {}).password || "");
  if (!/^\d{1,12}$/.test(licence)) return res.status(400).json({ error: "the licence number should be digits only" });
  if (!email.includes("@") || email.length > 200) return res.status(400).json({ error: "enter the Veloce login email" });
  const cur = await loadPosConnection(req.params.id);
  if (!password && !(cur && cur.password_enc)) return res.status(400).json({ error: "enter the Veloce password" });
  if (password.length > 200) return res.status(400).json({ error: "that password is too long" });
  const passEnc = password ? posEncrypt(password) : cur.password_enc;
  const changed = !cur || cur.email !== email || cur.licence_number !== licence || !!password;
  await pool.query(
    `INSERT INTO pos_connections (restaurant_id, provider, licence_number, email, password_enc, status, updated_at)
     VALUES ($1,'veloce',$2,$3,$4,'new',$5)
     ON CONFLICT (restaurant_id) DO UPDATE SET licence_number = $2, email = $3, password_enc = $4, updated_at = $5,
       token_enc = CASE WHEN $6 THEN NULL ELSE pos_connections.token_enc END,
       token_expires = CASE WHEN $6 THEN NULL ELSE pos_connections.token_expires END,
       location_id = CASE WHEN $6 THEN NULL ELSE pos_connections.location_id END,
       location_name = CASE WHEN $6 THEN NULL ELSE pos_connections.location_name END,
       status = CASE WHEN $6 THEN 'new' ELSE pos_connections.status END,
       last_error = CASE WHEN $6 THEN NULL ELSE pos_connections.last_error END`,
    [req.params.id, licence, email, passEnc, Date.now(), changed]
  );
  logActivity({ restaurantId: req.params.id, eventType: "pos_saved", detail: `POS connection saved (licence ${licence}, ${email})` });
  res.json(posPublic(await loadPosConnection(req.params.id)));
});
app.delete("/api/platform/restaurants/:id/pos", requirePlatformAuth, async (req, res) => {
  await pool.query("DELETE FROM pos_connections WHERE restaurant_id = $1", [req.params.id]);
  logActivity({ restaurantId: req.params.id, eventType: "pos_removed", detail: "POS connection removed" });
  res.json(posPublic(null));
});
// Logs in to Veloce and finds the restaurant's location from its licence number.
app.post("/api/platform/restaurants/:id/pos/test", requirePlatformAuth, async (req, res) => {
  const conn = await loadPosConnection(req.params.id);
  if (!conn || !conn.email || !conn.password_enc) return res.status(400).json({ error: "save the Veloce login first" });
  if (!posKey()) return res.status(503).json({ error: "POS_SECRET_KEY is not set in Render yet" });
  try {
    const r = await veloceGet(conn, "/locations", { licenceNumber: conn.licence_number, limit: 5 });
    if (!r.ok) throw Object.assign(new Error(`Veloce answered HTTP ${r.status} when looking up the licence`), { status: r.status });
    const list = (Array.isArray(r.data) ? r.data : r.data && (r.data.content || r.data.locations || r.data.data || r.data.items)) || [];
    const loc = list.find((l) => String(l.licenceNumber) === String(conn.licence_number)) || list[0];
    if (!loc || !loc.id) throw new Error("this Veloce login can't see a location with that licence number");
    await pool.query("UPDATE pos_connections SET location_id = $1, location_name = $2, status = 'ok', last_error = NULL, last_ok_at = $3, updated_at = $3 WHERE restaurant_id = $4", [loc.id, loc.reportingDisplayName || loc.name || "", Date.now(), req.params.id]);
    logActivity({ restaurantId: req.params.id, eventType: "pos_test_ok", detail: `POS test OK: ${loc.name || loc.id}` });
    res.json(posPublic(await loadPosConnection(req.params.id)));
  } catch (e) {
    await posFail(req.params.id, e.message);
    logActivity({ restaurantId: req.params.id, eventType: "pos_test_failed", level: "warn", detail: `POS test failed: ${e.message}` });
    res.status(502).json({ error: e.message });
  }
});
// Reads one day's net sales from Veloce and shows it. It does NOT write anything into the app yet — this is for checking the numbers against the POS.
app.post("/api/platform/restaurants/:id/pos/preview-sales", requirePlatformAuth, async (req, res) => {
  const conn = await loadPosConnection(req.params.id);
  if (!conn || !conn.location_id) return res.status(400).json({ error: "run Test connection first" });
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String((req.body || {}).date || "")) ? req.body.date : torontoYesterday();
  try {
    const r = await veloceGet(conn, "/sales/net", { locationId: conn.location_id, currency: "CAD", from: torontoDateTime(day, 0), to: torontoDateTime(day, 1), date: torontoDateTime(day, 0), includeTotals: "true" });
    if (!r.ok) throw new Error(`Veloce answered HTTP ${r.status} for net sales`);
    const rowsArr = Array.isArray(r.data && r.data.sales) ? r.data.sales : [];
    const sum = (k) => Math.round(rowsArr.reduce((a, x) => a + (Number(x[k]) || 0), 0) * 100) / 100;
    const totals = (r.data && r.data.totals) || null;
    await pool.query("UPDATE pos_connections SET last_ok_at = $1, status = 'ok', last_error = NULL WHERE restaurant_id = $2", [Date.now(), req.params.id]);
    res.json({ date: day, rows: rowsArr.length, netSales: totals ? Number(totals.netSales) : sum("netSales"), grossSales: totals ? Number(totals.grossSales) : sum("grossSales"), checks: totals ? Number(totals.checks) : sum("checks"), customers: totals ? Number(totals.customers) : sum("customers") });
  } catch (e) {
    await posFail(req.params.id, e.message);
    res.status(502).json({ error: e.message });
  }
});

// Raw activity rows are kept this long, then rolled up into activity_daily.
const ACTIVITY_RETENTION_DAYS = Math.max(7, Number(process.env.ACTIVITY_RETENTION_DAYS) || 90);

// Rolls raw rows older than the retention window into daily totals, then deletes them.
// One transaction, so a row is never counted both live and archived.
async function archiveOldActivity(retentionDays = ACTIVITY_RETENTION_DAYS) {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO activity_daily (day, restaurant_id, event_type, level, n, dur_total, dur_n)
       SELECT (to_timestamp(created_at / 1000.0) AT TIME ZONE $2)::date, COALESCE(restaurant_id, ''), event_type, level,
              COUNT(*), COALESCE(SUM(duration_ms), 0), COUNT(duration_ms)
       FROM activity_log WHERE created_at < $1 GROUP BY 1, 2, 3, 4
       ON CONFLICT (day, restaurant_id, event_type, level) DO UPDATE
         SET n = activity_daily.n + EXCLUDED.n, dur_total = activity_daily.dur_total + EXCLUDED.dur_total, dur_n = activity_daily.dur_n + EXCLUDED.dur_n`,
      [cutoff, OWNER_TZ]
    );
    const del = await client.query("DELETE FROM activity_log WHERE created_at < $1", [cutoff]);
    await client.query("COMMIT");
    return del.rowCount;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Spreadsheet-safe CSV cell (also blocks =,+,-,@ formula injection from logged text).
function csvCell(v) {
  let t = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
  return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}
function csvRow(cells) { return cells.map(csvCell).join(","); }

// Adds "local day from..to (inclusive)" conditions on a.created_at.
function addDayRange(conditions, params, from, to) {
  if (from && isIsoDate(from)) {
    params.push(from, OWNER_TZ);
    conditions.push(`a.created_at >= EXTRACT(EPOCH FROM ($${params.length - 1}::date)::timestamp AT TIME ZONE $${params.length}) * 1000`);
  }
  if (to && isIsoDate(to)) {
    params.push(to, OWNER_TZ);
    conditions.push(`a.created_at < EXTRACT(EPOCH FROM (($${params.length - 1}::date + 1)::timestamp) AT TIME ZONE $${params.length}) * 1000`);
  }
}
function activityFilters(q) {
  const conditions = [];
  const params = [];
  if (q.restaurantId) { params.push(q.restaurantId); conditions.push(`a.restaurant_id = $${params.length}`); }
  if (q.eventType) { params.push(q.eventType); conditions.push(`a.event_type = $${params.length}`); }
  if (q.level) { params.push(q.level); conditions.push(`a.level = $${params.length}`); }
  addDayRange(conditions, params, q.from, q.to);
  return { conditions, params };
}

app.get("/api/platform/activity", requirePlatformAuth, async (req, res) => {
  const { conditions, params } = activityFilters(req.query);
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(Math.min(Number(req.query.limit) || 100, 500));

  const { rows } = await pool.query(
    `SELECT a.*, r.name AS restaurant_name FROM activity_log a LEFT JOIN restaurants r ON r.id = a.restaurant_id ${where} ORDER BY a.created_at DESC LIMIT $${params.length}`,
    params
  );
  res.json(rows.map((r) => ({
    id: r.id,
    restaurantId: r.restaurant_id,
    restaurantName: r.restaurant_name || "—",
    eventType: r.event_type,
    level: r.level,
    detail: r.detail || "",
    durationMs: r.duration_ms,
    createdAt: Number(r.created_at),
  })));
});

// CSV download of the raw log for the same filters as the feed (plus from/to dates).
app.get("/api/platform/activity/export", requirePlatformAuth, async (req, res) => {
  const { conditions, params } = activityFilters(req.query);
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const { rows } = await pool.query(
    `SELECT a.*, r.name AS restaurant_name FROM activity_log a LEFT JOIN restaurants r ON r.id = a.restaurant_id ${where} ORDER BY a.created_at DESC LIMIT 100000`,
    params
  );
  const lines = [csvRow(["time_utc", "time_local", "restaurant", "event_type", "level", "detail", "duration_ms"])];
  for (const r of rows) {
    const ms = Number(r.created_at);
    lines.push(csvRow([
      new Date(ms).toISOString(),
      new Date(ms).toLocaleString("en-CA", { timeZone: OWNER_TZ, hour12: false }),
      r.restaurant_name || "", r.event_type, r.level, r.detail || "", r.duration_ms,
    ]));
  }
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="activity-${ownerToday()}.csv"`);
  res.send(lines.join("\r\n") + "\r\n");
});

// Per-day SMS / AI / error totals for the last N days (live log + archived daily totals).
app.get("/api/platform/history", requirePlatformAuth, async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
  const startDay = addDaysIso(ownerToday(), -(days - 1));
  const rid = req.query.restaurantId || null;
  const { rows } = await pool.query(
    `WITH live AS (
       SELECT (to_timestamp(created_at / 1000.0) AT TIME ZONE $2)::date AS day, event_type, level, COUNT(*)::int AS n,
              COALESCE(SUM(duration_ms), 0)::bigint AS dur_total, COUNT(duration_ms)::int AS dur_n
       FROM activity_log
       WHERE created_at >= EXTRACT(EPOCH FROM ($1::date)::timestamp AT TIME ZONE $2) * 1000 AND ($3::text IS NULL OR restaurant_id = $3)
       GROUP BY 1, 2, 3
     ), arch AS (
       SELECT day, event_type, level, SUM(n)::int AS n, SUM(dur_total)::bigint AS dur_total, SUM(dur_n)::int AS dur_n
       FROM activity_daily WHERE day >= $1::date AND ($3::text IS NULL OR restaurant_id = $3) GROUP BY 1, 2, 3
     )
     SELECT day::text AS day, event_type, level, SUM(n)::int AS n, SUM(dur_total)::bigint AS dur_total, SUM(dur_n)::int AS dur_n
     FROM (SELECT * FROM live UNION ALL SELECT * FROM arch) u GROUP BY 1, 2, 3`,
    [startDay, OWNER_TZ, rid]
  );
  const byDay = new Map();
  for (let i = 0; i < days; i++) {
    const d = addDaysIso(startDay, i);
    byDay.set(d, { day: d, smsSent: 0, smsFailed: 0, aiAnswered: 0, aiFailed: 0, errors: 0, events: 0, smsMs: 0, smsMsN: 0, aiMs: 0, aiMsN: 0 });
  }
  for (const r of rows) {
    const row = byDay.get(r.day);
    if (!row) continue;
    const n = Number(r.n);
    row.events += n;
    if (r.level === "error") row.errors += n;
    if (r.event_type === "sms_sent") { row.smsSent += n; row.smsMs += Number(r.dur_total); row.smsMsN += Number(r.dur_n); }
    else if (r.event_type === "sms_failed") row.smsFailed += n;
    else if (r.event_type === "ai_answered") { row.aiAnswered += n; row.aiMs += Number(r.dur_total); row.aiMsN += Number(r.dur_n); }
    else if (r.event_type === "ai_failed") row.aiFailed += n;
  }
  const out = [...byDay.values()].reverse().map((r) => ({
    day: r.day, smsSent: r.smsSent, smsFailed: r.smsFailed, aiAnswered: r.aiAnswered, aiFailed: r.aiFailed,
    errors: r.errors, events: r.events,
    smsAvgMs: r.smsMsN ? Math.round(r.smsMs / r.smsMsN) : null,
    aiAvgMs: r.aiMsN ? Math.round(r.aiMs / r.aiMsN) : null,
  }));
  if (req.query.format === "csv") {
    const lines = [csvRow(["day", "sms_sent", "sms_failed", "ai_answered", "ai_failed", "errors", "total_events", "sms_avg_ms", "ai_avg_ms"])];
    out.forEach((r) => lines.push(csvRow([r.day, r.smsSent, r.smsFailed, r.aiAnswered, r.aiFailed, r.errors, r.events, r.smsAvgMs, r.aiAvgMs])));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="daily-totals-${ownerToday()}.csv"`);
    return res.send(lines.join("\r\n") + "\r\n");
  }
  res.json({ days: out, retentionDays: ACTIVITY_RETENTION_DAYS });
});

app.get("/api/platform/health", requirePlatformAuth, async (req, res) => {
  const dbStart = Date.now();
  let dbOk = true;
  try {
    await pool.query("SELECT 1");
  } catch (e) {
    dbOk = false;
  }
  const dbLatencyMs = Date.now() - dbStart;

  // "Today" = since local midnight in the owner's time zone (not a rolling hour).
  const midnight = await pool.query("SELECT (EXTRACT(EPOCH FROM date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1) * 1000)::bigint AS ms", [OWNER_TZ]);
  const sinceHour = Number(midnight.rows[0].ms);
  const [smsStats, aiStats, failureCounts] = await Promise.all([
    pool.query("SELECT COUNT(*) FILTER (WHERE event_type = 'sms_sent') AS sent, COUNT(*) FILTER (WHERE event_type = 'sms_failed') AS failed, AVG(duration_ms) FILTER (WHERE event_type = 'sms_sent') AS avg_ms FROM activity_log WHERE created_at > $1 AND event_type IN ('sms_sent','sms_failed')", [sinceHour]),
    pool.query("SELECT COUNT(*) FILTER (WHERE event_type = 'ai_answered') AS answered, COUNT(*) FILTER (WHERE event_type = 'ai_failed') AS failed, AVG(duration_ms) FILTER (WHERE event_type = 'ai_answered') AS avg_ms FROM activity_log WHERE created_at > $1 AND event_type IN ('ai_answered','ai_failed')", [sinceHour]),
    pool.query("SELECT event_type, COUNT(*) AS count FROM activity_log WHERE level = 'error' AND created_at > $1 GROUP BY event_type ORDER BY count DESC", [sinceHour]),
  ]);

  res.json({
    database: { ok: dbOk, latencyMs: dbLatencyMs },
    sms: {
      sentToday: Number(smsStats.rows[0].sent || 0),
      failedToday: Number(smsStats.rows[0].failed || 0),
      avgLatencyMs: smsStats.rows[0].avg_ms ? Math.round(Number(smsStats.rows[0].avg_ms)) : null,
    },
    ai: {
      answeredToday: Number(aiStats.rows[0].answered || 0),
      failedToday: Number(aiStats.rows[0].failed || 0),
      avgLatencyMs: aiStats.rows[0].avg_ms ? Math.round(Number(aiStats.rows[0].avg_ms)) : null,
    },
    errorsToday: failureCounts.rows.map((r) => ({ eventType: r.event_type, count: Number(r.count) })),
  });
});

// ---------- health check ----------

app.get("/api/health", async (req, res) => {
  const restaurantCount = await pool.query("SELECT COUNT(*) FROM restaurants");
  res.json({ ok: true, database: "connected", restaurants: Number(restaurantCount.rows[0].count) });
});

// Last stop for any error thrown (or rejected) inside a route: log it with a reference code and answer cleanly instead of hanging.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = Number(err && (err.status || err.statusCode));
  if (status >= 400 && status < 500) { // bad input from the client (malformed JSON, body too large …): not our bug
    return res.status(status).json({ error: status === 413 ? "that upload is too large" : "invalid request" });
  }
  const code = makeErrorCode();
  console.error(`[${code}] ${req.method} ${req.originalUrl}`, err);
  logActivity({
    restaurantId: req.restaurantId || null,
    eventType: "server_error",
    level: "error",
    detail: `[${code}] ${req.method} ${String(req.path || "").slice(0, 120)} — ${err && err.message ? err.message : String(err)}`,
  });
  res.status(500).json({
    error: `Something went wrong on our side. Please try again — if it keeps happening, tell us this code: ${code}`,
    errorCode: code,
  });
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
  logActivity({ eventType: "server_error", level: "error", detail: `Unhandled rejection: ${reason && reason.message ? reason.message : String(reason)}` });
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  logActivity({ eventType: "server_error", level: "error", detail: `Uncaught exception: ${err.message}` });
});

// Only auto-connect and bind a port when this file is run directly (`node server.js`),
// not when it's `require()`'d by the test suite — tests manage their own DB connection
// and never bind a real port.
if (require.main === module) {
  initDb()
    .then(() => {
      const runArchive = () => archiveOldActivity().then((n) => { if (n) console.log(`Archived ${n} old activity rows into daily totals`); }).catch((e) => console.error("Activity archive failed:", e.message));
      runArchive();
      setInterval(runArchive, 24 * 60 * 60 * 1000).unref();
      // the demo restaurant: build it now if it's missing or from an earlier day, and check again every half hour
      const keepDemoFresh = () => ensureFreshDemo().catch((e) => console.error("Demo refresh failed:", e.message));
      keepDemoFresh();
      setInterval(keepDemoFresh, 30 * 60 * 1000).unref();
      app.listen(PORT, () => {
        console.log(`Shift SMS backend running on port ${PORT}`);
        console.log(`Database: connected · multi-tenant auth: enabled`);
        if (PUBLIC_URL) {
          console.log(`Set your Twilio number's inbound webhook to: ${PUBLIC_URL}/api/sms/inbound`);
        } else {
          console.log(`Once deployed, set your Twilio number's inbound webhook to: <your-url>/api/sms/inbound`);
        }
      });
    })
    .catch((e) => {
      console.error("Failed to initialize database:", e.message);
      process.exit(1);
    });
}

// ---------- owners: accounts created by the platform admin ----------

function tempPassword() {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no look-alike characters
  const bytes = crypto.randomBytes(10);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

async function ownerWithRestaurants(ownerId) {
  const { rows } = await pool.query("SELECT * FROM owners WHERE id = $1", [ownerId]);
  if (rows.length === 0) return null;
  const { rows: rs } = await pool.query(
    "SELECT r.id, r.name FROM owner_restaurants o JOIN restaurants r ON r.id = o.restaurant_id WHERE o.owner_id = $1 ORDER BY r.name",
    [ownerId]
  );
  return {
    id: rows[0].id,
    name: rows[0].name,
    email: rows[0].email,
    role: rows[0].role === "manager" ? "manager" : "owner",
    createdAt: Number(rows[0].created_at),
    lastLoginAt: rows[0].last_login_at ? Number(rows[0].last_login_at) : null,
    restaurants: rs.map((r) => ({ id: r.id, name: r.name })),
  };
}

async function setOwnerRestaurants(ownerId, restaurantIds) {
  const ids = [...new Set((restaurantIds || []).map(String))];
  const { rows } = ids.length ? await pool.query("SELECT id FROM restaurants WHERE id = ANY($1)", [ids]) : { rows: [] };
  if (rows.length !== ids.length) return false;
  await pool.query("DELETE FROM owner_restaurants WHERE owner_id = $1", [ownerId]);
  for (const rid of ids) await pool.query("INSERT INTO owner_restaurants (owner_id, restaurant_id) VALUES ($1,$2)", [ownerId, rid]);
  return true;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.get("/api/platform/owners", requirePlatformAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT id FROM owners ORDER BY created_at DESC");
  const owners = [];
  for (const r of rows) owners.push(await ownerWithRestaurants(r.id));
  res.json(owners);
});

app.post("/api/platform/owners", requirePlatformAuth, async (req, res) => {
  const { name, email, restaurantIds } = req.body || {};
  const role = (req.body || {}).role === "manager" ? "manager" : "owner";
  if (!name || !String(name).trim()) return res.status(400).json({ error: "name is required" });
  if (!email || !EMAIL_RE.test(String(email).trim())) return res.status(400).json({ error: "a valid email is required" });
  if (!Array.isArray(restaurantIds) || restaurantIds.length === 0) return res.status(400).json({ error: "pick at least one restaurant" });
  const cleanEmail = String(email).trim().toLowerCase();
  const { rows: dup } = await pool.query("SELECT 1 FROM owners WHERE email = $1", [cleanEmail]);
  if (dup.length) return res.status(409).json({ error: "an owner with that email already exists" });
  const ownerId = id();
  const password = tempPassword();
  await pool.query("INSERT INTO owners (id, name, email, password_hash, created_at, role) VALUES ($1,$2,$3,$4,$5,$6)", [ownerId, String(name).trim(), cleanEmail, await bcrypt.hash(password, 10), Date.now(), role]);
  if (!(await setOwnerRestaurants(ownerId, restaurantIds))) {
    await pool.query("DELETE FROM owners WHERE id = $1", [ownerId]);
    return res.status(400).json({ error: "one of those restaurants doesn't exist" });
  }
  logActivity({ eventType: "owner_created", detail: `${role}: ${String(name).trim()} (${cleanEmail}) → ${restaurantIds.length} restaurant(s)` });
  res.status(201).json({ owner: await ownerWithRestaurants(ownerId), tempPassword: password });
});

app.patch("/api/platform/owners/:id", requirePlatformAuth, async (req, res) => {
  const existing = await ownerWithRestaurants(req.params.id);
  if (!existing) return res.status(404).json({ error: "owner not found" });
  const { name, email, restaurantIds, role } = req.body || {};
  if (role !== undefined) {
    if (role !== "owner" && role !== "manager") return res.status(400).json({ error: "role must be 'owner' or 'manager'" });
    await pool.query("UPDATE owners SET role = $1 WHERE id = $2", [role, existing.id]);
  }
  if (name !== undefined) {
    if (!String(name).trim()) return res.status(400).json({ error: "name can't be empty" });
    await pool.query("UPDATE owners SET name = $1 WHERE id = $2", [String(name).trim(), existing.id]);
  }
  if (email !== undefined) {
    if (!EMAIL_RE.test(String(email).trim())) return res.status(400).json({ error: "a valid email is required" });
    const cleanEmail = String(email).trim().toLowerCase();
    const { rows: dup } = await pool.query("SELECT 1 FROM owners WHERE email = $1 AND id <> $2", [cleanEmail, existing.id]);
    if (dup.length) return res.status(409).json({ error: "an owner with that email already exists" });
    await pool.query("UPDATE owners SET email = $1 WHERE id = $2", [cleanEmail, existing.id]);
  }
  if (restaurantIds !== undefined) {
    if (!Array.isArray(restaurantIds) || restaurantIds.length === 0) return res.status(400).json({ error: "pick at least one restaurant" });
    if (!(await setOwnerRestaurants(existing.id, restaurantIds))) return res.status(400).json({ error: "one of those restaurants doesn't exist" });
  }
  res.json(await ownerWithRestaurants(existing.id));
});

app.post("/api/platform/owners/:id/reset-password", requirePlatformAuth, async (req, res) => {
  const existing = await ownerWithRestaurants(req.params.id);
  if (!existing) return res.status(404).json({ error: "owner not found" });
  const password = tempPassword();
  await pool.query("UPDATE owners SET password_hash = $1 WHERE id = $2", [await bcrypt.hash(password, 10), existing.id]);
  res.json({ tempPassword: password });
});

app.delete("/api/platform/owners/:id", requirePlatformAuth, async (req, res) => {
  const { rowCount } = await pool.query("DELETE FROM owners WHERE id = $1", [req.params.id]);
  if (rowCount === 0) return res.status(404).json({ error: "owner not found" });
  res.status(204).end();
});

// ---------- owner login + multi-restaurant snapshot ----------

app.post("/api/owner-auth/login", loginLimiter, loginEmailLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email and password are required" });
  const { rows } = await pool.query("SELECT * FROM owners WHERE email = $1", [String(email).trim().toLowerCase()]);
  const owner = rows[0];
  if (!owner || !(await bcrypt.compare(password, owner.password_hash))) {
    logActivity({ eventType: "login_failed", level: "warn", detail: `owner page login failed: ${String(email).trim().toLowerCase()} (${owner ? "wrong password" : "no such account"}) [${deviceLabel(req)}]` });
    return res.status(401).json({ error: "incorrect email or password" });
  }
  await pool.query("UPDATE owners SET last_login_at = $1 WHERE id = $2", [Date.now(), owner.id]);
  res.cookie("owner_token", signToken({ ownerId: owner.id }), COOKIE_OPTS);
  logActivity({ eventType: "login_success", detail: `${owner.role === "manager" ? "manager" : "owner"} login via owner page: ${owner.email} [${deviceLabel(req)}]` });
  const full = await ownerWithRestaurants(owner.id);
  res.json({ name: owner.name, role: full.role, restaurantIds: full.restaurants.map((r) => r.id) });
});

app.post("/api/owner-auth/logout", (req, res) => {
  res.clearCookie("owner_token", { ...COOKIE_OPTS, maxAge: undefined });
  res.clearCookie("token", { ...COOKIE_OPTS, maxAge: undefined });
  res.json({ ok: true });
});

app.get("/api/owner-auth/me", requireOwnerAuth, async (req, res) => {
  const o = await ownerWithRestaurants(req.ownerId);
  if (!o) return res.status(401).json({ error: "not logged in" });
  res.json({ name: o.name, email: o.email, role: o.role, restaurantIds: o.restaurants.map((r) => r.id) });
});

app.post("/api/owner-auth/change-password", requireOwnerAuth, loginLimiter, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 8) return res.status(400).json({ error: "new password must be at least 8 characters" });
  const { rows } = await pool.query("SELECT password_hash FROM owners WHERE id = $1", [req.ownerId]);
  if (!rows[0] || !(await bcrypt.compare(String(currentPassword || ""), rows[0].password_hash))) return res.status(401).json({ error: "current password is incorrect" });
  await pool.query("UPDATE owners SET password_hash = $1 WHERE id = $2", [await bcrypt.hash(String(newPassword), 10), req.ownerId]);
  res.json({ ok: true });
});

const OWNER_TZ = "America/Toronto";
const OWNER_LABOR_HIGH_PCT = 35;
const OWNER_OPEN_SHIFTS_ALERT = 3;
const OWNER_SALES_DROP_PCT = -15;

function ownerToday() {
  return new Date().toLocaleDateString("en-CA", { timeZone: OWNER_TZ }); // YYYY-MM-DD
}

// One restaurant's week-to-date picture. Pure data + simple rules — no AI call, no cost.
async function restaurantSnapshot(restaurant, today) {
  const rid = restaurant.id;
  const weekStart = mondayOfIso(today);
  const lastStart = addDaysIso(weekStart, -7);
  const lastSame = addDaysIso(today, -7);
  const num = (v) => (v === null || v === undefined ? 0 : Number(v));

  const { rows: sales } = await pool.query(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE sale_date >= $2 AND sale_date <= $3), 0) AS this_week,
            COUNT(*) FILTER (WHERE sale_date >= $2 AND sale_date <= $3 AND amount IS NOT NULL) AS days,
            COALESCE(SUM(amount) FILTER (WHERE sale_date >= $4 AND sale_date <= $5), 0) AS last_week
     FROM actual_sales WHERE restaurant_id = $1`,
    [rid, weekStart, today, lastStart, lastSame]
  );
  const salesWeek = num(sales[0].this_week);
  const salesDays = Number(sales[0].days);
  const salesLast = num(sales[0].last_week);

  const { rows: sched } = await pool.query(
    `SELECT ss.start_time, ss.end_time, st.hourly_rate FROM schedule_shifts ss JOIN staff st ON st.id = ss.staff_id
     WHERE ss.restaurant_id = $1 AND ss.shift_date >= $2 AND ss.shift_date <= $3`,
    [rid, weekStart, today]
  );
  let labor = 0;
  for (const r of sched) {
    const [a, b] = shiftRange(r.start_time, r.end_time);
    labor += ((b - a) / 60) * num(r.hourly_rate);
  }
  const laborPct = salesWeek > 0 ? Math.round((labor / salesWeek) * 1000) / 10 : null;
  const vsLastPct = salesLast > 0 ? Math.round(((salesWeek - salesLast) / salesLast) * 1000) / 10 : null;

  const { rows: open } = await pool.query("SELECT COUNT(*) AS n FROM shifts WHERE restaurant_id = $1 AND status = 'open'", [rid]);
  const { rows: sw } = await pool.query("SELECT COUNT(*) AS n FROM shift_swaps WHERE restaurant_id = $1 AND status = 'pending'", [rid]);
  const { rows: staffN } = await pool.query("SELECT COUNT(*) AS n FROM staff WHERE restaurant_id = $1 AND archived_at IS NULL", [rid]);
  const openShifts = Number(open[0].n);
  const pendingSwaps = Number(sw[0].n);

  const attention = [];
  const info = [];
  if (laborPct !== null && laborPct > OWNER_LABOR_HIGH_PCT) attention.push({ code: "labor_high", value: laborPct });
  if (openShifts >= OWNER_OPEN_SHIFTS_ALERT) attention.push({ code: "open_shifts", value: openShifts });
  if (vsLastPct !== null && vsLastPct <= OWNER_SALES_DROP_PCT) attention.push({ code: "sales_down", value: vsLastPct });
  if (pendingSwaps > 0) info.push({ code: "swaps", value: pendingSwaps });
  if (vsLastPct !== null && vsLastPct >= 10) info.push({ code: "sales_up", value: vsLastPct });
  if (salesDays === 0) info.push({ code: "no_sales", value: 0 });

  return {
    id: rid,
    name: restaurant.name,
    status: attention.length ? "attention" : "on_track",
    salesWeek: Math.round(salesWeek * 100) / 100,
    salesDays,
    salesVsLastWeekPct: vsLastPct,
    laborPct,
    openShifts,
    pendingSwaps,
    staffCount: Number(staffN[0].n),
    flags: [...attention.map((f) => ({ ...f, level: "attention" })), ...info.map((f) => ({ ...f, level: "info" }))],
  };
}

// Opens one of the owner's restaurants as its manager: same privileges as the manager login, because the
// session cookie carries that restaurant's id. Only restaurants linked to this owner can be opened.
app.post("/api/owner/open/:restaurantId", requireOwnerAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT 1 FROM owner_restaurants WHERE owner_id = $1 AND restaurant_id = $2", [req.ownerId, req.params.restaurantId]);
  if (rows.length === 0) return res.status(404).json({ error: "restaurant not found" });
  res.cookie("token", signToken({ restaurantId: req.params.restaurantId, ownerId: req.ownerId }), COOKIE_OPTS);
  logActivity({ restaurantId: req.params.restaurantId, eventType: "owner_opened_restaurant", detail: `owner ${req.ownerId}` });
  res.json({ ok: true });
});

app.get("/api/owner/overview", requireOwnerAuth, async (req, res) => {
  const owner = await ownerWithRestaurants(req.ownerId);
  if (!owner) return res.status(401).json({ error: "not logged in" });
  const today = ownerToday();
  const restaurants = [];
  for (const r of owner.restaurants) restaurants.push(await restaurantSnapshot(r, today));
  res.json({
    owner: { name: owner.name },
    today,
    weekStart: mondayOfIso(today),
    totals: {
      salesWeek: Math.round(restaurants.reduce((a, r) => a + r.salesWeek, 0) * 100) / 100,
      openShifts: restaurants.reduce((a, r) => a + r.openShifts, 0),
      needAttention: restaurants.filter((r) => r.status === "attention").length,
      locations: restaurants.length,
    },
    restaurants,
  });
});

module.exports = { verifyStripeSignature, stripeForm, clearBillingCache, app, pool, initDb, seedDemoNow, ensureFreshDemo, demoIds, makeErrorCode, archiveOldActivity, parseMetNoForecast, cleanEvents, checkScheduleCandidates, cleanAvailability };
