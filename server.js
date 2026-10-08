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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
  `);
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff_availability (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      staff_id TEXT NOT NULL UNIQUE REFERENCES staff(id) ON DELETE CASCADE,
      availability JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at BIGINT NOT NULL
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
  await pool.query(`CREATE INDEX IF NOT EXISTS activity_log_restaurant_idx ON activity_log (restaurant_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS activity_log_created_idx ON activity_log (created_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS activity_log_type_idx ON activity_log (event_type);`);
}

// ---------- helpers ----------

function id() {
  return crypto.randomBytes(6).toString("hex");
}

// Lightweight activity/event logging for the platform-owner dashboard.
// Never throws — a logging failure should never break the actual request.
async function logActivity({ restaurantId = null, eventType, level = "info", detail = "", durationMs = null }) {
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
function staffRowToJson(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    roles: row.roles,
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
  };
}
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "30d" });
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

function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies.token;
  if (!token) return res.status(401).json({ error: "not logged in" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.restaurantId = payload.restaurantId;
    req.userId = payload.userId;
    next();
  } catch (e) {
    return res.status(401).json({ error: "session expired — please log in again" });
  }
}

function requireStaffAuth(req, res, next) {
  const token = req.cookies && req.cookies.staff_token;
  if (!token) return res.status(401).json({ error: "not logged in" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.staffId = payload.staffId;
    req.restaurantId = payload.restaurantId;
    next();
  } catch (e) {
    return res.status(401).json({ error: "session expired — please log in again" });
  }
}

function requirePlatformAuth(req, res, next) {
  const token = req.cookies && req.cookies.platform_token;
  if (!token) return res.status(401).json({ error: "not logged in" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload.platformAdminId) throw new Error("not a platform token");
    req.platformAdminId = payload.platformAdminId;
    next();
  } catch (e) {
    return res.status(401).json({ error: "session expired — please log in again" });
  }
}

// ---------- app setup ----------

const app = express();
app.set("trust proxy", 1); // Render sits in front of this app — without this, every visitor looks like the same IP to rate limiting
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

const allowedOrigins = ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : true, credentials: true }));

app.use(express.static(path.join(__dirname, "public")));

// ---------- rate limiting ----------
// Login endpoints: a real person mistypes their password once or twice; a brute-force
// attempt tries hundreds of times per minute. This gap is wide enough that a tight limit
// never bothers a real user while making guessing attacks impractically slow.
const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
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
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.restaurantId || req.ip,
  message: { error: "This restaurant has reached the hourly limit for AI questions. Please try again later." },
});

// ---------- auth endpoints ----------

app.post("/api/auth/signup", signupLimiter, async (req, res) => {
  const { restaurantName, email, password } = req.body || {};
  if (!restaurantName || !restaurantName.trim()) return res.status(400).json({ error: "restaurant name is required" });
  if (!email || !isValidEmail(email)) return res.status(400).json({ error: "a valid email is required" });
  if (!password || password.length < 8) return res.status(400).json({ error: "password must be at least 8 characters" });

  const { rows: existing } = await pool.query("SELECT id FROM users WHERE email = $1", [email.toLowerCase()]);
  if (existing.length > 0) return res.status(409).json({ error: "an account with that email already exists" });

  const restaurantId = id();
  const userId = id();
  const passwordHash = await bcrypt.hash(password, 10);
  const now = Date.now();

  await pool.query("INSERT INTO restaurants (id, name, created_at) VALUES ($1,$2,$3)", [restaurantId, restaurantName.trim(), now]);
  await pool.query(
    "INSERT INTO users (id, restaurant_id, email, password_hash, created_at) VALUES ($1,$2,$3,$4,$5)",
    [userId, restaurantId, email.toLowerCase(), passwordHash, now]
  );

  const token = signToken({ userId, restaurantId });
  res.cookie("token", token, COOKIE_OPTS);
  logActivity({ restaurantId, eventType: "restaurant_signup", detail: `${restaurantName.trim()} (${email.toLowerCase()})` });
  res.status(201).json({ restaurant: { id: restaurantId, name: restaurantName.trim() }, email: email.toLowerCase() });
});

app.post("/api/auth/login", loginLimiter, async (req, res) => {
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
    logActivity({ eventType: "login_failed", level: "warn", detail: `manager login failed: ${email.toLowerCase()} (no such account)` });
    return res.status(401).json({ error: "incorrect email or password" });
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    logActivity({ restaurantId: user.restaurant_id, eventType: "login_failed", level: "warn", detail: `manager login failed: ${email.toLowerCase()} (wrong password)` });
    return res.status(401).json({ error: "incorrect email or password" });
  }

  const token = signToken({ userId: user.id, restaurantId: user.restaurant_id });
  res.cookie("token", token, COOKIE_OPTS);
  logActivity({ restaurantId: user.restaurant_id, eventType: "login_success", detail: `manager login: ${email.toLowerCase()}` });
  res.json({ restaurant: { id: user.restaurant_id, name: user.restaurant_name, address: user.restaurant_address || "" }, email: user.email });
});

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("token", { ...COOKIE_OPTS, maxAge: undefined });
  res.status(204).end();
});

app.get("/api/auth/me", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT users.email, restaurants.id AS restaurant_id, restaurants.name AS restaurant_name, restaurants.address AS restaurant_address
     FROM users JOIN restaurants ON restaurants.id = users.restaurant_id
     WHERE users.id = $1`,
    [req.userId]
  );
  if (rows.length === 0) return res.status(401).json({ error: "not logged in" });
  res.json({
    restaurant: { id: rows[0].restaurant_id, name: rows[0].restaurant_name, address: rows[0].restaurant_address || "" },
    email: rows[0].email,
  });
});

