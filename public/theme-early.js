/* Runs first thing in <body> on the main app, Back Office and staff portal. If this browser tab is inside the demo
   restaurant, it puts the demo look on straight away, so moving between pages doesn't flash the old design first.
   It does nothing for real restaurants. (The demo flag lives only in this tab's session storage.) */
(function () {
  var KEY = "osr-demo-theme";
  function flagged() { try { return sessionStorage.getItem(KEY) === "1"; } catch (e) { return false; } }
  function plain() { try { var q = new URLSearchParams(location.search).get("theme"); if (q) sessionStorage.setItem("osr-theme", q); return sessionStorage.getItem("osr-theme") === "clean"; } catch (e) { return false; } }
  function add(tag, id, attrs) {
    if (document.getElementById(id)) return;
    if (document.readyState === "loading") document.write("<" + tag + ' id="' + id + '" ' + attrs + (tag === "script" ? "></" + tag + ">" : ">"));
    else { var el = document.createElement(tag); el.id = id; attrs.replace(/(\w+)="([^"]*)"/g, function (m, k, v) { el.setAttribute(k, v); }); (tag === "script" ? document.body : document.head).appendChild(el); if (tag === "script") el.onload = function () { if (window.cleanNav) window.cleanNav(); }; }
  }
  window.osrApplyTheme = function () {
    try { sessionStorage.setItem(KEY, "1"); } catch (e) {}
    document.body.classList.add("theme-clean");
    add("link", "themeCleanCss", 'rel="stylesheet" href="/theme-clean.css"');
    if (!plain()) { document.body.classList.add("theme-warm"); add("link", "themeWarmCss", 'rel="stylesheet" href="/theme-warm.css"'); }
    add("script", "themeCleanJs", 'src="/theme-clean.js"');
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { if (window.cleanNav) window.cleanNav(); });
    else if (window.cleanNav) window.cleanNav();
  };
  /* this tab was in the demo a moment ago, so assume it still is; the page confirms or corrects this once it hears from the server */
  window.osrNotDemo = function () { if (flagged()) { try { sessionStorage.removeItem(KEY); } catch (e) {} location.reload(); } };
  if (flagged()) window.osrApplyTheme();
})();
