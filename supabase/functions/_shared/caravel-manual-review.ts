/**
 * Caravel — persistent operator review on paid supplier failures.
 * ISOLATED, NOT DEPLOYED. For the real booking_review_queue schema:
 * booking_id text; provider_key text; provider_status text;
 * api_response text; resolved boolean.
 *
 * A failure after a supplier POST is AMBIGUOUS: mark booking as manual
 * before queueing evidence; NEVER retry the POST or auto-refund.
 * A known external reference stays ONLY in the review, not a confirmed
 * api_booking_reference or a customer voucher.
 *
 * The draft caravel-paid-dispatch-claim.sql partial UNIQUE index makes
 * the review insert safe against concurrent workers. The code also handles
 * unique violation 23505 with an authoritative re-read.
 */
const PARTNER="78721481-7619-44df-a9b7-5faa344b69bb";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASON=/^CARAVEL_[A-Z0-9_]{3,100}$/;
type Rec=Record<string,unknown>;
const rec=(x:unknown):Rec|null=>x!==null&&typeof x==="object"&&!Array.isArray(x)?x as Rec:null;
type DbError={code?:string;message?:string}|null;
type DbResult={data:Rec|null;error:DbError};
type Query={
 select:(columns:string)=>Query;
 update:(payload:Rec)=>Query;
 insert:(payload:Rec)=>PromiseLike<{error:DbError}>;
 eq:(column:string,value:unknown)=>Query;
 is:(column:string,value:null)=>Query;
 limit:(num:number)=>Query;
 maybeSingle:()=>Promise<DbResult>;
};
export type CaravelReviewAdmin={from:(table:"bookings"|"booking_review_queue")=>Query};
export type CaravelSupplierFailure={
 phase:"preflight"|"supplier_response"|"supplier_outcome_uncertain"|"confirmation";
 reasons:string[];
 externalReference:string|null;
};
export type CaravelReviewResult=
 |{ok:true;action:"queued"|"already_queued";bookingId:string;
   mayGenerateVoucher:false;mayAutomaticallyRetry:false;mayAutomaticallyRefund:false}
 |{ok:false;reason:string;mayGenerateVoucher:false;
   mayAutomaticallyRetry:false;mayAutomaticallyRefund:false};