// ---------- restaurant settings ----------

app.get("/api/restaurant", requireAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT id, name, address FROM restaurants WHERE id = $1", [req.restaurantId]);
  if (rows.length === 0) return res.status(404).json({ error: "restaurant not found" });
  res.json({ id: rows[0].id, name: rows[0].name, address: rows[0].address || "" });
});

// ---------- training: courses, manuals, contracts (scoped to the logged-in restaurant) ----------

const TRAINING_KINDS = ["course", "manual", "contract"];

async function loadTrainingItems(restaurantId) {
  const { rows: items } = await pool.query("SELECT id, kind, title, minutes, created_at, file_name, file_type, file_size FROM training_items WHERE restaurant_id = $1 ORDER BY created_at DESC", [restaurantId]);
  if (items.length === 0) return [];
  const { rows: assigns } = await pool.query(
    `SELECT a.item_id, a.staff_id, a.completed_at FROM training_assignments a
     JOIN training_items i ON i.id = a.item_id WHERE i.restaurant_id = $1`,
    [restaurantId]
  );
  return items.map((it) => ({
    id: it.id,
    kind: it.kind,
    title: it.title,
    minutes: it.minutes,
    createdAt: Number(it.created_at),
    file: it.file_name ? { name: it.file_name, type: it.file_type, size: it.file_size } : null,
    assignments: assigns
      .filter((a) => a.item_id === it.id)
      .map((a) => ({ staffId: a.staff_id, done: !!a.completed_at })),
  }));
}

app.get("/api/training", requireAuth, async (req, res) => {
  res.json(await loadTrainingItems(req.restaurantId));
});

