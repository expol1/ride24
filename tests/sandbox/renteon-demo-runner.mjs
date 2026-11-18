// Server-side acceptance only. No production partner, booking, payment or notification writes.
// The caller provides the real adapter and a durable single-run journal in an isolated environment.
export async function runRenteonDemo({credentials,input,adapter,journal}) {
 if(credentials?.renteon_provider_code!=='demo'||credentials.api_url!=='https://aggregator.renteon.com')
   throw Error('DEMO_ONLY');
 if(!input?.run_id?.startsWith('ride24-demo-')||!Array.isArray(input.selections))throw Error('INVALID_DEMO_INPUT');
 if(!await journal.claim(input.run_id))throw Error('RUN_ALREADY_CLAIMED');
 // Claim is permanent. An interrupted save must never be retried under a new run ID to hide uncertainty.
 let reference=null;
 try {
   const locations=await adapter.aggregatorLocations(credentials);
   for(const id of [input.pickup_location_id,input.dropoff_location_id])
     if(!locations.some(x=>x.external_id===id))throw Error('LOCATION_NOT_IN_DEMO');
   const offers=await adapter.aggregatorAvailability(credentials,input);
   const offer=offers.find(x=>x.external_id===input.vehicle_group_id);
   if(!offer)throw Error('DEMO_GROUP_UNAVAILABLE');
   if(offer.provider_quote_data?.provider_code!=='demo'||offer.provider_quote_data?.offer?.Provider!=='demo')throw Error('DEMO_QUOTE_MISMATCH');
   const quote=await adapter.aggregatorQuoteOptions(credentials,offer.provider_quote_data,input.selections,[35]);
   await journal.record(input.run_id,{phase:'quoted',category:offer.external_id,partner_total:quote.calculated.Total,currency:quote.calculated.Currency,selections:input.selections});
   // Persist intent BEFORE the only supplier save call. No automatic save retry after any failure.
   await journal.record(input.run_id,{phase:'save_started'});
   const saved=await adapter.aggregatorBook(credentials,{
     ...input,ride24_booking_id:input.run_id,idempotency_key:input.run_id,
     partner_amount:quote.calculated.Total,provider_quote_data:quote.provider_quote_data,
     main_driver:{name:'Ride24 Demo Acceptance',age:35},client_email:'ride24-demo@example.invalid',client_phone:null,
   });
   reference=saved.booking_reference||saved.reference;
   if(typeof reference!=='string'||!reference)throw Error('DEMO_SAVE_OUTCOME_UNKNOWN');
   await journal.record(input.run_id,{phase:'saved',reference,status:saved.status,needs_manual_review:saved.needs_manual_review===true});
   const status=await adapter.aggregatorStatus(credentials,reference);
   if((status.booking_reference||status.reference)!==reference)throw Error('DEMO_STATUS_REFERENCE_MISMATCH');
   await journal.record(input.run_id,{phase:'status_read',reference,status:status.status});
   // finally must verify cancellation before this return can complete.
   return {reference,status:'cancelled',booking_status_before_cancellation:status.status,category:offer.external_id,partner_total:quote.calculated.Total};
 } catch(error) {
   await journal.record(input.run_id,{phase:reference?'failed_after_save':'failed_or_unknown',reference,
     error:error instanceof Error&&/^[A-Z0-9_:]+$/.test(error.message)?error.message:'DEMO_RUN_FAILED'});
   throw error;
 } finally {
   // Cancel only a reference returned by THIS demo run, using the same hard-gated credentials.
   if(reference) {
     const cancelled=await adapter.aggregatorCancel(credentials,reference);
     if(cancelled.status!=='cancelled'||(cancelled.booking_reference||cancelled.reference)!==reference)
       throw Error('DEMO_CANCELLATION_UNCONFIRMED');
     const readBack=await adapter.aggregatorStatus(credentials,reference);
     if(readBack.status!=='cancelled'||(readBack.booking_reference||readBack.reference)!==reference)
       throw Error('DEMO_CANCELLATION_READBACK_UNCONFIRMED');
     await journal.record(input.run_id,{phase:'cancelled_verified',reference});
   }
 }
}
