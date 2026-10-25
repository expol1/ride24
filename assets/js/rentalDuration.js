/* Ride24 WEB rental duration, independent of form structure. */
(function () {
    "use strict";
    const DAY_MS = 86400000;
    const DATE = /^\d{4}-\d{2}-\d{2}$/;
    const TIME = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
    const dateUtc = value => {
        if (typeof value !== "string" || !DATE.test(value)) throw new Error("INVALID_RENTAL_DATE");
        const ms = Date.parse(value + "T00:00:00.000Z");
        if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) throw new Error("INVALID_RENTAL_DATE");
        return ms;
    };
    const timeOffset = value => {
        const parts = typeof value === "string" ? TIME.exec(value) : null;
        if (!parts) throw new Error("INVALID_RENTAL_TIME");
        return (+parts[1] * 3600 + +parts[2] * 60 + +(parts[3] || 0)) * 1000;
    };
    function calculate(pickupDate, returnDate, pickupTime, returnTime) {
        const elapsedMs = dateUtc(returnDate) - dateUtc(pickupDate)
            + timeOffset(returnTime) - timeOffset(pickupTime);
        if (elapsedMs <= 0 || elapsedMs > 366 * DAY_MS) throw new Error("INVALID_RENTAL_DURATION");
        return Object.freeze({
            elapsedMs, billedDays: Math.ceil(elapsedMs / DAY_MS),
            fullDays: Math.floor(elapsedMs / DAY_MS)
        });
    }
    const meetsMinimum = (duration, minimum) => {
        const raw = Number(minimum);
        const min = Number.isInteger(raw) && raw >= 1 && raw <= 366 ? raw : 1;
        return min <= 1 || duration.fullDays >= min;
    };
    const dateAfter = (startDate, days) => new Date(dateUtc(startDate) + days * DAY_MS).toISOString().slice(0, 10);
    const earliestReturnDate = (startDate, pickupTime, returnTime, minDays) => {
        const minimum = Math.max(1, Math.min(366, Math.trunc(Number(minDays) || 1)));
        const requiredDays = minimum + (timeOffset(returnTime) < timeOffset(pickupTime) ? 1 : 0);
        return dateAfter(startDate, requiredDays);
    };
    window.Ride24RentalDuration = Object.freeze({
        calculate, meetsMinimum, dateAfter, earliestReturnDate
    });
})();