app.post("/api/training", requireAuth, async (req, res) => {
  const { kind, title, minutes, staffIds } = req.body || {};
  if (!TRAINING_KINDS.includes(kind)) return res.status(400).json({ error: "kind must be course, manual or contract" });
  if (!title || !String(title).trim()) return res.status(400).json({ error: "title is required" });
  let mins = null;
  if (kind === "course" && minutes !== undefined && minutes !== null && minutes !== "") {
    mins = Math.round(Number(minutes));
    if (isNaN(mins) || mins < 0) return res.status(400).json({ error: "minutes must be a positive number" });
  }

  // Only staff belonging to this restaurant can be assigned. Omitting staffIds assigns everyone.
  const { rows: staffRows } = await pool.query("SELECT id FROM staff WHERE restaurant_id = $1", [req.restaurantId]);
  const validIds = new Set(staffRows.map((s) => s.id));
  const targets = Array.isArray(staffIds) ? staffIds.filter((sid) => validIds.has(sid)) : [...validIds];

  const newId = id();
  await pool.query(
    "INSERT INTO training_items (id, restaurant_id, kind, title, minutes, created_at) VALUES ($1,$2,$3,$4,$5,$6)",
    [newId, req.restaurantId, kind, String(title).trim(), mins, Date.now()]
  );
  await Promise.all(targets.map((sid) =>
    pool.query("INSERT INTO training_assignments (item_id, staff_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [newId, sid])
  ));
  const items = await loadTrainingItems(req.restaurantId);
  res.status(201).json(items.find((i) => i.id === newId));
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

app.put(
  "/api/training/:id/file",
  requireAuth,
  express.raw({ type: () => true, limit: TRAINING_FILE_MAX_BYTES }),
  async (req, res) => {
    const { rows: item } = await pool.query("SELECT id FROM training_items WHERE id = $1 AND restaurant_id = $2", [req.params.id, req.restaurantId]);
    if (item.length === 0) return res.status(404).json({ error: "item not found" });
    const name = String(req.query.name || "").replace(/[\\/\r\n"]/g, "_").slice(0, 150).trim();
    const ext = (name.split(".").pop() || "").toLowerCase();
    if (!name || !TRAINING_FILE_TYPES[ext]) {
      return res.status(400).json({ error: "File type not allowed. Use PDF, Word, Excel, PowerPoint, text, image or video (mp4/mov/webm)." });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: "file is empty" });
    await pool.query(
      "UPDATE training_items SET file_name = $1, file_type = $2, file_size = $3, file_data = $4 WHERE id = $5 AND restaurant_id = $6",
      [name, TRAINING_FILE_TYPES[ext], req.body.length, req.body, req.params.id, req.restaurantId]
    );
    res.json({ name, type: TRAINING_FILE_TYPES[ext], size: req.body.length });
  }
);

app.get("/api/training/:id/file", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT file_name, file_type, file_data FROM training_items WHERE id = $1 AND restaurant_id = $2",
    [req.params.id, req.restaurantId]
  );
  if (rows.length === 0 || !rows[0].file_data) return res.status(404).json({ error: "no file attached" });
  res.set({
    "Content-Type": rows[0].file_type || "application/octet-stream",
    "Content-Disposition": `attachment; filename="${rows[0].file_name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(rows[0].file_name)}`,
    "X-Content-Type-Options": "nosniff",
  });
  res.send(rows[0].file_data);
});

app.delete("/api/training/:id/file", requireAuth, async (req, res) => {
  const result = await pool.query(
    "UPDATE training_items SET file_name = NULL, file_type = NULL, file_size = NULL, file_data = NULL WHERE id = $1 AND restaurant_id = $2",
    [req.params.id, req.restaurantId]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: "item not found" });
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
  const { rows: existingRows } = await pool.query("SELECT * FROM staff WHERE id = $1 AND restaurant_id = $2", [req.params.id, req.restaurantId]);
  if (existingRows.length === 0) return res.status(404).json({ error: "staff not found" });

  const { name, phone, roles, hourlyRate, hireDate, address } = req.body || {};
  const updates = {
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
  if (hireDate !== undefined) updates.hire_date = hireDate.trim() || null;
  if (address !== undefined) updates.address = address.trim() || null;

  const { rows } = await pool.query(
    "UPDATE staff SET name=$1, phone=$2, roles=$3, hourly_rate=$4, hire_date=$5, address=$6 WHERE id=$7 AND restaurant_id=$8 RETURNING *",
    [updates.name, updates.phone, JSON.stringify(updates.roles), updates.hourly_rate, updates.hire_date, updates.address, req.params.id, req.restaurantId]
  );
  res.json(staffRowToJson(rows[0]));
});

app.delete("/api/staff/:id", requireAuth, async (req, res) => {
  await pool.query("DELETE FROM staff WHERE id = $1 AND restaurant_id = $2", [req.params.id, req.restaurantId]);
  res.status(204).end();
});

app.post("/api/staff/:id/send-login-setup", requireAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM staff WHERE id = $1 AND restaurant_id = $2", [req.params.id, req.restaurantId]);
  if (rows.length === 0) return res.status(404).json({ error: "staff not found" });
  const staffer = rows[0];

  const token = id() + id(); // longer, single-use token
  await pool.query("UPDATE staff SET claim_token = $1 WHERE id = $2 AND restaurant_id = $3", [token, staffer.id, req.restaurantId]);

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
    `SELECT * FROM staff WHERE restaurant_id = $1
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

  const { rows: staffRows } = await pool.query("SELECT * FROM staff WHERE id = $1 AND restaurant_id = $2", [staffId, req.restaurantId]);
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

  const { rows: staffRows } = await pool.query("SELECT * FROM staff WHERE restaurant_id = $1", [req.restaurantId]);
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

app.post("/api/sms/inbound", async (req, res) => {
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
      const { rows: staffRows } = await pool.query("SELECT * FROM staff WHERE phone = $1 AND restaurant_id = $2 LIMIT 1", [from, restaurantId]);
      if (staffRows[0]) staffer = staffRowToJson(staffRows[0]);
    }
  }

  if (!staffer) {
    // Fallback: shared default number, or no dedicated-number match — best-effort phone lookup.
    const { rows: staffRows } = await pool.query("SELECT * FROM staff WHERE phone = $1 LIMIT 1", [from]);
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

app.get("/api/staff-auth/claim/:token", async (req, res) => {
  const { rows } = await pool.query("SELECT staff.*, restaurants.name AS restaurant_name FROM staff JOIN restaurants ON restaurants.id = staff.restaurant_id WHERE staff.claim_token = $1", [req.params.token]);
  if (rows.length === 0) return res.status(404).json({ error: "This setup link isn't valid — ask your manager to send a new one." });
  res.json({ name: rows[0].name, restaurantName: rows[0].restaurant_name });
});

app.post("/api/staff-auth/claim", signupLimiter, async (req, res) => {
  const { token, email, password } = req.body || {};
  if (!token) return res.status(400).json({ error: "token is required" });
  if (!email || !isValidEmail(email)) return res.status(400).json({ error: "a valid email is required" });
  if (!password || password.length < 8) return res.status(400).json({ error: "password must be at least 8 characters" });

  const { rows } = await pool.query("SELECT * FROM staff WHERE claim_token = $1", [token]);
  if (rows.length === 0) return res.status(404).json({ error: "This setup link isn't valid — ask your manager to send a new one." });
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

app.post("/api/staff-auth/login", loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email and password are required" });

  const { rows } = await pool.query("SELECT * FROM staff WHERE email = $1", [email.toLowerCase()]);
  const staffer = rows[0];
  if (!staffer || !staffer.password_hash) {
    logActivity({ eventType: "login_failed", level: "warn", detail: `staff login failed: ${email.toLowerCase()} (no such account)` });
    return res.status(401).json({ error: "incorrect email or password" });
  }

  const valid = await bcrypt.compare(password, staffer.password_hash);
  if (!valid) {
    logActivity({ restaurantId: staffer.restaurant_id, eventType: "login_failed", level: "warn", detail: `staff login failed: ${email.toLowerCase()} (wrong password)` });
    return res.status(401).json({ error: "incorrect email or password" });
  }

  const sessionToken = signToken({ staffId: staffer.id, restaurantId: staffer.restaurant_id });
  res.cookie("staff_token", sessionToken, COOKIE_OPTS);
  logActivity({ restaurantId: staffer.restaurant_id, eventType: "login_success", detail: `staff login: ${email.toLowerCase()}` });
  res.json({ name: staffer.name });
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
  res.json({ ...staffRowToJson(rows[0]), restaurantName: rows[0].restaurant_name });
});

// ---------- staff portal: schedule, availability, open shifts (staff, authenticated) ----------

app.get("/api/staff-auth/schedule", requireStaffAuth, async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: "start and end date query params are required (YYYY-MM-DD)" });
  const { rows } = await pool.query(
    "SELECT * FROM schedule_shifts WHERE staff_id = $1 AND restaurant_id = $2 AND shift_date >= $3 AND shift_date <= $4 ORDER BY shift_date ASC, start_time ASC",
    [req.staffId, req.restaurantId, start, end]
  );
  res.json(rows.map(scheduleShiftRowToJson));
});

app.get("/api/staff-auth/availability", requireStaffAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM staff_availability WHERE staff_id = $1", [req.staffId]);
  res.json({ availability: rows[0] ? rows[0].availability : {} });
});

app.put("/api/staff-auth/availability", requireStaffAuth, async (req, res) => {
  const { availability } = req.body || {};
  if (!availability || typeof availability !== "object") return res.status(400).json({ error: "availability object is required" });
  const newId = id();
  const { rows } = await pool.query(
    `INSERT INTO staff_availability (id, restaurant_id, staff_id, availability, updated_at)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (staff_id) DO UPDATE SET availability = EXCLUDED.availability, updated_at = EXCLUDED.updated_at
     RETURNING *`,
    [newId, req.restaurantId, req.staffId, JSON.stringify(availability), Date.now()]
  );
  res.json({ availability: rows[0].availability });
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

app.post("/api/schedule", requireAuth, async (req, res) => {
  const { staffId, date, startTime, endTime, role } = req.body || {};
  if (!staffId) return res.status(400).json({ error: "staffId is required" });
  if (!date) return res.status(400).json({ error: "date is required" });
  if (!startTime || !endTime) return res.status(400).json({ error: "startTime and endTime are required" });

  const { rows: staffRows } = await pool.query("SELECT id FROM staff WHERE id = $1 AND restaurant_id = $2", [staffId, req.restaurantId]);
  if (staffRows.length === 0) return res.status(404).json({ error: "staff not found" });

  const newId = id();
  const { rows } = await pool.query(
    "INSERT INTO schedule_shifts (id, restaurant_id, staff_id, shift_date, start_time, end_time, role, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
    [newId, req.restaurantId, staffId, date, startTime, endTime, (role || "").trim() || null, Date.now()]
  );
  res.status(201).json(scheduleShiftRowToJson(rows[0]));
});

// ---------- bulk schedule helpers (used by the AI scheduler and its Apply / Undo) ----------

const SCHEDULE_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const SCHEDULE_BULK_MAX = 250;
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
function checkScheduleCandidates(candidates, { staffById, existing, availabilityByStaff, windowStart, windowEnd }) {
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
    if (dayEntry && dayEntry.available === false) { skipped.push({ ...base, code: "unavailable" }); continue; }
    const k = `${c.staffId}|${c.date}`;
    if ((taken[k] || []).some((r) => rangesOverlap(r, range))) { skipped.push({ ...base, code: "overlap" }); continue; }
    (taken[k] = taken[k] || []).push(range);
    const roles = person.roles || [];
    const role = roles.includes(c.role) ? c.role : (roles[0] || "");
    ok.push({ staffId: c.staffId, staffName: person.name, date: c.date, startTime: c.startTime, endTime: c.endTime, role });
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

// Insert several shifts at once (all or nothing). Conflicts with what's already on the grid are skipped, not errors.
app.post("/api/schedule/bulk", requireAuth, async (req, res) => {
  const list = req.body && req.body.shifts;
  if (!Array.isArray(list) || list.length === 0) return res.status(400).json({ error: "shifts must be a non-empty array" });
  if (list.length > SCHEDULE_BULK_MAX) return res.status(400).json({ error: `at most ${SCHEDULE_BULK_MAX} shifts at a time` });
  const dates = list.map((c) => c && c.date).filter(isIsoDate).sort();
  if (dates.length === 0) return res.status(400).json({ error: "valid dates are required" });
  const { rows: staffRows } = await pool.query("SELECT id, name, roles FROM staff WHERE restaurant_id = $1", [req.restaurantId]);
  const staffById = {};
  staffRows.forEach((r) => { staffById[r.id] = { name: r.name, roles: r.roles || [] }; });
  const { rows: existingRows } = await pool.query(
    "SELECT * FROM schedule_shifts WHERE restaurant_id = $1 AND shift_date >= $2 AND shift_date <= $3",
    [req.restaurantId, dates[0], dates[dates.length - 1]]
  );
  const existing = existingRows.map(scheduleShiftRowToJson);
  const { ok, skipped } = checkScheduleCandidates(
    list.map((c) => ({ staffId: c && c.staffId, date: c && c.date, startTime: c && c.startTime, endTime: c && c.endTime, role: c && c.role })),
    { staffById, existing, availabilityByStaff: null }
  );
  const client = await pool.connect();
  const created = [];
  try {
    await client.query("BEGIN");
    for (const sh of ok) {
      const { rows } = await client.query(
        "INSERT INTO schedule_shifts (id, restaurant_id, staff_id, shift_date, start_time, end_time, role, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
        [id(), req.restaurantId, sh.staffId, sh.date, sh.startTime, sh.endTime, sh.role || null, Date.now()]
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

  const { startTime, endTime, role, date, staffId } = req.body || {};
  const updates = {
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

  const { rows } = await pool.query(
    "UPDATE schedule_shifts SET staff_id=$1, shift_date=$2, start_time=$3, end_time=$4, role=$5 WHERE id=$6 AND restaurant_id=$7 RETURNING *",
    [updates.staff_id, updates.shift_date, updates.start_time, updates.end_time, updates.role, req.params.id, req.restaurantId]
  );
  res.json(scheduleShiftRowToJson(rows[0]));
});

app.delete("/api/schedule/:id", requireAuth, async (req, res) => {
  await pool.query("DELETE FROM schedule_shifts WHERE id = $1 AND restaurant_id = $2", [req.params.id, req.restaurantId]);
  res.status(204).end();
});

// ---------- projected sales (manual daily entry) ----------

app.get("/api/sales-projections", requireAuth, async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: "start and end date query params are required (YYYY-MM-DD)" });
  const { rows } = await pool.query(
    "SELECT * FROM sales_projections WHERE restaurant_id = $1 AND proj_date >= $2 AND proj_date <= $3",
    [req.restaurantId, start, end]
  );
  res.json(
    rows.map((r) => ({
      date: r.proj_date instanceof Date ? r.proj_date.toISOString().slice(0, 10) : r.proj_date,
      projectedAmount: r.projected_amount !== null ? Number(r.projected_amount) : null,
    }))
  );
});

app.put("/api/sales-projections", requireAuth, async (req, res) => {
  const { date, projectedAmount } = req.body || {};
  if (!date) return res.status(400).json({ error: "date is required" });
  let amount = null;
  if (projectedAmount !== undefined && projectedAmount !== "" && projectedAmount !== null) {
    amount = Number(projectedAmount);
    if (isNaN(amount) || amount < 0) return res.status(400).json({ error: "projected amount must be a positive number" });
  }
  const newId = id();
  const { rows } = await pool.query(
    `INSERT INTO sales_projections (id, restaurant_id, proj_date, projected_amount, created_at)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (restaurant_id, proj_date) DO UPDATE SET projected_amount = EXCLUDED.projected_amount
     RETURNING *`,
    [newId, req.restaurantId, date, amount, Date.now()]
  );
  res.json({
    date: rows[0].proj_date instanceof Date ? rows[0].proj_date.toISOString().slice(0, 10) : rows[0].proj_date,
    projectedAmount: rows[0].projected_amount !== null ? Number(rows[0].projected_amount) : null,
  });
});

// ---------- actual sales (empty until a POS integration exists; this is the slot it will write into) ----------

function actualSalesRowToJson(r) {
  const num = (v) => (v !== null && v !== undefined ? Number(v) : null);
  return {
    date: r.sale_date instanceof Date ? r.sale_date.toISOString().slice(0, 10) : r.sale_date,
    amount: num(r.amount),
    foodAmount: num(r.food_amount),
    bevAmount: num(r.bev_amount),
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
  res.json(rows.map(actualSalesRowToJson));
});

// Two ways to write a day's sales:
//  - foodAmount and/or bevAmount: the manager's entry (or a POS that reports categories). The day's total is food + beverage.
//  - amount only: a POS total with no split. The food/beverage split is cleared so the total stays authoritative.
// Empty string or null clears a value.
app.put("/api/actual-sales", requireAuth, async (req, res) => {
  const { date, amount, foodAmount, bevAmount, source } = req.body || {};
  if (!date) return res.status(400).json({ error: "date is required" });

  const parseMoney = (raw, label) => {
    if (raw === undefined) return { provided: false };
    if (raw === null || raw === "") return { provided: true, value: null };
    const n = Number(raw);
    if (isNaN(n) || n < 0) return { error: `${label} must be a positive number` };
    return { provided: true, value: n };
  };
  const total = parseMoney(amount, "amount");
  const food = parseMoney(foodAmount, "foodAmount");
  const bev = parseMoney(bevAmount, "bevAmount");
  for (const p of [total, food, bev]) if (p.error) return res.status(400).json({ error: p.error });

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
       SET amount = EXCLUDED.amount, food_amount = EXCLUDED.food_amount, bev_amount = EXCLUDED.bev_amount, source = EXCLUDED.source
     RETURNING *`,
    [newId, req.restaurantId, date, amt, foodVal, bevVal, (source || "manual").trim(), Date.now()]
  );
  res.json(actualSalesRowToJson(rows[0]));
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
  const today = new Date().toISOString().slice(0, 10);
  res.json({ today, ...buildRevenueSummary({ year, today, weeks, thisYearByWeek, lastYearByWeek }) });
});

