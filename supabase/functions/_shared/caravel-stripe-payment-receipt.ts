/**
 * Idempotent, Stripe-signed PAID receipt persistence for Caravel only.
 *
 * The caller MUST first verify a real Stripe webhook signature and match
 * client, booking, checkout session, currency and exact Ride24 reservation
 * fee against the trusted booking (caravel-payment-commit.ts does this).
 * Never expose this helper to user-authenticated or public requests.
 *
 * The existing production payments_stripe_session_uidx unique index makes
 * concurrent replays safe. A pre-existing receipt with changed booking,
 * currency, paid status or amount is a manual-review hold, NOT success.
 * No supplier calls, refunds, vouchers or confirmation emails here.
 */
type Rec=Record<string,unknown>;
type Result={data:Rec|null;error:{code?:string;message?:string}|null};
type Query={select:(columns:string)=>Query;
 eq:(column:string,value:unknown)=>Query;maybeSingle:()=>Promise<Result>;
 insert:(row:Rec)=>Promise<{error:{code?:string;message?:string}|null}>;};
export type CaravelReceiptAdmin={
 from:(name:"payments")=>Query;
};
export type CaravelReceiptResult=
 |{ok:true;stripeSessionId:string;receiptPersisted:true}
 |{ok:false;reason:string;receiptPersisted:false};
const uuid=(x:unknown):x is string=>typeof x==="string"&&
 /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
const record=(v:unknown):Rec|null=>
 v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Rec:null;
const fail=(reason:string):CaravelReceiptResult=>
 ({ok:false,reason,receiptPersisted:false});
const cents=(value:unknown):number|null=>{
 if(typeof value!=="number"&&typeof value!=="string")return null;
 const x=Number(value),n=Math.round(x*100);
 return Number.isFinite(x)&&x>0&&Number.isSafeInteger(n)&&
   Math.abs(n/100-x)<1e-7?n:null;
};
export async function persistCaravelPaidStripeReceipt(args:{
 admin:CaravelReceiptAdmin;bookingId:string;clientId:string;
 /** Only the object verified by Stripe.webhooks.constructEventAsync. */
 verifiedStripeSession:unknown;expectedFeeMinor:number;
}):Promise<CaravelReceiptResult>{
 const s=record(args?.verifiedStripeSession),meta=record(s?.metadata);
 const sessionId=s?.id;
 if(!args||!args.admin||!uuid(args.bookingId)||!uuid(args.clientId)||
    typeof sessionId!=="string"||!sessionId.startsWith("cs_")||
    s?.client_reference_id!==args.bookingId||
    meta?.booking_id!==args.bookingId||meta?.client_id!==args.clientId||
    s?.status!=="complete"||s?.payment_status!=="paid"||
    s?.currency!=="pln"||!Number.isSafeInteger(args.expectedFeeMinor)||
    args.expectedFeeMinor<=0||s?.amount_total!==args.expectedFeeMinor)
   return fail("CARAVEL_STRIPE_RECEIPT_EVIDENCE_INVALID");
 const verify=(row:Rec|null)=>!!row&&
    row.booking_id===args.bookingId&&
    row.stripe_session_id===sessionId&&
    row.currency==="pln"&&row.status==="paid"&&
    cents(row.amount)===args.expectedFeeMinor;
 const read=async():Promise<Result>=>{
  return await args.admin.from("payments").select(
   "booking_id,stripe_session_id,amount,currency,status"
  ).eq("stripe_session_id",sessionId).maybeSingle();
 };
 let current:Result;
 try{current=await read();}
 catch{return fail("CARAVEL_STRIPE_RECEIPT_READ_FAILED");}
 if(current.error)return fail("CARAVEL_STRIPE_RECEIPT_READ_FAILED");
 if(current.data)return verify(current.data)?
   {ok:true,stripeSessionId:sessionId,receiptPersisted:true}:
   fail("CARAVEL_STRIPE_RECEIPT_CONFLICT");
 try{
  const {error}=await args.admin.from("payments").insert({
    booking_id:args.bookingId,stripe_session_id:sessionId,
    amount:args.expectedFeeMinor/100,currency:"pln",status:"paid",
    provider:"stripe",
  });
  // Unique conflict may be a benign concurrent replay; re-read and
  // compare the actual durable row, never assume it belongs to us.
  if(error&&error.code!=="23505")
   return fail("CARAVEL_STRIPE_RECEIPT_WRITE_FAILED");
 }catch{return fail("CARAVEL_STRIPE_RECEIPT_WRITE_FAILED");}
 try{current=await read();}
 catch{return fail("CARAVEL_STRIPE_RECEIPT_RECHECK_FAILED");}
 if(current.error||!current.data)
   return fail("CARAVEL_STRIPE_RECEIPT_RECHECK_FAILED");
 return verify(current.data)?
  {ok:true,stripeSessionId:sessionId,receiptPersisted:true}:
  fail("CARAVEL_STRIPE_RECEIPT_CONFLICT");
}
