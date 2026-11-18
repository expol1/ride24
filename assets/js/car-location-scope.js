// Per-vehicle pickup AND return eligibility for local partners.
// A null allowed_location_ids array retains historical "all partner locations" behavior.
// Scoped groups require a matching local partner-location UUID for both legs.
(function (root) {
  "use strict";
  function isCarAllowed(car, returnRowsByPartner) {
    const scope = car?.allowed_location_ids;
    if (scope == null) return true;
    if (!Array.isArray(scope) || scope.length === 0) return false;
    const scoped = new Set(scope.map(String));
    const partnerId = String(car.partner_id || car.partners?.id || "");
    const locations = car.partners?.partner_locations;
    const pickups = Array.isArray(locations) ? locations : (locations ? [locations] : []);
    const returns = returnRowsByPartner?.get?.(partnerId) || [];
    return pickups.some(location => scoped.has(String(location.id)))
      && returns.some(location => scoped.has(String(location.id)));
  }
  root.Ride24CarLocationScope = Object.freeze({ isCarAllowed });
})(typeof window !== "undefined" ? window : globalThis);
