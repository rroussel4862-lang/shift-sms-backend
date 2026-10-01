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

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  DATABASE_URL,
  JWT_SECRET,
  ANTHROPIC_API_KEY,
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
}

// ---------- helpers ----------

function id() {
  return crypto.randomBytes(6).toString("hex");
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
async function sendSms(to, body) {
  try {
    await smsClient.messages.create({ to, from: TWILIO_PHONE_NUMBER, body });
    return { to, ok: true };
  } catch (e) {
    console.error(`SMS to ${to} failed:`, e.message);
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
  secure: true,
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

// ---------- app setup ----------

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

const allowedOrigins = ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : true, credentials: true }));

app.use(express.static(path.join(__dirname, "public")));

// ---------- auth endpoints ----------

app.post("/api/auth/signup", async (req, res) => {
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
  res.status(201).json({ restaurant: { id: restaurantId, name: restaurantName.trim() }, email: email.toLowerCase() });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email and password are required" });

  const { rows } = await pool.query(
    `SELECT users.*, restaurants.name AS restaurant_name, restaurants.address AS restaurant_address FROM users
     JOIN restaurants ON restaurants.id = users.restaurant_id
     WHERE users.email = $1`,
    [email.toLowerCase()]
  );
  const user = rows[0];
  if (!user) return res.status(401).json({ error: "incorrect email or password" });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: "incorrect email or password" });

  const token = signToken({ userId: user.id, restaurantId: user.restaurant_id });
  res.cookie("token", token, COOKIE_OPTS);
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
  await pool.query("UPDATE staff SET claim_token = $1 WHERE id = $2", [token, staffer.id]);

  const restaurantRows = await pool.query("SELECT name FROM restaurants WHERE id = $1", [req.restaurantId]);
  const restaurantName = restaurantRows.rows[0] ? restaurantRows.rows[0].name : "your restaurant";
  const baseUrl = PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
  const link = `${baseUrl}/staff-claim.html?token=${token}`;
  const text = `Hi ${staffer.name.split(" ")[0]} — set up your ${restaurantName} staff login here: ${link}`;

  const result = await sendSms(staffer.phone, text);
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
  const text = [
    `Open shift: ${shift.role}${shift.time ? ` — ${shift.time}` : ""}.`,
    shift.note ? shift.note : null,
    `Can cover it? Reply YES ${code} to claim.`,
  ].filter(Boolean).join(" ");

  const { rows: recipientRows } = await pool.query(
    `SELECT * FROM staff WHERE restaurant_id = $1
     AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(roles) r WHERE lower(r) = lower($2))`,
    [req.restaurantId, shift.role]
  );
  const recipients = recipientRows.map(staffRowToJson);
  const results = await Promise.all(recipients.map((s) => sendSms(s.phone, text)));
  const sent = results.filter((r) => r.ok).length;

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

  const confirmText = `You're confirmed: ${updated.role}${updated.time ? ` — ${updated.time}` : ""}. Thanks for covering!`;
  const filledText = `Heads up — the ${updated.role}${updated.time ? ` (${updated.time})` : ""} shift has been covered. Thanks for responding!`;

  const others = shift.responders.filter((r) => r.staffId !== staffId);
  await sendSms(winner.phone, confirmText);
  await Promise.all(others.map((r) => allStaff.find((s) => s.id === r.staffId)).filter(Boolean).map((s) => sendSms(s.phone, filledText)));

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
  const body = (req.body.Body || "").trim();
  const twiml = new twilio.twiml.MessagingResponse();

  const { rows: staffRows } = await pool.query("SELECT * FROM staff WHERE phone = $1 LIMIT 1", [from]);
  const staffer = staffRows[0] ? staffRowToJson(staffRows[0]) : null;
  const restaurantId = staffRows[0] ? staffRows[0].restaurant_id : null;

  if (!staffer) {
    twiml.message("This number isn't on any staff list — ask your manager to add you.");
    res.type("text/xml").send(twiml.toString());
    return;
  }

  const match = body.match(/YES\s*([A-Z0-9]{4})/i);
  if (!match) {
    twiml.message('To claim an open shift, reply "YES" followed by the 4-character code from the shift text.');
    res.type("text/xml").send(twiml.toString());
    return;
  }

  const code = match[1].toUpperCase();
  const { rows: openShiftRows } = await pool.query("SELECT * FROM shifts WHERE restaurant_id = $1 AND status = 'open'", [restaurantId]);
  const shiftRow = openShiftRows.find((r) => shortCode(r.id) === code);

  if (!shiftRow) {
    twiml.message("That shift's already filled or the code doesn't match an open shift. Sorry!");
    res.type("text/xml").send(twiml.toString());
    return;
  }

  const shift = shiftRowToJson(shiftRow);
  const already = shift.responders.some((r) => r.staffId === staffer.id);
  if (!already) {
    const responders = [...shift.responders, { staffId: staffer.id, name: staffer.name, ts: Date.now() }];
    await pool.query("UPDATE shifts SET responders = $1 WHERE id = $2", [JSON.stringify(responders), shift.id]);
  }

  twiml.message(`Got it, ${staffer.name.split(" ")[0]} — you're down for ${shift.role}. Your manager will confirm shortly.`);
  res.type("text/xml").send(twiml.toString());
});

