import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { authenticatedUser, corsHeaders, enforceRateLimit, isUuid, jsonResponse, publicErrorMessage, serviceClient } from "../_shared/ride24-security.ts";
import { readJsonObject } from "../_shared/booking-request.ts";
import { exchangeRate } from "../_shared/booking-exchange-rate.ts";
import { BookingOptionsError, loadBookingOptions, makeBookingQuote, pricedExtrasEnabled, pricingContext } from "../_shared/booking-options.mjs";
import { assertApiPricingCompatible, assertApiRequestedOptions } from "../_shared/api-quote-contract.mjs";
import { rentalDuration, meetsMinimumRental } from "../_shared/rental-duration.ts";
import { loadPartnerCredentials, sanitizePartnerPayload } from "../_shared/partner-api.ts";
import { previewRenteonExtras } from "../_shared/provider-adapters.ts";
import { apiRenteonExtrasPricing } from "../_shared/api-provider-extras-quote.mjs";
import { customerPricing } from "../_shared/booking-items.mjs";
import { priceFingerprint } from "../_shared/booking-options.mjs";
import { apiQuoteContext, assertApiQuoteContext } from "../_shared/api-quote-contract.mjs";

function date(value: unknown): string {
  if(typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10)!==value) throw new Error('Nieprawidłowe daty');
  return value;
}
function time(value: unknown): string {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value) ? value : '10:00';
}

