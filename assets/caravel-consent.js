// Ride24 — Caravel pre-Stripe consent (WWW). Shown only for the Caravel partner.
// Everything displayed comes from the server (caravel-booking-request
// "consent-view"): the released, re-hashed clauses/v1 terms (server-escaped HTML),
// the quote's exclusions, the exact administration fee and the money split.
// The browser only echoes what it was shown; the backend and the SQL RPC verify it.
(function () {
  "use strict";
  var PARTNER = "78721481-7619-44df-a9b7-5faa344b69bb";
  var state = { active: false, view: null, quoteId: null, selected: [], catalog: [], unavailable: [], catalogError: null, busy: false, submitLocked: false, auth: null, mainDriverId:null, additionalDriverId:null };

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
    box.setAttribute("style", "margin:0;padding:0;border:0;background:transparent;color:#0F172A;font-size:13px;line-height:1.5");
    var coverage = view.coverage || {};
    var excluded = Array.isArray(coverage.excluded) ? coverage.excluded : [];
    var statements = Array.isArray(view.statements) ? view.statements : [];
    var money = view.money || {};
    var termsData = view.terms || {};
    var adminMinor = Number(coverage.damage_admin_fee_minor);
    var hasAdminFee = Number.isSafeInteger(adminMinor) && adminMinor > 0;
    var adminCurrency = coverage.damage_admin_fee_currency === "EUR" ? "EUR" : null;

    // Match the existing AVIA booking-price-breakdown card. Every amount is
    // supplied by Caravel / Ride24's verified server consent; no client fee maths.
    var breakdown = money.breakdown;
    var pricePanel = document.createElement("section");
    pricePanel.className = "booking-price-breakdown caravel-price-summary";
    pricePanel.setAttribute("aria-label", en ? "Caravel itemised price" : "Rozliczenie Caravel");
    pricePanel.appendChild(text("h4", en ? "Price summary" : "Podsumowanie ceny"));
    function zeroAmount(value) {
      // Purely visual: hide explicitly zero-valued lines; never alter the totals.
      return /^\s*0(?:[.,]0+)?\s*(?:EUR|€|PLN|zł)?\s*$/i.test(String(value == null ? "" : value));
    }
    function priceRow(name, value, kind) {
      if (!name || value == null || value === "" || (kind === "item" && zeroAmount(value))) return;
      var row = document.createElement("div");
      row.className = "booking-price-row" + (kind === "total" ? " caravel-price-total" : "") +
        (kind === "payment" ? " caravel-price-payment" : "");
      row.appendChild(text("span", name));
      row.appendChild(text(kind === "total" ? "strong" : "span", value));
      pricePanel.appendChild(row);
    }
    // The server supplies the Ride24 fee in PLN. Never put a long EUR
    // fallback message inside the amount column (it breaks the modal layout).
    function onlineFee() {
      var minor = Number(money.ride24_fee_pln_minor);
      if (Number.isSafeInteger(minor) && minor > 0 && typeof money.ride24_fee_pln === "string") {
        return new Intl.NumberFormat(en ? "en-US" : "pl-PL", {
          style: "currency", currency: "PLN", minimumFractionDigits: 2,
          maximumFractionDigits: 2
        }).format(minor / 100);
      }
      return en ? "PLN unavailable" : "— zł";
    }
    priceRow(en ? "Car rental" : "Wynajem samochodu", breakdown?.customer_rental || money.customer_total, "rental");
    if (breakdown && Array.isArray(breakdown.fees)) {
      breakdown.fees.forEach(function (fee) {
        if (fee && fee.label) priceRow(fee.label + (en ? " (mandatory)" : " (obowiązkowa)"), fee.amount, "item");
      });
      (Array.isArray(breakdown.extras) ? breakdown.extras : []).forEach(function (extra) {
        if (extra && extra.name) priceRow(extra.name + (extra.quantity > 1 ? " × " + extra.quantity : ""), extra.amount, "extra");
      });
    }
    priceRow(en ? "Ride24 online fee" : "Opłata rezerwacyjna Ride24 online",
      onlineFee(), "payment");
    priceRow(en ? "Pay to Caravel at pickup" : "Do zapłaty partnerowi",
      breakdown && breakdown.partner_total ? breakdown.partner_total : money.rental_at_pickup, "payment");
    pricePanel.appendChild(text("small", en
      ? "Online fee is shown in PLN at the current exchange rate; the final amount is confirmed before payment. Rental and extras are paid to Caravel at pickup."
      : "Płatność online w PLN według bieżącego kursu. Ostateczna kwota zostanie potwierdzona przed płatnością. Wynajem i dodatki płacisz Caravel przy odbiorze.",
      "margin-top:10px;color:#64748B"));
    box.appendChild(pricePanel);

    if (coverage.deposit_minor === 0 && coverage.excess_minor === 0) {
      var premiumNote = text("div", en
        ? "Premium included in the rental price — deposit 0, excess 0."
        : "Pakiet Premium w cenie — kaucja 0, udział własny 0.");
      premiumNote.className = "caravel-premium-note";
      box.appendChild(premiumNote);
    }
    if (excluded.length || hasAdminFee) {
      var warning = en
        ? "Important: Premium has coverage exclusions."
        : "Ważne: pakiet Premium ma wyłączenia ochrony.";
      if (hasAdminFee && adminCurrency) warning += en
        ? " In case of damage or theft, the administration fee is " + (adminMinor / 100).toFixed(2) + " EUR per rental."
        : " W razie szkody lub kradzieży obowiązuje opłata administracyjna " + (adminMinor / 100).toFixed(2).replace(".", ",") + " EUR za wynajem.";
      var warningNote = text("p", warning);
      warningNote.className = "caravel-warning-note";
      box.appendChild(warningNote);
    }

    var heading = text("strong", en ? "Caravel rental terms" : "Warunki wynajmu Caravel");
    heading.className = "caravel-legal-heading";
    box.appendChild(heading);

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

  // Uses the same Ride24 equipment modal and genuine price re-quoting.
  // No browser-side price maths; the catalog unit price is indicative.
  function renderExtras() {
    var picker=byId("bookingExtrasPicker"), total=byId("bookingExtrasTotal"),legacy=byId("equipmentLegacyInfo");
    if(!picker||!total)return;
    picker.replaceChildren();total.replaceChildren();
    picker.hidden=false;total.hidden=false;
    if(legacy)legacy.hidden=true;
    var en=isEnglish();
    if(state.catalogError)picker.appendChild(text("p",state.catalogError,"color:#9A3412"));
    if(!state.catalog.length&&!state.catalogError)picker.appendChild(text("p",
      en?"Caravel has no verified voluntary extras available for online booking.":"Caravel nie udostępnia obecnie zweryfikowanych dodatków do rezerwacji online."));
    state.catalog.forEach(function(e){
      var row=document.createElement("label");
      row.className="booking-extra-row";
      var left=document.createElement("span");
      left.appendChild(text("strong",en?e.name_en:e.name_pl));
      var price=(e.unit_minor/100).toFixed(2).replace(".",en?".":",")+" "+e.currency;
      left.appendChild(text("small",price+(e.pricing_type==="per_day"?(en?" / day":" / dzień"):(en?" / rental":" / wynajem"))));
      if(e.price_cap_minor!=null)left.appendChild(text("small",en?"Price cap may apply; final supplier quote below.":"Możliwy limit ceny; ostateczna wycena poniżej."));
      row.appendChild(left);
      var existing=state.selected.find(function(x){return x.extra_id===e.extra_id;});
      if(e.max_quantity===1){
        var toggle=document.createElement("input");toggle.type="checkbox";toggle.className="r24-extra-switch-input";
        toggle.setAttribute("role","switch");
        toggle.setAttribute("aria-label",en?e.name_en:e.name_pl);
        toggle.checked=!!existing;toggle.disabled=state.busy;
        toggle.onchange=function(){chooseExtra(e.extra_id,toggle.checked?1:0);};
        var switchBox=document.createElement("span");switchBox.className="r24-extra-switch";
        switchBox.appendChild(toggle);
        var track=document.createElement("span");track.className="r24-extra-switch-track";track.appendChild(text("span",""));
        var value=text("span",toggle.checked?(en?"Yes":"Tak"):(en?"No":"Nie"));value.className="r24-extra-switch-value";
        switchBox.appendChild(track);switchBox.appendChild(value);
        row.appendChild(switchBox);
      } else {
        var select=document.createElement("select");select.disabled=state.busy;
        select.setAttribute("aria-label",en?e.name_en:e.name_pl);
        for(var i=0;i<=e.max_quantity;i++){
          if(i>0 && i<(e.min_quantity||1))continue;
          var option=document.createElement("option");option.value=String(i);option.textContent=String(i);
          select.appendChild(option);
        }
        select.value=String(existing?.quantity||0);
        select.onchange=function(){chooseExtra(e.extra_id,Number(select.value));};
        row.appendChild(select);
      }
      picker.appendChild(row);
    });
    var p=state.view?.money?.breakdown;
    total.appendChild(text("strong",en?"Your Caravel extras":"Twoje dodatki Caravel"));
    (p?.extras||[]).forEach(function(x){var line=document.createElement("div");
      line.className="booking-price-row";
      line.appendChild(text("span",x.name+" × "+x.quantity));
      line.appendChild(text("strong",x.amount));total.appendChild(line);});
    if(p)total.appendChild(text("p",(en?"To pay Caravel at pickup: ":"Do zapłaty Caravel przy odbiorze: ")+p.partner_total,
      "font-weight:750;margin:10px 0"));
    total.appendChild(text("small",en?"Only Caravel's confirmed quote is binding.":"Wiążąca jest wyłącznie wycena potwierdzona przez Caravel."));
  }
  async function chooseExtra(id,qty){
    if(state.busy||!state.auth||!state.view)return;
    var selected=state.selected.filter(function(x){return x.extra_id!==id;});
    if(qty>0)selected.push({extra_id:id,quantity:qty});
    state.busy=true;
    renderExtras();
    lockDriverControls(true);
    var button=byId("confirmBookingBtn");if(button)button.disabled=true;
    var picker=byId("bookingExtrasPicker");
    if(picker)picker.appendChild(text("p",isEnglish()?"Verifying new supplier price…":"Potwierdzamy nową cenę u Caravel…"));
    try{
      var auth=state.auth;
      var response=await call("extras-requote",{api_quote_id:state.quoteId,extras:selected},
         auth.accessToken,auth.supabaseUrl,auth.supabaseKey);
      if(!response.ok||!response.body?.consent)throw new Error(
         (isEnglish()?response.body?.error_en:response.body?.error)||
         (isEnglish()?"Extras are not available at this price.":"Dodatki nie są dostępne w tej cenie."));
      state.view=response.body.consent;state.quoteId=state.view.api_quote_id;state.selected=selected;
      rememberDrivers();
      state.submitLocked=false;state.catalogError=null;
      localStorage.setItem("selectedApiQuoteId",state.quoteId);
      var accept=byId("acceptTerms");if(accept)accept.checked=false;
    }catch(error){
      state.catalogError=error.message||"CARAVEL_EXTRA_REQUOTE_FAILED";
      // Customer may retry, but cannot submit a previous quote without a fresh
      // successful price check; the previous choice is never silently changed.
      state.submitLocked=true;
      var accepted=byId("acceptTerms");if(accepted)accepted.checked=false;
    }finally{
      state.busy=false;lockDriverControls(false);
      if(state.view)render(state.view);
      renderExtras();
      if(button)button.disabled=!state.view || state.submitLocked;
    }
  }

  function rememberDrivers(){
    try {sessionStorage.setItem("caravelDriverChoice",JSON.stringify({quote:state.quoteId,main:state.mainDriverId,extra:state.additionalDriverId}));} catch(e){}
  }
  function lockDriverControls(locked){
    ["driverSelect","additionalDriverSelect","caravelDriverProfile"].forEach(function(id){
      var el=byId(id);
      if(el)el.disabled=locked || (id!=="driverSelect" && !state.driverService);
    });
  }
  function reset() {
    state = { active: false, view: null, quoteId: null, selected: [], catalog: [], unavailable: [], catalogError: null, busy: false, submitLocked: false, auth: null, mainDriverId:null, additionalDriverId:null };
    var picker=byId("bookingExtrasPicker");if(picker){picker.replaceChildren();picker.hidden=true;}
    var totals=byId("bookingExtrasTotal");if(totals){totals.replaceChildren();totals.hidden=true;}
    var box = byId("caravelConsent");
    if (box) { box.hidden = true; box.innerHTML = ""; }
  }

  window.Ride24CaravelConsent = {
    PARTNER: PARTNER,
    isCaravel: function (partnerId) { return partnerId === PARTNER; },
    active: function () { return state.active; },
    requiresAgeRequote: function (age) {
      return !!(state.active && state.view && Number.isInteger(Number(age)) &&
        Number(state.view.driver_age) !== Number(age));
    },
    savedDrivers: function(){
      try {var draft=JSON.parse(sessionStorage.getItem("caravelDriverChoice"));
        return draft?.quote===state.quoteId ? draft : null;
      }catch(e){return null;}
    },
    hasAdditionalDriver: function(){return state.view?.additional_driver_age!=null;},
    driverService: function(){return state.driverService || null;},
    isBusy: function(){return state.busy;},
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
      state.auth = {accessToken:opts.accessToken,supabaseUrl:opts.supabaseUrl,supabaseKey:opts.supabaseKey};
      state.mainDriverId=opts.driverId||null;
      state.additionalDriverId=opts.additionalDriverId||null;
      var catalog=await call("extras-catalog",{api_quote_id:state.quoteId},opts.accessToken,opts.supabaseUrl,opts.supabaseKey);
      if(catalog.ok && catalog.body && Array.isArray(catalog.body.catalog)) {
        state.catalog=catalog.body.catalog;
        state.driverService=catalog.body.driver_service || null;
        state.unavailable=Array.isArray(catalog.body.unavailable)?catalog.body.unavailable:[];
      } else {
        state.catalogError=isEnglish()?"Extras catalog is temporarily unavailable.":"Katalog dodatków jest chwilowo niedostępny.";
      }
      state.selected=(state.view.money?.breakdown?.extras || []).map(function(x){return {extra_id:x.extra_id,quantity:x.quantity};});
      render(state.view);
      renderExtras();
      return true;
    },
    /** Re-price the authenticated main and additional driver before Stripe.
     * A failed quote never changes the selected supplier quote. */
    requoteDrivers: async function (opts) {
      if (!state.active || !state.auth || !state.quoteId || state.busy) return false;
      var mainId=opts?.driverId||null, extraId=opts?.additionalDriverId||null;
      if(mainId && mainId===extraId) return false;
      if(mainId===state.mainDriverId && extraId===state.additionalDriverId && !opts?.force) return true;
      state.busy=true;
      lockDriverControls(true);renderExtras();
      var prevMain=state.mainDriverId, prevExtra=state.additionalDriverId;
      try {
        var r=await call("drivers-requote",{
          api_quote_id:state.quoteId,driver_id:mainId,additional_driver_id:extraId
        },state.auth.accessToken,state.auth.supabaseUrl,state.auth.supabaseKey);
        if (!r.ok || !r.body?.consent) {
          if(opts?.force)state.submitLocked=true;
          if (window.showToast) window.showToast((isEnglish()?r.body?.error_en:r.body?.error)||
            (isEnglish()?"Caravel could not confirm the drivers and price.":"Caravel nie potwierdził kierowców i ceny."),"error");
          var m=byId("driverSelect"),a=byId("additionalDriverSelect");
          if(m)m.value=prevMain||"";
          if(a)a.value=prevExtra||"none";
          return false;
        }
        state.view=r.body.consent;state.quoteId=r.body.consent.api_quote_id;
        state.selected=(state.view.money?.breakdown?.extras||[]).map(function(x){
          return {extra_id:x.extra_id,quantity:x.quantity};
        });
        state.mainDriverId=mainId;state.additionalDriverId=extraId;rememberDrivers();state.submitLocked=false;
        try {localStorage.setItem("selectedApiQuoteId",state.quoteId);}catch(e){}
        var general=byId("acceptTerms");if(general)general.checked=false;
        render(state.view);renderExtras();
        return true;
      } catch(err) {
        if(opts?.force)state.submitLocked=true;
        if(window.showToast)window.showToast(isEnglish()
          ? "Caravel could not update the drivers. Please retry."
          : "Nie udało się przeliczyć kierowców w Caravel. Spróbuj ponownie.","error");
        var m=byId("driverSelect"),a=byId("additionalDriverSelect");
        if(m)m.value=prevMain||"";
        if(a)a.value=prevExtra||"none";
        return false;
      } finally {state.busy=false;lockDriverControls(false);renderExtras();}
    },
    canSubmit: function () {
      return !!(!state.busy && !state.submitLocked && state.view && Number(state.view.money?.ride24_fee_pln_minor) > 0 && byId("caravelTermsAccept") && byId("caravelTermsAccept").checked &&
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
      if (r.body && ["CARAVEL_REQUOTED_FOR_DRIVER_AGE","CARAVEL_REQUOTED_FOR_DRIVERS"].includes(r.body.code) && r.body.consent) {
        // New price for the real driver age: show it and require a fresh confirmation.
        state.view = r.body.consent; state.quoteId = r.body.consent.api_quote_id;
        state.selected=(state.view.money?.breakdown?.extras||[]).map(function(x){
          return {extra_id:x.extra_id,quantity:x.quantity};
        });
        try { localStorage.setItem("selectedApiQuoteId", state.quoteId); } catch (e) {}
        var general=byId("acceptTerms");if(general)general.checked=false;
        render(state.view);renderExtras();
      }
      return r;
    }
  };
})();