// Enter (or clear) one past week's total. weekStart is that past week's Monday.
app.put("/api/revenue-history", requireAuth, async (req, res) => {
  const { weekStart, amount } = req.body || {};
  if (!isIsoDate(weekStart) || new Date(weekStart + "T00:00:00Z").getUTCDay() !== 1) return res.status(400).json({ error: "weekStart must be a Monday (YYYY-MM-DD)" });
  if (weekStart < "2000-01-03" || weekStart > addDaysIso(new Date().toISOString().slice(0, 10), 7)) return res.status(400).json({ error: "weekStart is out of range" });
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
    `SELECT i.id, i.kind, i.title, i.minutes, i.created_at, i.file_name, i.file_type, i.file_size, a.completed_at
       FROM training_assignments a JOIN training_items i ON i.id = a.item_id
      WHERE a.staff_id = $1 AND i.restaurant_id = $2
      ORDER BY (a.completed_at IS NOT NULL) ASC, i.created_at DESC`,
    [req.staffId, req.restaurantId]
  );
  const items = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    minutes: r.minutes,
    file: r.file_name ? { name: r.file_name, type: r.file_type, size: r.file_size, viewable: INLINE_VIEW_TYPES.test(r.file_type || "") } : null,
    done: !!r.completed_at,
  }));
  res.json({ items, todoCount: items.filter((i) => !i.done).length });
});

