/* Clean theme, part 2: one slim navigation bar instead of two stacked bars (demo restaurant only).
   It only moves existing elements into a "More" menu, so every button keeps its behaviour. Loaded by demo-banner.js. */
(function () {
  var MORE = { en: "More", fr: "Plus", es: "Más" };
  function lang() { try { return localStorage.getItem("osr-lang") || "en"; } catch (e) { return "en"; } }
  function makeMenu(bar) {
    var wrap = document.createElement("div"); wrap.className = "cn-more";
    var btn = document.createElement("button"); btn.type = "button"; btn.className = "cn-trigger";
    btn.setAttribute("aria-haspopup", "true"); btn.setAttribute("aria-expanded", "false");
    btn.innerHTML = '<span class="cn-label"></span><svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="3" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="13" cy="8" r="1.4"/></svg>';
    btn.querySelector(".cn-label").textContent = MORE[lang()] || MORE.en;
    var panel = document.createElement("div"); panel.className = "cn-panel"; panel.hidden = true;
    wrap.appendChild(btn); wrap.appendChild(panel); bar.appendChild(wrap);
    function close() { panel.hidden = true; btn.setAttribute("aria-expanded", "false"); }
    btn.addEventListener("click", function (e) { e.stopPropagation(); panel.hidden = !panel.hidden; btn.setAttribute("aria-expanded", String(!panel.hidden)); });
    document.addEventListener("click", function (e) { if (!wrap.contains(e.target)) close(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
    panel.addEventListener("click", function (e) { if (e.target.closest(".nav-stub, a, #logoutBtn")) close(); });
    return panel;
  }
  function sep(panel) { var s = document.createElement("div"); s.className = "cn-sep"; panel.appendChild(s); }

  function mainApp() {
    var bar = document.getElementById("sidebar"), top = document.getElementById("topbarNew");
    if (!bar || !top || bar.querySelector(".cn-more")) return false;
    var mark = top.querySelector(".topbar-mark"); if (mark) bar.insertBefore(mark, bar.firstChild);
    var panel = makeMenu(bar);
    ["tabBtnTraining", "tabBtnHiring"].forEach(function (id) { var b = document.getElementById(id); if (b) panel.appendChild(b); });
    sep(panel);
    var right = document.getElementById("topbarRight");
    if (right) { while (right.firstChild) panel.appendChild(right.firstChild); }
    return true;
  }
  function backOffice() {
    var head = document.querySelector("header"), bar = document.querySelector("nav.sections");
    if (!head || !bar || bar.querySelector(".cn-more")) return false;
    var left = head.querySelector(".header-left"); if (left) bar.insertBefore(left, bar.firstChild);
    var panel = makeMenu(bar);
    var right = document.getElementById("hdrRight");
    if (right) { right.style.display = "flex"; panel.appendChild(right); }
    return true;
  }
  window.cleanNav = function () { if (!mainApp()) backOffice(); };
})();
