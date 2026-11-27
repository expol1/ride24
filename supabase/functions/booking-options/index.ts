import { makeApiBookingOptions, readArventExtrasCatalog, readArventOfferExtras } from "../_shared/api-booking-options.ts";
import { makeKayfleetBookingOptions } from "../_shared/kayfleet-booking-options.ts";
import { driverAgeAllowed, driverAgeLimits } from "../_shared/driver-age.mjs";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { authenticatedUser, corsHeaders, enforceRateLimit, isUuid, jsonResponse, publicErrorMessage, serviceClient } from "../_shared/ride24-security.ts";
import { readJsonObject } from "../_shared/booking-request.ts";
import { exchangeRate } from "../_shared/booking-exchange-rate.ts";
import { BookingOptionsError, loadBookingOptions, makeBookingQuote, pricedExtrasEnabled, pricingContext, priceFingerprint } from "../_shared/booking-options.mjs";
import {arventPricedExtrasCatalog,arventSelectedExtrasQuote,arventOptionsSnapshot} from "../_shared/arvent-extras-pricing.mjs";
import { apiOnlinePaymentPln, assertApiPricingCompatible, assertApiQuoteContext, assertApiRequestedOptions } from "../_shared/api-quote-contract.mjs";
import { rentalDuration, meetsMinimumRental } from "../_shared/rental-duration.ts";

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
    const {data:car,error}=await admin.from('car_classes').select('id,partner_id,allowed_location_ids,active,min_driver_age,driver_included,partners(id,active,account_status,currency,provider_type,api_provider,min_rental_days,min_driver_age,max_driver_age)').eq('id',body.car_class_id).single();
    const partner=Array.isArray(car?.partners) ? car.partners[0] : car?.partners;
    if(error || !car?.active || !partner?.active || partner.account_status!=='active') throw new Error('Wybrana grupa nie jest dostępna');
    const driverAges:number[]=[];
    if (car.driver_included !== true) {
      for (const id of [body.driver_id || null, ...(body.additional_driver_id ? [body.additional_driver_id] : [])]) {
        if (id !== null && !isUuid(id)) throw new Error('Nieprawidłowy kierowca');
        const result = id === null
          ? await admin.from('profiles').select('age').eq('id',user.id).maybeSingle()
          : await admin.from('drivers').select('age').eq('id',id).eq('user_id',user.id).maybeSingle();
        if (result.error || !result.data) throw new Error('Nieprawidłowy kierowca');
        driverAges.push(Number(result.data.age));
        if (!driverAgeAllowed(result.data.age,car,partner)) {
          const limits=driverAgeLimits(car,partner);
          const range=limits.max===null ? `${limits.min}+` : `${limits.min}–${limits.max}`;
          throw new BookingOptionsError('DRIVER_AGE_NOT_ALLOWED',`Wymagany wiek każdego kierowcy: ${range} lat.`,`Each driver must meet the age requirement: ${range}.`,400);
        }
      }
    }
    if(partner.provider_type==='api' && partner.api_provider==='arvent_kolaycar') {
      // Arvent-only supplier-priced selections. Do not change Renteon or local extras.
      // Preview accepts an original vehicle quote and selection codes, never a client price.
      if(!Array.isArray(body.extras??[]) || (body.extras?.length||0)>20 || body.pricing_version===2)
        throw new BookingOptionsError('ARVENT_EXTRAS_UNAVAILABLE',
        'Wybierz dodatki ponownie dla tej oferty.','Choose extras again for this offer.',400);
      await assertApiPricingCompatible(admin, car.partner_id, partner.api_provider);
      // Read-only preview of the server quote; the booking request recomputes it.
      if(!isUuid(body.api_quote_id)) throw new BookingOptionsError('QUOTE_EXPIRED','Oferta wygasła. Wyszukaj ponownie.','The offer expired. Please search again.',409);
      const {data:q,error:qe}=await admin.from('api_quotes')
        .select('id,partner_id,car_class_id,booking_id,used_at,start_date,end_date,external_group_id,pickup_location_external_id,dropoff_location_external_id,partner_net_total,commission_total,final_total,currency,expires_at,raw_response')
        .eq('id',body.api_quote_id).maybeSingle();
      const start=date(body.start_date), end=date(body.end_date);
      if(qe||!q||q.partner_id!==car.partner_id||q.car_class_id!==car.id||q.booking_id||q.used_at||q.currency!=='EUR'
        ||q.start_date!==start||q.end_date!==end||!(Date.parse(q.expires_at)>Date.now()))
        throw new BookingOptionsError('QUOTE_EXPIRED','Oferta wygasła lub zmieniła się. Wyszukaj ponownie.','The offer expired or changed. Please search again.',409);
      // Do not query supplier offers for a different time or pickup/return
      // than the Ride24 quote. This also protects against tampered form data.
      assertApiQuoteContext(q.raw_response,body);
      const rental=Number(q.partner_net_total), fee=Number(q.commission_total), total=Number(q.final_total);
      if(![rental,fee,total].every(v=>Number.isFinite(v)&&v>=0)||total<=0||Math.abs(rental+fee-total)>0.05)
        throw new BookingOptionsError('QUOTE_EXPIRED','Nie można potwierdzić ceny. Wyszukaj ponownie.','The price cannot be confirmed. Please search again.',409);
      const {data:loyalty,error:le}=await admin.rpc('calculate_loyalty_discount',{p_user_id:user.id});
      if(le) throw new Error('Nie udało się obliczyć rabatu');
      const loyaltyValue=Number(Array.isArray(loyalty)?loyalty[0]:loyalty);
      const discount=Math.max(0,Math.min(20,Number.isFinite(loyaltyValue)?loyaltyValue:0));
      const currency=String(q.currency||'EUR').toUpperCase();
      let rate:number;
      try { rate=await exchangeRate(currency,true); }
      catch { throw new BookingOptionsError('EXCHANGE_RATE_UNAVAILABLE','Nie udało się pobrać aktualnego kursu NBP. Spróbuj ponownie za chwilę.','The current NBP exchange rate is unavailable. Please try again shortly.',503); }
      const duration=rentalDuration(start,end,time(body.pickup_time),time(body.return_time));
      const display=q.raw_response?.ride24_display||{};
      // Read-only catalogue: names and codes are NOT priced for this offer.
      // Failure must not block a normal Arvent vehicle booking.
      const [extraCatalog,offerExtras]=await Promise.all([
        readArventExtrasCatalog(admin,car.partner_id).catch(()=>[]),
        readArventOfferExtras(admin,car.partner_id,q,body)
          .catch((error:unknown)=>{
            // A mismatched/changed offer is NOT merely "unpriced extras".
            // Stop before Stripe rather than presenting an obsolete quote.
            const code=error instanceof Error?error.message:'';
            if(new Set([
              'PARTNER_API_ERROR:ARVENT_OFFER_CHANGED',
              'PARTNER_API_ERROR:ARVENT_EXTRAS_QUOTE_CHANGED',
              'PARTNER_API_ERROR:ARVENT_QUOTE_REQUIRED'
            ]).has(code))throw new BookingOptionsError('QUOTE_EXPIRED',
              'Oferta lub jej cena zmieniła się. Wyszukaj ponownie.',
              'The offer or its price has changed. Search again.',409);
            if([
              'PARTNER_API_ERROR:ARVENT_REQUIRED_EXTRAS_UNVERIFIED',
              'PARTNER_API_ERROR:ARVENT_REQUIRED_EXTRAS_UNPRICED',
              'PARTNER_API_ERROR:ARVENT_EXTRAS_SHAPE',
              'PARTNER_API_ERROR:ARVENT_EXTRAS_DUPLICATE_OR_CODE'
            ].includes(code))throw new BookingOptionsError('ARVENT_EXTRAS_PRICE_UNVERIFIED',
              'Dostawca nie potwierdził pełnej ceny oferty z dodatkami. Nie pobierzemy opłaty za niepełną rezerwację.',
              'The supplier has not confirmed the complete price including extras. We will not charge for an incomplete booking.',409);
            // A missing/temporarily unavailable extras endpoint must not
            // disable booking the vehicle without any selected extras.
            return {status:'unavailable',items:[]};
          })
      ]);
      const {data:configuration,error:configurationError}=await admin.from('partners')
        .select('api_settings').eq('id',car.partner_id).maybeSingle();
      if(configurationError)throw new BookingOptionsError('ARVENT_EXTRAS_CONFIG_UNAVAILABLE',
        'Nie można potwierdzić konfiguracji dodatków. Spróbuj ponownie.',
        'Cannot verify the extras configuration. Please try again.',503);
      const settings=configuration?.api_settings||{};
      const certified=settings.arvent_extras_pricing_certified===true;
      if(body.additional_driver_id)
        throw new BookingOptionsError('ARVENT_ADDITIONAL_DRIVER_IDENTITY_NOT_REQUIRED',
          'W Arvent wybierz płatny dodatek „Dodatkowy kierowca” bez podawania danych tej osoby.',
          'For Arvent select the paid Additional driver option; personal details are not collected online.',400);
      const typeMap=settings.arvent_extra_billing_types && typeof settings.arvent_extra_billing_types==='object'
         && !Array.isArray(settings.arvent_extra_billing_types) ? settings.arvent_extra_billing_types : {};
      const driverCode=settings.arvent_additional_driver_certified===true
        ? settings.arvent_additional_driver_code : null;
      const effectiveItems=arventPricedExtrasCatalog(offerExtras.items,typeMap,certified,driverCode);
      const selected=body.extras||[];
      // No payment for a paid mandatory item whose billing could not be certified.
      if(effectiveItems.some((item:any)=>item.required &&
         (!item.bookable && item.price_eur!==0)))
        throw new BookingOptionsError('ARVENT_EXTRAS_PRICE_UNVERIFIED',
          'Arvent nie potwierdził naliczania obowiązkowego dodatku. Nie pobierzemy opłaty.',
          'Arvent has not confirmed mandatory extras billing. No charge will be taken.',409);
      const readyItems=effectiveItems;
      const supplierDays=offerExtras.billed_days;
      const hasChargedDaily=readyItems.some((x:any)=>x.billing==='day'&&x.price_eur>0
         && (x.required || selected.some((chosen:any)=>chosen?.id===x.code)));
      if(hasChargedDaily && (!Number.isInteger(supplierDays)||supplierDays<1||supplierDays>366))
        throw new BookingOptionsError('ARVENT_EXTRAS_BILLING_DAYS_UNVERIFIED',
          'Arvent nie potwierdził liczby dób naliczania dodatków. Nie pobierzemy opłaty.',
          'Arvent did not confirm how many days to bill extras. No charge will be taken.',409);
      const priceDays=Number.isInteger(supplierDays)&&supplierDays>=1&&supplierDays<=366
          ?supplierDays:duration.billedDays;
      let savedQuoteId=q.id, quoteFingerprint:null|string=null, snapshot:any=null;
      let extraQuote:{items:any[];total_cents:number;selected:any[]}|null=null;
      try {
        extraQuote=arventSelectedExtrasQuote({items:readyItems,selections:selected,
          billedDays:priceDays,certified,driverCode,
          certifiedMap:typeMap,additionalDriverId:null});
      } catch(e) {
        const code=e instanceof Error?e.message:'';
        throw new BookingOptionsError(code==='ARVENT_EXTRA_DRIVER_SELECTION_MISMATCH'
          ?'ARVENT_EXTRA_DRIVER_SELECTION_MISMATCH':'ARVENT_EXTRAS_UNAVAILABLE',
          'Nie można potwierdzić ilości, ceny lub kierowcy dla wybranych dodatków.',
          'The selected extras quantity, price or driver could not be verified.',409);
      }
      // Zero-price mandatory supplier equipment is already included in the
      // vehicle-only SaveReservation. Do not mint a v2 paid-options quote for
      // free mandatory items when the partner has not certified paid extras.
      const needsPriceSnapshot=selected.length>0 || extraQuote.total_cents>0;
      if(needsPriceSnapshot){
        snapshot=arventOptionsSnapshot({rentalCents:Math.round(rental*100),
          ride24FeeCents:Math.round(fee*100),extraQuote,days:priceDays,
          loyaltyPercent:discount,nbpRate:rate});
        const binding={user_id:user.id,driver_id:body.driver_id||null,
          additional_driver_id:null,ages:driverAges,selections:selected};
        quoteFingerprint=await priceFingerprint(snapshot,binding);
        // Persist precisely the server-accepted extras, not a client-entered
        // total. Same short-lived API quote transaction model as AVIA.
        const {data:original,error:originalError}=await admin.from('api_quotes')
          .select('*').eq('id',q.id).maybeSingle();
        if(originalError||!original||original.partner_id!==car.partner_id||original.booking_id
           ||original.used_at || !(Date.parse(original.expires_at)>Date.now()))
          throw new BookingOptionsError('QUOTE_EXPIRED',
            'Oferta wygasła. Wyszukaj ponownie.','Offer expired. Search again.',409);
        const {id,created_at,used_at,booking_id,...copy}=original;
        const {data:derived,error:derivedError}=await admin.from('api_quotes')
          .insert({...copy,partner_net_total:snapshot.partner_cents/100,
            commission_total:snapshot.commission_cents/100,
            final_total:snapshot.gross_cents/100,
            public_price_per_day:snapshot.partner_cents/100/duration.billedDays,
            raw_response:{...original.raw_response,ride24_options:{
              binding,fingerprint:quoteFingerprint,snapshot,
              arvent_extra:{rental_cents:Math.round(rental*100),
                extras_cents:extraQuote.total_cents,selected:extraQuote.items,
                driver_code:driverCode,billing_type_map:typeMap,pricing_certified:true}
            }}
          }).select('id').single();
        if(derivedError||!derived?.id)throw new BookingOptionsError('PRICING_UNAVAILABLE',
          'Nie można zapisać zweryfikowanej wyceny dodatków.',
          'Cannot save the verified extras quotation.',503);
        savedQuoteId=derived.id;
      }
      return jsonResponse(req,{enabled:needsPriceSnapshot,
        ...(needsPriceSnapshot?{api_quote_id:savedQuoteId,fingerprint:quoteFingerprint}:{}),
        arvent:{
        api_quote_id:savedQuoteId, currency, billed_days:priceDays,
        start_date:start, end_date:end, pickup_time:time(body.pickup_time).slice(0,5), return_time:time(body.return_time).slice(0,5),
        pickup_location:typeof body.pickup_location==='string'?body.pickup_location.slice(0,250):'',
        return_location:typeof body.return_location==='string'?body.return_location.slice(0,250):'',
        category:{class_code:display.class_code??null,group_name:display.group_name??null,example_model:display.example_model??null,sipp:display.sipp??null},
        // Public rental is the SAME amount shown in Ride24 search (rental
        // plus the already embedded reservation fee), not the supplier net.
        // It is a presentation field; supplier payable EUR and Stripe PLN
        // are still split according to the verified server quote.
        rental_total:rental, rental_public_total:total, mandatory_fees:[],
        extras:extraQuote.items,extra_catalog:extraCatalog,
        offer_extras:{...offerExtras,items:readyItems},
        total:needsPriceSnapshot?snapshot.gross_cents/100:total,
        ride24_fee:fee,loyalty_discount_percent:discount,exchange_rate:rate,
        online_pln:needsPriceSnapshot?snapshot.online_pln_cents/100:apiOnlinePaymentPln(fee,rate,discount),
        pay_on_pickup:needsPriceSnapshot?snapshot.partner_cents/100:rental,
        expires_at:q.expires_at,
      }});
    }
    if(partner.provider_type==='api') {
      if(partner.api_provider==='kayfleet' && body.api_quote_id) {
        await assertApiPricingCompatible(admin,car.partner_id,partner.api_provider);
        return jsonResponse(req,await makeKayfleetBookingOptions(admin,user,car,body,driverAges));
      }
      if(partner.api_provider==='renteon_aggregator' && body.api_quote_id) {
        await assertApiPricingCompatible(admin,car.partner_id,partner.api_provider);
        return jsonResponse(req,await makeApiBookingOptions(admin,user,car,partner,body,driverAges));
      }
      assertApiRequestedOptions(body);
      await assertApiPricingCompatible(admin, car.partner_id, partner.api_provider);
      return jsonResponse(req,{enabled:false});
    }
    if(!await pricedExtrasEnabled(admin)) return jsonResponse(req,{enabled:false});
    const start=date(body.start_date), end=date(body.end_date);
    const duration=rentalDuration(start,end,time(body.pickup_time),time(body.return_time));
    const days=duration.billedDays;
    if(!meetsMinimumRental(duration, partner.min_rental_days)) {
      throw new BookingOptionsError('MIN_RENTAL_DAYS','Wybierz dłuższy okres wynajmu.','Select a longer rental period.',400);
    }
    if(typeof body.pickup_location!=='string' || typeof body.return_location!=='string' || body.pickup_location.length>250 || body.return_location.length>250) throw new Error('Nieprawidłowa lokalizacja');
    // A scoped local group may be quoted only for the selected partner-owned
    // pickup AND return locations. Older APKs cannot bypass this restriction.
    if (car.allowed_location_ids !== null) {
      const allowed = Array.isArray(car.allowed_location_ids) ? car.allowed_location_ids : [];
      if (!allowed.length) throw new BookingOptionsError('VEHICLE_LOCATION_UNAVAILABLE',
        'Ta grupa pojazdów nie jest dostępna w wybranej lokalizacji.',
        'This vehicle group is not available at the selected location.',409);
      const {data:rows,error:locationError}=await admin.from('partner_locations')
        .select('id,location_name').eq('partner_id',car.partner_id).eq('active',true)
        .in('location_name',[body.pickup_location,body.return_location]);
      if (locationError) throw locationError;
      const valid = name => (rows||[]).some(row => row.location_name===name && allowed.includes(row.id));
      if(!valid(body.pickup_location) || !valid(body.return_location)) {
        throw new BookingOptionsError('VEHICLE_LOCATION_UNAVAILABLE',
          'Ta grupa pojazdów nie jest dostępna w wybranej lokalizacji.',
          'This vehicle group is not available at the selected location.',409);
      }
    }
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
