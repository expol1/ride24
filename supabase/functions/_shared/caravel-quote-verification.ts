/**
 * Verify Caravel's authoritative quote before a customer-facing price is shown.
 * The caller must map provider-documented fields; no API response shape is assumed here.
 * All money is in integer minor units, and no locally computed extras are added
 * to the provider total a second time.
 */
export type VerifiedCaravelQuote = {
  currency: string;
  rentalAmountMinor: number;
  extrasAmountMinor: number;
  mandatoryFeesAmountMinor: number;
  totalAmountMinor: number;
  quoteId: string;
  expiresAtEpochMs: number;
  plan: string;
  depositAmountMinor: number;
  excessAmountMinor: number;
};
export type QuoteVerification = {ok:true;partnerPayableMinor:number;quoteId:string} |
  {ok:false;errors:string[]};
const amount = (n:unknown):n is number => typeof n==="number" && Number.isSafeInteger(n) && n>=0;
export function verifyCaravelQuote(q:VerifiedCaravelQuote, nowEpochMs:number):QuoteVerification {
  const errors:string[]=[];
  if(!/^[A-Z]{3}$/.test(q.currency)) errors.push("INVALID_CURRENCY");
  if(q.plan.toLowerCase()!=="premium") errors.push("PREMIUM_REQUIRED");
  if(!amount(q.depositAmountMinor) || q.depositAmountMinor!==0) errors.push("ZERO_DEPOSIT_REQUIRED");
  if(!amount(q.excessAmountMinor) || q.excessAmountMinor!==0) errors.push("ZERO_EXCESS_REQUIRED");
  if(!q.quoteId.trim()) errors.push("QUOTE_ID_REQUIRED");
  if(!Number.isSafeInteger(nowEpochMs) || !Number.isSafeInteger(q.expiresAtEpochMs) || q.expiresAtEpochMs<=nowEpochMs) errors.push("QUOTE_EXPIRED");
  const components=[q.rentalAmountMinor,q.extrasAmountMinor,q.mandatoryFeesAmountMinor,q.totalAmountMinor];
  if(!components.every(amount)) errors.push("INVALID_AMOUNT");
  else {
    const sum=q.rentalAmountMinor+q.extrasAmountMinor+q.mandatoryFeesAmountMinor;
    if(!Number.isSafeInteger(sum) || sum!==q.totalAmountMinor) errors.push("QUOTE_TOTAL_MISMATCH");
  }
  if(errors.length) return {ok:false,errors};
  return {ok:true,partnerPayableMinor:q.totalAmountMinor,quoteId:q.quoteId};
}
