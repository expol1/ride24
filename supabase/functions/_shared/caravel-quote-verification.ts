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
  if(typeof q.currency!=="string" || !/^[A-Z]{3}$/.test(q.currency)) errors.push("INVALID_CURRENCY");
  if(typeof q.plan!=="string" || q.plan.toLowerCase()!=="premium") errors.push("PREMIUM_REQUIRED");
  if(!amount(q.depositAmountMinor) || q.depositAmountMinor!==0) errors.push("ZERO_DEPOSIT_REQUIRED");
  if(!amount(q.excessAmountMinor) || q.excessAmountMinor!==0) errors.push("ZERO_EXCESS_REQUIRED");
  if(typeof q.quoteId!=="string" || !q.quoteId.trim()) errors.push("QUOTE_ID_REQUIRED");
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

/**
 * Supplier-confirmed mandatory charges, including out-of-hours pickup/return.
 * The supplier quote remains authoritative: this function never invents a
 * night-time window or adds a fee to the quoted total a second time.
 */
export type CaravelMandatoryCharge = {
  externalId:string;
  label:string;
  category:"out_of_hours_pickup"|"out_of_hours_return"|"one_way"|"location"|"other";
  amountMinor:number;
  currency:string;
};
export function verifyCaravelMandatoryCharges(input:{
  charges:CaravelMandatoryCharge[];
  quoteCurrency:string;
  quoteMandatoryFeesMinor:number;
  pickupLocalTime:string;
  returnLocalTime:string;
  pickupTimezone:string;
  returnTimezone:string;
  pickupOutsideHours:boolean|null;
  returnOutsideHours:boolean|null;
}):{ok:true;outOfHoursAmountMinor:number}|{ok:false;errors:string[]} {
  const errors:string[]=[];
  if(!Array.isArray(input.charges)) return {ok:false,errors:["CHARGES_UNVERIFIED"]};
  if(!/^[A-Z]{3}$/.test(input.quoteCurrency??"") ||
    !Number.isSafeInteger(input.quoteMandatoryFeesMinor) || input.quoteMandatoryFeesMinor<0)
    errors.push("MANDATORY_TOTAL_UNVERIFIED");
  if(typeof input.pickupLocalTime!=="string" || typeof input.returnLocalTime!=="string" ||\n    !/^\d{2}:\d{2}$/.test(input.pickupLocalTime) ||
    !/^\d{2}:\d{2}$/.test(input.returnLocalTime) ||
    ![input.pickupLocalTime,input.returnLocalTime].every(t=>{
      const [h,m]=t.split(":").map(Number);return h<=23 && m<=59;
    }) ||
    typeof input.pickupTimezone!=="string" || !input.pickupTimezone.trim() ||\n    typeof input.returnTimezone!=="string" || !input.returnTimezone.trim())
    errors.push("LOCAL_TIME_UNVERIFIED");
  if(typeof input.pickupOutsideHours!=="boolean" || typeof input.returnOutsideHours!=="boolean")
    errors.push("OPERATING_HOURS_UNVERIFIED");
  const ids=new Set<string>();let sum=0,night=0;
  for(const fee of input.charges){
    if(!fee || typeof fee.externalId!=="string" || !fee.externalId.trim() || ids.has(fee.externalId) ||
      typeof fee.label!=="string" || !fee.label.trim() ||
      !["out_of_hours_pickup","out_of_hours_return","one_way","location","other"].includes(fee.category) ||
      fee.currency!==input.quoteCurrency || !Number.isSafeInteger(fee.amountMinor) || fee.amountMinor<0){
      errors.push("MANDATORY_CHARGE_UNVERIFIED");continue;
    }
    ids.add(fee.externalId);
    if(!Number.isSafeInteger(sum+fee.amountMinor)){errors.push("MANDATORY_AMOUNT_OVERFLOW");continue;}
    sum+=fee.amountMinor;
    if(fee.category==="out_of_hours_pickup" || fee.category==="out_of_hours_return"){\n      if(!Number.isSafeInteger(night+fee.amountMinor)) errors.push("OUT_OF_HOURS_AMOUNT_OVERFLOW");\n      else night+=fee.amountMinor;\n    }
  }
  if(sum!==input.quoteMandatoryFeesMinor) errors.push("MANDATORY_FEE_MISMATCH");
  if(input.pickupOutsideHours===true && !input.charges.some(f=>f?.category==="out_of_hours_pickup"))
    errors.push("PICKUP_FEE_UNVERIFIED");
  if(input.returnOutsideHours===true && !input.charges.some(f=>f?.category==="out_of_hours_return"))
    errors.push("RETURN_FEE_UNVERIFIED");
  return errors.length?{ok:false,errors:[...new Set(errors)]}:{ok:true,outOfHoursAmountMinor:night};
}
