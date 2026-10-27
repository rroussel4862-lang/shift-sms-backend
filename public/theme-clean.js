/* Clean theme, part 2: one navigation for the whole app (demo restaurant only).
   Five groups: Today, Schedule, People, Money, Messages. Items from the main app and the Back Office sit side by side,
   so there is no need to know which of the two a screen lives in. The original buttons stay in the page (hidden) and are
   clicked on your behalf, so nothing about how the screens work changes. Loaded by demo-banner.js. */
(function () {
  var L = {
    en: { today: "Today", schedule: "Schedule", people: "People", money: "Money", messages: "Messages", menu: "Menu",
      overview: "Overview", week: "Weekly schedule", open: "Open shifts & swaps", punch: "Punch clock", team: "Team & requests", pay: "Pay & tenure",
      training: "Training", hiring: "Hiring", payroll: "Payroll & sales", sales: "Daily sales entry", revenue: "Revenue history", tour: "Take the tour" },
    fr: { today: "Aujourd'hui", schedule: "Horaire", people: "Équipe", money: "Argent", messages: "Messages", menu: "Menu",
      overview: "Aperçu", week: "Horaire de la semaine", open: "Quarts ouverts et échanges", punch: "Pointage", team: "Personnel et demandes", pay: "Salaires et ancienneté",
      training: "Formation", hiring: "Embauche", payroll: "Paie et ventes", sales: "Saisie des ventes", revenue: "Historique des revenus", tour: "Visite guidée" },
    es: { today: "Hoy", schedule: "Horario", people: "Equipo", money: "Dinero", messages: "Mensajes", menu: "Menú",
      overview: "Resumen", week: "Horario semanal", open: "Turnos abiertos y cambios", punch: "Reloj", team: "Personal y solicitudes", pay: "Pago y antigüedad",
      training: "Capacitación", hiring: "Contratación", payroll: "Nómina y ventas", sales: "Registro de ventas", revenue: "Historial de ingresos", tour: "Recorrido guiado" }
  };
  function lang() { try { return localStorage.getItem("osr-lang") || "en"; } catch (e) { return "en"; } }
  function tx(k) { return (L[lang()] || L.en)[k] || L.en[k] || k; }

  /* every destination: which page it lives on, and the id of the original (now hidden) button that opens it */
  var GROUPS = [
    { id: "today", items: [{ k: "overview", page: "mi", key: "overview", btn: "tabBtnOverview" }] },
    { id: "schedule", items: [
      { k: "week", page: "bo", key: "schedule", btn: "sectionBtnSchedule" },
      { k: "open", page: "mi", key: "shifts", btn: "tabBtnShifts" },
      { k: "punch", page: "bo", key: "punch", btn: "sectionBtnPunch" }] },
    { id: "people", items: [
      { k: "team", page: "mi", key: "staff", btn: "tabBtnStaff" },
      { k: "pay", page: "bo", key: "staff", btn: "sectionBtnStaff" },
      { k: "training", page: "mi", key: "training", btn: "tabBtnTraining" },
      { k: "hiring", page: "mi", key: "hiring", btn: "tabBtnHiring" }] },
    { id: "money", items: [
      { k: "payroll", page: "mi", key: "payroll", btn: "tabBtnPayroll" },
      { k: "sales", page: "bo", key: "sales", btn: "sectionBtnSales" },
      { k: "revenue", page: "bo", key: "revenue", btn: "sectionBtnRevenue" }] },
    { id: "messages", items: [{ k: "comms", page: "mi", key: "comms", btn: "tabBtnComms", label: "messages" }] }
  ];

  var here = null;                 // "mi" or "bo"
  var openPanel = null, openBtn = null;
  function closeAll() { if (openPanel) { openPanel.hidden = true; if (openBtn) openBtn.setAttribute("aria-expanded", "false"); } openPanel = openBtn = null; }
  function place(panel, btn, alignRight) {
    var r = btn.getBoundingClientRect();
    panel.style.top = (r.bottom + 6) + "px";
    if (alignRight) { panel.style.right = Math.max(8, window.innerWidth - r.right) + "px"; panel.style.left = "auto"; }
    else { panel.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 248)) + "px"; panel.style.right = "auto"; }
  }
  function attach(btn, panel, alignRight) {
    document.body.appendChild(panel); panel.hidden = true;
    btn.setAttribute("aria-haspopup", "true"); btn.setAttribute("aria-expanded", "false");
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      var wasOpen = openPanel === panel; closeAll();
      if (!wasOpen) { place(panel, btn, alignRight); panel.hidden = false; openPanel = panel; openBtn = btn; btn.setAttribute("aria-expanded", "true"); }
    });
    panel.addEventListener("click", function (e) { if (e.target.closest(".cn-item, a, #logoutBtn")) closeAll(); });
  }
  document.addEventListener("click", function (e) { if (openPanel && !openPanel.contains(e.target)) closeAll(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeAll(); });
  window.addEventListener("resize", closeAll);

  function go(item) {
    if (item.page === here) { var b = document.getElementById(item.btn); if (b) b.click(); return; }
    if (item.page === "mi") { try { sessionStorage.setItem("osr-mi-tab", item.key); } catch (e) {} location.href = "/"; }
    else location.href = "/backoffice.html?section=" + item.key;
  }
  var BADGE = { tabBtnShifts: "shiftsBadge", tabBtnStaff: "staffBadge" };
  function countOf(item) {
    var id = BADGE[item.btn]; if (!id || item.page !== here) return 0;
    var b = document.getElementById(id);
    if (!b || b.style.display === "none") return 0;
    return parseInt(b.textContent, 10) || 0;
  }
  function isActive(item) { if (item.page !== here) return false; var b = document.getElementById(item.btn); return !!(b && b.classList.contains("active")); }

  function build(bar) {
    var tabs = [];
    var strip = document.createElement("div"); strip.className = "cn-tabs"; bar.appendChild(strip);
    GROUPS.forEach(function (g) {
      var one = g.items.length === 1;
      var btn = document.createElement("button"); btn.type = "button"; btn.className = "cn-tab";
      var label = document.createElement("span"); btn.appendChild(label);
      var tabBadge = document.createElement("span"); tabBadge.className = "cn-badge cn-dot"; tabBadge.hidden = true; btn.appendChild(tabBadge);
      if (!one) btn.insertAdjacentHTML("beforeend", '<svg class="cn-chev" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>');
      strip.appendChild(btn);
      var panel = null, rows = [];
      if (one) btn.addEventListener("click", function () { closeAll(); go(g.items[0]); });
      else {
        panel = document.createElement("div"); panel.className = "cn-panel";
        g.items.forEach(function (it) {
          var r = document.createElement("button"); r.type = "button"; r.className = "cn-item";
          r.addEventListener("click", function () { go(it); });
          r.innerHTML = '<span class="cn-lbl"></span><span class="cn-badge" hidden></span>';
          panel.appendChild(r); rows.push({ el: r, item: it });
        });
        attach(btn, panel, false);
      }
      tabs.push({ g: g, btn: btn, label: label, rows: rows, tabBadge: tabBadge });
    });
    function refresh() {
      tabs.forEach(function (t) {
        var one = t.g.items.length === 1;
        t.label.textContent = one ? tx(t.g.items[0].label || t.g.items[0].k === "overview" ? (t.g.items[0].label || "today") : t.g.id) : tx(t.g.id);
        var any = false;
        var total = 0;
        t.rows.forEach(function (r) {
          r.el.querySelector(".cn-lbl").textContent = tx(r.item.k);
          var a = isActive(r.item); r.el.classList.toggle("on", a); if (a) any = true;
          var n = countOf(r.item), bd = r.el.querySelector(".cn-badge"); bd.hidden = !n; bd.textContent = n || ""; total += n;
        });
        t.tabBadge.hidden = !total; t.tabBadge.textContent = total || "";
        if (one) any = isActive(t.g.items[0]);
        t.btn.classList.toggle("active", any);
      });
    }
    refresh();
    /* follow the hidden original buttons, so the highlight is always right */
    var mo = new MutationObserver(refresh);
    GROUPS.forEach(function (g) { g.items.forEach(function (it) { var b = document.getElementById(it.btn); if (b) mo.observe(b, { attributes: true, attributeFilter: ["class"] }); }); });
    window.addEventListener("storage", refresh);
    return refresh;
  }

  function settings(bar, source, extra) {
    var wrap = document.createElement("div"); wrap.className = "cn-more";
    var btn = document.createElement("button"); btn.type = "button"; btn.className = "cn-trigger"; btn.setAttribute("aria-label", tx("menu"));
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="3" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="13" cy="8" r="1.4"/></svg>';
    wrap.appendChild(btn); bar.appendChild(wrap);
    var panel = document.createElement("div"); panel.className = "cn-panel cn-settings";
    attach(btn, panel, true);
    if (source) {
      while (source.firstChild) panel.appendChild(source.firstChild);
      /* anything added later (for example the "?" tour button) joins the menu too */
      if (extra) new MutationObserver(function () { while (source.firstChild) panel.appendChild(source.firstChild); }).observe(source, { childList: true });
    }
  }

  function mainApp() {
    var bar = document.getElementById("sidebar"), top = document.getElementById("topbarNew");
    if (!bar || !top || bar.querySelector(".cn-tab")) return false;
    here = "mi";
    var mark = top.querySelector(".topbar-mark");
    var brand = document.createElement("div"); brand.className = "cn-brand header-left";
    if (mark) brand.appendChild(mark);
    var nm = document.createElement("span"); nm.className = "cn-name"; brand.appendChild(nm);
    bar.insertBefore(brand, bar.firstChild);
    var src = document.getElementById("sidebarRestaurantName");
    function setName() { var n = ""; try { n = (typeof restaurantName === "string" && restaurantName) || ""; } catch (e) {} var cached = ""; try { cached = sessionStorage.getItem("osr-demo-name") || ""; } catch (e) {} var real = n || (src && src.textContent !== "Open Shift Rail" ? src.textContent : ""); if (real) { try { sessionStorage.setItem("osr-demo-name", real); } catch (e) {} } nm.textContent = real || cached || "Open Shift Rail"; }
    setName();
    if (src) new MutationObserver(setName).observe(src, { childList: true, characterData: true, subtree: true });
    setTimeout(setName, 600); setTimeout(setName, 2500);
    build(bar);
    settings(bar, document.getElementById("topbarRight"), true);
    return true;
  }
  function backOffice() {
    var head = document.querySelector("header"), bar = document.querySelector("nav.sections");
    if (!head || !bar || bar.querySelector(".cn-tab")) return false;
    here = "bo";
    var left = head.querySelector(".header-left"); if (left) bar.insertBefore(left, bar.firstChild);
    /* show the restaurant's name straight away (remembered from the last page), then let the page set the real one */
    var h1 = document.getElementById("restaurantHeading");
    if (h1) {
      var cached = ""; try { cached = sessionStorage.getItem("osr-demo-name") || ""; } catch (e) {}
      if (cached && /^Back Office$/i.test(h1.textContent.trim())) h1.textContent = cached + " — Back Office";
      new MutationObserver(function () { var n = h1.textContent.split(" — ")[0].trim(); if (n && !/^Back Office$/i.test(n)) { try { sessionStorage.setItem("osr-demo-name", n); } catch (e) {} } }).observe(h1, { childList: true, characterData: true, subtree: true });
    }
    build(bar);
    settings(bar, document.getElementById("hdrRight"), true);
    scheduleViews();
    return true;
  }

  /* ------------------------------------------------------------------------------------------------
     Schedule: "Phone view" (one day at a time, as a list) and "Desktop view" (the full week grid).
     The grid itself is untouched; phone view is a second way of looking at the same data.            */
  var SV = {
    en: { phone: "Phone view", desk: "Desktop view", empty: "Nobody is scheduled this day.", hrs: "h", labor: "Labor", forecast: "Forecast", shifts: "shifts", edit: "Edit in desktop view", people: "scheduled", hours: "Hours" },
    fr: { phone: "Vue mobile", desk: "Vue bureau", empty: "Personne n'est à l'horaire ce jour-là.", hrs: "h", labor: "Main-d'œuvre", forecast: "Prévision", shifts: "quarts", edit: "Modifier en vue bureau", people: "à l'horaire", hours: "Heures" },
    es: { phone: "Vista móvil", desk: "Vista escritorio", empty: "Nadie está programado ese día.", hrs: "h", labor: "Mano de obra", forecast: "Pronóstico", shifts: "turnos", edit: "Editar en vista escritorio", people: "programados", hours: "Horas" }
  };
  function sv(k) { return (SV[lang()] || SV.en)[k]; }
  var phoneMode = false, dayIdx = null;
  function savedMode() { try { var m = localStorage.getItem("osr-sched-view"); if (m) return m === "phone"; } catch (e) {} return window.innerWidth < 760; }
  function esc(x) { return String(x == null ? "" : x).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function fmtT(t) { try { return formatTime(t); } catch (e) { return t; } }
  function money(v) { return "$" + Math.round(v).toLocaleString("en-US"); }

  function renderPhone() {
    var box = document.getElementById("phoneSched"); if (!box) return;
    var dates = [];
    for (var i = 0; i < 7; i++) { var d = new Date(weekStart); d.setDate(d.getDate() + i); dates.push(d); }
    if (dayIdx === null || dayIdx > 6) { var t = toISODate(new Date()), f = dates.findIndex(function (d) { return toISODate(d) === t; }); dayIdx = f >= 0 ? f : 0; }
    var groups = viewGroups(), ids = {}; groups.forEach(function (g) { g.people.forEach(function (p) { ids[p.id] = p; }); });
    var mine = scheduleShifts.filter(function (s) { return ids[s.staffId]; });
    var perDay = dates.map(function (d) { var ds = toISODate(d); return mine.filter(function (s) { return s.date === ds; }); });
    var strip = dates.map(function (d, i) {
      return '<button type="button" class="ps-day' + (i === dayIdx ? " on" : "") + '" data-i="' + i + '"><span>' + esc(tr("days." + i)) + '</span><b>' + d.getDate() + '</b><i>' + (perDay[i].length || "") + '</i></button>';
    }).join("");
    var ds = toISODate(dates[dayIdx]), day = perDay[dayIdx].slice().sort(function (a, b) { return (a.startTime || "").localeCompare(b.startTime || ""); });
    var hours = 0, cost = 0;
    day.forEach(function (s) { var h = computeHours(s.startTime, s.endTime); hours += h; cost += h * ((ids[s.staffId] && ids[s.staffId].hourlyRate) || 0); });
    var fc = salesProjections[ds];
    var pct = (fc && cost) ? Math.round(cost / fc * 1000) / 10 + "%" : "";
    var summary = '<div class="ps-sum"><div><b>' + day.length + '</b><span>' + sv("people") + '</span></div><div><b>' + (Math.round(hours * 10) / 10) + '</b><span>' + sv("hours") + '</span></div><div><b>' + money(cost) + '</b><span>' + sv("labor") + (pct ? " · " + pct : "") + '</span></div>' + (fc ? '<div><b>' + money(fc) + '</b><span>' + sv("forecast") + '</span></div>' : "") + '</div>';
    var body = "";
    groups.forEach(function (g) {
      var rows = day.filter(function (s) { return (s.role || "") === g.role || ((!s.role) && (ids[s.staffId].roles || [])[0] === g.role); });
      rows.forEach(function (s) { s.__g = 1; });
      if (!rows.length) return;
      body += '<div class="ps-role">' + esc(g.role) + '</div>' + rows.map(card).join("");
    });
    var rest = day.filter(function (s) { return !s.__g; });
    if (rest.length) body += '<div class="ps-role">·</div>' + rest.map(card).join("");
    day.forEach(function (s) { delete s.__g; });
    if (!day.length) body = '<div class="ps-empty">' + sv("empty") + '</div>';
    function card(s) {
      var p = ids[s.staffId], h = Math.round(computeHours(s.startTime, s.endTime) * 10) / 10;
      return '<button type="button" class="ps-card" data-id="' + esc(s.id) + '"><span class="ps-time">' + esc(fmtT(s.startTime)) + ' – ' + esc(fmtT(s.endTime)) + '</span><span class="ps-who"><b>' + esc(p.name) + '</b><i>' + esc(s.role || "") + '</i></span><span class="ps-h">' + h + sv("hrs") + '</span></button>';
    }
    box.innerHTML = '<div class="ps-strip">' + strip + '</div>' + summary + '<div class="ps-list">' + body + '</div><button type="button" class="ps-edit">' + sv("edit") + '</button>';
  }
  function applyMode() {
    document.body.classList.toggle("sched-phone", phoneMode);
    var a = document.getElementById("viewBtnPhone"), b = document.getElementById("viewBtnDesk");
    if (a) a.classList.toggle("active", phoneMode); if (b) b.classList.toggle("active", !phoneMode);
    if (a) a.textContent = sv("phone"); if (b) b.textContent = sv("desk");
    if (phoneMode) renderPhone();
  }
  function setMode(m) { phoneMode = m; try { localStorage.setItem("osr-sched-view", m ? "phone" : "desk"); } catch (e) {} applyMode(); }
  function scheduleViews() {
    var tog = document.querySelector(".house-toggle"), wrap = document.querySelector(".grid-wrap");
    if (!tog || !wrap || document.getElementById("phoneSched")) return;
    var vt = document.createElement("span"); vt.className = "view-toggle";
    vt.innerHTML = '<button type="button" class="house-btn" id="viewBtnPhone"></button><button type="button" class="house-btn" id="viewBtnDesk"></button>';
    tog.appendChild(vt);
    vt.querySelector("#viewBtnPhone").addEventListener("click", function () { setMode(true); });
    vt.querySelector("#viewBtnDesk").addEventListener("click", function () { setMode(false); });
    var box = document.createElement("div"); box.id = "phoneSched"; var anchor = document.getElementById("pubBar"); if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(box, anchor.nextSibling); else wrap.parentNode.insertBefore(box, wrap);
    box.addEventListener("click", function (e) {
      var d = e.target.closest(".ps-day"); if (d) { dayIdx = +d.getAttribute("data-i"); renderPhone(); return; }
      var c = e.target.closest(".ps-card");
      if (c) { setMode(false); try { editShift(c.getAttribute("data-id")); } catch (x) {} return; }
      if (e.target.closest(".ps-edit")) setMode(false);
    });
    /* redraw the list whenever the grid is redrawn (week change, house change, saves...) */
    var orig = window.renderScheduleGrid;
    if (typeof orig === "function") window.renderScheduleGrid = function () { var r = orig.apply(this, arguments); if (phoneMode) { try { renderPhone(); } catch (x) {} } return r; };
    phoneMode = savedMode(); applyMode();
  }


  /* The demo's navigation has new names, so the main app's own pointers ("Review in Scheduling", "Back Office › Schedule"...)
     are reworded to match where things now are. Only the demo loads this file. */
  var RELABEL = {
    en: { "snap.swapWaitLink": "Review swaps", "snap.availWaitLink": "Review requests",
      "snap.noAiForecast": "Generate it in Schedule › Weekly schedule", "snap.noForecast": "Enter today's forecast in Schedule › Weekly schedule", "snap.noLastYear": "Add it in Schedule › Weekly schedule",
      "snap.needAddressLink": "Add it in People › Hiring", "snap.geoFailed": "We couldn't locate that address — check it in People › Hiring.",
      "scheduling.todayEmptyHint": "Build the week in Schedule › Weekly schedule.", "scheduling.openBackOffice": "Open weekly schedule", "comms.schedOpenBo": "Open weekly schedule" },
    fr: { "snap.swapWaitLink": "Voir les échanges", "snap.availWaitLink": "Voir les demandes",
      "snap.noAiForecast": "À générer dans Horaire › Horaire de la semaine", "snap.noForecast": "Entrez la prévision du jour dans Horaire › Horaire de la semaine", "snap.noLastYear": "À ajouter dans Horaire › Horaire de la semaine",
      "snap.needAddressLink": "À ajouter dans Équipe › Embauche", "snap.geoFailed": "Adresse introuvable — vérifiez-la dans Équipe › Embauche.",
      "scheduling.todayEmptyHint": "Préparez la semaine dans Horaire › Horaire de la semaine.", "scheduling.openBackOffice": "Ouvrir l'horaire de la semaine", "comms.schedOpenBo": "Ouvrir l'horaire de la semaine" },
    es: { "snap.swapWaitLink": "Revisar cambios", "snap.availWaitLink": "Revisar solicitudes",
      "snap.noAiForecast": "Genéralo en Horario › Horario semanal", "snap.noForecast": "Ingresa la proyección de hoy en Horario › Horario semanal", "snap.noLastYear": "Agrégalo en Horario › Horario semanal",
      "snap.needAddressLink": "Agrégala en Equipo › Contratación", "snap.geoFailed": "No pudimos ubicar esa dirección — revísala en Equipo › Contratación.",
      "scheduling.todayEmptyHint": "Arma la semana en Horario › Horario semanal.", "scheduling.openBackOffice": "Abrir horario semanal", "comms.schedOpenBo": "Abrir horario semanal" }
  };
  function relabel() {
    if (typeof T === "undefined") return;
    try {
      Object.keys(RELABEL).forEach(function (l) {
        if (!T[l]) return;
        Object.keys(RELABEL[l]).forEach(function (path) { var p = path.split("."); if (T[l][p[0]] && p[1] in T[l][p[0]]) T[l][p[0]][p[1]] = RELABEL[l][path]; });
      });
      if (typeof renderOverview === "function" && document.getElementById("overviewGrid") && document.getElementById("overviewGrid").innerHTML) renderOverview();
    } catch (e) {}
  }

  var embedded = false;
  try { embedded = window.top !== window || /[?&]embed=1/.test(location.search); } catch (e) { embedded = true; }
  /* inside /app.html the bar belongs to the outer page; the Back Office still gets its phone/desktop schedule toggle */
  window.cleanNav = function () { relabel(); if (embedded) { if (document.querySelector("nav.sections")) { here = "bo"; scheduleViews(); } return; } if (!mainApp()) backOffice(); };
})();
