/**
 * Caravel SANDBOX periodic reconciliation for silent webhook outages.
 * Uses documented GET /v1/bookings?updated_since with opaque pagination.
 * One supplier / one page per call, each booking refetched from provider.
 *
 * The repository MUST implement atomic DB checkpoints and monotonic revisions.
 * This is sandbox-only monitoring, NOT Ride24 customer booking dispatch.
 */
const ID=/^[A-Za-z0-9_-]{1,128}$/;
const CONTROL=/[\u0000-\u001f\u007f]/;
const PAGE_MAX=100;
const validToken=v=>v===null||(typeof v==="string"&&v.length>0&&v.length<=2048&&!CONTROL.test(v));
const validIso=v=>typeof v==="string"&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(v)&&
  Number.isFinite(Date.parse(v));

export async function runCaravelSandboxPeriodicPoll({
  client,repository,now=()=>Date.now(),maxRows=PAGE_MAX,budgetMs=75000,
}={}){
  if(client?.environment!=="sandbox" || !client?.suppliers || !client?.listBookings ||
     !client?.bookingStatusSandbox || !repository?.registerSuppliers ||
     !repository?.claimPeriodic || !repository?.commitPeriodicPage || !repository?.releasePeriodic)
    throw new Error("CARAVEL_PERIODIC_SANDBOX_REPOSITORY_REQUIRED");
  if(!Number.isSafeInteger(maxRows)||maxRows<1||maxRows>PAGE_MAX||
     !Number.isSafeInteger(budgetMs)||budgetMs<1000||budgetMs>90000)
    throw new Error("CARAVEL_PERIODIC_INVALID_BOUND");
  const started=now();
  // Read the supplier list from Caravel itself (never hardcode EUR/GBP IDs).
  const supplied=(await client.suppliers())?.data;
  if(!Array.isArray(supplied)||supplied.length<1||supplied.length>10)
    throw new Error("CARAVEL_PERIODIC_SUPPLIERS_UNVERIFIED");
  const ids=supplied.map(s=>s?.supplier_id);
  if(ids.some(id=>typeof id!=="string"||!ID.test(id)) || new Set(ids).size!==ids.length)
    throw new Error("CARAVEL_PERIODIC_SUPPLIERS_INVALID");
  // Registering is additive only: never change an existing watermark.
  await repository.registerSuppliers(ids);

  const lease=crypto.randomUUID();
  const job=await repository.claimPeriodic(lease);
  if(job===null)return {ok:true,state:"idle",pages:0,bookings:0};
  const validJob=typeof job?.supplier_id==="string"&&ids.includes(job.supplier_id)&&
    validIso(job.scan_from)&&validIso(job.scan_to)&&
    Date.parse(job.scan_from)<=Date.parse(job.scan_to)&&
    Date.parse(job.scan_to)<=started+1000&&
    validToken(job.page_token??null);
  if(!validJob){
    try{await repository.releasePeriodic(job?.supplier_id,lease);}catch{}
    return {ok:false,state:"invalid_job",pages:0,bookings:0};
  }
  try{
    const params={updated_since:job.scan_from,
      ...(job.page_token==null?{}:{page_token:job.page_token})};
    const page=await client.listBookings(params,job.supplier_id);
    if(!Array.isArray(page?.data)||page.data.length>maxRows)
      throw new Error("CARAVEL_PERIODIC_PAGE_INVALID");
    const next=page.meta?.next_page??null;
    if(!validToken(next)||next!==null&&next===job.page_token)
      throw new Error("CARAVEL_PERIODIC_CURSOR_INVALID");
    const processed=[],seen=new Set();
    for(const summary of page.data){
      if(now()-started>=budgetMs)throw new Error("CARAVEL_PERIODIC_TIME_BUDGET");
      const id=summary?.booking_id;
      if(typeof id!=="string"||!ID.test(id))
        throw new Error("CARAVEL_PERIODIC_BOOKING_ID_INVALID");
      if(seen.has(id))continue;
      seen.add(id);
      const current=(await client.bookingStatusSandbox(id,job.supplier_id))?.data;
      if(!current||current.booking_id!==id||
        current.supplier_id!=null&&current.supplier_id!==job.supplier_id||
        !Number.isSafeInteger(current.revision)||current.revision<1||
        typeof current.status!=="string"||!/^[a-z_]{1,64}$/.test(current.status))
        throw new Error("CARAVEL_PERIODIC_REFETCH_INVALID");
      processed.push({booking_id:id,revision:current.revision,status:current.status});
    }
    if(now()-started>=budgetMs)throw new Error("CARAVEL_PERIODIC_TIME_BUDGET");
    // Provider's pagination has no upper-time filter. Commit a fixed scan_to
    // taken at scan START; the next cycle overlaps the previous watermark.
    const result=await repository.commitPeriodicPage(job.supplier_id,lease,processed,next);
    if(result?.accepted!==true||typeof result.complete!=="boolean")
      throw new Error("CARAVEL_PERIODIC_CHECKPOINT_FAILED");
    return {ok:true,state:result.complete?"complete":"more",
      pages:1,bookings:processed.length,changed:result.changed??null};
  }catch{
    try{await repository.releasePeriodic(job.supplier_id,lease);}catch{}
    return {ok:false,state:"retry",pages:0,bookings:0,
      reason:"CARAVEL_PERIODIC_PAGE_FAILED"};
  }
}
