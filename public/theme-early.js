/* Runs first thing in <body> on the main app, Back Office and staff portal. If this browser last signed in to a
   restaurant that uses the new layout and design, it puts that look on straight away, so moving between pages doesn't
   flash the old design first. The server has the final say: every page checks with it and corrects the flag
   (see osrDesign / osrNotDemo). The flag is kept in this browser's local storage. */
(function () {
  var KEY = "osr-demo-theme";
  var embedded = false;
  try { embedded = window.top !== window || /[?&]embed=1/.test(location.search); } catch (e) { embedded = true; }
  var path = location.pathname;
  var isMain = path === "/" || path === "/index.html", isBo = path === "/backoffice.html";
  /* in the demo, the main app and Back Office live together inside /app.html (one page, one bar). Opened on their own, they hand over to it. */
  function toShell() {
    var v = isBo ? "bo" : "mi", k = "";
    try {
      if (isBo) k = new URLSearchParams(location.search).get("section") || "";
      else k = sessionStorage.getItem("osr-mi-tab") || "";
    } catch (e) {}
    location.replace("/app.html?v=" + v + (k ? "&k=" + encodeURIComponent(k) : ""));
  }
  if (embedded) { document.body.classList.add("embed"); document.documentElement.classList.add("embed"); }
  function flagged() { try { return localStorage.getItem(KEY) === "1"; } catch (e) { return false; } }
  function setFlag(on) { try { if (on) localStorage.setItem(KEY, "1"); else localStorage.removeItem(KEY); sessionStorage.removeItem(KEY); } catch (e) {} }
  function plain() { try { var q = new URLSearchParams(location.search).get("theme"); if (q) sessionStorage.setItem("osr-theme", q); return sessionStorage.getItem("osr-theme") === "clean"; } catch (e) { return false; } }
  function add(tag, id, attrs) {
    if (document.getElementById(id)) return;
    if (document.readyState === "loading") document.write("<" + tag + ' id="' + id + '" ' + attrs + (tag === "script" ? "></" + tag + ">" : ">"));
    else { var el = document.createElement(tag); el.id = id; attrs.replace(/(\w+)="([^"]*)"/g, function (m, k, v) { el.setAttribute(k, v); }); (tag === "script" ? document.body : document.head).appendChild(el); if (tag === "script") el.onload = function () { if (window.cleanNav) window.cleanNav(); }; }
  }
  window.osrApplyTheme = function () {
    setFlag(true);
    if (!embedded && (isMain || isBo)) { toShell(); return; }
    document.body.classList.add("theme-clean");
    add("link", "themeCleanCss", 'rel="stylesheet" href="/theme-clean.css"');
    if (!plain()) { document.body.classList.add("theme-warm"); add("link", "themeWarmCss", 'rel="stylesheet" href="/theme-warm.css"'); }
    add("script", "themeCleanJs", 'src="/theme-clean.js"');
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { if (window.cleanNav) window.cleanNav(); });
    else if (window.cleanNav) window.cleanNav();
  };
  /* this tab was in the demo a moment ago, so assume it still is; the page confirms or corrects this once it hears from the server */
  window.osrNotDemo = function () { if (flagged()) { setFlag(false); location.reload(); } };
  /* every page calls this once the server has said who is signed in: new design on -> apply it (and the demo bar in the demo); off -> classic */
  window.osrDesign = function (me) {
    if (me && me.newDesign) { if (me.demo && window.showDemoBanner) window.showDemoBanner(); else window.osrApplyTheme(); }
    else window.osrNotDemo();
  };
  window.osrClearDesign = function () { setFlag(false); };
  /* in a demo tab, show the app frame straight away (instead of the login screen or an empty page until the server
     answers) and open the tab you picked, so moving between main app and Back Office doesn't flash or re-draw */
  function showFrame() {
    var landing = document.getElementById("landing"), shell = document.getElementById("appShell"), app = document.getElementById("app");
    if (landing && shell) {
      landing.style.display = "none"; shell.style.display = "block";
      try { var saved = sessionStorage.getItem("osr-mi-tab"); if (saved && typeof switchTab === "function") switchTab(saved); } catch (e) {}
    }
    if (app && document.getElementById("authGate")) {
      app.style.display = "block";
      /* open the right section right now (the page itself loads its data once the server answers) */
      var all = ["staff", "schedule", "punch", "sales", "revenue"], want = new URLSearchParams(location.search).get("section");
      try { if (all.indexOf(want) < 0 && typeof loc !== "undefined") want = loc.get("section"); } catch (e) {}
      if (all.indexOf(want) < 0) want = "schedule";
      all.forEach(function (n) {
        var c = n.charAt(0).toUpperCase() + n.slice(1), p = document.getElementById("section" + c), b = document.getElementById("sectionBtn" + c);
        if (p) p.classList.toggle("active", n === want); if (b) b.classList.toggle("active", n === want);
      });
    }
  }
  /* the server says nobody is signed in after all: put the pages back the way they were */
  window.osrNoSession = function () {
    setFlag(false);
    if (embedded) { try { window.top.location.href = "/"; } catch (e) {} return; }
    var landing = document.getElementById("landing"), shell = document.getElementById("appShell"), app = document.getElementById("app");
    if (landing && shell) { landing.style.display = ""; shell.style.display = "none"; }
    if (app && document.getElementById("authGate")) app.style.display = "none";
  };
  if (flagged()) {
    window.osrApplyTheme();
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", showFrame); else showFrame();
  }
})();