const fail=(reason:string):CaravelReviewResult=>({
 ok:false,reason,mayGenerateVoucher:false,
 mayAutomaticallyRetry:false,mayAutomaticallyRefund:false,
});
export async function queueCaravelSupplierManualReview(args:{
 admin:CaravelReviewAdmin;
 bookingId:string;
 outcome:CaravelSupplierFailure;
}):Promise<CaravelReviewResult>{
 if(!args||typeof args.bookingId!=="string"||!UUID.test(args.bookingId)||
    !args.admin||typeof args.admin.from!=="function")
   return fail("CARAVEL_REVIEW_INPUT_INVALID");
 const outcome=args.outcome;
 if(!outcome||![
   "preflight","supplier_response","supplier_outcome_uncertain","confirmation",
 ].includes(outcome.phase)||
   !Array.isArray(outcome.reasons)||outcome.reasons.length<1||
   outcome.reasons.length>12||
   !outcome.reasons.every(r=>typeof r==="string"&&REASON.test(r))||
   (outcome.externalReference!==null&&
    (typeof outcome.externalReference!=="string"||!UUID.test(outcome.externalReference))))
   return fail("CARAVEL_REVIEW_UNSAFE_OUTCOME");
 let row:DbResult;
 try{
  row=await args.admin.from("bookings")
   .select("id,partner_id,provider_type,status,api_status,manual_review,cancelled_at,api_booking_reference,stripe_session_id,caravel_stripe_payment_confirmed_at,partners!bookings_partner_id_fkey(api_provider)")
   .eq("id",args.bookingId).maybeSingle();
 }catch{return fail("CARAVEL_REVIEW_BOOKING_READ_FAILED");}
 const booking=row.data;
 const relation=rec(booking?.partners);
 if(row.error||!booking||booking.id!==args.bookingId||
   booking.partner_id!==PARTNER||booking.provider_type!=="api"||
   relation?.api_provider!=="caravel"||
   typeof booking.stripe_session_id!=="string"||
   !booking.stripe_session_id.startsWith("cs_")||
   typeof booking.caravel_stripe_payment_confirmed_at!=="string"||
   !Number.isFinite(Date.parse(booking.caravel_stripe_payment_confirmed_at)))
   return fail("CARAVEL_REVIEW_PAID_BOOKING_SCOPE_INVALID");
 // Never convert a completed/vouchered booking back into a manual state.
 if(booking.status==="paid"||booking.api_status==="confirmed"||
    booking.api_booking_reference!=null)
   return fail("CARAVEL_REVIEW_BOOKING_ALREADY_CONFIRMED");
 const pending=booking.status==="pending";
 const cancelled=booking.status==="cancelled";
 const alreadyHeld=pending&&booking.api_status==="caravel_manual_review_required"&&
   booking.manual_review===true;
 const eligiblePending=pending&&booking.manual_review===false&&
   booking.cancelled_at==null&&[
     "caravel_paid_awaiting_supplier","caravel_supplier_dispatch_claimed",
   ].includes(String(booking.api_status));
 const eligibleCancelled=cancelled&&
   booking.api_status==="caravel_supplier_dispatch_claimed"&&
   booking.manual_review===false;
 if(!alreadyHeld&&!eligiblePending&&!eligibleCancelled)
   return fail("CARAVEL_REVIEW_STATE_NOT_ELIGIBLE");

 if(!alreadyHeld){
   const payload:Rec=eligibleCancelled
     ?{manual_review:true}
     :{manual_review:true,api_status:"caravel_manual_review_required"};
   let updated:DbResult;
   try{
    let q=args.admin.from("bookings").update(payload)
      .eq("id",args.bookingId)
      .eq("partner_id",PARTNER)
      .eq("provider_type","api")
      .eq("status",booking.status)
      .eq("api_status",booking.api_status)
      .eq("manual_review",false)
      .is("api_booking_reference",null);
    if(eligiblePending)q=q.is("cancelled_at",null);
    updated=await q.select("id").maybeSingle();
   }catch{return fail("CARAVEL_REVIEW_BOOKING_HOLD_UNCERTAIN");}
   if(updated.error)return fail("CARAVEL_REVIEW_BOOKING_HOLD_FAILED");
   if(!updated.data)return fail("CARAVEL_REVIEW_BOOKING_CHANGED_RECONCILE");
 }
 // Holding the booking MUST precede review insertion. A failed insert leaves
 // the booking blocked; a subsequent job may safely fill the missing ticket.
 const status="supplier_manual_review";
 async function existingReview():Promise<DbResult>{
   return args.admin.from("booking_review_queue").select("id,resolved")
     .eq("booking_id",args.bookingId)
     .eq("provider_key","caravel")
     .eq("provider_status",status).limit(1).maybeSingle();
 }
 let prior:DbResult;
 try{prior=await existingReview();}
 catch{return fail("CARAVEL_REVIEW_QUEUE_READ_FAILED");}
 if(prior.error)return fail("CARAVEL_REVIEW_QUEUE_READ_FAILED");
 if(prior.data){
   if(prior.data.resolved===true)return fail("CARAVEL_REVIEW_ALREADY_RESOLVED");
   return {ok:true,action:"already_queued",bookingId:args.bookingId,
     mayGenerateVoucher:false,mayAutomaticallyRetry:false,mayAutomaticallyRefund:false};
 }
 // Strictly minimal, non-PII supplier evidence; no raw request, customer
 // details, provider tokens, error stack or untrusted free-text response.
 const evidence=JSON.stringify({
   phase:outcome.phase,
   reasons:[...new Set(outcome.reasons)].sort(),
   external_reference:outcome.externalReference,
 });
 let inserted:{error:DbError};
 try{
   inserted=await args.admin.from("booking_review_queue").insert({
     booking_id:args.bookingId,provider_key:"caravel",
     provider_status:status,api_response:evidence,resolved:false,
   });
 }catch{return fail("CARAVEL_REVIEW_QUEUE_INSERT_FAILED");}
 if(inserted.error){
   if(inserted.error.code!=="23505")
     return fail("CARAVEL_REVIEW_QUEUE_INSERT_FAILED");
   let after:DbResult;
   try{after=await existingReview();}
   catch{return fail("CARAVEL_REVIEW_QUEUE_INSERT_FAILED");}
   if(after.error||!after.data||after.data.resolved===true)
     return fail("CARAVEL_REVIEW_QUEUE_INSERT_FAILED");
   return {ok:true,action:"already_queued",bookingId:args.bookingId,
     mayGenerateVoucher:false,mayAutomaticallyRetry:false,mayAutomaticallyRefund:false};
 }
 return {ok:true,action:"queued",bookingId:args.bookingId,
   mayGenerateVoucher:false,mayAutomaticallyRetry:false,mayAutomaticallyRefund:false};
}
