/* Ride24 WEB-only seasonal minimum preference. Never used to block booking requests. */
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
  root.Ride24SeasonalMinimum = Object.freeze({normalizedMonths, forPickup});
})(typeof window === "undefined" ? globalThis : window);
