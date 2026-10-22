// The demo restaurant: a made-up, bilingual restaurant that is safe to show to prospects.
// It lives in the same database as real restaurants but is flagged (restaurants.is_demo), never sends real texts,
// and is rebuilt from scratch every night (and on demand from the platform dashboard).
// Nothing in here comes from a real restaurant or a real person.

const crypto = require("crypto");
const bcrypt = require("bcryptjs");

const DEMO_RESTAURANT_ID = "demo-restaurant";
const DEMO_USER_ID = "demo-user";
const DEMO_MANAGER_EMAIL = "demo-manager@demo.invalid";
const DEMO_STAFF_VIEW_ID = "demo-s01"; // Camille: the server a prospect "becomes" in the staff view

// key, name, roles (the first role is the main one), hourly rate
const ROSTER = [
  ["s01", "Camille Tremblay", ["Server"], 15.5],
  ["s02", "Mathieu Gagnon", ["Server"], 15.5],
  ["s03", "Léa Bouchard", ["Server"], 15.5],
  ["s04", "Olivier Roy", ["Server"], 15.5],
  ["s05", "Maya Singh", ["Server"], 15.5],
  ["s06", "Julien Côté", ["Server"], 15.5],
  ["s07", "Sarah Cohen", ["Bartender"], 17],
  ["s08", "Nicolas Lavoie", ["Bartender"], 17],
  ["s09", "Émilie Pelletier", ["Host"], 16],
  ["s10", "Antoine Fortin", ["Busser"], 15],
  ["s11", "Zoé Lapointe", ["Busser"], 15],
  ["s12", "Isabelle Martin", ["Manager"], 27],
  ["s13", "Marc-André Leblanc", ["Manager"], 27],
  ["s14", "Luc Demers", ["Manager", "Line Cook"], 31],
  ["s15", "Karim Haddad", ["Line Cook"], 20],
  ["s16", "Sophie Lemieux", ["Line Cook"], 20],
  ["s17", "Vincent Morin", ["Line Cook"], 19],
  ["s18", "Yan Chen", ["Prep Cook"], 17.5],
  ["s19", "Rosa Alvarez", ["Dishwasher"], 16],
  ["s20", "Théo Girard", ["Dishwasher"], 16],
  ["s21", "Nadia Benali", ["Expo"], 18],
  ["s22", "Mélanie Tardif", ["Line Cook"], 19],
];

const sid = (key) => "demo-" + key;
const rid = () => crypto.randomBytes(6).toString("hex");

// A stable pseudo-random number between 0 and 1 for a text key, so the same day always gets the same figures.
function noise(text) {
  const h = crypto.createHash("md5").update(text).digest();
  return h.readUInt16BE(0) / 65535;
}

const WEEKDAY_BASE = {
  // Mon..Sun: [lunch/brunch, dinner]
  0: [1300, 3600], 1: [1450, 4100], 2: [1700, 4700], 3: [1900, 6000], 4: [2300, 9300], 5: [3300, 11400], 6: [3100, 7200],
};

