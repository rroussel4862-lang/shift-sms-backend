/* Shared, tiny i18n helper for the simple pages (staff portal, claim page, apply page, back office).
   The manager interface (index.html) has its own richer T/t() but uses the same "osr-lang" key,
   so the chosen language follows the person from page to page. */
(function () {
  var LANGS = [{ code: "en", label: "EN" }, { code: "fr", label: "FR" }, { code: "es", label: "ES" }];
  var LOCALES = { en: "en-CA", fr: "fr-CA", es: "es-US" };
  var dict = { en: {}, fr: {}, es: {} };
  var listeners = [];
  var lang = "en";
  try {
    var saved = localStorage.getItem("osr-lang");
    if (saved && dict[saved]) lang = saved;
    else if (/^fr/i.test(navigator.language || "")) lang = "fr";
    else if (/^es/i.test(navigator.language || "")) lang = "es";
  } catch (e) {}

  function add(d) {
    Object.keys(d).forEach(function (code) {
      if (!dict[code]) dict[code] = {};
      Object.assign(dict[code], d[code]);
    });
  }

  function t(key) {
    var args = Array.prototype.slice.call(arguments, 1);
    var v = dict[lang][key];
    if (v === undefined) v = dict.en[key];
    if (v === undefined) return key;
    return typeof v === "function" ? v.apply(null, args) : v;
  }

  function apply() {
    document.documentElement.lang = lang;
    document.querySelectorAll("[data-i18n]").forEach(function (el) { el.textContent = t(el.getAttribute("data-i18n")); });
    document.querySelectorAll("[data-i18n-ph]").forEach(function (el) { el.placeholder = t(el.getAttribute("data-i18n-ph")); });
    document.querySelectorAll("[data-i18n-label]").forEach(function (el) { el.setAttribute("data-label", t(el.getAttribute("data-i18n-label"))); });
    document.querySelectorAll("[data-i18n-title]").forEach(function (el) { el.title = t(el.getAttribute("data-i18n-title")); });
    var titleKey = document.documentElement.getAttribute("data-title-key");
    if (titleKey) document.title = t(titleKey);
    renderSwitchers();
  }

  function renderSwitchers() {
    document.querySelectorAll(".i18n-switch").forEach(function (box) {
      box.innerHTML = LANGS.map(function (l) {
        return '<button type="button" class="i18n-btn' + (l.code === lang ? " active" : "") + '" data-lang="' + l.code + '">' + l.label + "</button>";
      }).join("");
      box.querySelectorAll("button").forEach(function (b) {
        b.addEventListener("click", function () { setLang(b.getAttribute("data-lang")); });
      });
    });
  }

  function setLang(code) {
    if (!dict[code]) return;
    lang = code;
    try { localStorage.setItem("osr-lang", code); } catch (e) {}
    apply();
    listeners.forEach(function (fn) { try { fn(code); } catch (e) {} });
  }

  function onChange(fn) { listeners.push(fn); }

  function formatDate(dateStr) {
    var d = new Date(dateStr + "T00:00:00");
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString(LOCALES[lang], { weekday: "short", month: "short", day: "numeric" });
  }

  function formatTime(hhmm) {
    var p = String(hhmm || "").split(":").map(Number);
    var h = p[0], m = p[1] || 0;
    if (isNaN(h)) return hhmm;
    if (lang === "fr") return h + " h" + (m ? " " + String(m).padStart(2, "0") : "");
    var period = h >= 12 ? "PM" : "AM";
    var h12 = h % 12 === 0 ? 12 : h % 12;
    return h12 + ":" + String(m).padStart(2, "0") + " " + period;
  }

  var style = document.createElement("style");
  style.textContent =
    ".i18n-switch{display:flex;gap:4px;justify-content:center}" +
    ".i18n-btn{background:none;border:1px solid #454C46;color:#9BA39C;font-family:inherit;font-size:11px;letter-spacing:.04em;padding:4px 8px;border-radius:4px;cursor:pointer;width:auto;margin:0}" +
    ".i18n-btn.active{background:#E2A33B;border-color:#E2A33B;color:#23261F}";
  document.head.appendChild(style);

  window.I18N = {
    add: add, t: t, apply: apply, setLang: setLang, onChange: onChange,
    formatDate: formatDate, formatTime: formatTime,
    get lang() { return lang; }
  };
})();
