/* One page for the whole app (demo restaurant). The main app and the Back Office stay loaded side by side inside this
   page and the navigation bar lives here, so moving between them is instant: nothing reloads, nothing flashes, and each
   screen is exactly where you left it. The two pages themselves are unchanged; they just hide their own top bars. */
(function () {
  var L = {
    en: { today: "Today", schedule: "Schedule", people: "People", money: "Money", messages: "Messages", menu: "Menu",
      overview: "Overview", week: "Weekly schedule", open: "Open shifts", punch: "Punch clock", team: "Team", pay: "Pay & tenure",
      training: "Training", hiring: "Hiring", payroll: "Payroll & sales", sales: "Daily sales entry", revenue: "Revenue history", tour: "Take the tour", logout: "Log out",
      demo: "Demo: made-up restaurant and sample data. It resets every night." },
    fr: { today: "Aujourd'hui", schedule: "Horaire", people: "Équipe", money: "Argent", messages: "Messages", menu: "Menu",
      overview: "Aperçu", week: "Horaire de la semaine", open: "Quarts ouverts", punch: "Pointage", team: "Personnel", pay: "Salaires et ancienneté",
      training: "Formation", hiring: "Embauche", payroll: "Paie et ventes", sales: "Saisie des ventes", revenue: "Historique des revenus", tour: "Visite guidée", logout: "Déconnexion",
      demo: "Démo : restaurant fictif et données d'exemple. Réinitialisé chaque nuit." },
    es: { today: "Hoy", schedule: "Horario", people: "Equipo", money: "Dinero", messages: "Mensajes", menu: "Menú",
      overview: "Resumen", week: "Horario semanal", open: "Turnos abiertos", punch: "Reloj", team: "Personal", pay: "Pago y antigüedad",
      training: "Capacitación", hiring: "Contratación", payroll: "Nómina y ventas", sales: "Registro de ventas", revenue: "Historial de ingresos", tour: "Recorrido guiado", logout: "Cerrar sesión",
      demo: "Demo: restaurante ficticio con datos de ejemplo. Se reinicia cada noche." }
  };
  function lang() { try { return localStorage.getItem("osr-lang") || "en"; } catch (e) { return "en"; } }
  function tx(k) { return (L[lang()] || L.en)[k] || L.en[k] || k; }

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
    { id: "messages", items: [{ k: "messages", page: "mi", key: "comms", btn: "tabBtnComms" }] }
  ];
  var FRAME = { mi: document.getElementById("fMi"), bo: document.getElementById("fBo") };
  var URLS = { mi: "/index.html?embed=1", bo: "/backoffice.html?embed=1" };
  var here = "mi";
  var bar = document.getElementById("sidebar");
  var ready = { mi: false, bo: false };

  /* ---------- helpers on the two pages ---------- */
  function win(p) { try { return FRAME[p].contentWindow; } catch (e) { return null; } }
  function doc(p) { try { return FRAME[p].contentDocument; } catch (e) { return null; } }
  function activate(item) {
    var w = win(item.page); if (!w) return;
    try { if (item.page === "mi") w.switchTab(item.key); else w.showSection(item.key); } catch (e) {}
  }
  function isActive(item) {
    if (item.page !== here) return false;
    var d = doc(item.page), b = d && d.getElementById(item.btn);
    return !!(b && b.classList.contains("active"));
  }
  function show(page) {
    here = page;
    FRAME.mi.classList.toggle("on", page === "mi"); FRAME.bo.classList.toggle("on", page === "bo");
    try { FRAME[page].contentWindow.focus(); } catch (e) {}
  }
  function go(item) {
    var pending = !ready[item.page];
    show(item.page);
    if (pending) { FRAME[item.page].addEventListener("load", function once() { FRAME[item.page].removeEventListener("load", once); setTimeout(function () { activate(item); refresh(); }, 50); }); }
    else activate(item);
    remember(item);
    refresh();
  }
  function remember(item) {
    try { history.replaceState(null, "", "/app.html?v=" + item.page + "&k=" + item.key); } catch (e) {}
    if (item.page === "mi") { try { sessionStorage.setItem("osr-mi-tab", item.key); } catch (e) {} }
  }

  /* ---------- drop-down menus ---------- */
  var openPanel = null, openBtn = null;
  function closeAll() { if (openPanel) { openPanel.hidden = true; if (openBtn) openBtn.setAttribute("aria-expanded", "false"); } openPanel = openBtn = null; }
  function place(panel, btn, right) {
    var r = btn.getBoundingClientRect();
    panel.style.top = (r.bottom + 6) + "px";
    if (right) { panel.style.right = Math.max(8, window.innerWidth - r.right) + "px"; panel.style.left = "auto"; }
    else { panel.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 248)) + "px"; panel.style.right = "auto"; }
  }
  function attach(btn, panel, right) {
    document.body.appendChild(panel); panel.hidden = true;
    btn.setAttribute("aria-haspopup", "true"); btn.setAttribute("aria-expanded", "false");
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      var was = openPanel === panel; closeAll();
      if (!was) { place(panel, btn, right); panel.hidden = false; openPanel = panel; openBtn = btn; btn.setAttribute("aria-expanded", "true"); }
    });
    panel.addEventListener("click", function (e) { if (e.target.closest(".cn-item")) closeAll(); });
  }
  document.addEventListener("click", function (e) { if (openPanel && !openPanel.contains(e.target)) closeAll(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeAll(); });
  window.addEventListener("resize", closeAll);
  /* a click inside either page should also close an open menu here */
  function watchFrame(p) { var d = doc(p); if (d) d.addEventListener("click", closeAll); }

  /* ---------- build the bar ---------- */
  var brand = document.createElement("div"); brand.className = "cn-brand header-left";
  brand.innerHTML = '<div class="topbar-mark" aria-hidden="true"></div><span class="cn-name"></span>';
  bar.appendChild(brand);
  var strip = document.createElement("div"); strip.className = "cn-tabs"; bar.appendChild(strip);
  var tabs = GROUPS.map(function (g) {
    var one = g.items.length === 1;
    var btn = document.createElement("button"); btn.type = "button"; btn.className = "cn-tab";
    var label = document.createElement("span"); btn.appendChild(label);
    if (!one) btn.insertAdjacentHTML("beforeend", '<svg class="cn-chev" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>');
    strip.appendChild(btn);
    var rows = [];
    if (one) btn.addEventListener("click", function () { closeAll(); go(g.items[0]); });
    else {
      var panel = document.createElement("div"); panel.className = "cn-panel";
      g.items.forEach(function (it) {
        var r = document.createElement("button"); r.type = "button"; r.className = "cn-item";
        r.addEventListener("click", function () { go(it); });
        panel.appendChild(r); rows.push({ el: r, item: it });
      });
      attach(btn, panel, false);
    }
    return { g: g, btn: btn, label: label, rows: rows };
  });

  /* settings menu: tour, language, log out */
  var more = document.createElement("div"); more.className = "cn-more";
  var mbtn = document.createElement("button"); mbtn.type = "button"; mbtn.className = "cn-trigger";
  mbtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="3" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="13" cy="8" r="1.4"/></svg>';
  more.appendChild(mbtn); bar.appendChild(more);
  var spanel = document.createElement("div"); spanel.className = "cn-panel cn-settings";
  var tourBtn = document.createElement("button"); tourBtn.type = "button"; tourBtn.className = "cn-item";
  tourBtn.addEventListener("click", function () { var d = doc(here), h = d && d.querySelector(".osr-help"); if (h) h.click(); });
  var langRow = document.createElement("div"); langRow.className = "lang-switch";
  ["en", "fr", "es"].forEach(function (c) {
    var b = document.createElement("button"); b.type = "button"; b.className = "lang-btn"; b.textContent = c.toUpperCase(); b.setAttribute("data-l", c);
    b.addEventListener("click", function () {
      try { localStorage.setItem("osr-lang", c); } catch (e) {}
      closeAll(); ready.mi = ready.bo = false;
      try { win("mi").location.reload(); win("bo").location.reload(); } catch (e) {}
      refresh();
    });
    langRow.appendChild(b);
  });
  var outBtn = document.createElement("button"); outBtn.type = "button"; outBtn.className = "cn-item";
  outBtn.addEventListener("click", function () {
    closeAll();
    var w = win("mi"); try { w.api("/api/auth/logout", { method: "POST" }).then(done, done); } catch (e) { done(); }
    function done() { try { sessionStorage.removeItem("osr-demo-theme"); } catch (e) {} location.href = "/"; }
  });
  spanel.appendChild(tourBtn); spanel.appendChild(langRow); spanel.appendChild(outBtn);
  attach(mbtn, spanel, true);
  mbtn.setAttribute("aria-label", "Menu");

  function refresh() {
    var l = lang();
    document.documentElement.lang = l;
    tourBtn.textContent = "? " + tx("tour"); outBtn.textContent = tx("logout");
    langRow.querySelectorAll(".lang-btn").forEach(function (b) { b.classList.toggle("active", b.getAttribute("data-l") === l); });
    document.getElementById("demoBar").textContent = tx("demo");
    tabs.forEach(function (t) {
      var one = t.g.items.length === 1, any = false;
      t.label.textContent = tx(one ? (t.g.id === "messages" ? "messages" : "today") : t.g.id);
      t.rows.forEach(function (r) { r.el.textContent = tx(r.item.k); var a = isActive(r.item); r.el.classList.toggle("on", a); if (a) any = true; });
      if (one) any = isActive(t.g.items[0]);
      t.btn.classList.toggle("active", any);
    });
  }
  setInterval(refresh, 400);   // follows the pages, so the highlight is right even when a screen changes itself

  /* ---------- load the two pages ---------- */
  function params() { var p = new URLSearchParams(location.search); return { v: p.get("v") === "bo" ? "bo" : "mi", k: p.get("k") || "" }; }
  var start = params();
  var firstItem = null;
  GROUPS.forEach(function (g) { g.items.forEach(function (it) { if (it.page === start.v && it.key === start.k) firstItem = it; }); });
  if (!firstItem) firstItem = start.v === "bo" ? GROUPS[1].items[0] : GROUPS[0].items[0];
  if (firstItem.page === "mi") { try { sessionStorage.setItem("osr-mi-tab", firstItem.key); } catch (e) {} }
  try { sessionStorage.setItem("osr-demo-theme", "1"); } catch (e) {}

  function boSection() { try { return new URLSearchParams(win("bo").location.search).get("section"); } catch (e) { return null; } }
  function load(p, extra) { FRAME[p].src = URLS[p] + (extra || ""); }
  FRAME.mi.addEventListener("load", function () { onLoad("mi"); });
  FRAME.bo.addEventListener("load", function () { onLoad("bo"); });
  function onLoad(p) {
    var w = win(p), path = ""; try { path = w.location.pathname; } catch (e) {}
    /* a link inside one page that leads to the other page: open it in the right frame instead */
    var other = p === "mi" ? "backoffice.html" : "index.html";
    if (path.indexOf(other) >= 0 || (p === "bo" && path === "/")) {
      var sec = null; try { sec = new URLSearchParams(w.location.search).get("section"); } catch (e) {}
      load(p);                                                  // put this frame back where it was
      var target = p === "mi" ? "bo" : "mi";
      var item = null; GROUPS.forEach(function (g) { g.items.forEach(function (it) { if (it.page === target && (!sec || it.key === sec)) item = item || it; }); });
      if (item) go(item);
      return;
    }
    ready[p] = true; watchFrame(p); refresh();
  }
  /* the first page you asked for loads first; the other one loads right behind it, so the first switch is instant too */
  var first = firstItem.page, second = first === "mi" ? "bo" : "mi";
  show(first);
  load(first, first === "bo" ? "&section=" + firstItem.key : "");
  FRAME[first].addEventListener("load", function once() { FRAME[first].removeEventListener("load", once); setTimeout(function () { load(second, second === "bo" ? "&section=schedule" : ""); }, 200); });
  /* the name and the sign-in check */
  fetch("/api/auth/me", { credentials: "same-origin" }).then(function (r) { return r.ok ? r.json() : null; }).then(function (me) {
    if (!me || !me.demo) { try { sessionStorage.removeItem("osr-demo-theme"); } catch (e) {} location.replace("/"); return; }
    var n = (me.restaurant && me.restaurant.name) || "Open Shift Rail";
    bar.querySelector(".cn-name").textContent = n; document.title = n + " — Open Shift Rail";
    try { sessionStorage.setItem("osr-demo-name", n); } catch (e) {}
  }).catch(function () {});
  try { var cn = sessionStorage.getItem("osr-demo-name"); if (cn) bar.querySelector(".cn-name").textContent = cn; else bar.querySelector(".cn-name").textContent = "Open Shift Rail"; } catch (e) {}
  refresh();
})();