function buildSchedule(weekMonday, wk, addDaysIso) {
  const shifts = []; // { key, staff, date, start, end, role, station }
  const add = (staff, date, start, end, role, station = null) => shifts.push({ key: staff + "|" + date + "|" + start, staff, date, start, end, role, station });
  const servers = ["s01", "s02", "s03", "s04", "s05", "s06"];
  const cooks = ["s15", "s16", "s17", "s22"];
  const stations = ["Grill", "Fryer and Pans", "Garde-Manger"];
  for (let d = 0; d < 7; d++) {
    const date = addDaysIso(weekMonday, d);
    const weekend = d >= 5, busy = d === 4 || d === 5;
    const r = (d + wk + 6) % 6; // rotation for servers, kept positive
    const dinnerServers = busy || d === 6 ? 5 : 3;
    for (let k = 0; k < dinnerServers; k++) add(servers[(r + k) % 6], date, "17:00", "23:00", "Server");
    const lunchServers = weekend ? [servers[(r + 5) % 6], servers[r % 6]] : [servers[(r + 3) % 6], servers[(r + 4) % 6]].slice(0, 2);
    lunchServers.forEach((s) => add(s, date, weekend ? "10:00" : "11:00", "16:00", "Server"));
    if (busy || d === 6) { add("s07", date, "16:30", "23:30", "Bartender"); add("s08", date, "16:30", "23:30", "Bartender"); }
    else add((d + wk) % 2 ? "s07" : "s08", date, "16:30", "23:00", "Bartender");
    if (weekend) add((d + wk) % 2 ? "s08" : "s07", date, "10:00", "16:00", "Bartender");
    if (d >= 2) add("s09", date, "16:30", "23:00", "Host");
    if (weekend) add("s09", addDaysIso(weekMonday, d), "10:00", "15:00", "Host");
    if (d >= 3) add((d + wk) % 2 ? "s10" : "s11", date, "17:00", "23:00", "Busser");
    if (weekend) add("s11", date, "10:00", "15:00", "Busser");
    // managers
    add([0, 1, 2, 6].includes(d) ? "s12" : "s13", date, "15:30", "23:30", "Manager");
    if (d >= 1 && d <= 5) add("s14", date, "09:00", "18:00", "Manager");
    // kitchen
    const c = (d + wk + 8) % 4;
    const lunchCooks = weekend ? [cooks[c]] : [cooks[c], cooks[(c + 1) % 4]];
    lunchCooks.forEach((p, i) => add(p, date, "10:00", "16:00", "Line Cook", i === 0 ? "Grill" : "Garde-Manger"));
    const dinnerCooks = weekend ? [cooks[(c + 1) % 4], cooks[(c + 2) % 4], cooks[(c + 3) % 4]] : [cooks[(c + 2) % 4], cooks[(c + 3) % 4]];
    dinnerCooks.forEach((p, i) => add(p, date, "15:30", "23:00", "Line Cook", stations[i % 3]));
    add("s18", date, "09:00", "15:00", "Prep Cook");
    add("s19", date, "10:00", "16:00", "Dishwasher", "Dishwasher");
    add("s20", date, "16:00", "23:00", "Dishwasher", "Dishwasher");
    if (d >= 3 || d === 0) add("s21", date, "16:30", "23:00", "Expo");
  }
  return shifts;
}

