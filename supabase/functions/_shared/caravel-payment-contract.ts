/**
 * Caravel supplier quote -> Ride24 collection contract, WITHOUT any API calls.
 *
 * amounts_minor is the Ride24 payment SCHEDULE derived from the supplier's
 * pay_on_arrival AGREEMENT (Caravel contract §6.2: price.totals.pay_now is a
 * product-wide price-line split and may be non-zero; it never means anything is
 * due before pickup under pay_on_arrival). The real schedule is proven again by
 * booking.payment (model pay_on_arrival, amount_prepaid 0, on-arrival = total).
 * Ride24 charges its OWN reservation fee separately through Stripe and the
 * supplier must collect the ENTIRE rental at vehicle pickup. A quote split
 * is authoritative; merely setting payment_model=pay_on_arrival on a local
 * offer is not evidence that the supplier priced that payment mode.
 *
 * The supplier's raw sandbox/contract fixtures should still be parsable by
 * the generic normalizer, but only validated quotes may enter Ride24 offers
 * or a production booking. No credit-card/deposit requirements are inferred.
 */
type Json=Record<string,unknown>;
const rec=(value:unknown):Json|null =>
  value!==null && typeof value==="object" && !Array.isArray(value)
    ? value as Json : null;
const integer=(x:unknown):x is number=>typeof x==="number" && Number.isSafeInteger(x);
export type CaravelPaymentContract =
  |{ok:true;currency:"EUR"|"GBP";totalMinor:number}
  |{ok:false;errors:string[]};

export function verifyCaravelRide24PaymentContract(providerQuoteData:unknown):CaravelPaymentContract {
  const row=rec(providerQuoteData);
  const minor=rec(row?.amounts_minor);
  const major=rec(row?.amounts);
  const errors:string[]=[];
  const currency=row?.currency;
  if(row?.provider!=="caravel")errors.push("CARAVEL_QUOTE_REQUIRED");
  if(currency!=="EUR" && currency!=="GBP")errors.push("RIDE24_PAYMENT_CURRENCY_UNSUPPORTED");
  if(row?.payment_model!=="pay_on_arrival")errors.push("PAY_ON_ARRIVAL_NOT_VERIFIED");
  const total=minor?.total;
  const payNow=minor?.pay_now;
  const atPickup=minor?.pay_at_pickup;
  if(!integer(total) || total<=0 || !integer(payNow) || payNow<0 ||
     !integer(atPickup) || atPickup<0 || !Number.isSafeInteger(payNow+atPickup))
    errors.push("CARAVEL_PAYMENT_SPLIT_UNVERIFIED");
  else {
    if(payNow!==0) errors.push("CARAVEL_PREPAYMENT_NOT_ALLOWED");
    if(atPickup!==total) errors.push("CARAVEL_PICKUP_AMOUNT_MISMATCH");
  }
  if(typeof major?.total!=="number" || !Number.isFinite(major.total) ||
     !integer(total) || Math.abs(major.total*100-total)>0.00001)
    errors.push("CARAVEL_PAYMENT_MAJOR_MINOR_MISMATCH");
  return errors.length
    ?{ok:false,errors:[...new Set(errors)]}
    :{ok:true,currency:currency as "EUR"|"GBP",totalMinor:total as number};
}
