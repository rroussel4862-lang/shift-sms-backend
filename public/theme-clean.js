/* Clean theme, part 2: one navigation for the whole app (demo restaurant only).
   Five groups: Today, Schedule, People, Money, Messages. Items from the main app and the Back Office sit side by side,
   so there is no need to know which of the two a screen lives in. The original buttons stay in the page (hidden) and are
   clicked on your behalf, so nothing about how the screens work changes. Loaded by demo-banner.js. */
(function () {
  var L = {
    en: { today: "Today", schedule: "Schedule", people: "People", money: "Money", messages: "Messages", menu: "Menu",
      overview: "Overview", week: "Weekly schedule", open: "Open shifts", punch: "Punch clock", team: "Team", pay: "Pay & tenure",
      training: "Training", hiring: "Hiring", payroll: "Payroll & sales", sales: "Daily sales entry", revenue: "Revenue history", tour: "Take the tour" },
    fr: { today: "Aujourd'hui", schedule: "Horaire", people: "Équipe", money: "Argent", messages: "Messages", menu: "Menu",
      overview: "Aperçu", week: "Horaire de la semaine", open: "Quarts ouverts", punch: "Pointage", team: "Personnel", pay: "Salaires et ancienneté",
      training: "Formation", hiring: "Embauche", payroll: "Paie et ventes", sales: "Saisie des ventes", revenue: "Historique des revenus", tour: "Visite guidée" },
    es: { today: "Hoy", schedule: "Horario", people: "Equipo", money: "Dinero", messages: "Mensajes", menu: "Menú",
      overview: "Resumen", week: "Horario semanal", open: "Turnos abiertos", punch: "Reloj", team: "Personal", pay: "Pago y antigüedad",
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
  function isActive(item) { if (item.page !== here) return false; var b = document.getElementById(item.btn); return !!(b && b.classList.contains("active")); }

  function build(bar) {
    var tabs = [];
    var strip = document.createElement("div"); strip.className = "cn-tabs"; bar.appendChild(strip);
    GROUPS.forEach(function (g) {
      var one = g.items.length === 1;
      var btn = document.createElement("button"); btn.type = "button"; btn.className = "cn-tab";
      var label = document.createElement("span"); btn.appendChild(label);
      if (!one) btn.insertAdjacentHTML("beforeend", '<svg class="cn-chev" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>');
      strip.appendChild(btn);
      var panel = null, rows = [];
      if (one) btn.addEventListener("click", function () { closeAll(); go(g.items[0]); });
      else {
        panel = document.createElement("div"); panel.className = "cn-panel";
        g.items.forEach(function (it) {
          var r = document.createElement("button"); r.type = "button"; r.className = "cn-item";
          r.addEventListener("click", function () { go(it); });
          panel.appendChild(r); rows.push({ el: r, item: it });
        });
        attach(btn, panel, false);
      }
      tabs.push({ g: g, btn: btn, label: label, rows: rows });
    });
    function refresh() {
      tabs.forEach(function (t) {
        var one = t.g.items.length === 1;
        t.label.textContent = one ? tx(t.g.items[0].label || t.g.items[0].k === "overview" ? (t.g.items[0].label || "today") : t.g.id) : tx(t.g.id);
        var any = false;
        t.rows.forEach(function (r) { r.el.textContent = tx(r.item.k); var a = isActive(r.item); r.el.classList.toggle("on", a); if (a) any = true; });
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
    function setName() { var n = ""; try { n = (typeof restaurantName === "string" && restaurantName) || ""; } catch (e) {} nm.textContent = n || (src && src.textContent) || "Open Shift Rail"; }
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
    build(bar);
    settings(bar, document.getElementById("hdrRight"), true);
    return true;
  }
  window.cleanNav = function () { if (!mainApp()) backOffice(); };
})();
