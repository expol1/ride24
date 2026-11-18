/**
 * Caravel-only server-service adapter to PostgreSQL's transactional booking
 * quote-claim RPC. Does NOT take HTTP input or expose a client endpoint.
 * The authenticated Edge caller must derive clientId, terms, current cover,
 * driver's licence, exchange rate and customer assent from trusted sources.
 *
 * Release protection lives ALSO in PostgreSQL caravel_release_control:
 * certified=false and allow_customer_checkout=false until live supplier
 * approval. Never invoke Stripe unless this returns a booking UUID.
 */
import {buildCertifiedCaravelBookingInsert,type CaravelInsertBuilderArgs}
 from "./caravel-booking-insert.ts";
type Rec=Record<string,unknown>;
type RpcResult={data:unknown;error:{message?:string}|null};
export type CaravelCommitAdmin={
 rpc:(name:"caravel_commit_pending_booking",args:{
  p_quote_id:string;p_client_id:string;p_payload:Rec;
 })=>Promise<RpcResult>;
};
export type CaravelPendingCommitResult=
 |{ok:true;bookingId:string;status:"awaiting_payment";stripeAllowed:false}
 |{ok:false;reason:string;stripeAllowed:false;retrySupplierBooking:false};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function fail(reason:string):CaravelPendingCommitResult{
 return {ok:false,reason,stripeAllowed:false,retrySupplierBooking:false};
}
export async function persistCertifiedCaravelPendingBooking(args:{
 admin:CaravelCommitAdmin;
 trustedInput:CaravelInsertBuilderArgs;
}):Promise<CaravelPendingCommitResult>{
 if(!args||!args.admin||typeof args.admin.rpc!=="function")
  return fail("CARAVEL_PENDING_RPC_NOT_CONFIGURED");
 const decision=buildCertifiedCaravelBookingInsert(args.trustedInput);
 if("reason" in decision)
  return fail(decision.reason);
 // No retry after an uncertain DB outcome: the quote is one-time.
 // Future caller can read api_quotes.booking_id for safe reconciliation.
 let persisted:RpcResult;
 try{
  persisted=await args.admin.rpc("caravel_commit_pending_booking",{
   p_quote_id:decision.quoteId,
   p_client_id:args.trustedInput.authenticatedClientId,
   p_payload:decision.payload,
  });
 }catch{return fail("CARAVEL_PENDING_RPC_OUTCOME_UNCERTAIN");}
 if(persisted.error)return fail("CARAVEL_PENDING_DB_REJECTED");
 if(typeof persisted.data!=="string"||!UUID.test(persisted.data))
  return fail("CARAVEL_PENDING_RPC_BAD_RESULT");
 return {ok:true,bookingId:persisted.data,status:"awaiting_payment",
  stripeAllowed:false};
}
