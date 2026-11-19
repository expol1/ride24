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

  // Keep the binding terms and the provider's full disclosures reachable,
  // but make the compact reservation panel match Ride24's clickable documents.
  // The consent fields and server-verified acceptance payload are unchanged.
  function render(view) {
    var box = byId("caravelConsent");
    if (!box) return;
    var en = isEnglish();
    box.replaceChildren();
    box.setAttribute("style", "margin:12px 0;padding:12px 14px;border:1px solid #CBD5E1;border-radius:10px;background:#F8FAFC;color:#0F172A;font-size:13px;line-height:1.5");
    var coverage = view.coverage || {};
    var excluded = Array.isArray(coverage.excluded) ? coverage.excluded : [];
    var statements = Array.isArray(view.statements) ? view.statements : [];
    var money = view.money || {};
    var termsData = view.terms || {};
    var adminMinor = Number(coverage.damage_admin_fee_minor);
    var hasAdminFee = Number.isSafeInteger(adminMinor) && adminMinor > 0;
    var adminCurrency = coverage.damage_admin_fee_currency === "EUR" ? "EUR" : null;

    var heading = text("strong", en
      ? "Caravel — read the terms before accepting"
      : "Caravel — przeczytaj przed zaznaczeniem zgód");
    heading.setAttribute("style", "display:block;font-size:14px;color:#0F172A;margin-bottom:6px");
    box.appendChild(heading);

    // All fee rows and amounts are read from the signed-in user's server quote.
    // Never calculate age, one-way or night rates in the browser.
    var breakdown = money.breakdown;
    if (breakdown && Array.isArray(breakdown.fees)) {
      var pricePanel = document.createElement("section");
      pricePanel.setAttribute("aria-label", en ? "Caravel itemised price" : "Rozliczenie Caravel");
      pricePanel.setAttribute("style", "background:#fff;border:1px solid #CBD5E1;border-radius:8px;padding:10px 12px;margin:8px 0 10px");
      pricePanel.appendChild(text("strong", en ? "Your price — supplier-confirmed" : "Twoja cena — potwierdzona przez Caravel",
        "display:block;margin-bottom:8px;color:#0F172A"));
      function priceRow(name, value, emphasise) {
        var r = document.createElement("div");
        r.setAttribute("style", "display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin:5px 0;" +
          (emphasise ? "padding-top:7px;border-top:1px solid #E2E8F0;font-weight:800;" : ""));
        var labelEl = text("span", name);
        var valueEl = text("strong", value, "white-space:nowrap;font-variant-numeric:tabular-nums");
        r.appendChild(labelEl); r.appendChild(valueEl);
        pricePanel.appendChild(r);
      }
      priceRow(en ? "Rental incl. Premium" : "Wynajem z pakietem Premium", breakdown.rental_base);
      breakdown.fees.forEach(function (fee) {
        var name = fee.label;
        if (fee.original_label && fee.original_label !== fee.label) name += " (" + fee.original_label + ")";
        priceRow(name, fee.amount);
      });
      if (!breakdown.fees.length) {
        pricePanel.appendChild(text("small", en
          ? "No additional mandatory charges in this supplier quote."
          : "Brak dodatkowych obowiązkowych dopłat w tej wycenie.",
          "display:block;margin:4px 0;color:#64748B"));
      }
      priceRow(en ? "Pay Caravel at pickup" : "Do zapłaty Caravel przy odbiorze", breakdown.partner_total, true);
      priceRow(en ? "Ride24 reservation fee — online" : "Opłata rezerwacyjna Ride24 — online", money.ride24_fee);
      pricePanel.appendChild(text("small", en
        ? "All listed surcharges are already included in the supplier total. They are not added a second time."
        : "Wszystkie dopłaty są już zawarte w kwocie Caravel. Nie naliczamy ich drugi raz.",
        "display:block;margin-top:8px;color:#475569"));
      box.appendChild(pricePanel);
    } else if (money.rental_at_pickup && money.ride24_fee) {
      box.appendChild(text("p", en
        ? "At pickup: " + money.rental_at_pickup + " to Caravel. Online: " + money.ride24_fee + " Ride24 reservation fee."
        : "Przy odbiorze: " + money.rental_at_pickup + " dla Caravel. Online: " + money.ride24_fee + " opłaty rezerwacyjnej Ride24.",
      "margin:5px 0;font-weight:600"));
    }
    if (coverage.deposit_minor === 0 && coverage.excess_minor === 0) {
      box.appendChild(text("p", en
        ? "Premium included in the rental price — deposit 0, excess 0."
        : "Pakiet Premium w cenie — kaucja 0, udział własny 0.",
      "margin:5px 0;color:#166534;font-weight:700"));
    }
    if (excluded.length || hasAdminFee) {
      var warning = en
        ? "Important: Premium has coverage exclusions."
        : "Ważne: pakiet Premium ma wyłączenia ochrony.";
      if (hasAdminFee && adminCurrency) warning += en
        ? " In case of damage or theft, the administration fee is " + (adminMinor / 100).toFixed(2) + " EUR per rental."
        : " W razie szkody lub kradzieży obowiązuje opłata administracyjna " + (adminMinor / 100).toFixed(2).replace(".", ",") + " EUR za wynajem.";
      box.appendChild(text("p", warning, "margin:7px 0;color:#92400E;font-weight:650"));
    }

    function disclosure(title, child) {
      var details = document.createElement("details");
      details.setAttribute("style", "margin:7px 0;border:1px solid #CBD5E1;border-radius:8px;background:#FFF;overflow:hidden");
      var summary = text("summary", title, "padding:10px 12px;color:#1D4ED8;font-weight:700;cursor:pointer;list-style-position:inside");
      details.appendChild(summary);
      var area = document.createElement("div");
      area.setAttribute("style", "padding:0 12px 12px;border-top:1px solid #E2E8F0;color:#334155");
      area.appendChild(child);
      details.appendChild(area);
      box.appendChild(details);
      return details;
    }

    // The binding clauses/v1 document remains exact, unmodified and accessible
    // through a keyboard-operable native disclosure rather than an always-open scrollbox.
    var terms = document.createElement("div");
    terms.id = "caravelTermsBody";
    terms.setAttribute("style", "max-height:330px;overflow:auto;border:1px solid #E2E8F0;border-radius:8px;padding:10px;background:#fff;font-size:12px;line-height:1.6;margin-top:10px");
    // Server-rendered from clauses/v1 text runs; every run is HTML-escaped server-side.
    terms.innerHTML = termsData.html || "";
    var termsContainer = document.createElement("div");
    termsContainer.appendChild(text("p", (en ? "Binding document: " : "Dokument wiążący: ") +
      String(termsData.title || "Terms & Conditions") + " · v" + String(termsData.version || "") +
      " · " + String(termsData.language || "en").toUpperCase() +
      " · SHA-256 " + String(termsData.content_hash || "").slice(0, 12) + "…",
      "margin:8px 0;font-size:11px;color:#64748B"));
    termsContainer.appendChild(terms);
    disclosure(en ? "📄 Open Caravel rental terms" : "📄 Otwórz regulamin Caravel", termsContainer);

    var description = document.createElement("div");
    var list = document.createElement("ul");
    list.setAttribute("style", "margin:10px 0 8px 18px;padding:0");
    statements.forEach(function (s) { list.appendChild(text("li", s, "margin-bottom:5px")); });
    description.appendChild(list);
    if (excluded.length) {
      description.appendChild(text("p", (en ? "Excluded from protection: " : "Wyłączenia ochrony: ") +
        excluded.map(function (x) { return x.label; }).join(", ") + ".",
        "margin:8px 0;color:#92400E;font-weight:600"));
    }
    disclosure(en ? "🛡️ Protection, exclusions and fees" : "🛡️ Ochrona, wyłączenia i opłaty", description);

    box.appendChild(text("p", en
      ? "Open and read both sections before ticking the boxes below."
      : "Otwórz i przeczytaj obie sekcje przed zaznaczeniem zgód.",
      "margin:9px 0 4px;color:#475569;font-size:12px"));
    function check(id, label) {
      var l = document.createElement("label");
      l.setAttribute("style", "display:flex;gap:9px;align-items:flex-start;margin-top:9px;font-weight:650;cursor:pointer");
      var c = document.createElement("input");
      c.type = "checkbox"; c.id = id; c.setAttribute("style", "margin-top:4px;flex-shrink:0");
      l.appendChild(c); l.appendChild(text("span", label));
      box.appendChild(l);
    }
    check("caravelTermsAccept", en
      ? "I have read and accept Caravel's rental terms (the version linked above)."
      : "Przeczytałem/am i akceptuję regulamin wynajmu Caravel (wersję wskazaną wyżej).");
    check("caravelCoverageAck", excluded.length
      ? (en ? "I understand the protection exclusions and administration fee detailed above."
        : "Rozumiem wyłączenia ochrony oraz opłatę administracyjną wskazane wyżej.")
      : (en ? "I understand the payment split and protection terms shown above."
        : "Rozumiem przedstawione warunki ochrony i podział płatności."));
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
