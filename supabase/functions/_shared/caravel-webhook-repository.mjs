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
    // GAP-RECOVERY QUEUE (separate invoker, never called by a public client).
    async claimJob(lease){
      const result=await rpc("caravel_sbx_reconcile_claim",{p_lease:lease});
      if(result===null)return null;
      if(typeof result!=="object" || typeof result.job_id!=="string")
        throw new Error("CARAVEL_RECONCILE_BAD_CLAIM");
      return result;
    },
    async commitPage(jobId,lease,items,nextPage){
      if(!Array.isArray(items) || items.length>100)
        throw new Error("CARAVEL_RECONCILE_TOO_MANY_ROWS");
      const result=await rpc("caravel_sbx_reconcile_apply_page",{
        p_job_id:jobId,p_lease:lease,p_items:items,p_next_page:nextPage,
      });
      if(!result || result.accepted!==true || typeof result.complete!=="boolean")
        throw new Error("CARAVEL_RECONCILE_BAD_COMMIT");
      return result;
    },
    async releaseJob(jobId,lease){
      return rpc("caravel_sbx_reconcile_release",{p_job_id:jobId,p_lease:lease});
    },
  };
}
