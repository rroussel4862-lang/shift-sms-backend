// Shift SMS backend
// -------------------
// Real outbound + inbound SMS for the Open Shift Rail app.
//
// What it does:
//   - Manager posts a shift  -> every staff member gets a text immediately.
//   - Staff reply "YES 4F2A" -> they're recorded as available for that shift.
//   - Manager assigns a shift -> the winner gets a confirmation text,
//                                everyone else who replied gets a "covered" text.
//
// Data is stored in a local JSON file (data.json) for simplicity. That's fine
// for a single small restaurant getting started, but most hosting platforms
// wipe the local disk on every redeploy — see README.md "Going to production"
// before you rely on this for real service.

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const twilio = require("twilio");

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
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

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const DATA_FILE = path.join(__dirname, "data.json");

// ---------- tiny JSON-file "database" ----------

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    return { staff: [], shifts: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (e) {
    console.error("data.json was unreadable, starting fresh:", e.message);
    return { staff: [], shifts: [] };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

let db = loadData();

// ---------- helpers ----------

function id() {
  return crypto.randomBytes(6).toString("hex");
}

function shortCode(shiftId) {
  return shiftId.slice(0, 4).toUpperCase();
}

// Accepts things like "+15551234567", "15551234567", "(555) 123-4567"
// Normalizes to E.164 assuming US/Canada if no country code is given.
// For a multi-country restaurant, have staff enter numbers with a leading "+".
function normalizePhone(raw) {
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null; // couldn't confidently normalize
}

async function sendSms(to, body) {
  try {
    await client.messages.create({ to, from: TWILIO_PHONE_NUMBER, body });
    return { to, ok: true };
  } catch (e) {
    console.error(`SMS to ${to} failed:`, e.message);
    return { to, ok: false, error: e.message };
  }
}

// ---------- app setup ----------

const app = express();
app.use(express.json());
// Twilio's inbound webhook posts form-urlencoded data, not JSON
app.use(express.urlencoded({ extended: false }));

const allowedOrigins = ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
app.use(
  cors({
    origin: allowedOrigins.length ? allowedOrigins : true,
  })
);

// Manager admin page — visiting the site root shows public/index.html
app.use(express.static(path.join(__dirname, "public")));

// ---------- staff endpoints ----------

app.get("/api/staff", (req, res) => {
  res.json(db.staff);
});

app.post("/api/staff", (req, res) => {
  const { name, phone, roles } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "name is required" });
  const roleList = Array.isArray(roles) ? roles.map((r) => String(r).trim()).filter(Boolean) : [];
  const normalized = normalizePhone(phone || "");
  if (!normalized) {
    return res.status(400).json({ error: "phone is missing or not recognizable — include country code if outside the US, e.g. +44..." });
  }
  const staffer = { id: id(), name: name.trim(), phone: normalized, roles: roleList };
  db.staff.push(staffer);
  saveData(db);
  res.status(201).json(staffer);
});

app.delete("/api/staff/:id", (req, res) => {
  db.staff = db.staff.filter((s) => s.id !== req.params.id);
  saveData(db);
  res.status(204).end();
});

// ---------- shift endpoints ----------

app.get("/api/shifts", (req, res) => {
  res.json(db.shifts);
});

app.post("/api/shifts", async (req, res) => {
  const { role, time, note } = req.body || {};
  if (!role || !role.trim()) return res.status(400).json({ error: "role is required" });

  const shift = {
    id: id(),
    role: role.trim(),
    time: (time || "").trim(),
    note: (note || "").trim(),
    status: "open",
    postedAt: Date.now(),
    responders: [],
    assignedTo: null,
  };
  db.shifts.unshift(shift);
  saveData(db);

  const code = shortCode(shift.id);
  const text = [
    `Open shift: ${shift.role}${shift.time ? ` — ${shift.time}` : ""}.`,
    shift.note ? shift.note : null,
    `Can cover it? Reply YES ${code} to claim.`,
  ]
    .filter(Boolean)
    .join(" ");

  const recipients = db.staff.filter(
    (s) =>
      Array.isArray(s.roles) &&
      s.roles.some((r) => r.trim().toLowerCase() === shift.role.trim().toLowerCase())
  );

  const results = await Promise.all(recipients.map((s) => sendSms(s.phone, text)));
  const sent = results.filter((r) => r.ok).length;

  res.status(201).json({ shift, sms: { sent, total: recipients.length, failures: results.filter((r) => !r.ok) } });
});

