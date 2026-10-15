import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { authenticatedUser, corsHeaders, enforceRateLimit, isUuid, jsonResponse, publicErrorMessage, serviceClient } from "../_shared/ride24-security.ts";
import { readJsonObject } from "../_shared/booking-request.ts";
import { exchangeRate } from "../_shared/booking-exchange-rate.ts";
import { BookingOptionsError, loadBookingOptions, makeBookingQuote, pricedExtrasEnabled, pricingContext } from "../_shared/booking-options.mjs";

function date(value: unknown): string {
  if(typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10)!==value) throw new Error('Nieprawidłowe daty');
  return value;
}
function time(value: unknown): string {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value) ? value : '10:00';
}
serve(async(req: Request)=>{
  if(req.method==='OPTIONS') return new Response('ok',{headers:corsHeaders(req)});
  if(req.method!=='POST') return jsonResponse(req,{error:'METHOD_NOT_ALLOWED'},405);
  try {
    const user=await authenticatedUser(req), admin=serviceClient();
    await enforceRateLimit(admin,req,'booking-options',60,60);
    const body=await readJsonObject(req);
    if(!isUuid(body.car_class_id)) throw new Error('Nieprawidłowa grupa');
    const {data:car,error}=await admin.from('car_classes').select('id,partner_id,active,partners(id,active,account_status,currency,provider_type)').eq('id',body.car_class_id).single();
    const partner=Array.isArray(car?.partners) ? car.partners[0] : car?.partners;
    if(error || !car?.active || !partner?.active || partner.account_status!=='active') throw new Error('Wybrana grupa nie jest dostępna');
    if(partner.provider_type==='api' || !await pricedExtrasEnabled(admin)) return jsonResponse(req,{enabled:false});
    const start=date(body.start_date), end=date(body.end_date);
    const days=(Date.parse(end)-Date.parse(start))/86400000;
    if(days<1 || days>366) throw new Error('Nieprawidłowe daty');
    if(typeof body.pickup_location!=='string' || typeof body.return_location!=='string' || body.pickup_location.length>250 || body.return_location.length>250) throw new Error('Nieprawidłowa lokalizacja');
    if(body.additional_driver_id && !isUuid(body.additional_driver_id)) throw new Error('Nieprawidłowy kierowca');
    const [options,price,loyalty]=await Promise.all([
      loadBookingOptions(admin,car.partner_id,body.pickup_location,body.return_location),
      admin.rpc('calculate_booking_price',{car_id:car.id,start_date:start,end_date:end}),
      admin.rpc('calculate_loyalty_discount',{p_user_id:user.id}),
    ]);
    const rental=Array.isArray(price.data) ? price.data[0] : price.data;
    if(price.error || !rental || loyalty.error) throw new Error('PRICING_UNAVAILABLE');
    const discount=Math.max(0,Math.min(20,Number(Array.isArray(loyalty.data) ? loyalty.data[0] : loyalty.data)||0));
    const rawCurrency=String(partner.currency || 'EUR').trim().toUpperCase();
    const currency=rawCurrency==='TRL' ? 'TRY' : rawCurrency;
    const context=pricingContext({userId:user.id,carId:car.id,startDate:start,endDate:end,pickupTime:time(body.pickup_time),returnTime:time(body.return_time),additionalDriverId:body.additional_driver_id},options);
    const {publicQuote}=await makeBookingQuote({options,selections:body.extras ?? [],hasAdditionalDriver:Boolean(body.additional_driver_id),context,rental,days,marginPercent:Number(rental.platform_margin_percent),loyaltyPercent:discount,currency,exchangeRate:await exchangeRate(currency)});
    return jsonResponse(req,publicQuote);
  } catch(error) {
    if(error instanceof BookingOptionsError) return jsonResponse(req,{error:error.message,error_en:error.en,code:error.code},error.status);
    const safe=publicErrorMessage(error);
    return jsonResponse(req,{error:safe.message},safe.status);
  }
});
