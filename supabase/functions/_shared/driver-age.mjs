export function driverAgeLimits(car, partner) {
  return { min: Number(car.min_driver_age ?? partner.min_driver_age ?? 21), max: partner.max_driver_age == null ? null : Number(partner.max_driver_age) };
}
export function driverAgeAllowed(age, car, partner) {
  if (car.driver_included === true) return true;
  const {min, max} = driverAgeLimits(car, partner);
  return Number.isInteger(Number(age)) && Number(age) >= min && (max === null || Number(age) <= max);
}