async function quoteRenteonOptions(req: Request, admin: ReturnType<typeof serviceClient>, user: { id: string }, car: { id: string; partner_id: string; external_id?: string | null }, partner: { api_provider?: string; api_enabled?: boolean; min_rental_days?: number }, body: Record<string, unknown>) {
  if (partner.api_provider !== "renteon" || partner.api_enabled !== true) return jsonResponse(req,{enabled:false});
  if (!isUuid(body.api_quote_id)) {
    throw new BookingOptionsError('API_QUOTE_REQUIRED','Wybierz ponownie ofertę API z wyników wyszukiwania.','Select the API offer again from the search results.',400);
  }
  const start = date(body.start_date), end = date(body.end_date);
  const pickupTime = time(body.pickup_time), returnTime = time(body.return_time);
  const duration = rentalDuration(start,end,pickupTime,returnTime);
  if (!meetsMinimumRental(duration, partner.min_rental_days)) {
    throw new BookingOptionsError('MIN_RENTAL_DAYS','Wybierz dłuższy okres wynajmu.','Select a longer rental period.',400);
  }
  const pickupName = body.pickup_location, dropoffName = body.return_location;
  if (typeof pickupName !== "string" || !pickupName || pickupName.length > 250
    || typeof dropoffName !== "string" || !dropoffName || dropoffName.length > 250) {
    throw new BookingOptionsError('INVALID_API_QUOTE_CONTEXT','Lokalizacja oferty jest nieprawidłowa.','Invalid offer location.',400);
  }
  const selections = body.extras ?? [];
  if (!Array.isArray(selections) || selections.length > 20) {
    throw new BookingOptionsError('API_EXTRAS_INVALID_SELECTION','Wybierz dodatki ponownie.','Choose the extras again.',400);
  }
  const now = new Date().toISOString();
  const { data: quote, error } = await admin.from('api_quotes')
    .select('id,partner_id,car_class_id,external_group_id,pickup_location_external_id,dropoff_location_external_id,start_date,end_date,partner_discount_percent,platform_margin_percent,currency,raw_response,expires_at,external_quote_reference')
    .eq('id',body.api_quote_id).eq('car_class_id',car.id).eq('partner_id',car.partner_id)
    .eq('start_date',start).eq('end_date',end).gt('expires_at',now)
    .is('used_at',null).is('booking_id',null).maybeSingle();
  if (error || !quote || !quote.raw_response || !quote.external_group_id) {
    throw new BookingOptionsError('API_QUOTE_CHANGED','Oferta API wygasła. Wybierz ją ponownie.','API offer expired. Select it again.');
  }
  assertApiQuoteContext(quote.raw_response,{
    pickup_time:pickupTime,return_time:returnTime,pickup_location:pickupName,return_location:dropoffName,
  });
  const original = quote.raw_response;
  const source = original.provider_quote_data;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new BookingOptionsError('API_QUOTE_CHANGED','Wycena API nie jest kompletna.','The API quote is incomplete.');
  }

  const { data:profile, error:profileError } = await admin.from('profiles')
    .select('name,age').eq('id',user.id).maybeSingle();
  if (profileError || !profile || !profile.name || !(Number(profile.age) >= 18)) {
    throw new BookingOptionsError('PROFILE_REQUIRED','Uzupełnij imię i wiek w profilu.','Complete your profile name and age.',400);
  }
  let additionalDriver = null;
  if (body.additional_driver_id != null) {
    if (!isUuid(body.additional_driver_id)) {
      throw new BookingOptionsError('INVALID_DRIVER','Nieprawidłowy dodatkowy kierowca.','Invalid additional driver.',400);
    }
    const {data:driver,error:driverError} = await admin.from('drivers')
      .select('name,age').eq('id',body.additional_driver_id).eq('user_id',user.id).maybeSingle();
    if (driverError || !driver || !driver.name || !(Number(driver.age) >= 18)) {
      throw new BookingOptionsError('INVALID_DRIVER','Nieprawidłowy dodatkowy kierowca.','Invalid additional driver.',400);
    }
    additionalDriver = {name:String(driver.name),age:Number(driver.age)};
  }
  const credentials = await loadPartnerCredentials(admin,car.partner_id);
  const providerInput = {
    idempotency_key: `preview:${quote.id}`, ride24_booking_id:quote.id,
    vehicle_group_id:String(quote.external_group_id),
    pickup_location_id:String(quote.pickup_location_external_id || ''),
    dropoff_location_id:String(quote.dropoff_location_external_id || quote.pickup_location_external_id || ''),
    pickup_date:start,return_date:end,pickup_time:pickupTime,return_time:returnTime,
    currency:String(quote.currency),
    partner_discount_percent:Number(quote.partner_discount_percent ?? 0),
    main_driver:{name:String(profile.name),age:Number(profile.age)},
    additional_driver:additionalDriver,
    provider_quote_data:source,
  };
  let preview;
  try {
    preview = await previewRenteonExtras(credentials,providerInput,selections);
  } catch(error) {
    console.error("Renteon extras preview failed",error instanceof Error ? error.message : "unknown");
    throw new BookingOptionsError('API_EXTRAS_UNAVAILABLE','Nie można teraz potwierdzić dodatków i ich ceny w systemie wypożyczalni.','Cannot confirm extras and pricing with the rental company right now.',503);
  }
  const days = duration.billedDays;
  const { data:loyaltyResult,error:loyaltyError } = await admin.rpc('calculate_loyalty_discount',{p_user_id:user.id});
  if (loyaltyError) throw new Error('LOYALTY_PRICING_UNAVAILABLE');
  const loyaltyData = Array.isArray(loyaltyResult) ? loyaltyResult[0] : loyaltyResult;
  const loyaltyPercent = Math.max(0,Math.min(20,Number(loyaltyData)||0));
  const currency = String(quote.currency || '').toUpperCase();
  const { snapshot, price } = apiRenteonExtrasPricing({
    baseTotal:preview.baseTotal,selectedTotal:preview.total,
    days,currency,discountPercent:Number(quote.partner_discount_percent ?? 0),
    marginPercent:Number(quote.platform_margin_percent ?? 25),
    loyaltyPercent,exchangeRate:await exchangeRate(currency),selections,catalog:preview.catalog,
  });
  const newContext = {
    user_id:user.id,source_api_quote_id:quote.id,car_id:car.id,start,end,
    pickup_time:pickupTime,return_time:returnTime,pickup_location:pickupName,
    return_location:dropoffName,selections,
  };
  const fingerprint = await priceFingerprint(snapshot,newContext);
  const quotePayload = {
    partner_id:quote.partner_id,car_class_id:quote.car_class_id,
    external_group_id:quote.external_group_id,
    pickup_location_external_id:quote.pickup_location_external_id,
    dropoff_location_external_id:quote.dropoff_location_external_id,
    start_date:start,end_date:end,
    public_price_per_day:Number((preview.total/days).toFixed(6)),
    partner_discount_percent:quote.partner_discount_percent,
    platform_margin_percent:quote.platform_margin_percent,
    partner_net_total:price.partnerNetTotal,commission_total:price.commissionTotal,
    final_total:price.finalTotal,currency,
    external_quote_reference:quote.external_quote_reference,
    expires_at:quote.expires_at,
    raw_response:sanitizePartnerPayload({
      ...original,
      provider_quote_data:{
        ...source,
        ride24_selected_extras:selections,
      },
      ride24_api_extras:{
        user_id:user.id,
        source_api_quote_id:quote.id,
        fingerprint,
        selections,
        snapshot,
      },
      ride24_context:apiQuoteContext({
        pickupTime,returnTime,pickupName,returnName:dropoffName,
      }),
    },80_000),
  };
  const {data:saved,error:saveError} = await admin.from('api_quotes')
    .insert(quotePayload).select('id').single();
  if (saveError || !saved?.id) throw new Error('API_EXTRAS_QUOTE_PERSIST_FAILED');
  return jsonResponse(req,{
    enabled:true,provider:"renteon",api_quote_id:saved.id,
    catalog:preview.catalog,pricing:customerPricing(snapshot),fingerprint,
  });
}

