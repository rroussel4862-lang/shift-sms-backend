/* Open Shift Rail — "Getting started" walk-through.
   Bubble tour (spotlight + speech bubble) shared by the manager interface (/), the back office and the staff portal, plus the
   "Getting started" checklist card on the manager Overview. Progress is saved on the server per person, so the tour resumes
   where it stopped (even on another page or device) and never nags after it's finished or skipped.

   Pages call OSRTour.init({ tour, page, views, helpMount, canStart }) once the person is logged in.
     tour      "manager" | "staff"
     page      "mi" | "bo" | "si"  — which page this is (the tour hops between pages by itself)
     views     { name: fn } — how this page opens each view a step needs (a tab, a section …)
     helpMount CSS selector of a container that gets the round "?" replay button
     canStart  false on pages that must not START a brand-new tour (the back office only ever resumes one)  */
(function () {
  "use strict";

  /* ---------------------------------------------------------------- text
     All wording lives in /tour-texts.js (every line has a code, e.g. M04) so it can be edited without touching this file. */
  var X = window.OSR_TOUR_TEXTS || {};
  var CL_CODE = { staff: "C1", login: "C2", services: "C3", schedule: "C4", sales: "C5", post: "C6" };

  // Where each step happens: page, the view to open there, and the element(s) to spotlight (first visible one wins).
  var STEPS = {
    manager: [
      { code: "M01", page: "mi", view: "overview", sel: null },
      { code: "M02", page: "mi", view: "overview", sel: ["#overviewGrid"] },
      { code: "M03", page: "mi", view: "staff", sel: ["#panelStaff .stub.plain"] },
      { code: "M04", page: "mi", view: "staff", sel: ["#staffList .row-actions .edit-btn", "#staffList"] },
      { code: "M05", page: "bo", view: "schedule", sel: ["#sectionSchedule .grid-wrap"] },
      { code: "M06", page: "bo", view: "schedule", sel: ["#aiSched"] },
      { code: "M07", page: "bo", view: "schedule", sel: ["#pubBar", "#sectionSchedule .week-nav"] },
      { code: "M08", page: "bo", view: "sales", sel: ["#sectionSales .sales-wrap", "#sectionSales .week-nav"] },
      { code: "M09", page: "bo", view: "schedule", sel: ["#sectionSchedule tr.sales-ac", "#sectionSchedule .grid-wrap"] },
      { code: "M10", page: "bo", view: "punch", sel: ["#punchList", "#sectionPunch .week-nav"] },
      { code: "M11", page: "mi", view: "overview", sel: null }
    ],
    staff: [
      { code: "S01", page: "si", view: "schedule", sel: ["#myScheduleList"] },
      { code: "S02", page: "si", view: "availability", sel: ["#tabBtnAvailability"] },
      { code: "S03", page: "si", view: "open", sel: ["#tabBtnOpen"] },
      { code: "S04", page: "si", view: "board", sel: ["#tabBtnBoard"] }
    ]
  };

  var PAGE_URL = { mi: "/", bo: "/backoffice.html", si: "/staff-portal.html" };
  var API = { manager: "/api/tour", staff: "/api/staff-auth/tour" };

  /* --------------------------------------------------------------- state */
  var cfg = null, idx = 0, running = false, paused = false;
  var elOv = null, elSpot = null, elBub = null, curTarget = null, rafId = 0;
  var clLast = 0, clData = null;

  function lang() {
    var l = "en";
    try { l = localStorage.getItem("osr-lang") || "en"; } catch (e) {}
    return l === "fr" || l === "es" ? l : "en";
  }
  // one piece of wording by code, in the current language (English if that language is missing)
  function L(code) { var e = X[code] || {}; return e[lang()] || e.en || code; }
  function ui() {
    return {
      next: L("L01"), back: L("L02"), skip: L("L03"), finish: L("L04"), help: L("L05"), pausedT: L("L06"), pausedB: L("L07"), cont: L("L08"),
      clTitle: L("L09"), clHide: L("L10"), clReplay: L("L11"), clDoneT: L("L12"), clDoneB: L("L13"),
      of: function (a, b) { return a + " / " + b; }
    };
  }
  // ?codes=1 in the address shows each bubble's code (for editing the wording); ?codes=0 hides it again
  function showCodes() {
    try {
      var m = /[?&]codes=([01])/.exec(location.search);
      if (m) sessionStorage.setItem("osr-tour-codes", m[1]);
      return sessionStorage.getItem("osr-tour-codes") === "1";
    } catch (e) { return false; }
  }
  function steps() { return STEPS[cfg.tour]; }
  function text(i) { var e = X[steps()[i].code] || {}; return e[lang()] || e.en || [steps()[i].code, ""]; }
  // every visible string goes through esc(); in French a space before ? ! : is a non-breaking one
  function esc(s) {
    s = String(s);
    if (lang() === "fr") s = s.replace(/ ([?!:;»])/g, "\u00a0$1");
    return s.replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; });
  }

  function api(method, body) {
    var opts = { method: method, headers: { "Content-Type": "application/json" }, credentials: "same-origin" };
    if (body) opts.body = JSON.stringify(body);
    return fetch(API[cfg.tour], opts).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }
  function save(status, step) { return api("PUT", { status: status, step: step }); }

  /* ------------------------------------------------------------- styling */
  function injectCss() {
    if (document.getElementById("osrTourCss")) return;
    var css = [
      ".osr-tour-ov{position:fixed;inset:0;z-index:99990;background:transparent}",
      ".osr-tour-ov.dim{background:rgba(10,12,10,.66)}",
      ".osr-tour-spot{position:fixed;z-index:99991;border-radius:12px;box-shadow:0 0 0 9999px rgba(10,12,10,.66),0 0 0 3px #E2A33B,0 0 24px 4px rgba(226,163,59,.55);pointer-events:none;transition:top .28s ease,left .28s ease,width .28s ease,height .28s ease}",
      ".osr-bub{position:fixed;z-index:99992;width:340px;max-width:calc(100vw - 24px);box-sizing:border-box;background:#F0EAD8;color:#23261F;border-radius:16px;padding:16px 18px 14px;font:14px/1.5 'IBM Plex Sans',system-ui,sans-serif;box-shadow:0 14px 40px rgba(0,0,0,.45);animation:osrPop .32s cubic-bezier(.2,1.4,.4,1)}",
      "@keyframes osrPop{0%{opacity:0;transform:scale(.88) translateY(8px)}100%{opacity:1;transform:none}}",
      ".osr-bub h4{margin:0 0 6px;font:700 18px/1.25 'Oswald','IBM Plex Sans',sans-serif;letter-spacing:.01em}",
      ".osr-bub p{margin:0 0 12px;font-size:14px;color:#3a3d33}",
      ".osr-bub .osr-count{position:absolute;top:12px;right:16px;font:600 11px 'IBM Plex Mono',monospace;color:#7a7566}",
      ".osr-bub .osr-code{background:#23261F;color:#E2A33B;border-radius:5px;padding:1px 6px;margin-right:4px}",
      ".osr-bub .osr-dots{display:flex;gap:4px;margin:0 0 12px}",
      ".osr-bub .osr-dots i{width:7px;height:7px;border-radius:50%;background:#d6cfba}",
      ".osr-bub .osr-dots i.on{background:#E2A33B}",
      ".osr-bub .osr-dots i.cur{background:#23261F;transform:scale(1.25)}",
      ".osr-bub .osr-row{display:flex;align-items:center;gap:8px}",
      ".osr-bub .osr-grow{flex:1}",
      ".osr-bub button{font:600 13px 'IBM Plex Sans',system-ui,sans-serif;border-radius:9px;padding:8px 14px;cursor:pointer;border:1.5px solid #23261F;background:transparent;color:#23261F}",
      ".osr-bub button.osr-primary{background:#E2A33B;border-color:#E2A33B;color:#23261F}",
      ".osr-bub button.osr-primary:hover{filter:brightness(1.06);transform:translateY(-1px)}",
      ".osr-bub button.osr-link{border:0;padding:8px 2px;color:#7a7566;text-decoration:underline;font-weight:500}",
      ".osr-bub .osr-arrow{position:absolute;width:16px;height:16px;background:#F0EAD8;transform:rotate(45deg);border-radius:3px}",
      ".osr-bub.below .osr-arrow{top:-7px}.osr-bub.above .osr-arrow{bottom:-7px}",
      ".osr-help{width:30px;height:30px;border-radius:50%;border:1.5px solid #E2A33B;background:transparent;color:#E2A33B;font:700 15px 'Oswald','IBM Plex Sans',sans-serif;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0;flex:none}",
      ".osr-help:hover{background:#E2A33B;color:#23261F}",
      ".osr-cl{background:#F0EAD8;color:#23261F;border-radius:14px;padding:14px 16px;margin:0 0 16px;font:14px/1.45 'IBM Plex Sans',system-ui,sans-serif;border-left:6px solid #E2A33B}",
      ".osr-cl-head{display:flex;align-items:center;gap:10px}",
      ".osr-cl-head b{font:700 17px 'Oswald','IBM Plex Sans',sans-serif;letter-spacing:.01em}",
      ".osr-cl-head .osr-n{font:600 12px 'IBM Plex Mono',monospace;color:#7a7566}",
      ".osr-cl-head .osr-sp{flex:1}",
      ".osr-cl button.osr-x{border:0;background:transparent;color:#7a7566;cursor:pointer;font:500 12px 'IBM Plex Sans',sans-serif;text-decoration:underline;padding:2px}",
      ".osr-cl-bar{height:6px;border-radius:3px;background:#d6cfba;margin:8px 0 10px;overflow:hidden}",
      ".osr-cl-bar i{display:block;height:100%;background:#5C8C6B;border-radius:3px;transition:width .4s}",
      ".osr-cl ul{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:2px 16px}",
      ".osr-cl li button{all:unset;box-sizing:border-box;display:flex;gap:8px;align-items:center;width:100%;padding:5px 2px;cursor:pointer;border-radius:6px}",
      ".osr-cl li button:hover{background:rgba(35,38,31,.07)}",
      ".osr-cl li .osr-box{width:18px;height:18px;border-radius:50%;border:2px solid #b9b199;display:inline-flex;align-items:center;justify-content:center;font-size:11px;color:#fff;flex:none}",
      ".osr-cl li.done .osr-box{background:#5C8C6B;border-color:#5C8C6B}",
      ".osr-cl li.done span.osr-t{text-decoration:line-through;color:#7a7566}",
      ".osr-cl .osr-foot{margin-top:8px}",
      "@media (max-width:560px){.osr-bub{width:auto}}"
    ].join("\n");
    var st = document.createElement("style");
    st.id = "osrTourCss"; st.textContent = css;
    document.head.appendChild(st);
  }

  /* ------------------------------------------------------------ the bubble */
  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function findTarget(sels) {
    if (!sels) return null;
    for (var i = 0; i < sels.length; i++) {
      var el = document.querySelector(sels[i]);
      if (visible(el)) return el;
    }
    return null;
  }
  // Wait (briefly) for a view to finish rendering, then hand back the element to spotlight (or null).
  function waitTarget(sels, cb) {
    var t0 = Date.now();
    (function poll() {
      var el = findTarget(sels);
      if (el || !sels || Date.now() - t0 > 1600) return cb(el);
      setTimeout(poll, 80);
    })();
  }

  function teardown() {
    running = false; paused = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0; curTarget = null;
    [elOv, elSpot, elBub].forEach(function (e) { if (e && e.parentNode) e.parentNode.removeChild(e); });
    elOv = elSpot = elBub = null;
    window.removeEventListener("resize", schedulePlace);
    window.removeEventListener("scroll", schedulePlace, true);
    document.removeEventListener("keydown", onKey, true);
  }
  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); skip(); }
    else if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); next(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); back(); }
  }

  function ensureLayer() {
    if (elOv) return;
    injectCss();
    elOv = document.createElement("div"); elOv.className = "osr-tour-ov dim";
    elSpot = document.createElement("div"); elSpot.className = "osr-tour-spot"; elSpot.style.display = "none";
    elBub = document.createElement("div"); elBub.className = "osr-bub"; elBub.setAttribute("role", "dialog");
    document.body.appendChild(elOv); document.body.appendChild(elSpot); document.body.appendChild(elBub);
    window.addEventListener("resize", schedulePlace);
    window.addEventListener("scroll", schedulePlace, true);
    document.addEventListener("keydown", onKey, true);
  }

  function schedulePlace() {
    if (rafId) return;
    rafId = requestAnimationFrame(function () { rafId = 0; place(); });
  }

  function place() {
    if (!elBub) return;
    var vw = window.innerWidth, vh = window.innerHeight, pad = 8;
    var bw = elBub.offsetWidth, bh = elBub.offsetHeight;
    var arrow = elBub.querySelector(".osr-arrow");
    elBub.classList.remove("above", "below");
    if (arrow) arrow.style.display = "none";

    if (!curTarget || !visible(curTarget)) {
      // no element to point at: dim everything and sit in the middle of the screen
      elSpot.style.display = "none"; elOv.classList.add("dim");
      elBub.style.left = Math.max(12, (vw - bw) / 2) + "px";
      elBub.style.top = Math.max(12, (vh - bh) / 2) + "px";
      elBub.style.bottom = "auto";
      return;
    }
    elOv.classList.remove("dim");
    var r = curTarget.getBoundingClientRect();
    // only the part of a tall target that is on screen gets lit up
    var top = Math.max(r.top - pad, 6), bottom = Math.min(r.bottom + pad, vh - 6);
    var left = Math.max(r.left - pad, 6), right = Math.min(r.right + pad, vw - 6);
    elSpot.style.display = "block";
    elSpot.style.top = top + "px"; elSpot.style.left = left + "px";
    elSpot.style.width = Math.max(0, right - left) + "px"; elSpot.style.height = Math.max(0, bottom - top) + "px";

    var small = vw < 560;
    var cx = (left + right) / 2;
    var below = vh - bottom, above = top;
    var bl, bt, side = null;
    if (small) {
      bl = 12; bt = Math.max(12, vh - bh - 12);
      if (bt < bottom && bt + bh > top) { bt = above >= bh + 20 ? top - bh - 14 : bt; }
    } else if (below >= bh + 22) {
      side = "below"; bt = bottom + 14; bl = Math.min(Math.max(cx - bw / 2, 12), vw - bw - 12);
    } else if (above >= bh + 22) {
      side = "above"; bt = top - bh - 14; bl = Math.min(Math.max(cx - bw / 2, 12), vw - bw - 12);
    } else if (vw - right >= bw + 24) {
      bl = right + 14; bt = Math.min(Math.max(top, 12), vh - bh - 12);
    } else if (left >= bw + 24) {
      bl = left - bw - 14; bt = Math.min(Math.max(top, 12), vh - bh - 12);
    } else {
      // target fills the screen: park the bubble at the bottom, over the lit area
      bl = Math.max(12, (vw - bw) / 2); bt = vh - bh - 16;
    }
    elBub.style.left = bl + "px"; elBub.style.top = bt + "px"; elBub.style.bottom = "auto";
    if (side && arrow) {
      elBub.classList.add(side);
      arrow.style.display = "block";
      arrow.style.left = Math.min(Math.max(cx - bl - 8, 18), bw - 34) + "px";
    }
  }

  function dotsHtml(i, n) {
    var h = "";
    for (var k = 0; k < n; k++) h += '<i class="' + (k < i ? "on" : k === i ? "cur" : "") + '"></i>';
    return '<div class="osr-dots">' + h + "</div>";
  }

  function render(i, el) {
    ensureLayer();
    var n = steps().length, tx = text(i), u = ui();
    var last = i === n - 1;
    elBub.innerHTML =
      '<div class="osr-arrow"></div><span class="osr-count">' + (showCodes() ? '<b class="osr-code">' + esc(steps()[i].code) + "</b> " : "") + esc(u.of(i + 1, n)) + "</span>" +
      "<h4>" + esc(tx[0]) + "</h4><p>" + esc(tx[1]) + "</p>" + dotsHtml(i, n) +
      '<div class="osr-row">' +
      '<button type="button" class="osr-link" data-a="skip">' + esc(u.skip) + "</button>" +
      '<span class="osr-grow"></span>' +
      (i > 0 ? '<button type="button" data-a="back">' + esc(u.back) + "</button>" : "") +
      '<button type="button" class="osr-primary" data-a="next">' + esc(last ? u.finish : u.next) + "</button></div>";
    wireButtons();
    curTarget = el;
    if (el) {
      var r = el.getBoundingClientRect(), vh = window.innerHeight;
      if (r.height > vh * 0.7) { el.scrollIntoView({ block: "start" }); window.scrollBy(0, -90); }
      else if (r.top < 70 || r.bottom > vh - 70) el.scrollIntoView({ block: "center" });
    }
    place();
    // fonts / images can change the bubble's height a moment later
    setTimeout(schedulePlace, 120);
  }

  function wireButtons() {
    elBub.querySelectorAll("button[data-a]").forEach(function (b) {
      b.addEventListener("click", function (ev) {
        ev.stopPropagation();
        var a = b.getAttribute("data-a");
        if (a === "next") next(); else if (a === "back") back(); else if (a === "skip") skip(); else if (a === "go") goHere();
      });
    });
  }

  /* ----------------------------------------------------------- navigation */
  function openStep(i) {
    var s = steps()[i];
    running = true; paused = false; idx = i;
    if (s.page !== cfg.page) {            // this step lives on another page — save our place and hop over
      save("active", i).then(function () { window.location.href = PAGE_URL[s.page]; });
      return;
    }
    var open = cfg.views && cfg.views[s.view];
    try { if (open) open(); } catch (e) {}
    waitTarget(s.sel, function (el) { if (running && idx === i) render(i, el); });
  }
  function next() {
    if (!running) return;
    if (idx >= steps().length - 1) return finish();
    save("active", idx + 1);
    openStep(idx + 1);
  }
  function back() {
    if (!running || idx === 0) return;
    save("active", idx - 1);
    openStep(idx - 1);
  }
  function finish() {
    save("done", 0);
    teardown();
    clLast = 0; refreshChecklist(true);
  }
  function skip() {
    save("skipped", idx);
    teardown();
  }
  function goHere() { // from the "tour paused" bubble
    var s = steps()[idx];
    window.location.href = PAGE_URL[s.page];
  }

  function showPaused() {
    var u = ui();
    running = true; paused = true;
    ensureLayer();
    elBub.innerHTML =
      "<h4>" + esc(u.pausedT) + "</h4><p>" + esc(u.pausedB) + "</p>" +
      '<div class="osr-row"><button type="button" class="osr-link" data-a="skip">' + esc(u.skip) + "</button>" +
      '<span class="osr-grow"></span><button type="button" class="osr-primary" data-a="go">' + esc(u.cont) + "</button></div>";
    wireButtons();
    curTarget = null;
    place();
  }

  /* ------------------------------------------------------------- start-up */
  function startFromServer() {
    return api("GET").then(function (d) {
      if (!d || !d.tour) return;
      if (d.checklist) renderChecklist(d.checklist);
      var st = d.tour.status, step = Math.min(Math.max(d.tour.step || 0, 0), steps().length - 1);
      if (st === "new") {
        if (cfg.canStart === false) return;
        save("active", 0); setTimeout(function () { openStep(0); }, 500);
      } else if (st === "active") {
        idx = step;
        if (steps()[step].page === cfg.page) setTimeout(function () { openStep(step); }, 400);
        else showPaused();
      }
    });
  }

  function replay() {
    try { localStorage.removeItem("osr-cl-hide"); } catch (e) {}
    if (running) teardown();
    save("active", 0).then(function () {
      if (steps()[0].page === cfg.page) openStep(0);
      else window.location.href = PAGE_URL[steps()[0].page];
    });
    clLast = 0; refreshChecklist(true);
  }

  function mountHelp() {
    if (!cfg.helpMount) return;
    var box = document.querySelector(cfg.helpMount);
    if (!box || box.querySelector(".osr-help")) return;
    injectCss();
    var b = document.createElement("button");
    b.type = "button"; b.className = "osr-help"; b.textContent = "?";
    b.title = ui().help; b.setAttribute("aria-label", ui().help);
    b.addEventListener("click", replay);
    box.insertBefore(b, box.firstChild);
  }

  /* ------------------------------------------------------------ checklist */
  var CL_GO = { staff: "staff", login: "staff" };      // MI views; everything else lives in the back office
  var CL_BO = { services: "schedule", schedule: "schedule", sales: "sales", post: "schedule" };

  function clHidden() { try { return localStorage.getItem("osr-cl-hide") === "1"; } catch (e) { return false; } }

  function renderChecklist(cl) {
    clData = cl;
    var box = document.getElementById("gettingStarted");
    if (!box || cfg.tour !== "manager") return;
    var u = ui();
    if (clHidden()) { box.innerHTML = ""; return; }
    var done = cl.items.filter(function (i) { return i.done; }).length, n = cl.items.length;
    if (cl.allDone) {
      box.innerHTML = '<div class="osr-cl"><div class="osr-cl-head"><b>' + esc(u.clDoneT) + '</b><span class="osr-sp"></span><button type="button" class="osr-x" data-x="hide">' + esc(u.clHide) + '</button></div><div style="margin-top:6px">' + esc(u.clDoneB) + "</div></div>";
    } else {
      var li = cl.items.map(function (it) {
        return '<li class="' + (it.done ? "done" : "") + '"><button type="button" data-go="' + it.key + '"><span class="osr-box">' + (it.done ? "✓" : "") + '</span><span class="osr-t">' + esc(L(CL_CODE[it.key])) + "</span></button></li>";
      }).join("");
      box.innerHTML = '<div class="osr-cl"><div class="osr-cl-head"><b>' + esc(u.clTitle) + '</b><span class="osr-n">' + done + " / " + n + '</span><span class="osr-sp"></span><button type="button" class="osr-x" data-x="replay">' + esc(u.clReplay) + '</button><button type="button" class="osr-x" data-x="hide">' + esc(u.clHide) + "</button></div>" +
        '<div class="osr-cl-bar"><i style="width:' + Math.round(done / n * 100) + '%"></i></div><ul>' + li + "</ul></div>";
    }
    box.querySelectorAll("[data-x]").forEach(function (b) {
      b.addEventListener("click", function () {
        if (b.getAttribute("data-x") === "replay") return replay();
        try { localStorage.setItem("osr-cl-hide", "1"); } catch (e) {}
        box.innerHTML = "";
      });
    });
    box.querySelectorAll("[data-go]").forEach(function (b) {
      b.addEventListener("click", function () {
        var k = b.getAttribute("data-go");
        if (CL_GO[k] && cfg.views && cfg.views[CL_GO[k]]) cfg.views[CL_GO[k]]();
        else window.location.href = PAGE_URL.bo + "?section=" + (CL_BO[k] || "schedule");
      });
    });
  }

  function refreshChecklist(force) {
    if (!cfg || cfg.tour !== "manager" || !document.getElementById("gettingStarted")) return;
    if (!force && Date.now() - clLast < 10000) { if (clData) renderChecklist(clData); return; }
    clLast = Date.now();
    api("GET").then(function (d) { if (d && d.checklist) renderChecklist(d.checklist); });
  }

  /* ----------------------------------------------------------------- API */
  window.OSRTour = {
    init: function (c) {
      if (!window.OSR_TOUR_TEXTS) return; // wording file missing: stay silent rather than show broken bubbles
      cfg = c;
      mountHelp();
      return startFromServer();
    },
    replay: function () { if (cfg) replay(); },
    refreshChecklist: function (force) { refreshChecklist(force); },
    // for the pages' language switchers: redraw whatever is showing in the new language
    relang: function () {
      if (!cfg) return;
      var h = document.querySelector(".osr-help"); if (h) { h.title = ui().help; h.setAttribute("aria-label", ui().help); }
      if (clData) renderChecklist(clData);
      if (paused) showPaused();
      else if (running && elBub && steps()[idx] && steps()[idx].page === cfg.page) render(idx, curTarget);
    },
    _steps: STEPS, _texts: X
  };
})();
