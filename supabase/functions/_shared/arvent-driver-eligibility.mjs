// Arvent/kolayCAR: validate self-declared date the driver's licence was FIRST
// obtained, not the physical card replacement/renewal issue date.
// Calendar-year anniversaries are measured at the booked local pickup date.
// This is an eligibility check, not proof of a genuine licence.
function parseIsoDate(raw) {
  if(typeof raw!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(raw))return null;
  const [year,month,day]=raw.split('-').map(Number);
  if(year<1900||year>2200)return null;
  const d=new Date(Date.UTC(year,month-1,day));
  if(d.getUTCFullYear()!==year||d.getUTCMonth()!==month-1||d.getUTCDate()!==day)return null;
  return {year,month,day,text:raw};
}
export function arventLicenseYears(firstIssued,pickupDate,today=new Date().toISOString().slice(0,10)) {
  const first=parseIsoDate(firstIssued);
  const pickup=parseIsoDate(pickupDate);
  const current=parseIsoDate(today);
  if(!first||!pickup||!current||first.text>current.text||current.text>pickup.text)return null;
  let years=pickup.year-first.year;
  if(pickup.month<first.month||(pickup.month===first.month&&pickup.day<first.day))years--;
  if(years<0||years>85)return null;
  return years;
}
export function arventLicenseEligible(firstIssued,pickupDate,minYears,today) {
  if(!Number.isInteger(minYears)||minYears<0||minYears>50)return false;
  const actual=arventLicenseYears(firstIssued,pickupDate,today);
  return actual!==null&&actual>=minYears;
}
