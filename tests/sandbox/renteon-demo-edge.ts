// Deploy only after approval of a separate, short-lived test endpoint.
// Does not replace a production function or update any partner configuration.
import {serviceClient} from '../../supabase/functions/_shared/ride24-security.ts';
import {loadPartnerCredentials} from '../../supabase/functions/_shared/partner-api.ts';
import * as adapter from '../../supabase/functions/_shared/renteon-aggregator.ts';
import {runRenteonDemo} from './renteon-demo-runner.mjs';
const AVIA='91e04805-31da-4242-9e6f-b6075019d784';
const TABLE='ride24_avia_bootstrap_jobs';
Deno.serve(async(req)=>{
 const until=Date.parse(Deno.env.get('RIDE24_DEMO_ACCEPTANCE_UNTIL')||'');
 if(!Number.isFinite(until)||Date.now()>=until)return Response.json({closed:true},{status:410});
 if(req.method!=='POST')return Response.json({error:'METHOD_NOT_ALLOWED'},{status:405});
 const raw=await req.text();if(raw.length>4096)return Response.json({error:'TOO_LARGE'},{status:413});
 let body:any;try {body=JSON.parse(raw);}catch {return Response.json({error:'INVALID_JSON'},{status:400});}
 if(!/^[0-9a-f-]{36}$/.test(body?.job_id)||!/^[0-9a-f]{64}$/.test(body?.token))return Response.json({error:'AUTH_REQUIRED'},{status:401});
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(body.token))),x=>x.toString(16).padStart(2,'0')).join('');
 const admin=serviceClient();
 const {data:job,error}=await admin.from(TABLE).update({status:'running',consumed_at:new Date().toISOString()})
   .eq('id',body.job_id).eq('token_hash',hash).eq('status','pending').is('consumed_at',null)
   .gt('expires_at',new Date().toISOString()).select('id').maybeSingle();
 if(error||!job)return Response.json({error:'AUTH_REQUIRED'},{status:401});
 const events:any[]=[];
 const save=async(status:string,event:any)=>{
   events.push(event);const {error}=await admin.from(TABLE).update({status,result:{demo_only:true,events}}).eq('id',job.id);
   if(error)throw Error('DEMO_JOURNAL_UNAVAILABLE');
 };
 try {
   const existing=await loadPartnerCredentials(admin,AVIA);
   if(existing.renteon_provider_code!=='Avia')throw Error('SOURCE_CONFIGURATION_CHANGED');
   // Copy in memory; never update partners/partner_api_credentials or Vault.
   const credentials={...existing,renteon_provider_code:'demo'};
   if(body.operation==='inspect') {
     const locations=await adapter.aggregatorLocations(credentials);
     await save('synced',{phase:'demo_setup',locations:locations.map(x=>({external_id:x.external_id,name:x.location_name}))});
     return Response.json({demo_only:true,events});
   }
   if(body.operation==='quote') {
     const locations=await adapter.aggregatorLocations(credentials);
     for(const id of [body.pickup_location_id,body.dropoff_location_id])
       if(!locations.some(x=>x.external_id===id))throw Error('LOCATION_NOT_IN_DEMO');
     const input={pickup_location_id:body.pickup_location_id,dropoff_location_id:body.dropoff_location_id,
       pickup_date:body.pickup_date,return_date:body.return_date,pickup_time:body.pickup_time,return_time:body.return_time,currency:'EUR'};
     const offers=await adapter.aggregatorAvailability(credentials,input);
     const chosen=body.vehicle_group_id?offers.find(x=>x.external_id===body.vehicle_group_id):offers[0];
     if(!chosen)throw Error('DEMO_GROUP_UNAVAILABLE');
     const quoted=await adapter.aggregatorQuoteOptions(credentials,chosen.provider_quote_data,body.selections||[],[35]);
     await save('synced',{phase:'demo_quote',offers:offers.map(x=>({category:x.external_id,total:x.public_price_total})),
       category:chosen.external_id,partner_total:quoted.calculated.Total,currency:quoted.calculated.Currency,catalog:quoted.catalog});
     return Response.json({demo_only:true,events});
   }
   if(body.operation!=='reserve_and_cancel')throw Error('UNKNOWN_OPERATION');
   const input={run_id:'ride24-demo-'+job.id,pickup_location_id:body.pickup_location_id,dropoff_location_id:body.dropoff_location_id,
     pickup_date:body.pickup_date,return_date:body.return_date,pickup_time:body.pickup_time,return_time:body.return_time,
     vehicle_group_id:body.vehicle_group_id,selections:body.selections,currency:'EUR'};
   const journal={claim:async(id:string)=>id===input.run_id,
     record:async(_id:string,event:any)=>save('running',event)};
   const result=await runRenteonDemo({credentials,input,adapter,journal});
   await save('synced',{phase:'finished',...result});return Response.json({demo_only:true,events});
 }catch {
   await save('failed',{phase:'runner_failed',manual_review:true}).catch(()=>{});
   return Response.json({error:'DEMO_TEST_INCOMPLETE',demo_only:true,events},{status:409});
 }
});