// ---------- staff portal: account setup & login (public) ----------

app.get("/api/staff-auth/claim/:token", async (req, res) => {
  const { rows } = await pool.query("SELECT staff.*, restaurants.name AS restaurant_name FROM staff JOIN restaurants ON restaurants.id = staff.restaurant_id WHERE staff.claim_token = $1", [req.params.token]);
  if (rows.length === 0) return res.status(404).json({ error: "This setup link isn't valid — ask your manager to send a new one." });
  res.json({ name: rows[0].name, restaurantName: rows[0].restaurant_name });
});

app.post("/api/staff-auth/claim", async (req, res) => {
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
  res.status(201).json({ name: staffer.name });
});

app.post("/api/staff-auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email and password are required" });

  const { rows } = await pool.query("SELECT * FROM staff WHERE email = $1", [email.toLowerCase()]);
  const staffer = rows[0];
  if (!staffer || !staffer.password_hash) return res.status(401).json({ error: "incorrect email or password" });

  const valid = await bcrypt.compare(password, staffer.password_hash);
  if (!valid) return res.status(401).json({ error: "incorrect email or password" });

  const sessionToken = signToken({ staffId: staffer.id, restaurantId: staffer.restaurant_id });
  res.cookie("staff_token", sessionToken, COOKIE_OPTS);
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
      const text = `Hi ${updated.name.split(" ")[0]}, your interview for ${postingTitle} at ${restaurantName} is scheduled: ${updated.interviewTime}. Reply if you have any questions.`;
      const result = await sendSms(updated.phone, text);
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

// ---------- AI agent (Communications) ----------

app.post("/api/ai/ask", requireAuth, async (req, res) => {
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
    const toDate = (d) => d.toISOString().slice(0, 10);

    const [staffRows, openShiftRows, scheduleRows, postingRows, appRows, projRows] = await Promise.all([
      pool.query("SELECT * FROM staff WHERE restaurant_id = $1", [req.restaurantId]),
      pool.query("SELECT * FROM shifts WHERE restaurant_id = $1 AND status = 'open'", [req.restaurantId]),
      pool.query("SELECT * FROM schedule_shifts WHERE restaurant_id = $1 AND shift_date >= $2 AND shift_date <= $3", [req.restaurantId, toDate(weekAgo), toDate(twoWeeksOut)]),
      pool.query("SELECT * FROM job_postings WHERE restaurant_id = $1 AND status = 'open'", [req.restaurantId]),
      pool.query("SELECT a.*, p.title AS posting_title FROM applications a JOIN job_postings p ON p.id = a.posting_id WHERE a.restaurant_id = $1 ORDER BY a.created_at DESC LIMIT 25", [req.restaurantId]),
      pool.query("SELECT * FROM sales_projections WHERE restaurant_id = $1 AND proj_date >= $2 AND proj_date <= $3", [req.restaurantId, toDate(weekAgo), toDate(twoWeeksOut)]),
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

    const contextBlock = JSON.stringify(
      {
        today: toDate(today),
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

    const systemPrompt = `You are a helpful operations assistant for a restaurant manager, built into their staff/scheduling/hiring app. Answer the manager's question using ONLY the restaurant data provided below — don't invent numbers or people that aren't in it. If the data doesn't cover what they're asking, say so plainly rather than guessing. Keep answers short and concrete (a few sentences), like a sharp assistant who already knows the business, not a generic chatbot. Dates are in YYYY-MM-DD format; "today" tells you the current date for relative reasoning.\n\nRESTAURANT DATA:\n${contextBlock}`;

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 500,
        system: systemPrompt,
        messages: [{ role: "user", content: question.trim() }],
      }),
    });

    if (!aiRes.ok) {
      const errBody = await aiRes.text();
      console.error("Anthropic API error:", aiRes.status, errBody);
      return res.status(502).json({ error: "The AI agent couldn't respond right now — try again shortly." });
    }

    const aiData = await aiRes.json();
    const textBlock = (aiData.content || []).find((b) => b.type === "text");
    const answer = textBlock ? textBlock.text : "I couldn't generate a response for that.";

    res.json({ answer });
  } catch (e) {
    console.error("AI agent error:", e.message);
    res.status(500).json({ error: "Something went wrong answering that question." });
  }
});

// ---------- health check ----------

app.get("/api/health", async (req, res) => {
  const restaurantCount = await pool.query("SELECT COUNT(*) FROM restaurants");
  res.json({ ok: true, database: "connected", restaurants: Number(restaurantCount.rows[0].count) });
});

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
