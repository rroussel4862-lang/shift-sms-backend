/* A thin bar shown only inside the demo restaurant, so a prospect always knows the data is made up. */
(function () {
  var TEXT = {
    en: "Demo: made-up restaurant and sample data. It resets every night.",
    fr: "Démo : restaurant fictif et données d'exemple. Réinitialisé chaque nuit.",
    es: "Demo: restaurante ficticio con datos de ejemplo. Se reinicia cada noche."
  };
  window.showDemoBanner = function () {
    if (document.getElementById("demoBanner")) return;
    var lang = "en";
    try { lang = localStorage.getItem("osr-lang") || "en"; } catch (e) {}
    var bar = document.createElement("div");
    bar.id = "demoBanner";
    bar.textContent = TEXT[lang] || TEXT.en;
    bar.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:9999;background:#23261f;color:#f4e9c9;font:600 12px/1.3 system-ui,sans-serif;text-align:center;padding:6px 10px;letter-spacing:.02em";
    document.body.appendChild(bar);
    document.body.style.paddingBottom = "30px";
  };
})();
