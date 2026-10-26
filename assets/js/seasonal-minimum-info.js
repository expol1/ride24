/* Ride24 WEB pickup-month minimum: shared by WWW search and result cards. */
(function (root) {
  "use strict";
  const normalizedMonths = (values) => {
    if (!Array.isArray(values)) return [];
    return [...new Set(values.map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= 12))].sort((a,b) => a-b);
  };
  const forPickup = (partner, pickupDate) => {
    if (!partner || typeof pickupDate !== "string" || !/^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(pickupDate)) return null;
    const days = Number(partner.seasonal_min_rental_days);
    if (!Number.isInteger(days) || days < 1 || days > 366) return null;
    const month = Number(pickupDate.slice(5,7));
    return normalizedMonths(partner.seasonal_min_rental_months).includes(month) ? days : null;
  };
  // Always preserve the year-round minimum; a lower seasonal value must not
  // weaken it. The pickup month (not the return month) selects the season.
  const effectiveForPickup = (partner, pickupDate) => {
    const rawBase = Number(partner?.min_rental_days);
    const baseDays = Number.isInteger(rawBase) && rawBase >= 1 && rawBase <= 366 ? rawBase : 1;
    const seasonalDays = forPickup(partner, pickupDate);
    const days = seasonalDays === null ? baseDays : Math.max(baseDays, seasonalDays);
    return { days, seasonal: seasonalDays !== null && days > baseDays };
  };
  root.Ride24SeasonalMinimum = Object.freeze({normalizedMonths, forPickup, effectiveForPickup});
})(typeof window === "undefined" ? globalThis : window);
