/**
 * Caravel SANDBOX webhook-gap recovery (isolated, no Ride24 booking writes).
 * Each invocation handles at most one persisted page. The cursor advances
 * atomically with the booking revisions, never before successful refetch.
 *
 * The API key remains server-side. Do NOT invoke production Caravel.
 * Persistence methods MUST be atomic RPCs; the Edge runtime is not a store.
 */
const ID=/^[A-Za-z0-9_-]{1,128}$/;
const CURSOR_CONTROL=/[\u0000-\u001F\u007F]/;

function validCursor(x){
  return x===null || (typeof x==="string" && x.length>0 && x.length<=2048 && !CURSOR_CONTROL.test(x));
}

/** @param {any} options Server-side isolated invocation; runtime validates each required capability before API/DB calls. */
export async function runCaravelSandboxReconcile({repository,client,maxRows=100,budgetMs=80000}={}){
  const started=Date.now();
  if(!repository?.claimJob || !repository?.commitPage || !repository?.releaseJob ||
     !client || client.environment!=="sandbox" ||
     typeof client.listBookings!=="function" || typeof client.bookingStatusSandbox!=="function")
    throw new Error("SANDBOX_RECONCILIATION_CONFIG_REQUIRED");
  if(!Number.isSafeInteger(maxRows)||maxRows<1||maxRows>100)throw new Error("INVALID_PAGE_BOUND");
  if(!Number.isSafeInteger(budgetMs)||budgetMs<1000||budgetMs>90000)throw new Error("INVALID_TIME_BUDGET");
  const lease=crypto.randomUUID();
  const job=await repository.claimJob(lease);
  if(job===null)return {ok:true,state:"idle",pages:0,bookings:0};
  if(typeof job?.job_id!=="string" || !ID.test(job.job_id) ||
     typeof job.operator_id!=="string" || !ID.test(job.operator_id) ||
     typeof job.supplier_id!=="string" || !ID.test(job.supplier_id) ||
     !Number.isFinite(Date.parse(job.since_at)) ||
     !validCursor(job.page_token??null)){
    // A corrupt job must not be used to fetch any supplier data.
    try{await repository.releaseJob(job?.job_id,lease);}catch{}
    throw new Error("SANDBOX_RECONCILIATION_BAD_JOB");
  }
  let read=0;
  try{
    const params={updated_since:job.since_at,
      ...(job.page_token===null||job.page_token===undefined?{}:{page_token:job.page_token})};
    const page=await client.listBookings(params,job.supplier_id);
    if(!Array.isArray(page?.data) || page.data.length>maxRows)
      throw new Error("RECONCILIATION_PAGE_TOO_LARGE_OR_INVALID");
    const next=page.meta?.next_page??null;
    if(!validCursor(next))throw new Error("RECONCILIATION_BAD_CURSOR");
    if(next!==null && next===job.page_token)
      throw new Error("RECONCILIATION_LOOPING_CURSOR");

    const updates=[];
    const seen=new Set();
    for(const item of page.data){
      // Avoid running beyond the lease and Edge execution budget; retry the
      // full page later without persisting an incomplete checkpoint.
      if(Date.now()-started>=budgetMs)throw new Error("RECONCILIATION_TIME_BUDGET");
      const id=item?.booking_id;
      if(typeof id!=="string" || !ID.test(id))
        throw new Error("RECONCILIATION_INVALID_BOOKING_ID");
      if(seen.has(id))continue;
      seen.add(id);
      const fetched=(await client.bookingStatusSandbox(id,job.supplier_id))?.data;
      if(!fetched || fetched.booking_id!==id ||
         (fetched.supplier_id!==undefined && fetched.supplier_id!==null && fetched.supplier_id!==job.supplier_id) ||
         (fetched.operator_id!==undefined && fetched.operator_id!==null && fetched.operator_id!==job.operator_id) ||
         !Number.isSafeInteger(fetched.revision) || fetched.revision<1 ||
         typeof fetched.status!=="string" || !/^[a-z_]{1,64}$/.test(fetched.status))
        throw new Error("RECONCILIATION_REFETCH_MISMATCH");
      updates.push({booking_id:id,revision:fetched.revision,status:fetched.status});
      read++;
    }
    // SQL transaction upserts all updates, then moves opaque page_token or
    // completes the job. No partial page may be acknowledged.
    const applied=await repository.commitPage(job.job_id,lease,updates,next);
    if(!applied || applied.accepted!==true || typeof applied.complete!=="boolean")
      throw new Error("RECONCILIATION_COMMIT_UNCONFIRMED");
    return {ok:true,state:applied.complete?"complete":"more",pages:1,bookings:read,
      // Do not expose real booking data, secrets or page tokens.
      applied:applied.applied??null};
  }catch{
    // If commit already succeeded but its network response was lost, the lease
    // has been cleared. releaseJob must be a NO-OP; the checkpoint is durable.
    try{await repository.releaseJob(job.job_id,lease);}catch{}
    return {ok:false,state:"retry",pages:0,bookings:0,
      reason:"RECONCILIATION_PAGE_FAILED"};
  }
}