// Seed (or re-seed) the demo restaurant. Safe to call at any time: everything under the demo restaurant is replaced,
// the restaurant row and the demo manager keep their ids so open demo sessions keep working.
async function seedDemo(pool, { today, addDaysIso, mondayOfIso }) {
  const client = await pool.connect();
  const now = Date.now();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO restaurants (id, name, created_at, address, is_demo) VALUES ($1,$2,$3,$4,true)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, address = EXCLUDED.address, is_demo = true, services = NULL`,
      [DEMO_RESTAURANT_ID, "Bistro Démo", now, "Place Jacques-Cartier, Montréal, QC"]
    );
    await client.query(
      `UPDATE restaurants SET geo_lat = 45.5074, geo_lon = -73.5538, geo_for = address, geo_place = 'Vieux-Montréal',
              food_cost_pct = 31, bev_cost_pct = 24, demo_seeded_on = $2 WHERE id = $1`,
      [DEMO_RESTAURANT_ID, today]
    );
    // wipe everything the demo restaurant owns (staff takes availability, time off, swaps, acks and assignments with it)
    for (const t of ["staff", "schedule_shifts", "schedule_published", "shifts", "job_postings", "training_items", "board_posts",
                     "actual_sales", "sales_projections", "weekly_sales_history", "day_context", "schedule_snapshots"]) {
      await client.query(`DELETE FROM ${t} WHERE restaurant_id = $1`, [DEMO_RESTAURANT_ID]);
    }
    // nobody knows these passwords: the demo is entered through the demo page, never by typing a login
    const unknownHash = bcrypt.hashSync(crypto.randomBytes(24).toString("hex"), 4);
    await client.query(
      `INSERT INTO users (id, restaurant_id, email, password_hash, created_at, name) VALUES ($1,$2,$3,$4,$5,'Isabelle')
       ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash, name = 'Isabelle'`,
      [DEMO_USER_ID, DEMO_RESTAURANT_ID, DEMO_MANAGER_EMAIL, unknownHash, now]
    );
    await client.query(
      `INSERT INTO tour_progress (subject, tour, status, step, updated_at) VALUES ($1,'manager','done',0,$2) ON CONFLICT (subject, tour) DO UPDATE SET status='done'`,
      ["user:" + DEMO_USER_ID, now]
    );

    // ----- staff -----
    for (let i = 0; i < ROSTER.length; i++) {
      const [key, name, roles, rate] = ROSTER[i];
      const hired = addDaysIso(today, -(120 + i * 37));
      await client.query(
        `INSERT INTO staff (id, restaurant_id, name, phone, roles, hourly_rate, hire_date, email, password_hash) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)`,
        [sid(key), DEMO_RESTAURANT_ID, name, "+15550100" + String(10 + i), JSON.stringify(roles), rate, hired, `demo-${key}@demo.invalid`, unknownHash]
      );
      await client.query(
        `INSERT INTO tour_progress (subject, tour, status, step, updated_at) VALUES ($1,'staff','done',0,$2) ON CONFLICT (subject, tour) DO UPDATE SET status='done'`,
        ["staff:" + sid(key), now]
      );
    }

    // ----- schedule: last week, this week and next week are posted; the week after is still a draft -----
    const monday = mondayOfIso(today);
    const weeks = [-1, 0, 1, 2];
    let all = [];
    weeks.forEach((w) => { buildSchedule(addDaysIso(monday, w * 7), w + 5, addDaysIso).forEach((s) => all.push({ ...s, week: w })); });

    // swap tickets, chosen among upcoming shifts that don't clash
    const upcoming = (staffKey, minDate) => all.filter((s) => s.staff === staffKey && s.week >= 0 && s.week <= 1 && s.date > minDate && s.role === "Server" && s.start === "17:00").sort((a, b) => a.date.localeCompare(b.date));
    const hasShiftOn = (staffKey, date) => all.some((s) => s.staff === staffKey && s.date === date);
    const tomorrow = addDaysIso(today, 1);
    const pick = (staffKey, skip = 0, minDate = tomorrow) => upcoming(staffKey, minDate)[skip];
    const swaps = [];
    const SERVERS = ["s01", "s02", "s03", "s04", "s05", "s06"];
    const freeServer = (date, notThese) => SERVERS.find((k) => !notThese.includes(k) && !hasShiftOn(k, date));
    const used = new Set();
    const firstFor = (staffKey, skip = 0, needsTaker = false) => upcoming(staffKey, tomorrow).filter((x) => !used.has(x.key) && (!needsTaker || freeServer(x.date, [staffKey])))[skip];
    const openGive = firstFor("s02");
    if (openGive) { used.add(openGive.key); swaps.push({ shift: openGive, from: "s02", kind: "give", status: "open", note: "Family dinner, can anyone take it? / Souper de famille, quelqu'un peut le prendre?" }); }
    const pendGive = firstFor("s01", 0, true);
    if (pendGive) {
      used.add(pendGive.key);
      swaps.push({ shift: pendGive, from: "s01", kind: "give", status: "pending", to: freeServer(pendGive.date, ["s01"]), note: "", acceptedAgo: 45 * 60 * 1000 });
    }
    // a swap pair: Léa's shift for Olivier's, on two different days where each is free on the other's day
    let swapA = null, swapB = null;
    for (const x of upcoming("s03", tomorrow)) {
      const y = upcoming("s04", tomorrow).find((z) => z.date !== x.date && !hasShiftOn("s03", z.date) && !hasShiftOn("s04", x.date));
      if (y) { swapA = x; swapB = y; break; }
    }
    if (swapA && swapB) { used.add(swapA.key); used.add(swapB.key); swaps.push({ shift: swapA, from: "s03", kind: "swap", status: "pending", to: "s04", swapShift: swapB, note: "", acceptedAgo: 3 * 3600 * 1000 }); }
    const apprShift = upcoming("s06", tomorrow).find((x) => !used.has(x.key) && freeServer(x.date, ["s06"]) && (!pendGive || x.date !== pendGive.date));
    if (apprShift) {
      used.add(apprShift.key);
      const taker = freeServer(apprShift.date, ["s06"]);
      swaps.push({ shift: apprShift, from: "s06", kind: "give", status: "approved", to: taker, note: "", acceptedAgo: 30 * 3600 * 1000, resolvedAgo: 26 * 3600 * 1000 });
      apprShift.staff = taker; // an approved give-away has moved the shift to its new owner
      apprShift.key = taker + "|" + apprShift.date + "|" + apprShift.start;
    }
    const deniedShift = firstFor("s04", 0, true);
    if (deniedShift) {
      used.add(deniedShift.key);
      swaps.push({ shift: deniedShift, from: "s04", kind: "give", status: "denied", to: freeServer(deniedShift.date, ["s04"]), note: "", acceptedAgo: 50 * 3600 * 1000, resolvedAgo: 48 * 3600 * 1000 });
    }

    all.forEach((s) => { s.id = rid(); });
    const byKey = new Map(all.map((s) => [s.key, s]));
    const toRow = (s) => byKey.get(s.key) || s;
    await client.query(
      `INSERT INTO schedule_shifts (id, restaurant_id, staff_id, shift_date, start_time, end_time, role, created_at, station)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::date[], $5::text[], $6::text[], $7::text[], $8::bigint[], $9::text[])`,
      [all.map((s) => s.id), all.map(() => DEMO_RESTAURANT_ID), all.map((s) => sid(s.staff)), all.map((s) => s.date), all.map((s) => s.start), all.map((s) => s.end), all.map((s) => s.role), all.map(() => now), all.map((s) => s.station)]
    );
    for (const w of [-1, 0, 1]) {
      for (const house of ["foh", "boh"]) {
        await client.query("INSERT INTO schedule_published (restaurant_id, week_start, published_at, house) VALUES ($1,$2,$3,$4)", [DEMO_RESTAURANT_ID, addDaysIso(monday, w * 7), now - 86400000 * (w === 1 ? 1 : 3), house]);
      }
    }
    for (const sw of swaps) {
      const base = toRow(sw.shift);
      await client.query(
        `INSERT INTO shift_swaps (id, restaurant_id, shift_id, from_staff_id, kind, note, status, to_staff_id, swap_shift_id, created_at, accepted_at, resolved_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [rid(), DEMO_RESTAURANT_ID, base.id, sid(sw.from), sw.kind, sw.note || null, sw.status, sw.to ? sid(sw.to) : null, sw.swapShift ? toRow(sw.swapShift).id : null,
         now - (sw.acceptedAgo || 0) - 3600000, sw.acceptedAgo ? now - sw.acceptedAgo : null, sw.resolvedAgo ? now - sw.resolvedAgo : null]
      );
    }

    // ----- requests waiting for the manager -----
    const nextThu = addDaysIso(monday, 10), nextSat = addDaysIso(monday, 12);
    await client.query("INSERT INTO staff_time_off (id, restaurant_id, staff_id, off_date, from_time, to_time, note, status, created_at) VALUES ($1,$2,$3,$4,NULL,NULL,$5,'pending',$6)",
      [rid(), DEMO_RESTAURANT_ID, sid("s03"), nextThu, "Medical appointment / Rendez-vous médical", now - 5 * 3600000]);
    await client.query("INSERT INTO staff_time_off (id, restaurant_id, staff_id, off_date, from_time, to_time, note, status, created_at) VALUES ($1,$2,$3,$4,'16:00',NULL,$5,'pending',$6)",
      [rid(), DEMO_RESTAURANT_ID, sid("s04"), nextSat, "Exam / Examen", now - 2 * 3600000]);
    await client.query(
      `INSERT INTO staff_availability (id, restaurant_id, staff_id, availability, pending, pending_at, updated_at) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7)`,
      [rid(), DEMO_RESTAURANT_ID, sid("s05"),
       JSON.stringify({ tue: { available: false, note: "Classes / Cours", from: "09:00", to: "15:00" } }),
       JSON.stringify({ tue: { available: false, note: "Classes / Cours", from: "09:00", to: "15:00" }, wed: { available: false, note: "New job / Nouvel emploi", from: "", to: "" } }),
       now - 8 * 3600000, now - 20 * 86400000]
    );

    // ----- message board (every post carries all three languages) -----
    const posts = [
      { pinned: true, ago: 2, fr: ["Nouveau menu d'automne", "Le nouveau menu commence jeudi. Dégustation pour toute l'équipe mercredi à 15 h."],
        en: ["New fall menu", "The new menu starts Thursday. Tasting for the whole team Wednesday at 3 pm."], es: ["Nuevo menú de otoño", "El nuevo menú empieza el jueves. Degustación para todo el equipo el miércoles a las 3 pm."] },
      { pinned: false, ago: 26, fr: ["Réunion d'équipe lundi", "Réunion d'équipe lundi à 15 h, avant le service. Présence demandée pour tous."],
        en: ["Team meeting Monday", "Team meeting Monday at 3 pm, before service. Everyone please attend."], es: ["Reunión de equipo el lunes", "Reunión de equipo el lunes a las 3 pm, antes del servicio. Asistencia para todos."] },
      { pinned: false, ago: 70, fr: ["Rappel : tenue de travail", "Tablier propre et souliers antidérapants à chaque quart, s'il vous plaît."],
        en: ["Reminder: uniform", "Clean apron and non-slip shoes every shift, please."], es: ["Recordatorio: uniforme", "Delantal limpio y zapatos antideslizantes en cada turno, por favor."] },
    ];
    for (const p of posts) {
      const postId = rid(), at = now - p.ago * 3600000;
      await client.query("INSERT INTO board_posts (id, restaurant_id, title, body, pinned, translations, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$7)",
        [postId, DEMO_RESTAURANT_ID, p.fr[0], p.fr[1], p.pinned, JSON.stringify({ en: { title: p.en[0], body: p.en[1] }, fr: { title: p.fr[0], body: p.fr[1] }, es: { title: p.es[0], body: p.es[1] } }), at]);
      const ackers = p.pinned ? ["s02", "s03", "s05", "s07", "s09"] : ROSTER.map((r) => r[0]).filter((_, i) => i % 3 !== 0);
      for (const a of ackers) await client.query("INSERT INTO board_acks (post_id, staff_id, acked_at) VALUES ($1,$2,$3)", [postId, sid(a), at + 1800000]);
    }

    // ----- sales: eight weeks of actuals, two weeks of forecasts, last year's weeks for comparison -----
    const figures = (date) => {
      const dow = (new Date(date + "T12:00:00Z").getUTCDay() + 6) % 7;
      const [bl, bd] = WEEKDAY_BASE[dow];
      const f = 0.88 + noise(date) * 0.24;
      const lunch = Math.round((bl * f) / 10) * 10, dinner = Math.round((bd * (0.9 + noise(date + "d") * 0.2)) / 10) * 10;
      return { lunch, dinner };
    };
    const aIds = [], aDates = [], aAmt = [], aFood = [], aBev = [], aSvc = [], aSplit = [];
    for (let i = 56; i >= 1; i--) {
      const date = addDaysIso(today, -i), { lunch, dinner } = figures(date);
      const lf = Math.round(lunch * 0.7), df = Math.round(dinner * 0.72);
      aIds.push(rid()); aDates.push(date); aAmt.push(lunch + dinner); aFood.push(lf + df); aBev.push(lunch - lf + dinner - df);
      aSvc.push(JSON.stringify({ lunch, dinner }));
      aSplit.push(JSON.stringify({ lunch: { food: lf, bev: lunch - lf }, dinner: { food: df, bev: dinner - df } }));
    }
    await client.query(
      `INSERT INTO actual_sales (id, restaurant_id, sale_date, amount, food_amount, bev_amount, service_amounts, service_split, source, created_at)
       SELECT a, $1, b::date, c, d, e, f::jsonb, g::jsonb, 'demo', $2 FROM unnest($3::text[], $4::text[], $5::numeric[], $6::numeric[], $7::numeric[], $8::text[], $9::text[]) AS t(a,b,c,d,e,f,g)`,
      [DEMO_RESTAURANT_ID, now, aIds, aDates, aAmt, aFood, aBev, aSvc, aSplit]
    );
    for (let i = 0; i < 14; i++) {
      const date = addDaysIso(today, i), { lunch, dinner } = figures(date);
      const pl = Math.round((lunch * 1.03) / 50) * 50, pd = Math.round((dinner * 1.04) / 50) * 50;
      await client.query(
        "INSERT INTO sales_projections (id, restaurant_id, proj_date, projected_amount, service_amounts, last_year_amount, created_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)",
        [rid(), DEMO_RESTAURANT_ID, date, pl + pd, JSON.stringify({ lunch: pl, dinner: pd }), Math.round((pl + pd) * 0.93), now]
      );
    }
    for (let w = -8; w <= 3; w++) {
      let total = 0;
      for (let d = 0; d < 7; d++) { const f = figures(addDaysIso(addDaysIso(monday, w * 7), d)); total += f.lunch + f.dinner; }
      await client.query("INSERT INTO weekly_sales_history (restaurant_id, week_start, amount, updated_at) VALUES ($1,$2,$3,$4)",
        [DEMO_RESTAURANT_ID, addDaysIso(addDaysIso(monday, w * 7), -364), Math.round(total * 0.93), now]);
    }

    // ----- the daily snapshot: a few nearby events (the demo never asks the AI to search for them) -----
    const EVENTS = [
      [{ name: "Jazz au Vieux-Port", when: "7:30 PM", where: "Quai Jacques-Cartier", impact: "high", note: "Big evening crowd nearby; expect a busier dinner." }],
      [{ name: "Canadiens home game", when: "7:00 PM", where: "Centre Bell", impact: "medium", note: "Pre-game guests early, quieter after puck drop." }],
      [{ name: "Marché Bonsecours artisan market", when: "11:00 AM", where: "Marché Bonsecours", impact: "low", note: "Light lunch traffic boost." }],
      [],
    ];
    for (let i = -7; i <= 14; i++) {
      await client.query("INSERT INTO day_context (restaurant_id, day, events, events_at) VALUES ($1,$2,$3::jsonb,$4)",
        [DEMO_RESTAURANT_ID, addDaysIso(today, i), JSON.stringify(EVENTS[((i % 4) + 4) % 4]), now]);
    }

    // ----- hiring and training -----
    const postingId = rid();
    await client.query("INSERT INTO job_postings (id, restaurant_id, title, role, description, status, created_at) VALUES ($1,$2,$3,'Server',$4,'open',$5)",
      [postingId, DEMO_RESTAURANT_ID, "Server / Serveur·se", "Evenings and weekends, busy bistro in Old Montréal. / Soirs et fins de semaine, bistro achalandé dans le Vieux-Montréal.", now - 6 * 86400000]);
    const applicants = [
      ["Alexandre Dubé", "applied", null], ["Priya Nair", "screening", null], ["Chloé Fournier", "interview", "Thu 2 pm"], ["Samuel Ouellet", "offer", null],
    ];
    for (let i = 0; i < applicants.length; i++) {
      const [name, stage, when] = applicants[i];
      await client.query("INSERT INTO applications (id, restaurant_id, posting_id, name, email, phone, note, stage, interview_time, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [rid(), DEMO_RESTAURANT_ID, postingId, name, `applicant${i + 1}@demo.invalid`, "+15550199" + String(10 + i), "Two years in a busy restaurant. / Deux ans dans un restaurant achalandé.", stage, when, now - (5 - i) * 86400000]);
    }
    const training = [
      ["course", "Wine Service 101 / Service du vin 101", 45], ["manual", "Food Safety Manual / Manuel de salubrité", null], ["course", "Allergen Awareness / Sensibilisation aux allergènes", 30],
    ];
    for (let i = 0; i < training.length; i++) {
      const itemId = rid();
      await client.query("INSERT INTO training_items (id, restaurant_id, kind, title, minutes, created_at) VALUES ($1,$2,$3,$4,$5,$6)", [itemId, DEMO_RESTAURANT_ID, training[i][0], training[i][1], training[i][2], now - (10 + i) * 86400000]);
      for (let j = 0; j < ROSTER.length; j++) {
        if (i === 0 && ROSTER[j][2][0] !== "Server" && ROSTER[j][2][0] !== "Bartender") continue; // wine service is for the floor
        const done = (j + i) % 3 !== 0;
        await client.query("INSERT INTO training_assignments (item_id, staff_id, completed_at) VALUES ($1,$2,$3)", [itemId, sid(ROSTER[j][0]), done ? now - (j + 1) * 86400000 : null]);
      }
    }

    await client.query("COMMIT");
    return { staff: ROSTER.length, shifts: all.length, swaps: swaps.length };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { seedDemo, DEMO_RESTAURANT_ID, DEMO_USER_ID, DEMO_STAFF_VIEW_ID, DEMO_MANAGER_EMAIL, ROSTER };