app.post("/api/shifts/:id/respond", (req, res) => {
  const { staffId } = req.body || {};
  const shift = db.shifts.find((s) => s.id === req.params.id);
  if (!shift) return res.status(404).json({ error: "shift not found" });
  const staffer = db.staff.find((s) => s.id === staffId);
  if (!staffer) return res.status(404).json({ error: "staff not found" });
  if (shift.status !== "open") return res.status(400).json({ error: "shift is not open" });

  const already = shift.responders.some((r) => r.staffId === staffId);
  if (!already) {
    shift.responders.push({ staffId, name: staffer.name, ts: Date.now() });
    saveData(db);
  }
  res.json(shift);
});

app.post("/api/shifts/:id/assign", async (req, res) => {
  const { staffId } = req.body || {};
  const shift = db.shifts.find((s) => s.id === req.params.id);
  if (!shift) return res.status(404).json({ error: "shift not found" });
  const winner = db.staff.find((s) => s.id === staffId);
  if (!winner) return res.status(404).json({ error: "staff not found" });

  shift.status = "filled";
  shift.assignedTo = staffId;
  shift.filledAt = Date.now();
  saveData(db);

  const confirmText = `You're confirmed: ${shift.role}${shift.time ? ` — ${shift.time}` : ""}. Thanks for covering!`;
  const filledText = `Heads up — the ${shift.role}${shift.time ? ` (${shift.time})` : ""} shift has been covered. Thanks for responding!`;

  const others = shift.responders.filter((r) => r.staffId !== staffId);
  await sendSms(winner.phone, confirmText);
  await Promise.all(
    others
      .map((r) => db.staff.find((s) => s.id === r.staffId))
      .filter(Boolean)
      .map((s) => sendSms(s.phone, filledText))
  );

  res.json(shift);
});

app.delete("/api/shifts/:id", (req, res) => {
  db.shifts = db.shifts.filter((s) => s.id !== req.params.id);
  saveData(db);
  res.status(204).end();
});

// ---------- inbound SMS webhook ----------
// Point your Twilio number's "A MESSAGE COMES IN" webhook at:
//   POST https://<your-deployed-url>/api/sms/inbound

app.post("/api/sms/inbound", (req, res) => {
  const from = req.body.From;
  const body = (req.body.Body || "").trim();
  const twiml = new twilio.twiml.MessagingResponse();

  const staffer = db.staff.find((s) => s.phone === from);
  if (!staffer) {
    twiml.message("This number isn't on the staff list — ask your manager to add you.");
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
  const shift = db.shifts.find((s) => shortCode(s.id) === code && s.status === "open");
  if (!shift) {
    twiml.message("That shift's already filled or the code doesn't match an open shift. Sorry!");
    res.type("text/xml").send(twiml.toString());
    return;
  }

  const already = shift.responders.some((r) => r.staffId === staffer.id);
  if (!already) {
    shift.responders.push({ staffId: staffer.id, name: staffer.name, ts: Date.now() });
    saveData(db);
  }
  twiml.message(`Got it, ${staffer.name.split(" ")[0]} — you're down for ${shift.role}. Your manager will confirm shortly.`);
  res.type("text/xml").send(twiml.toString());
});

// ---------- health check ----------

app.get("/api/health", (req, res) => {
  res.json({ ok: true, staff: db.staff.length, shifts: db.shifts.length });
});

app.listen(PORT, () => {
  console.log(`Shift SMS backend running on port ${PORT}`);
  if (PUBLIC_URL) {
    console.log(`Set your Twilio number's inbound webhook to: ${PUBLIC_URL}/api/sms/inbound`);
  } else {
    console.log(`Once deployed, set your Twilio number's inbound webhook to: <your-url>/api/sms/inbound`);
  }
});