// Only items actually assigned to this person can be downloaded.
app.get("/api/staff-auth/training/:id/file", requireStaffAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT i.file_name, i.file_type, i.file_data FROM training_items i
       JOIN training_assignments a ON a.item_id = i.id
      WHERE i.id = $1 AND i.restaurant_id = $2 AND a.staff_id = $3`,
    [req.params.id, req.restaurantId, req.staffId]
  );
  if (rows.length === 0 || !rows[0].file_data) return res.status(404).json({ error: "no file attached" });
  const inline = req.query.view === "1" && INLINE_VIEW_TYPES.test(rows[0].file_type || "");
  res.set({
    "Content-Type": rows[0].file_type || "application/octet-stream",
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${rows[0].file_name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(rows[0].file_name)}`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox",
  });
  res.send(rows[0].file_data);
});

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
    const today = new Date();
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);
    const twoWeeksOut = new Date(today);
    twoWeeksOut.setDate(twoWeeksOut.getDate() + 14);
    const twoWeeksAgo = new Date(today);
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
    const toDate = (d) => d.toISOString().slice(0, 10);

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
        today: toDate(today),
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
    const systemPrompt = `You are a helpful operations assistant for a restaurant manager, built into their staff/scheduling/hiring app. Answer the manager's question using ONLY the restaurant data provided below — don't invent numbers or people that aren't in it. If the data doesn't cover what they're asking, say so plainly rather than guessing. Keep answers short and concrete (a few sentences), like a sharp assistant who already knows the business, not a generic chatbot. Dates are in YYYY-MM-DD format; "today" tells you the current date for relative reasoning. Reply in the language the manager writes in.

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
        max_tokens: 500,
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
    const textBlock = (aiData.content || []).find((b) => b.type === "text");
    const answer = textBlock ? textBlock.text : "I couldn't generate a response for that.";

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

// One place that talks to Anthropic for the board helpers. Throws an Error with .status for the caller to map.
async function callClaude({ system, user, maxTokens = 700 }) {
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
      system: `You help a restaurant manager write announcements for the team message board that every staff member reads on their phone. Turn the manager's rough note into a clear, friendly, direct announcement in ${langName}. Keep every fact the manager gave (dates, times, names, numbers) and do not invent any new ones. Short sentences, no emojis, no hashtags, at most ${Math.min(BOARD_BODY_MAX, 900)} characters in the body. Reply with ONLY a JSON object: {"title": "<short title, max 60 characters>", "body": "<the announcement>"}.`,
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

  const { rows: allStaff } = await pool.query("SELECT * FROM staff WHERE restaurant_id = $1", [restaurantId]);
  const pool_ = allStaff.filter((p) => !wanted || wanted.has(p.id));
  if (pool_.length === 0) throw httpError(400, "There is no staff to schedule here yet.");
  const staffById = {};
  pool_.forEach((p) => { staffById[p.id] = { name: p.name, roles: p.roles || [], rate: p.hourly_rate !== null ? Number(p.hourly_rate) : 0 }; });
  const availabilityByStaff = await loadAvailabilityMap(restaurantId, pool_.map((p) => p.id));
  const historyStart = addDaysIso(weekStart, -56); // 8 weeks of history
  const [existingRes, projRes, salesRes, pastShiftRes] = await Promise.all([
    pool.query("SELECT * FROM schedule_shifts WHERE restaurant_id = $1 AND shift_date >= $2 AND shift_date <= $3", [restaurantId, weekStart, weekEnd]),
    pool.query("SELECT * FROM sales_projections WHERE restaurant_id = $1 AND proj_date >= $2 AND proj_date <= $3", [restaurantId, weekStart, weekEnd]),
    pool.query("SELECT * FROM actual_sales WHERE restaurant_id = $1 AND sale_date >= $2 AND sale_date < $3 ORDER BY sale_date", [restaurantId, historyStart, weekStart]),
    pool.query("SELECT * FROM schedule_shifts WHERE restaurant_id = $1 AND shift_date >= $2 AND shift_date < $3", [restaurantId, historyStart, weekStart]),
  ]);
  const existing = existingRes.rows.map(scheduleShiftRowToJson);
  const plan = buildSalesPlan({
    weekStart,
    projections: projRes.rows,
    pastSales: salesRes.rows,
    pastShifts: pastShiftRes.rows.map(scheduleShiftRowToJson).filter((sh) => staffById[sh.staffId]),
    staffById,
  });

  const context = {
    week: Array.from({ length: 7 }, (_, i) => { const d = addDaysIso(weekStart, i); return { date: d, weekday: weekdayKey(d) }; }),
    staff: pool_.map((p) => ({
      id: p.id, name: p.name, roles: p.roles || [],
      hourlyRate: p.hourly_rate !== null ? Number(p.hourly_rate) : null,
      availability: Object.fromEntries(Object.entries(availabilityByStaff[p.id] || {}).map(([k, v]) => [k, { free: v.available, note: v.note || "" }])),
    })),
    alreadyScheduledThisWeek: existing.filter((e) => staffById[e.staffId]).map((e) => ({ staffId: e.staffId, date: e.date, start: e.startTime, end: e.endTime, role: e.role })),
    salesPlan: plan.salesPlan,
    staffingBenchmarks: plan.benchmarks,
  };

  const system = `You build weekly shift schedules for a restaurant manager. Follow the manager's request exactly, using ONLY the staff and dates in the data.
Rules:
- Use each person's id exactly as given. Never invent staff.
- A staff member's "role" must be one of their listed roles.
- Never schedule someone on a weekday where their availability free is false. Respect availability notes (e.g. "after 5pm") as best you can.
- Do not duplicate or overlap shifts in "alreadyScheduledThisWeek"; fill around them.
- One shift per person per day unless asked otherwise. Keep shifts between 3 and 12 hours. Avoid more than 40 hours a week per person unless asked.
- Size crews to expected sales. "salesPlan" gives each day's expected sales (the manager's projection when set, otherwise that weekday's recent average) with the food / beverage split. Busier days get more people; food sales drive the kitchen and beverage sales drive bartenders and bussers. When "staffingBenchmarks.suggestedLaborHours" is present, aim for each day's total shift hours to land near that number (and mention it in the summary). Headcounts or hours the manager states explicitly always win over these suggestions. If there is no sales data, spread staff evenly and say that in the summary.
- Times are 24-hour "HH:MM". Dates are YYYY-MM-DD and must fall inside the week.
- If the request can't be fully met (not enough staff, conflicts), schedule what you can and say so briefly in "summary".
Reply with ONLY a JSON object: {"summary":"<one or two sentences, in ${LANG_NAMES[lang] || "English"}>","shifts":[{"staffId":"","date":"","startTime":"","endTime":"","role":""}]}.

DATA:
${JSON.stringify(context)}`;

  const { text, durationMs } = await callClaude({ system, user: prompt, maxTokens: 6000 });
  const parsed = extractJsonObject(text);
  if (!parsed || !Array.isArray(parsed.shifts)) {
    logActivity({ restaurantId, eventType: "ai_failed", level: "error", detail: "schedule: unparseable reply", durationMs });
    throw httpError(502, "The AI agent couldn't build that schedule — try rephrasing.");
  }
  const candidates = parsed.shifts.slice(0, SCHEDULE_BULK_MAX).map((c) => ({
    staffId: c && c.staffId, date: c && c.date, startTime: c && c.startTime, endTime: c && c.endTime, role: c && c.role,
  }));
  const { ok, skipped } = checkScheduleCandidates(candidates, { staffById, existing, availabilityByStaff, windowStart: weekStart, windowEnd: weekEnd });
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
  if (setupKey !== PLATFORM_SETUP_KEY) return res.status(403).json({ error: "Invalid setup key" });
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

