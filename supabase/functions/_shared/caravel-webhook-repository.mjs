/**
 * Supabase RPC adapter for SANDBOX-only Caravel event bookkeeping.
 *
 * Tables and SQL functions are separate proposed DDL, NOT deployed.
 * Never create a fallback JS in-memory repository: concurrent Edge instances
 * must share an atomic event claim and monotonically ordered booking state.
 */
export function createCaravelSandboxWebhookRepository(admin){
  if(typeof admin?.rpc!=="function")throw new Error("CARAVEL_WEBHOOK_DATABASE_REQUIRED");
  const rpc=async(name,args)=>{
    const {data,error}=await admin.rpc(name,args);
    if(error)throw new Error("CARAVEL_WEBHOOK_STORAGE_FAILED");
    return data;
  };
  return {
    async claim(event,lease){
      const result=await rpc("caravel_sbx_webhook_claim",{
        p_event_id:event.event_id,p_operator_id:event.operator_id,
        p_booking_id:event.booking_id,p_supplier_id:event.supplier_id,
        p_revision:event.revision,p_sequence:event.sequence,
        p_occurred_at:event.occurred_at,p_lease:lease,
      });
      if(!["claimed","complete","busy"].includes(result))throw new Error("CARAVEL_WEBHOOK_BAD_CLAIM");
      return result;
    },
    async finalize(event,lease,booking){
      const result=await rpc("caravel_sbx_webhook_finalize",{
        p_event_id:event.event_id,p_lease:lease,
        p_fetched_revision:booking.revision,p_fetched_status:booking.status,
      });
      if(!result||!["applied","stale"].includes(result.outcome) ||
        typeof result.sequence_gap!=="boolean")
        throw new Error("CARAVEL_WEBHOOK_BAD_FINALIZE");
      return result;
    },
    async release(event,lease){
      const result=await rpc("caravel_sbx_webhook_release",{
        p_event_id:event.event_id,p_lease:lease,
      });
      if(result!==true&&result!==false)throw new Error("CARAVEL_WEBHOOK_BAD_RELEASE");
      return result;
    },
  };
}
