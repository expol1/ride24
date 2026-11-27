// Ride24 Cloudflare Turnstile: explicit rendering only when a login modal
// becomes visible, one widget per container, no CSS transforms on the iframe
// (scaling/clipping the iframe makes Turnstile fail its interaction checks
// on mobile browsers and shows "Verification failed"), automatic recovery
// from transient errors and token expiry, and per-widget reset after use
// (a consumed token must never be sent again).
(function () {
  "use strict";
  var SITEKEY = "0x4AAAAAACu2gUuoR8cE8lAv";
  var SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
  var MAX_AUTO_RETRIES = 3;
  var loading = null;
  var states = new WeakMap();

  function lang() {
    try { return localStorage.getItem("lang") === "en" ? "en" : "pl"; } catch (_) { return "pl"; }
  }
  function loadApi() {
    if (window.turnstile && window.turnstile.render) return Promise.resolve(window.turnstile);
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[src^="https://challenges.cloudflare.com/turnstile/v0/api.js"]');
      var script = existing || document.createElement("script");
      var done = function () {
        if (window.turnstile && window.turnstile.render) resolve(window.turnstile);
        else { loading = null; reject(new Error("TURNSTILE_UNAVAILABLE")); }
      };
      script.addEventListener("load", function () { window.turnstile && window.turnstile.ready ? window.turnstile.ready(done) : done(); });
      script.addEventListener("error", function () { loading = null; reject(new Error("TURNSTILE_LOAD_FAILED")); });
      if (!existing) { script.src = SRC; script.async = true; document.head.appendChild(script); }
      else if (window.turnstile) done();
    });
    return loading;
  }
  function state(el) {
    var s = states.get(el);
    if (!s) { s = { id: null, token: null, errors: 0, rendering: false }; states.set(el, s); }
    return s;
  }
  function mount(el) {
    if (!el) return Promise.resolve(null);
    var s = state(el);
    if (s.id !== null || s.rendering) return Promise.resolve(s.id);
    s.rendering = true;
    return loadApi().then(function (ts) {
      s.id = ts.render(el, {
        sitekey: SITEKEY,
        theme: "light",
        size: "flexible",
        language: lang(),
        retry: "auto",
        "retry-interval": 2000,
        "refresh-expired": "auto",
        "response-field": false,
        callback: function (token) { s.token = token; s.errors = 0; el.removeAttribute("data-error"); },
        "expired-callback": function () { s.token = null; },
        "timeout-callback": function () { s.token = null; try { ts.reset(s.id); } catch (_) {} },
        "error-callback": function (code) {
          s.token = null;
          s.errors += 1;
          el.setAttribute("data-error", String(code || ""));
          if (window.console) console.warn("Turnstile error", code);
          if (s.errors <= MAX_AUTO_RETRIES) {
            setTimeout(function () { try { ts.reset(s.id); } catch (_) {} }, 1200 * s.errors);
            return true; // handled: retry silently instead of a dead end
          }
          return false; // let Turnstile show its own guidance after repeated failures
        }
      });
      return s.id;
    }).catch(function () { return null; }).then(function (id) { s.rendering = false; return id; });
  }
  function reset(el) {
    var s = el && states.get(el);
    if (!s || s.id === null || !window.turnstile) return;
    s.token = null; s.errors = 0;
    try { window.turnstile.reset(s.id); } catch (_) {}
  }
  // Returns a fresh token or null. The widget is reset after each use.
  function token(el) {
    var s = el && states.get(el);
    if (!s || s.id === null || !window.turnstile) return null;
    var t = null;
    try { t = window.turnstile.isExpired && window.turnstile.isExpired(s.id) ? null : window.turnstile.getResponse(s.id); } catch (_) {}
    return t || s.token || null;
  }
  function watch(root) {
    var nodes = (root || document).querySelectorAll("[data-ride24-turnstile]");
    Array.prototype.forEach.call(nodes, function (el) {
      if (el.__ride24Watch) return;
      el.__ride24Watch = true;
      if ("IntersectionObserver" in window) {
        new IntersectionObserver(function (entries) {
          entries.forEach(function (e) { if (e.isIntersecting) mount(el); });
        }).observe(el);
      } else { mount(el); }
    });
  }
  window.Ride24Turnstile = { mount: mount, reset: reset, token: token, watch: watch, preload: loadApi };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { watch(); });
  else watch();
})();