app.post("/api/platform-auth/login", loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email and password are required" });

  const { rows } = await pool.query("SELECT * FROM platform_admins WHERE email = $1", [email.toLowerCase()]);
  const admin = rows[0];
  if (!admin) return res.status(401).json({ error: "incorrect email or password" });

  const valid = await bcrypt.compare(password, admin.password_hash);
  if (!valid) return res.status(401).json({ error: "incorrect email or password" });

  const token = signToken({ platformAdminId: admin.id });
  res.cookie("platform_token", token, COOKIE_OPTS);
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
      r.id, r.name, r.created_at, r.twilio_phone_number,
      (SELECT COUNT(*) FROM staff s WHERE s.restaurant_id = r.id) AS staff_count,
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
    staffCount: Number(r.staff_count),
    shiftCount: Number(r.shift_count),
    openShiftCount: Number(r.open_shift_count),
    openPostingCount: Number(r.open_posting_count),
    lastActivityAt: r.last_activity_at ? Number(r.last_activity_at) : null,
    activityLast7d: Number(r.activity_last_7d),
  })));
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

app.get("/api/platform/activity", requirePlatformAuth, async (req, res) => {
  const { restaurantId, eventType, level, limit = 100 } = req.query;
  const conditions = [];
  const params = [];
  if (restaurantId) { params.push(restaurantId); conditions.push(`a.restaurant_id = $${params.length}`); }
  if (eventType) { params.push(eventType); conditions.push(`a.event_type = $${params.length}`); }
  if (level) { params.push(level); conditions.push(`a.level = $${params.length}`); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(Math.min(Number(limit) || 100, 500));

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

app.get("/api/platform/health", requirePlatformAuth, async (req, res) => {
  const dbStart = Date.now();
  let dbOk = true;
  try {
    await pool.query("SELECT 1");
  } catch (e) {
    dbOk = false;
  }
  const dbLatencyMs = Date.now() - dbStart;

  const sinceHour = Date.now() - 60 * 60 * 1000;
  const [smsStats, aiStats, failureCounts] = await Promise.all([
    pool.query("SELECT COUNT(*) FILTER (WHERE event_type = 'sms_sent') AS sent, COUNT(*) FILTER (WHERE event_type = 'sms_failed') AS failed, AVG(duration_ms) FILTER (WHERE event_type = 'sms_sent') AS avg_ms FROM activity_log WHERE created_at > $1 AND event_type IN ('sms_sent','sms_failed')", [sinceHour]),
    pool.query("SELECT COUNT(*) FILTER (WHERE event_type = 'ai_answered') AS answered, COUNT(*) FILTER (WHERE event_type = 'ai_failed') AS failed, AVG(duration_ms) FILTER (WHERE event_type = 'ai_answered') AS avg_ms FROM activity_log WHERE created_at > $1 AND event_type IN ('ai_answered','ai_failed')", [sinceHour]),
    pool.query("SELECT event_type, COUNT(*) AS count FROM activity_log WHERE level = 'error' AND created_at > $1 GROUP BY event_type ORDER BY count DESC", [sinceHour]),
  ]);

  res.json({
    database: { ok: dbOk, latencyMs: dbLatencyMs },
    sms: {
      sentLastHour: Number(smsStats.rows[0].sent || 0),
      failedLastHour: Number(smsStats.rows[0].failed || 0),
      avgLatencyMs: smsStats.rows[0].avg_ms ? Math.round(Number(smsStats.rows[0].avg_ms)) : null,
    },
    ai: {
      answeredLastHour: Number(aiStats.rows[0].answered || 0),
      failedLastHour: Number(aiStats.rows[0].failed || 0),
      avgLatencyMs: aiStats.rows[0].avg_ms ? Math.round(Number(aiStats.rows[0].avg_ms)) : null,
    },
    errorsLastHour: failureCounts.rows.map((r) => ({ eventType: r.event_type, count: Number(r.count) })),
  });
});

// ---------- health check ----------

app.get("/api/health", async (req, res) => {
  const restaurantCount = await pool.query("SELECT COUNT(*) FROM restaurants");
  res.json({ ok: true, database: "connected", restaurants: Number(restaurantCount.rows[0].count) });
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

module.exports = { app, pool, initDb };
