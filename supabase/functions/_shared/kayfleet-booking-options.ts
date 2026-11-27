// KayFleet uses the exact same Ride24 booking-options v2 UX, quote binding,
// loyalty/NBP conversion and Stripe-only booking fee as existing API partners.
import { BookingOptionsError, priceFingerprint, quoteChanged } from "./booking-options.mjs";
import { assertApiQuoteContext } from "./api-quote-contract.mjs";
import { customerPricing } from "./booking-items.mjs";
import { exchangeRate } from "./booking-exchange-rate.ts";
import { loadPartnerCredentials } from "./partner-api.ts";
import { kayfleetQuoteWithExtras } from "./kayfleet-adapter.ts";
import { KAYFLEET_EXTRA_CATALOG, kayfleetCounts, kayfleetCatalog, kayfleetSnapshot, kayfleetAssertQuote } from "./kayfleet-pricing.mjs";

const code = (error: unknown): string => error instanceof Error ? error.message : "";
const priceError = (): never => {
  throw new BookingOptionsError("KAYFLEET_QUOTE_CHANGED",
    "Wycena lub dodatki zmieniły się. Wyszukaj samochód ponownie.",
    "The quote or extras changed. Search for a car again.", 409);
};
export async function makeKayfleetBookingOptions(
  admin: any, user: any, car: any, body: any, ages: number[],
): Promise<Record<string, unknown>> {
  if (typeof body.api_quote_id!=="string" || !body.api_quote_id) throw quoteChanged();
  const {data:quote,error}=await admin.from("api_quotes").select("*")
    .eq("id",body.api_quote_id).eq("partner_id",car.partner_id)
    .eq("car_class_id",car.id).eq("start_date",body.start_date).eq("end_date",body.end_date)
    .gt("expires_at",new Date().toISOString()).is("used_at",null).is("booking_id",null).maybeSingle();
  if(error||!quote||quote.currency!=="EUR"||Number(quote.partner_discount_percent)!==0)
    throw quoteChanged();
  assertApiQuoteContext(quote.raw_response,body);
  const old=quote.raw_response?.provider_quote_data;
  if(old?.kayfleet!==true || !old.quote || old.quote.group_id!==quote.external_group_id
    ||old.pickup_location!==quote.pickup_location_external_id
    ||old.dropoff_location!==quote.dropoff_location_external_id)
    throw quoteChanged();

  let selected;
  try { selected=kayfleetCounts(body.extras??[],body.additional_driver_id||null); }
  catch {throw new BookingOptionsError("KAYFLEET_INVALID_EXTRAS",
    "Nieprawidłowy wybór dodatków lub dodatkowego kierowcy.",
    "Invalid extras or additional driver selection.",400);}

  const context={
    pickup_location_id:quote.pickup_location_external_id,
    dropoff_location_id:quote.dropoff_location_external_id,
    pickup_date:quote.start_date,return_date:quote.end_date,
    pickup_time:body.pickup_time,return_time:body.return_time,currency:"EUR",
  };
  const credentials=await loadPartnerCredentials(admin,car.partner_id);
  let fresh;
  try {fresh=await kayfleetQuoteWithExtras(credentials,context,quote.external_group_id,selected);}
  catch (e) {if(code(e).startsWith("PARTNER_API_ERROR:KAYFLEET_"))priceError();throw e;}
  const previous={...old.quote,requested_full_insurance:true};
  // Do not reprice the underlying rental after the customer opened the modal.
  // Changing only supplier-priced extras is permitted; rental and insurance remain fixed.
  try {
    kayfleetAssertQuote(previous,{group_id:quote.external_group_id,
      pickup_location:context.pickup_location_id,dropoff_location:context.dropoff_location_id});
    kayfleetAssertQuote(fresh,{group_id:quote.external_group_id,
      pickup_location:context.pickup_location_id,dropoff_location:context.dropoff_location_id,extras:selected});
    for (const key of ["rental_total","insurance_fee","delivery_fee"])
      if(Math.round(previous[key]*100)!==Math.round(fresh[key]*100))priceError();
  } catch {priceError();}

  let catalog=quote.raw_response?.kayfleet_catalog;
  if(!Array.isArray(catalog)||catalog.length!==3
    ||KAYFLEET_EXTRA_CATALOG.some(x=>!catalog.some((c:any)=>c.id===x.id && Number.isSafeInteger(c.unit_customer_cents))))
    catalog=null;
  if(!catalog) {
    try {
      const base=Object.values(selected).every(x=>x===0)
        ? fresh
        : await kayfleetQuoteWithExtras(credentials,context,quote.external_group_id,
            {car_seat_qty:0,booster_seat_qty:0,additional_drivers:0});
      const unitQuotes:any={};
      // Only three catalogue reads per newly opened quote; subsequent selections
      // reuse the server-persisted catalogue and re-quote ONLY selected quantities.
      for (const item of KAYFLEET_EXTRA_CATALOG) {
        unitQuotes[item.field]=await kayfleetQuoteWithExtras(credentials,context,quote.external_group_id,{
          car_seat_qty:item.field==="car_seat_qty"?1:0,
          booster_seat_qty:item.field==="booster_seat_qty"?1:0,
          additional_drivers:item.field==="additional_drivers"?1:0,
        });
      }
      catalog=kayfleetCatalog(base,unitQuotes,Number(quote.platform_margin_percent));
    } catch(e) {if(code(e).startsWith("PARTNER_API_ERROR:KAYFLEET_"))priceError();throw e;}
  }

  const {data:loyalty,error:le}=await admin.rpc("calculate_loyalty_discount",{p_user_id:user.id});
  if(le)throw new Error("PRICING_UNAVAILABLE");
  const lv=Number(Array.isArray(loyalty)?loyalty[0]:loyalty);
  const discount=Math.max(0,Math.min(20,Number.isFinite(lv)?lv:0));
  const rate=await exchangeRate("EUR");
  let snapshot;
  try {snapshot=kayfleetSnapshot(fresh,{marginPercent:Number(quote.platform_margin_percent),
    loyaltyPercent:discount,exchangeRate:rate});}
  catch {priceError();}
  const binding={user_id:user.id,driver_id:body.driver_id||null,
    additional_driver_id:body.additional_driver_id||null,ages,selections:body.extras??[]};
  const fingerprint=await priceFingerprint(snapshot,binding);
  const {id,created_at,used_at,booking_id,...baseQuote}=quote;
  const {data:saved,error:saveError}=await admin.from("api_quotes").insert({
    ...baseQuote,
    external_quote_reference:fresh.quote_reference,
    expires_at:fresh.quote_expires_at,
    public_price_per_day:snapshot.partner_cents/100/Number(fresh.days),
    partner_net_total:snapshot.partner_cents/100,
    commission_total:snapshot.commission_cents/100,
    final_total:snapshot.gross_cents/100,
    raw_response:{
      ...quote.raw_response,kayfleet_catalog:catalog,
      provider_quote_data:{...old,quote:fresh},
      ride24_options:{binding,fingerprint,snapshot},
    },
  }).select("id").single();
  if(saveError||!saved?.id)throw new Error("PRICING_UNAVAILABLE");
  return {enabled:true,api_quote_id:saved.id,
    pricing:customerPricing(snapshot),catalog,fingerprint};
}