serve(async(req: Request)=>{
  if(req.method==='OPTIONS') return new Response('ok',{headers:corsHeaders(req)});
  if(req.method!=='POST') return jsonResponse(req,{error:'METHOD_NOT_ALLOWED'},405);
  try {
    const user=await authenticatedUser(req), admin=serviceClient();
    await enforceRateLimit(admin,req,'booking-options',60,60);
    const body=await readJsonObject(req);
    if(!isUuid(body.car_class_id)) throw new Error('Nieprawidłowa grupa');
    const {data:car,error}=await admin.from('car_classes').select('id,partner_id,external_id,active,partners(id,active,account_status,currency,provider_type,api_provider,api_enabled,min_rental_days)').eq('id',body.car_class_id).single();
    const partner=Array.isArray(car?.partners) ? car.partners[0] : car?.partners;
    if(error || !car?.active || !partner?.active || partner.account_status!=='active') throw new Error('Wybrana grupa nie jest dostępna');
    if(partner.provider_type==='api') {
      assertApiRequestedOptions({extras:[],pricing_version:undefined});
      await assertApiPricingCompatible(admin, car.partner_id);
      return await quoteRenteonOptions(req,admin,user,car,partner,body);
    }
    if(!await pricedExtrasEnabled(admin)) return jsonResponse(req,{enabled:false});
    const start=date(body.start_date), end=date(body.end_date);
    const duration=rentalDuration(start,end,time(body.pickup_time),time(body.return_time));
    const days=duration.billedDays;
    if(!meetsMinimumRental(duration, partner.min_rental_days)) {
      throw new BookingOptionsError('MIN_RENTAL_DAYS','Wybierz dłuższy okres wynajmu.','Select a longer rental period.',400);
    }
    if(typeof body.pickup_location!=='string' || typeof body.return_location!=='string' || body.pickup_location.length>250 || body.return_location.length>250) throw new Error('Nieprawidłowa lokalizacja');
    if(body.additional_driver_id && !isUuid(body.additional_driver_id)) throw new Error('Nieprawidłowy kierowca');
    const [options,price,loyalty]=await Promise.all([
      loadBookingOptions(admin,car.partner_id,body.pickup_location,body.return_location),
      admin.rpc('calculate_booking_price',{car_id:car.id,start_date:start,end_date:duration.pricingEndDate}),
      admin.rpc('calculate_loyalty_discount',{p_user_id:user.id}),
    ]);
    if((options.timeRules.length || options.timeBlocks.length) && (
      typeof body.pickup_time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(body.pickup_time)
      || typeof body.return_time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(body.return_time)
    )) throw new BookingOptionsError('TIME_REQUIRED','Wybierz godzinę odbioru i zwrotu, aby obliczyć dopłaty.','Select pickup and return times to calculate fees.',400);
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
