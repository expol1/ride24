/* Price comparison for Ride24 WEB search. Mandatory location fees are once per selected leg. */
(function (root) {
    "use strict";

    const normalizedName = value => String(value ?? "").trim().toLocaleLowerCase("en-US");
    function matchingLocations(rows, chosenName) {
        const all = Array.isArray(rows) ? rows : [];
        const selected = normalizedName(chosenName);
        const exact = selected ? all.filter(row => normalizedName(row?.location_name) === selected) : [];
        // Broader city/region searches have no exact location; compare the lowest applicable fee.
        return exact.length ? exact : all;
    }

    function safeAmount(value) {
        const amount = Number(value);
        return Number.isFinite(amount) && amount > 0 ? amount : 0;
    }

    function minimum(rows, amountOf) {
        return rows.length ? Math.min(...rows.map(amountOf)) : 0;
    }

    function selectedLocationFees(car, pickupName, returnName, localReturnRows) {
        const partner = car?.partners || {};
        const available = Array.isArray(partner.partner_locations) ? partner.partner_locations : [];
        const pickupRows = matchingLocations(available, pickupName);
        // API responses already contain both locations. Local cars have return fees
        // loaded separately because their nested join describes the pickup only.
        const isApi = car?.api_managed === true || Boolean(car?.api_quote_id);
        const returnRows = isApi
            ? matchingLocations(available, returnName)
            : (localReturnRows?.get(String(partner.id)) || []);
        return {
            pickup: minimum(pickupRows, row => row?.extra_fee === true ? safeAmount(row.extra_fee_amount) : 0),
            return: minimum(returnRows, row => safeAmount(row?.return_fee_amount))
        };
    }

    function customerLocationFeeTotal(fees, marginPercent) {
        const margin = Number(marginPercent);
        const safeMargin = Number.isFinite(margin) && margin >= 0 ? margin : 0;
        function gross(amount) {
            // Match server booking-items.mjs: cents + rounded margin for EACH fee line.
            const netCents = Math.round(safeAmount(amount) * 100);
            return (netCents + Math.round(netCents * safeMargin / 100)) / 100;
        }
        return Number((gross(fees?.pickup) + gross(fees?.return)).toFixed(2));
    }

    function totalRankPrice(rentalTotal, locationFeesCustomer, exchangeRate) {
        const rent = Number(rentalTotal), extras = Number(locationFeesCustomer), rate = Number(exchangeRate);
        if (![rent, extras, rate].every(Number.isFinite) || rent < 0 || extras < 0 || rate <= 0) {
            return Number.POSITIVE_INFINITY;
        }
        return (rent + extras) * rate;
    }

    function compareByTotalPrice(a, b, rankPrices) {
        const priceA = rankPrices.get(a) ?? Number.POSITIVE_INFINITY;
        const priceB = rankPrices.get(b) ?? Number.POSITIVE_INFINITY;
        if (priceA !== priceB) return priceA < priceB ? -1 : 1;
        // A chauffeur is a tie-breaker, never a reason to place a pricier offer first.
        return Number(b.driver_included === true) - Number(a.driver_included === true);
    }

    root.Ride24ResultPricing = Object.freeze({
        selectedLocationFees,
        customerLocationFeeTotal,
        totalRankPrice,
        compareByTotalPrice
    });
})(window);
