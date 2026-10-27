/* Billing screen for managers. Shows a full-screen "start your subscription" card when a restaurant hasn't paid yet
   (or its subscription ended), and a small bar when a payment failed or free access is about to end.
   Works on its own: it asks /api/billing/status and draws what is needed. Nothing is shown for restaurants that are fine. */
(function () {
  var T = {
    en: {
      unpaidH: "Start your subscription", unpaidB: "Open Shift Rail is $100 CAD per restaurant per month, plus tax, charged to your card every month. You can cancel any time.", unpaidBtn: "Pay by card",
      canceledH: "Your subscription has ended", canceledB: "Restart it to get back in. Your restaurant's data is kept.", canceledBtn: "Restart subscription",
      freeH: "Your free access has ended", freeB: "Add a card to keep using Open Shift Rail: $100 CAD per restaurant per month, plus tax.", freeBtn: "Add a card",
      waitH: "Confirming your payment…", waitB: "This takes a few seconds.", waitFail: "We have not heard back from the payment page yet. Reload in a minute, or write to support@openshiftrail.com.", reload: "Reload",
      logout: "Log out", err: "Could not open the payment page. Please try again.",
      pastDue: "Your last payment did not go through. Update your card to keep your account active.", update: "Update card",
      freeSoon: function (d) { return "Free access ends on " + d + ". Add a card so nothing is interrupted."; }, add: "Add a card"
    },
    fr: {
      unpaidH: "Démarrez votre abonnement", unpaidB: "Open Shift Rail coûte 100 $ CAD par restaurant par mois, plus les taxes, débités chaque mois sur votre carte. Vous pouvez annuler en tout temps.", unpaidBtn: "Payer par carte",
      canceledH: "Votre abonnement est terminé", canceledB: "Relancez-le pour revenir. Les données de votre restaurant sont conservées.", canceledBtn: "Relancer l'abonnement",
      freeH: "Votre accès gratuit est terminé", freeB: "Ajoutez une carte pour continuer à utiliser Open Shift Rail : 100 $ CAD par restaurant par mois, plus les taxes.", freeBtn: "Ajouter une carte",
      waitH: "Confirmation de votre paiement…", waitB: "Cela prend quelques secondes.", waitFail: "Nous n'avons pas encore reçu la confirmation. Rechargez dans une minute, ou écrivez à support@openshiftrail.com.", reload: "Recharger",
      logout: "Déconnexion", err: "Impossible d'ouvrir la page de paiement. Veuillez réessayer.",
      pastDue: "Votre dernier paiement n'est pas passé. Mettez votre carte à jour pour garder votre compte actif.", update: "Mettre la carte à jour",
      freeSoon: function (d) { return "L'accès gratuit se termine le " + d + ". Ajoutez une carte pour éviter toute interruption."; }, add: "Ajouter une carte"
    },
    es: {
      unpaidH: "Empieza tu suscripción", unpaidB: "Open Shift Rail cuesta 100 $ CAD por restaurante al mes, más impuestos, cobrados a tu tarjeta cada mes. Puedes cancelar cuando quieras.", unpaidBtn: "Pagar con tarjeta",
      canceledH: "Tu suscripción terminó", canceledB: "Reactívala para volver a entrar. Los datos de tu restaurante se conservan.", canceledBtn: "Reactivar suscripción",
      freeH: "Terminó tu acceso gratuito", freeB: "Añade una tarjeta para seguir usando Open Shift Rail: 100 $ CAD por restaurante al mes, más impuestos.", freeBtn: "Añadir tarjeta",
      waitH: "Confirmando tu pago…", waitB: "Tarda unos segundos.", waitFail: "Aún no recibimos la confirmación. Recarga en un minuto, o escribe a support@openshiftrail.com.", reload: "Recargar",
      logout: "Cerrar sesión", err: "No se pudo abrir la página de pago. Inténtalo de nuevo.",
      pastDue: "Tu último pago no se procesó. Actualiza tu tarjeta para mantener tu cuenta activa.", update: "Actualizar tarjeta",
      freeSoon: function (d) { return "Tu acceso gratuito termina el " + d + ". Añade una tarjeta para que nada se interrumpa."; }, add: "Añadir tarjeta"
    }
  };
  function lang() { var l = "en"; try { l = localStorage.getItem("osr-lang") || "en"; } catch (e) {} return T[l] ? l : "en"; }
  function tx() { return T[lang()]; }
  function embedded() { try { return window.top !== window; } catch (e) { return true; } }
  function call(path, method, body) {
    return fetch(path, { method: method || "GET", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); });
  }
  function toStripe(path, btn, errEl) {
    if (btn) btn.disabled = true;
    return call(path, "POST", { locale: lang() === "fr" ? "fr" : "en" }).then(function (r) {
      if (r.ok && r.data && r.data.url) { window.location.href = r.data.url; return true; }
      if (btn) btn.disabled = false;
      if (errEl) errEl.textContent = (r.data && r.data.error) || tx().err;
      return false;
    }).catch(function () { if (btn) btn.disabled = false; if (errEl) errEl.textContent = tx().err; return false; });
  }

  var CSS = "#osrPay{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;padding:20px;background:#F6F0E6;font:16px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#2C2620}" +
    "#osrPay .c{max-width:420px;width:100%;background:#FFFCF7;border:1px solid #EADFCE;border-radius:22px;padding:28px 24px;text-align:center;box-shadow:0 8px 30px rgba(90,58,5,.12)}" +
    "#osrPay .m{width:56px;height:56px;border-radius:16px;margin:0 auto 14px;background:#1C201D url('/icons/icon-192.png') center/cover no-repeat}" +
    "#osrPay h2{margin:0 0 8px;font-size:22px;letter-spacing:-.01em}#osrPay p{margin:0 0 18px;color:#7B6F61;font-size:15px}" +
    "#osrPay button,#osrPayBar button{font:inherit;font-weight:650;cursor:pointer;border:0;border-radius:999px}" +
    "#osrPay .go{width:100%;padding:13px 18px;background:#E8A33D;color:#2C2620;font-size:16px}#osrPay .go:disabled{opacity:.6;cursor:wait}" +
    "#osrPay .lo{margin-top:12px;background:none;color:#7B6F61;font-weight:500;font-size:14px;text-decoration:underline}" +
    "#osrPay .er{color:#C4452F;font-size:14px;min-height:20px;margin-top:10px}" +
    "#osrPayBar{position:fixed;left:0;right:0;bottom:0;z-index:99990;display:flex;gap:12px;align-items:center;justify-content:center;flex-wrap:wrap;padding:9px 14px;background:#FBE7C2;color:#5A3A05;font:600 14px/1.35 system-ui,sans-serif;text-align:center}" +
    "#osrPayBar button{padding:7px 16px;background:#E8A33D;color:#2C2620}";
  function style() {
    if (document.getElementById("osrPayCss")) return;
    var s = document.createElement("style"); s.id = "osrPayCss"; s.textContent = CSS; document.head.appendChild(s);
  }
  function clear() { var a = document.getElementById("osrPay"), b = document.getElementById("osrPayBar"); if (a) a.remove(); if (b) b.remove(); }
  function card(h, p, btnLabel, withAction) {
    style(); clear();
    var o = document.createElement("div"); o.id = "osrPay"; o.setAttribute("role", "dialog"); o.setAttribute("aria-modal", "true");
    o.innerHTML = '<div class="c"><div class="m" aria-hidden="true"></div><h2></h2><p></p><div class="act"></div><div class="er" role="alert"></div></div>';
    o.querySelector("h2").textContent = h; o.querySelector("p").textContent = p;
    var act = o.querySelector(".act"), er = o.querySelector(".er");
    if (withAction) {
      var go = document.createElement("button"); go.className = "go"; go.type = "button"; go.textContent = btnLabel;
      go.onclick = function () { toStripe("/api/billing/checkout", go, er); };
      act.appendChild(go);
      var lo = document.createElement("button"); lo.className = "lo"; lo.type = "button"; lo.textContent = tx().logout;
      lo.onclick = function () { call("/api/auth/logout", "POST").then(function () { window.location.href = "/"; }, function () { window.location.href = "/"; }); };
      act.appendChild(lo);
    }
    document.body.appendChild(o);
    return { overlay: o, act: act };
  }
  function bar(msg, label, path) {
    style(); clear();
    var b = document.createElement("div"); b.id = "osrPayBar";
    var s = document.createElement("span"); s.textContent = msg;
    var btn = document.createElement("button"); btn.type = "button"; btn.textContent = label;
    btn.onclick = function () { toStripe(path, btn, null); };
    b.appendChild(s); b.appendChild(btn); document.body.appendChild(b);
  }
  function fmt(ms) { try { return new Date(ms).toLocaleDateString(lang(), { year: "numeric", month: "long", day: "numeric" }); } catch (e) { return new Date(ms).toISOString().slice(0, 10); } }

  function render(st) {
    var t = tx();
    if (st.blocked) {
      if (st.status === "canceled") card(t.canceledH, t.canceledB, t.canceledBtn, true);
      else if (st.status === "free_ended") card(t.freeH, t.freeB, t.freeBtn, true);
      else card(t.unpaidH, t.unpaidB, t.unpaidBtn, true);
    } else if (st.status === "past_due") bar(t.pastDue, t.update, "/api/billing/portal");
    else if (st.status === "free" && st.freeUntil && st.freeUntil - Date.now() < 14 * 86400000) bar(t.freeSoon(fmt(st.freeUntil)), t.add, "/api/billing/checkout");
    else clear();
  }

  /* back from the payment page: the confirmation reaches us a moment later, so wait for it instead of showing the payment card again */
  function waitForPayment(tries) {
    var t = tx(), c = card(t.waitH, t.waitB, "", false);
    (function poll(n) {
      call("/api/billing/status").then(function (r) {
        if (r.ok && !r.data.blocked) { try { history.replaceState(null, "", location.pathname); } catch (e) {} clear(); window.location.reload(); return; }
        if (n <= 0) {
          c.overlay.querySelector("h2").textContent = t.waitH.replace("…", "");
          c.overlay.querySelector("p").textContent = t.waitFail;
          var b = document.createElement("button"); b.className = "go"; b.type = "button"; b.textContent = t.reload; b.onclick = function () { window.location.reload(); }; c.act.appendChild(b);
          return;
        }
        setTimeout(function () { poll(n - 1); }, 2000);
      }, function () { setTimeout(function () { poll(n - 1); }, 2000); });
    })(tries || 15);
  }

  /* opts.onStatus(status) is called with the answer (the main menu uses it for "Manage billing") */
  window.osrBillingCheck = function (opts) {
    if (embedded()) return;
    call("/api/billing/status").then(function (r) {
      if (!r.ok) return;
      var back = /[?&]billing=success/.test(location.search);
      if (back && r.data.blocked) waitForPayment(15); else render(r.data);
      if (opts && opts.onStatus) opts.onStatus(r.data);
    });
  };
  /* right after sign-up: a restaurant that has to pay goes straight to the payment page. Resolves true if it is leaving the page. */
  window.osrBillingStart = function () {
    return call("/api/billing/status").then(function (r) {
      if (r.ok && r.data.status === "unpaid" && r.data.configured) return toStripe("/api/billing/checkout", null, null);
      return false;
    }).catch(function () { return false; });
  };
  window.osrBillingPortal = function () { return toStripe("/api/billing/portal", null, null); };
})();
