/**
 * Caravel ONLY — persist a verified supplier confirmation before allowing
 * Ride24 to release its voucher and confirmation email.
 *
 * ISOLATED; NOT DEPLOYED, NOT A SHARED API ADAPTER.
 * The caller must obtain the result from submitVerifiedCaravelBooking()
 * (which strictly validates quoted grand_total, pay_on_arrival, zero
 * deposit/excess, supplier booking id, and quote id).
 *
 * A supplier POST may succeed even if Ride24 is cancelled simultaneously:
 * failure to save the confirmation is never authorization to issue a
 * voucher or retry POST. Preserve the external reference for manual
 * reconciliation / supplier cancellation when this happens.
 */
type Rec=Record<string,unknown>;
const rec=(x:unknown):Rec|null=>x!==null&&typeof x==="object"&&!Array.isArray(x)?x as Rec:null;
const uuid=(x:unknown):x is string=>
 typeof x==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
const CARAVEL="78721481-7619-44df-a9b7-5faa344b69bb";
const iso=(x:unknown):number|null=>{
 if(typeof x!=="string"||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(x))
   return null;
 const n=Date.parse(x);return Number.isFinite(n)?n:null;
};
type DbResult={data:Rec|null;error:{message?:string}|null};
type Chain={
 update:(payload:Rec)=>Chain;
 eq:(column:string,value:unknown)=>Chain;
 is:(column:string,value:null)=>Chain;
 select:(columns:string)=>Chain;
 maybeSingle:()=>Promise<DbResult>;
};
export type CaravelConfirmationAdmin={from:(table:"bookings")=>Chain};
export type CaravelConfirmationCommit=
 |{ok:true;bookingId:string;providerReference:string;
   releaseVoucher:true;notifyCustomer:true}
 |{ok:false;action:"hold_for_manual_review";reason:string;
   providerReference:string|null;releaseVoucher:false;notifyCustomer:false};
const fail=(reason:string,providerReference:string|null=null):CaravelConfirmationCommit=>
 ({ok:false,action:"hold_for_manual_review",reason,providerReference,
   releaseVoucher:false,notifyCustomer:false});

export async function commitVerifiedCaravelSupplierConfirmation(args:{
 admin:CaravelConfirmationAdmin;
 bookingId:string;
 /** Fresh server-side booking row from the winning atomic dispatch claim. */
 paidClaim:unknown;
 /** Only the successful result of submitVerifiedCaravelBooking().result. */
 verifiedProviderResult:unknown;
 nowIso:string;
}):Promise<CaravelConfirmationCommit>{
 if(!args||!args.admin||typeof args.admin.from!=="function"||
    !uuid(args.bookingId)||iso(args.nowIso)===null)
   return fail("CARAVEL_CONFIRMATION_CONTEXT_INVALID");
 const b=rec(args.paidClaim),receipt=rec(args.verifiedProviderResult);
 const data=rec(receipt?.provider_payload);
 const ref=typeof receipt?.booking_reference==="string"&&
   uuid(receipt.booking_reference)?receipt.booking_reference:null;
 if(!b||b.id!==args.bookingId||b.partner_id!==CARAVEL||
    b.provider_type!=="api"||b.api_provider!=="caravel"||
    b.status!=="pending"||b.api_status!=="caravel_supplier_dispatch_claimed"||
    b.manual_review!==false||b.cancelled_at!=null||
    b.api_booking_reference!=null||
    typeof b.stripe_session_id!=="string"||
    !b.stripe_session_id.startsWith("cs_")||
    b.stripe_currency!=="pln"||
    !Number.isSafeInteger(b.stripe_amount_cents)||
    (b.stripe_amount_cents as number)<=0||
    iso(b.caravel_stripe_payment_confirmed_at)===null||
    iso(b.caravel_supplier_dispatch_claimed_at)===null)
   return fail("CARAVEL_CONFIRMATION_PAID_CLAIM_INVALID",ref);
 const paidAt=iso(b.caravel_stripe_payment_confirmed_at)!;
 const claimedAt=iso(b.caravel_supplier_dispatch_claimed_at)!;
 const now=iso(args.nowIso)!;
 if(paidAt>claimedAt||claimedAt>now+5000||now-claimedAt>300000)
   return fail("CARAVEL_CONFIRMATION_CLAIM_TOO_OLD_OR_INVALID",ref);
 if(!ref||!receipt||receipt.status!=="confirmed"||
    receipt.id!==ref||receipt.reference!==ref||
    !data||data.booking_id!==ref||
    !uuid(data.quote_id)||data.quote_id!==b.caravel_supplier_quote_id||
    data.payment_model!=="pay_on_arrival"||
    !Number.isSafeInteger(data.revision)||(data.revision as number)<1)
   return fail("CARAVEL_CONFIRMATION_SUPPLIER_RECEIPT_INVALID",ref);

 let result:DbResult;
 try{
  result=await args.admin.from("bookings").update({
    status:"paid",
    api_status:"confirmed",
    api_booking_reference:ref,
    api_response:{provider:"caravel",booking_id:ref,
      quote_id:data.quote_id,revision:data.revision,
      payment_model:"pay_on_arrival"},
    manual_review:false,
  })
   .eq("id",args.bookingId)
   .eq("partner_id",CARAVEL)
   .eq("status","pending")
   .eq("api_status","caravel_supplier_dispatch_claimed")
   .eq("stripe_session_id",b.stripe_session_id)
   .eq("caravel_supplier_quote_id",b.caravel_supplier_quote_id)
   .eq("manual_review",false)
   .is("cancelled_at",null)
   .is("api_booking_reference",null)
   .select("id,api_booking_reference,status,api_status")
   .maybeSingle();
 }catch{return fail("CARAVEL_CONFIRMATION_DB_WRITE_UNCERTAIN",ref);}
 if(result.error)return fail("CARAVEL_CONFIRMATION_DB_WRITE_FAILED",ref);
 if(!result.data||result.data.id!==args.bookingId||
   result.data.api_booking_reference!==ref||
   result.data.status!=="paid"||
   result.data.api_status!=="confirmed")
   return fail("CARAVEL_CONFIRMATION_CONCURRENT_STATE_CHANGED",ref);
 return {ok:true,bookingId:args.bookingId,providerReference:ref,
   releaseVoucher:true,notifyCustomer:true};
}
