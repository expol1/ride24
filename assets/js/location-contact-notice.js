/* Automatic pickup contact notice, based on location type, not a partner checkbox. */
(function (root) {
    "use strict";
    const nonAirportTypes = new Set([
        "city", "hotel", "office", "railway_station", "seaport", "custom"
    ]);
    const normalized = value => String(value ?? "").trim().toLowerCase();
    const same = (a, b) => normalized(a) === normalized(b);

    function requiresContact(location) {
        return nonAirportTypes.has(normalized(location?.type));
    }

    function showForPickup(car, selectedLocation) {
        const selected = selectedLocation || {};
        // A selected airport must never trigger a non-airport pickup notice.
        if (normalized(selected.type) === "airport") return false;

        const rows = Array.isArray(car?.partners?.partner_locations)
            ? car.partners.partner_locations : [];
        const geographicRows = rows.filter(row =>
            (!selected.country || same(row.country, selected.country))
            && (!selected.city || same(row.city, selected.city))
        );
        const locationName = String(selected.location_name || "").trim();

        if (locationName) {
            const exactRows = geographicRows.filter(row =>
                same(row.location_name, locationName)
            );
            // Unknown or mixed types must not produce a misleading warning.
            return exactRows.length > 0 && exactRows.every(requiresContact);
        }

        // Broad city search can include airport and non-airport pickup points.
        // Only show the notice if every matching partner point is non-airport.
        if (normalized(selected.type) === "city") {
            return geographicRows.length > 0 && geographicRows.every(requiresContact);
        }

        // A named non-airport pickup type (e.g. hotel/office) can be identified
        // without the partner's legacy contact_required flag.
        return requiresContact(selected);
    }

    root.Ride24LocationContact = Object.freeze({ requiresContact, showForPickup });
})(typeof window !== "undefined" ? window : globalThis);
