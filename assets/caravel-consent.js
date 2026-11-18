// Ride24 — Caravel pre-Stripe consent (WWW). Shown only for the Caravel partner.
// Everything displayed comes from the server (caravel-booking-request
// "consent-view"): the released, re-hashed clauses/v1 terms (server-escaped HTML),
// the quote's exclusions, the exact administration fee and the money split.
// The browser only echoes what it was shown; the backend and the SQL RPC verify it.
(function () {
  "use strict";
  var PARTNER = "78721481-7619-44df-a9b7-5faa344b69bb";
  var state = { active: false, view: null, quoteId: null };

  function byId(id) { return document.getElementById(id); }
  function text(tag, value, style) {
    var n = document.createElement(tag);
    n.textContent = value == null ? "" : String(value);
    if (style) n.setAttribute("style", style);
    return n;
  }
  function isEnglish() {
    try { return localStorage.getItem("client_lang") === "en"; } catch (e) { return false; }
  }

  function render(view) {
    var box = byId("caravelConsent");
    if (!box) return;
    var en = isEnglish();
    box.innerHTML = "";
    box.appendChild(text("strong", en ? "Caravel — rental terms and protection (read before payment)"
      : "Caravel — warunki wynajmu i ochrony (przeczytaj przed płatnością)"));
    var list = document.createElement("ul");
    list.setAttribute("style", "margin:8px 0 10px 18px;padding:0");
    (view.statements || []).forEach(function (s) { list.appendChild(text("li", s)); });
    box.appendChild(list);
    if (view.coverage && view.coverage.excluded && view.coverage.excluded.length) {
      box.appendChild(text("p", (en ? "Not covered: " : "Nieobjęte ochroną: ") +
        view.coverage.excluded.map(function (x) { return x.label; }).join(", "),
        "margin:6px 0;font-weight:650;color:#7C2D12"));
    }
    box.appendChild(text("p", (en ? "Binding document: " : "Wiążący dokument: ") + view.terms.title +
      " · v" + view.terms.version + " · " + view.terms.language.toUpperCase() +
      " · SHA-256 " + String(view.terms.content_hash).slice(0, 12) + "…", "margin:6px 0;font-size:12px;color:#475569"));
    var terms = document.createElement("div");
    terms.id = "caravelTermsBody";
    terms.setAttribute("style", "max-height:260px;overflow:auto;border:1px solid #CBD5E1;border-radius:8px;padding:10px;background:#fff;font-size:12px;line-height:1.5");
    // Server-rendered from clauses/v1 text runs; every run is HTML-escaped server-side.
    terms.innerHTML = view.terms.html;
    box.appendChild(terms);
    function check(id, label) {
      var l = document.createElement("label");
      l.setAttribute("style", "display:flex;gap:9px;align-items:flex-start;margin-top:10px;font-weight:650;cursor:pointer");
      var c = document.createElement("input");
      c.type = "checkbox"; c.id = id; c.setAttribute("style", "margin-top:4px");
      l.appendChild(c); l.appendChild(text("span", label));
      box.appendChild(l);
    }
    check("caravelTermsAccept", en
      ? "I have read and accept Caravel's rental terms shown above (this exact version)."
      : "Przeczytałem/am i akceptuję powyższy regulamin wynajmu Caravel (dokładnie tę wersję).");
    check("caravelCoverageAck", view.coverage && view.coverage.excluded && view.coverage.excluded.length
      ? (en ? "I understand the protection exclusions and the administration fee listed above."
        : "Rozumiem wyłączenia ochrony oraz opłatę administracyjną wskazane powyżej.")
      : (en ? "I understand that the rental price is paid to Caravel at pickup and Stripe charges only the Ride24 fee."
        : "Rozumiem, że cenę wynajmu płacę Caravel przy odbiorze, a Stripe pobiera wyłącznie opłatę Ride24."));
    box.hidden = false;
  }

  async function call(action, payload, accessToken, supabaseUrl, supabaseKey) {
    var response = await fetch(supabaseUrl + "/functions/v1/caravel-booking-request", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + accessToken, "apikey": supabaseKey },
      body: JSON.stringify(Object.assign({ action: action, lang: isEnglish() ? "en" : "pl" }, payload))
    });
    var body = await response.json().catch(function () { return {}; });
    return { ok: response.ok, status: response.status, body: body };
  }

  function reset() {
    state = { active: false, view: null, quoteId: null };
    var box = byId("caravelConsent");
    if (box) { box.hidden = true; box.innerHTML = ""; }
  }

  window.Ride24CaravelConsent = {
    PARTNER: PARTNER,
    isCaravel: function (partnerId) { return partnerId === PARTNER; },
    active: function () { return state.active; },
    reset: reset,
    /** Load and show the consent for the selected quote; hides supplier PDF links (comparison only). */
    prepare: async function (opts) {
      reset();
      if (!opts || opts.partnerId !== PARTNER) return false;
      state.active = true;
      ["partnerTermsLink", "partnerRulesLink"].forEach(function (id) { var a = byId(id); if (a) a.style.display = "none"; });
      var quoteId = opts.apiQuoteId;
      var r = await call("consent-view", { api_quote_id: quoteId }, opts.accessToken, opts.supabaseUrl, opts.supabaseKey);
      if (!r.ok || !r.body || !r.body.consent) {
        var box = byId("caravelConsent");
        if (box) {
          box.innerHTML = "";
          box.appendChild(text("p", (isEnglish() ? r.body.error_en : r.body.error) ||
            (isEnglish() ? "This Caravel offer cannot be booked now." : "Tej oferty Caravel nie można teraz zarezerwować."),
            "margin:0;font-weight:650;color:#991B1B"));
          box.hidden = false;
        }
        state.view = null;
        return false;
      }
      state.view = r.body.consent; state.quoteId = r.body.consent.api_quote_id;
      render(state.view);
      return true;
    },
    canSubmit: function () {
      return !!(state.view && byId("caravelTermsAccept") && byId("caravelTermsAccept").checked &&
        byId("caravelCoverageAck") && byId("caravelCoverageAck").checked);
    },
    /** Exactly what was shown, echoed for server verification. */
    consentPayload: function () {
      if (!state.view) return null;
      var e = state.view.echo;
      return { terms_document_id: e.terms_document_id, terms_content_hash: e.terms_content_hash,
        terms_language: e.terms_language, excluded_codes: e.excluded_codes.slice(),
        damage_admin_fee_minor: e.damage_admin_fee_minor, accepted: true, coverage_acknowledged: true };
    },
    book: async function (opts) {
      var r = await call("book", { api_quote_id: state.quoteId, driver_id: opts.driverId || null,
        additional_driver_id: opts.additionalDriverId || null, consent: this.consentPayload() },
        opts.accessToken, opts.supabaseUrl, opts.supabaseKey);
      if (r.body && r.body.code === "CARAVEL_REQUOTED_FOR_DRIVER_AGE" && r.body.consent) {
        // New price for the real driver age: show it and require a fresh confirmation.
        state.view = r.body.consent; state.quoteId = r.body.consent.api_quote_id;
        try { localStorage.setItem("selectedApiQuoteId", state.quoteId); } catch (e) {}
        render(state.view);
      }
      return r;
    }
  };
})();
