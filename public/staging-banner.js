/* Staging copy only: a bright bar at the top so nobody mistakes it for the real site. Shows nothing on the real site. */
(function () {
  try { if (window.top !== window) return; } catch (e) { return; }   // inside the one-page app, the outer page shows it
  fetch("/api/health").then(function (r) { return r.json(); }).then(function (h) {
    if (!h || !h.staging) return;
    var bar = document.createElement("div");
    bar.textContent = "STAGING: test copy with fake data. Texts are switched off.";
    bar.style.cssText = "position:sticky;top:0;z-index:99999;background:#E2A33B;color:#161B22;font:700 12px/1.3 system-ui,sans-serif;text-align:center;padding:6px 10px;letter-spacing:.02em";
    document.body.insertBefore(bar, document.body.firstChild);
  }).catch(function () {});
})();
