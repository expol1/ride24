import { BookingOptionsError, priceFingerprint, quoteChanged, pricedExtrasEnabled } from './booking-options.mjs';
import { assertApiQuoteContext } from './api-quote-contract.mjs';
import { loadPartnerCredentials } from './partner-api.ts';
import { aggregatorQuoteOptions } from './renteon-aggregator.ts';
import { providerPricingSnapshot, providerServiceCatalog, unconfirmedServicePrice, serviceNames } from './provider-services.mjs';
import { customerPricing } from './booking-items.mjs';
import { exchangeRate } from './booking-exchange-rate.ts';
import { rentalDuration } from './rental-duration.ts';

export async function makeApiBookingOptions(admin:any,user:any,car:any,partner:any,body:any,ages:number[]) {
 if(!await pricedExtrasEnabled(admin))throw new BookingOptionsError('API_OPTIONS_PAUSED','Wycena dodatków jest chwilowo niedostępna. Spróbuj ponownie później.','Options pricing is temporarily unavailable. Try again later.');
 if(partner.api_provider!=='renteon_aggregator')throw quoteChanged();
 if(typeof body.api_quote_id!=='string')throw new BookingOptionsError('API_QUOTE_REQUIRED','Wróć do wyników i wybierz ofertę ponownie.','Return to results and select the offer again.');
 const {data:quote,error}=await admin.from('api_quotes').select('*').eq('id',body.api_quote_id)
 .eq('partner_id',car.partner_id).eq('car_class_id',car.id).eq('start_date',body.start_date).eq('end_date',body.end_date)
 .gt('expires_at',new Date().toISOString()).is('used_at',null).is('booking_id',null).maybeSingle();
 if(error||!quote)throw quoteChanged();
 assertApiQuoteContext(quote.raw_response,body);
 const selections=body.extras??[];
 const credentials=await loadPartnerCredentials(admin,car.partner_id);
 let result;
 try {result=await aggregatorQuoteOptions(credentials,quote.raw_response?.provider_quote_data,selections,ages);}
 catch(e) {
  if(e instanceof Error && e.message.endsWith('DRIVER_AGE_POLICY_REQUIRES_CONFIRMATION'))
    throw new BookingOptionsError('DRIVER_AGE_POLICY_REVIEW','Dostawca musi potwierdzić dopłatę dla kierowcy w wieku 24 lat. Skontaktuj się z Ride24.','The supplier must confirm the surcharge for a 24-year-old driver. Please contact Ride24.');
  throw e;
 }
 const loyalty=await admin.rpc('calculate_loyalty_discount',{p_user_id:user.id}); if(loyalty.error)throw Error('PRICING_UNAVAILABLE');
 const discount=Math.max(0,Math.min(20,Number(Array.isArray(loyalty.data)?loyalty.data[0]:loyalty.data)||0));
 const days=rentalDuration(body.start_date,body.end_date,body.pickup_time,body.return_time).billedDays;
 const snapshot=providerPricingSnapshot(result.calculated,{marginPercent:Number(quote.platform_margin_percent),loyaltyPercent:discount,exchangeRate:await exchangeRate(quote.currency),days});
 const binding={user_id:user.id,driver_id:body.driver_id||null,additional_driver_id:body.additional_driver_id||null,ages,selections};
 const fingerprint=await priceFingerprint(snapshot,binding);
 const {id,created_at,used_at,booking_id,...base}=quote;
 const {data:saved,error:saveError}=await admin.from('api_quotes').insert({...base,
   partner_net_total:snapshot.partner_cents/100,commission_total:snapshot.commission_cents/100,final_total:snapshot.gross_cents/100,
   public_price_per_day:snapshot.partner_cents/100/days,
   raw_response:{...quote.raw_response,provider_quote_data:result.provider_quote_data,
     ride24_options:{binding,fingerprint,snapshot}},
 }).select('id').single();
 if(saveError||!saved?.id)throw Error('PRICING_UNAVAILABLE');
 const catalog=result.catalog.map((x:any)=>({...x,unit_customer_cents:Math.round(x.unit_customer_cents*(1+Number(quote.platform_margin_percent)/100))}));
 return {enabled:true,api_quote_id:saved.id,pricing:customerPricing(snapshot),catalog,fingerprint,
  unavailable_services:result.calculated.Services.filter((s:any)=>!s.IsSelected&&!s.IsMandatory&&!String(s.Code).startsWith('INS-')&&(s.Code==='UNSPECIFIED'||unconfirmedServicePrice(s))).map((s:any)=>({name_en:serviceNames(s).en,name_pl:serviceNames(s).pl,status:s.Code==='UNSPECIFIED'?'mapping_requires_confirmation':'price_requires_confirmation'}))};
}
