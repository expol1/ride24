/**
 * Production voucher safety fence. ONLY Caravel is subject to these extra
 * supplier-confirmation conditions. All existing partner paths are unchanged.
 *
 * A Stripe-paid booking alone does not prove Caravel supplied a vehicle.
 * The server must first persist an authenticated, matching Caravel booking
 * reference, a supplier-scoped accepted version of terms and the verified
 * Stripe checkpoint. This guard is intentionally stricter than a public
 * client display check and does not itself confirm that remote booking exists.
 */
const CARAVEL_PARTNER_ID="78721481-7619-44df-a9b7-5faa344b69bb";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH=/^[0-9a-f]{64}$/;
function record(x){return x!==null&&typeof x==="object"&&!Array.isArray(x)?x:null;}
function validTimestamp(x){return typeof x==="string"&&Number.isFinite(Date.parse(x));}
function nonempty(x){return typeof x==="string"&&x.trim().length>0;}

export function isCaravelVoucherBooking(booking){
 const b=record(booking);
 if(!b)return false;
 return b.partner_id===CARAVEL_PARTNER_ID||b.api_provider==="caravel";
}

/** An invalid Caravel response always refuses voucher/email (fail closed).
 * Non-Caravel rows intentionally return true and use the existing Ride24
 * paid-payment and voucher-claim guards without any new restrictions.
 */
export function isCaravelVoucherAllowed(booking){
 const b=record(booking);
 if(!b)return false;
 if(!isCaravelVoucherBooking(b))return true;
 return b.partner_id===CARAVEL_PARTNER_ID&&
   b.api_provider==="caravel"&&b.provider_type==="api"&&
   b.status==="paid"&&b.api_status==="confirmed"&&
   b.manual_review===false&&b.cancelled_at==null&&
   UUID.test(String(b.api_booking_reference??""))&&
   nonempty(b.stripe_session_id)&&b.stripe_session_id.startsWith("cs_")&&
   b.stripe_currency==="pln"&&
   Number.isSafeInteger(b.stripe_amount_cents)&&b.stripe_amount_cents>0&&
   validTimestamp(b.caravel_stripe_payment_confirmed_at)&&
   validTimestamp(b.caravel_supplier_dispatch_claimed_at)&&
   UUID.test(String(b.caravel_supplier_quote_id??""))&&
   nonempty(b.caravel_supplier_id)&&
   /^[A-Za-z0-9_-]{1,128}$/.test(b.caravel_supplier_id)&&
   nonempty(b.caravel_terms_document_id)&&
   typeof b.caravel_terms_content_hash==="string"&&
   HASH.test(b.caravel_terms_content_hash)&&
   nonempty(b.caravel_terms_language)&&
   b.terms_accepted===true&&validTimestamp(b.terms_accepted_at);
}
