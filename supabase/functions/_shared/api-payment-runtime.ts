import { advanceApiPayment } from './api-payment-flow.mjs';
import { loadPartnerCredentials, sanitizePartnerPayload } from './partner-api.ts';
import { revalidatePaidProvider,createPaidProvider,readPaidProviderStatus } from './api-provider-fulfillment.ts';

async function one(query:any) {const {data,error}=await query; if(error)throw Error('API_WORKFLOW_DB_ERROR');return data;}
export async function apiPaymentEnabled(admin:any) {
 const row=await one(admin.from('api_payment_settings').select('enabled').eq('id',true).maybeSingle());return row?.enabled===true;
}
async function internalCall(name:string,id:string) {
 const response=await fetch(Deno.env.get('SUPABASE_URL')+'/functions/v1/'+name,{method:'POST',
   headers:{'Content-Type':'application/json',Authorization:'Bearer '+Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
   'x-internal-secret':Deno.env.get('RIDE24_INTERNAL_SECRET')||''},body:JSON.stringify({booking_id:id}),signal:AbortSignal.timeout(20000)});
 await response.body?.cancel();if(!response.ok)throw Error('API_CONFIRMATION_DELIVERY_FAILED');
}
export async function runApiPayment(admin:any,stripe:any,id:string) {
 let booking:any,credentials:any;
 const get=()=>one(admin.from('api_booking_workflows').select('*').eq('booking_id',id).maybeSingle());
 const load=async()=>{
   booking=await one(admin.from('bookings').select('*,partners!bookings_partner_id_fkey(api_provider,provider_type,rental_terms_url,rental_rules_url)').eq('id',id).maybeSingle());
   if(!booking||booking.provider_type!=='api')throw Error('API_BOOKING_NOT_FOUND');
   credentials=await loadPartnerCredentials(admin,booking.partner_id);return booking;
 };
 const rpc=async(name:string,args:any)=>one(admin.rpc(name,args));
 const move=async(_id:string,from:string,payload:any)=>one(admin.from('api_booking_workflows').update(payload).eq('booking_id',id).eq('state',from).select('*').maybeSingle());
 const deps={get,move,
   claimValidation:async(_id:string,w:any)=>one(admin.from('api_booking_workflows')
     .update({state:'revalidating',updated_at:new Date().toISOString()}).eq('booking_id',id).eq('state',w.state).eq('updated_at',w.updated_at).select('*').maybeSingle()),
   revalidate:async()=>{
     await load();const q=await one(admin.from('api_quotes').select('*').eq('id',booking.api_quote_id).maybeSingle());
     return revalidatePaidProvider(credentials,booking,q);
   },
   claimDispatch:async(_id:string,prepared:any)=>rpc('api_claim_paid_dispatch',{p_booking_id:id,p_prepared:prepared}),
   create:async(_id:string,prepared:any)=>{
     if(!credentials)await load();return createPaidProvider(credentials,prepared);
   },
   recover:async(_id:string,w:any)=>{
     // Renteon has not yet documented a unique OrderReference lookup guarantee.
     // Never interpret an empty search or an absent reference as permission to retry.
     if(!w.provider_reference)return null;
     if(w.last_error==='PROVIDER_RESPONSE_REQUIRES_REVIEW'||w.last_error==='CANCELLED_DURING_DISPATCH')return null;
     await load();return readPaidProviderStatus(credentials,w.provider_reference,w.prepared_quote);
   },
   status:async(_id:string,w:any)=>{await load();return readPaidProviderStatus(credentials,w.provider_reference,w.prepared_quote);},
   finalize:async()=>{
     const ok=await rpc('api_finalize_confirmed',{p_booking_id:id});
     if(ok) {
       await internalCall('generate-voucher',id);
       await one(admin.from('api_booking_workflows').update({fulfilled_at:new Date().toISOString()}).eq('booking_id',id).eq('state','confirmed').select('booking_id'));
     }
   },
   refund:async(_id:string,w:any)=>{
     if(w.refund_id)return stripe.refunds.retrieve(w.refund_id);
     const prior=await stripe.refunds.list({payment_intent:w.payment_intent,limit:100});
     const existing=prior.data.find((r:any)=>r.metadata?.ride24_api_booking_id===id);
     if(existing)return existing;
     if(prior.has_more||prior.data.some((r:any)=>r.status!=='failed'&&r.status!=='canceled'))throw Error('REFUND_RECONCILIATION_REQUIRED');
     // Stripe removes idempotency records after at least 24h: no blind retry beyond that.
     if(Date.now()-Date.parse(w.refund_started_at)>23*3600000)throw Error('REFUND_RECONCILIATION_REQUIRED');
     return stripe.refunds.create({payment_intent:w.payment_intent,amount:Number(w.amount_cents),
       metadata:{ride24_api_booking_id:id},reason:'requested_by_customer'}, {idempotencyKey:'ride24-api-full-refund:'+id});
   },
   refundNotice:async()=>{
     const w=await get();if(!w)return;
     const status=w.state==='refunded'?'completed':w.state==='refund_failed'?'failed':'pending';
     await one(admin.from('bookings').update({refund_status:status,refund_amount_pln:Number(w.amount_cents)/100,
       refund_percentage:100,refund_reason:w.last_error||'API fulfillment failed',
       ...(status==='completed'?{refund_completed_at:new Date().toISOString()}:{}),
       manual_review:status==='failed',api_status:'payment_'+w.state}).eq('id',id).select('id'));
     // Fulfillment has definitively failed; do not leave a paid cart shown as awaiting a partner.
     await one(admin.from('bookings').update({status:'rejected',partner_response_deadline:null,payment_deadline:null,expires_at:null})
       .eq('id',id).in('status',['pending','awaiting_payment']).select('id'));
     // One event per status. Do not use the local rejection email (it says no money was taken).
     const {error:noticeError}=await admin.from('email_logs').insert({booking_id:id,type:'api_refund_'+status,status:'queued'});
     // Existing email_logs uses a partial unique index; PostgREST upsert cannot infer its predicate.
     if(noticeError&&noticeError.code!=='23505')throw Error('API_REFUND_NOTICE_WRITE_FAILED');
     if(status!=='pending')await one(admin.from('api_booking_workflows').update({fulfilled_at:new Date().toISOString()}).eq('booking_id',id).eq('state',w.state).select('booking_id'));
   }
 };
 const result=await advanceApiPayment(deps,id);
 const w=await get();
 if(w?.state==='provider_pending')await one(admin.from('bookings').update({api_status:'payment_provider_pending',api_booking_reference:w.provider_reference}).eq('id',id).eq('status','pending').select('id'));
 if(w?.state==='unknown') {
   await one(admin.from('api_booking_workflows').update({updated_at:new Date().toISOString()}).eq('booking_id',id).eq('state','unknown').select('booking_id'));
   await one(admin.from('bookings').update({manual_review:true,api_status:'payment_unknown',
     ...(w.provider_reference?{api_booking_reference:w.provider_reference}:{})}).eq('id',id).select('id'));
   const existing=await one(admin.from('booking_review_queue').select('id').eq('booking_id',id).eq('provider_status','payment_unknown').limit(1).maybeSingle());
   if(!existing)await one(admin.from('booking_review_queue').insert({booking_id:id,provider_key:'api_payment',provider_status:'payment_unknown',
     api_response:JSON.stringify(sanitizePartnerPayload({reason:w.last_error,reference:w.provider_reference})),resolved:false}));
 }
 return result;
}
