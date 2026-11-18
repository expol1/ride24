/**
 * Isolated Caravel quote issuance / Ride24 api_quotes writer. NOT DEPLOYED.
 *
 * Quotes are obtained from the real supplier API from an authenticated,
 * server-owned selection and stored in Ride24's existing
 * api_quotes.raw_response.provider_quote_data format.
 *
 * This is NOT a public endpoint. The missing caller must authenticate the
 * user, derive the selection from trusted locations/classes/pricing, verify
 * the approved Caravel clauses/v1 canonical SHA-256 per contract section 3.9,
 * and have the current reviewed Premium exclusions on file.
 *
 * This bridge deliberately DOES NOT create bookings, start Stripe, set
 * certificationPassed, enable a provider, or modify other partners.
 */
import type {CaravelClient,CaravelQuoteRequest}
  from "./caravel-sandbox-adapter.ts";
import {caravelQuoteFromApi} from "./caravel-normalize.ts";
import {verifyCaravelRide24PaymentContract}
  from "./caravel-payment-contract.ts";
import {evaluateCaravelPremiumForRide24,
  type CaravelApprovedExclusionReview}
  from "./caravel-exclusion-policy.ts";
import {compareCaravelTermsVersion,bindReviewedCaravelTermsToQuote,
  type CaravelTermsSnapshot}
  from "./caravel-terms-version.ts";
import {apiQuoteContext} from "./api-quote-contract.mjs";
type Rec=Record<string,unknown>;
type DbResult={data:Rec|null;error:{message?:string}|null};
type Query={eq:(k:string,v:unknown)=>Query;maybeSingle:()=>Promise<DbResult>};
type Insert={
 insert:(row:Rec)=>{select:(cols:string)=>{single:()=>Promise<DbResult>}};
};
export type CaravelQuoteAdmin={
 from:(name:"partners"|"car_classes"|"partner_locations"|"api_quotes")=>{select:(cols:string)=>Query}&Insert;
};
type Client=Pick<CaravelClient,"quote"|"suppliers"|"referenceTerms"|"environment">;
export type CaravelQuoteIssueResult=
 |{ok:true;apiQuoteId:string;providerQuoteId:string;
   supplierId:string;partnerPayableMinor:number;expiresAt:string}
 |{ok:false;reason:string};
const PARTNER_ID="78721481-7619-44df-a9b7-5faa344b69bb";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUPPLIER=/^[A-Za-z0-9_-]{1,128}$/;
const DAY=/^\d{4}-\d{2}-\d{2}$/;
const rec=(x:unknown):Rec|null=>
 x!==null&&typeof x==="object"&&!Array.isArray(x)?x as Rec:null;
const reject=(reason:string):CaravelQuoteIssueResult=>({ok:false,reason});
const uuid=(x:unknown):x is string=>typeof x==="string"&&UUID.test(x);
const amt=(x:number)=>x/100;

export async function issueVerifiedCaravelQuote(args:{
 admin:CaravelQuoteAdmin;
 client:Client;
 /** Trusted, server-generated Idempotency-Key for exactly this selection. */
 idempotencyKey:string;
 supplierId:string;
 carClassId:string;
 /** Trusted Ride24 location primary keys, never provider-side IDs from browser. */
 pickupLocationId:string;dropoffLocationId:string;
 quoteRequest:CaravelQuoteRequest;
 /** Trusted Ride24 location/date mapping for the same request. */
 startDate:string;endDate:string;
 /** Server checked local times; canonical names are reloaded from DB. */
 pickupLocalTime:string;dropoffLocalTime:string;
 rentalDays:number;
 nowEpochMs:number;
 reviewedTerms:CaravelTermsSnapshot;
 canonicalHashIndependentlyVerified:boolean;
 /** Verified protection catalogue item used in the quote request. */
 protection:unknown;
 approvedExclusions?:CaravelApprovedExclusionReview;
 /** Production supplier quote traffic requires explicit enablement. */
 allowProductionQuoteIssuance:boolean;
}):Promise<CaravelQuoteIssueResult>{
 if(!args||!args.admin||!args.client||
    !uuid(args.idempotencyKey)||!uuid(args.carClassId)||
    !uuid(args.pickupLocationId)||!uuid(args.dropoffLocationId)||
    typeof args.supplierId!=="string"||!SUPPLIER.test(args.supplierId)||
    !DAY.test(args.startDate)||!DAY.test(args.endDate)||
    !/^\d\d:\d\d$/.test(args.pickupLocalTime)||
    !/^\d\d:\d\d$/.test(args.dropoffLocalTime)||
    !Number.isSafeInteger(args.rentalDays)||args.rentalDays<1||
    args.rentalDays>366||!Number.isSafeInteger(args.nowEpochMs))
   return reject("CARAVEL_QUOTE_INPUT_INVALID");
 if(args.canonicalHashIndependentlyVerified!==true)
   return reject("CARAVEL_QUOTE_CANONICAL_TERMS_NOT_VERIFIED");
 if(args.client.environment!=="sandbox"&&args.client.environment!=="production")
   return reject("CARAVEL_QUOTE_ENVIRONMENT_INVALID");
 if(args.client.environment==="production"&&
    args.allowProductionQuoteIssuance!==true)
   return reject("CARAVEL_QUOTE_PRODUCTION_NOT_AUTHORIZED");
 const requested=args.quoteRequest;
 const protection=rec(args.protection);
 if(!requested||requested.plan!=="premium"||
    requested.currency!=="EUR"&&requested.currency!=="GBP"||
    !requested.pickup?.location_id||!requested.dropoff?.location_id||
    typeof requested.vehicle_id!=="string"||!requested.vehicle_id||
    typeof requested.protection_id!=="string"||!requested.protection_id||
    protection?.protection_id!==requested.protection_id||
    (requested.extras?.length??0)!==0||
    !Array.isArray(requested.drivers)||requested.drivers.length!==1||
    requested.drivers[0]?.role!=="main"||
    !Number.isSafeInteger(requested.drivers[0]?.age)||
    requested.drivers[0].age<18||requested.drivers[0].age>90||
    !requested.pickup.at.startsWith(args.startDate+"T"+args.pickupLocalTime)||
    !requested.dropoff.at.startsWith(args.endDate+"T"+args.dropoffLocalTime)||
    Date.parse(requested.pickup.at)>=Date.parse(requested.dropoff.at)||
    !Number.isFinite(Date.parse(requested.pickup.at))||
    !Number.isFinite(Date.parse(requested.dropoff.at))||
    args.startDate>=args.endDate)
   return reject("CARAVEL_QUOTE_SELECTION_UNVERIFIED");
 let p:DbResult,c:DbResult,pickup:DbResult,dropoff:DbResult;
 try{
  p=await args.admin.from("partners").select(
    "id,api_provider,api_enabled,api_status,provider_type,active,account_status,currency,discount_percent"
  ).eq("id",PARTNER_ID).maybeSingle();
  c=await args.admin.from("car_classes").select(
    "id,partner_id,external_id,active"
  ).eq("id",args.carClassId).eq("partner_id",PARTNER_ID).maybeSingle();
  pickup=await args.admin.from("partner_locations").select(
    "id,partner_id,external_id,location_name,active,is_api_managed,return_only"
  ).eq("id",args.pickupLocationId).eq("partner_id",PARTNER_ID).maybeSingle();
  dropoff=args.pickupLocationId===args.dropoffLocationId?pickup:
   await args.admin.from("partner_locations").select(
    "id,partner_id,external_id,location_name,active,is_api_managed,return_only"
   ).eq("id",args.dropoffLocationId).eq("partner_id",PARTNER_ID).maybeSingle();
 }catch{return reject("CARAVEL_QUOTE_DB_CONTEXT_FAILED");}
 const partner=p.data,klass=c.data;
 const pickupRow=pickup.data,dropoffRow=dropoff.data;
 if(p.error||c.error||pickup.error||dropoff.error||
    !partner||!klass||!pickupRow||!dropoffRow||
    partner.api_provider!=="caravel"||partner.api_enabled!==true||
    partner.api_status!=="synced"||partner.provider_type!=="api"||
    partner.active!==true||partner.account_status!=="active"||
    Number(partner.discount_percent)!==0||
    partner.currency!==requested.currency||
    klass.active!==true||klass.external_id!==requested.vehicle_id)
   return reject("CARAVEL_QUOTE_PARTNER_CLASS_NOT_ACTIVE");
 if(pickupRow.id!==args.pickupLocationId||
    dropoffRow.id!==args.dropoffLocationId||
    pickupRow.partner_id!==PARTNER_ID||
    dropoffRow.partner_id!==PARTNER_ID||
    pickupRow.active!==true||dropoffRow.active!==true||
    pickupRow.is_api_managed!==true||dropoffRow.is_api_managed!==true||
    pickupRow.return_only===true||
    pickupRow.external_id!==requested.pickup.location_id||
    dropoffRow.external_id!==requested.dropoff.location_id||
    typeof pickupRow.location_name!=="string"||
    !pickupRow.location_name.trim()||
    typeof dropoffRow.location_name!=="string"||
    !dropoffRow.location_name.trim())
   return reject("CARAVEL_QUOTE_LOCATION_SCOPE_INVALID");
 let supplier:Rec|undefined;
 let terms:unknown;
 try{
  const suppliers=await args.client.suppliers();
  if(!Array.isArray(suppliers.data))
    return reject("CARAVEL_QUOTE_SUPPLIER_LIST_INVALID");
  supplier=suppliers.data.find(x=>x.supplier_id===args.supplierId) as Rec|undefined;
  if(!supplier||supplier.status!=="active"||
     supplier.tax_inclusive!==true||
     supplier.currency!==partner.currency||
     !Array.isArray(supplier.payment_models)||
     !supplier.payment_models.includes("pay_on_arrival"))
   return reject("CARAVEL_QUOTE_SUPPLIER_TERMS_NOT_APPROVED");
  terms=(await args.client.referenceTerms(args.supplierId)).data;
 }catch{return reject("CARAVEL_QUOTE_REFERENCE_API_FAILED");}
 let comparison;
 try{
  comparison=compareCaravelTermsVersion({
   supplierId:args.supplierId,
   language:args.reviewedTerms.language,
   currentMetadataList:terms,
   previousReviewed:args.reviewedTerms,
  });
 }catch{return reject("CARAVEL_QUOTE_TERMS_VERIFICATION_FAILED");}
 if(comparison.action!=="unchanged")
   return reject("CARAVEL_QUOTE_TERMS_REVIEW_REQUIRED");
 let response;
 try{
  response=(await args.client.quote(
    requested,args.idempotencyKey,args.supplierId)).data;
 }catch{return reject("CARAVEL_QUOTE_SUPPLIER_REQUEST_FAILED");}
 const api=rec(response);
 if(!api||api.supplier_id!==undefined&&api.supplier_id!==args.supplierId||
    api.vehicle_id!==undefined&&api.vehicle_id!==requested.vehicle_id||
    api.protection_id!==undefined&&api.protection_id!==requested.protection_id||
    api.payment_model!==undefined&&api.payment_model!=="pay_on_arrival")
   return reject("CARAVEL_QUOTE_SUPPLIER_RESPONSE_SCOPE_INVALID");
 const decoded=caravelQuoteFromApi(response,protection,supplier);
 if("errors" in decoded)
   return reject("CARAVEL_QUOTE_COMPONENTS_UNVERIFIED");
 const parsed=decoded.value;
 if(parsed.quote.plan!=="premium"||
    parsed.quote.currency!==requested.currency||
    parsed.rentalDays!==args.rentalDays||
    parsed.quote.depositAmountMinor!==0||
    parsed.quote.excessAmountMinor!==0||
    parsed.payNowMinor!==0||
    parsed.payAtPickupMinor!==parsed.quote.totalAmountMinor||
    parsed.extraLines.length!==0||
    parsed.quote.expiresAtEpochMs<args.nowEpochMs+10*60*1000)
   return reject("CARAVEL_QUOTE_PAYMENT_OR_VALIDITY_UNSAFE");
 const deposit=rec(api.deposit);
 const cover=evaluateCaravelPremiumForRide24(
   parsed.quote.plan,protection,deposit,args.approvedExclusions);
 if("errors" in cover||cover.noCardHold!==true)
   return reject("CARAVEL_QUOTE_PREMIUM_NOT_VERIFIED");
 let enriched:Rec;
 try{
  enriched=bindReviewedCaravelTermsToQuote({
    quoteData:{
      provider:"caravel",quote_id:parsed.quote.quoteId,
      supplier_id:args.supplierId,vehicle_id:requested.vehicle_id,
      plan:"premium",currency:parsed.quote.currency,
      payment_model:"pay_on_arrival",
      protection_id:requested.protection_id,
      protection,
      deposit,
      expires_at:new Date(parsed.quote.expiresAtEpochMs).toISOString(),
      amounts:{total:amt(parsed.quote.totalAmountMinor)},
      amounts_minor:{
        total:parsed.quote.totalAmountMinor,
        pay_now:parsed.payNowMinor,pay_at_pickup:parsed.payAtPickupMinor,
      },
      drivers:requested.drivers,
      ...(args.approvedExclusions?{
        coverage_review_terms_document_id:args.approvedExclusions.termsDocumentId,
        coverage_exclusions:args.approvedExclusions.documentedExcludedCodes,
        damage_administration_fee_minor:
          args.approvedExclusions.damageAdministrationFeeMinor,
      }:{}),
    },
    comparison,canonicalHashVerified:args.canonicalHashIndependentlyVerified,
  });
 }catch{return reject("CARAVEL_QUOTE_TERMS_BIND_FAILED");}
 const contract=verifyCaravelRide24PaymentContract(enriched);
 if("errors" in contract)
   return reject("CARAVEL_QUOTE_RIDE24_PAYMENT_CONTRACT_FAILED");
 // Ride24's fee is separate. Do not invent a partner discount or another
 // rental surcharge until the audited commercial model approves one.
 // Explicit allow-list: no supplier/customer credentials or untrusted
 // response fields are copied into the public API quote row.
 const covers=protection?.covers,excludes=protection?.excludes;
 if(!Array.isArray(covers)||!Array.isArray(excludes)||
    covers.length>30||excludes.length>30||
    ![...covers,...excludes].every(x=>
      typeof x==="string"&&/^[a-z0-9_]{1,80}$/.test(x)))
   return reject("CARAVEL_QUOTE_PROTECTION_STORAGE_INVALID");
 const money=(value:unknown):{amount:number;currency:string}|null=>{
   const r=rec(value);
   return r&&typeof r.amount==="number"&&Number.isSafeInteger(r.amount)&&
     r.amount>=0&&r.currency===contract.currency?
     {amount:r.amount as number,currency:contract.currency}:null;
 };
 const safeProtection={
   protection_id:requested.protection_id,
   tier:"premium",product_type:"waiver",
   deposit:money(protection?.deposit),
   excess:money(protection?.excess),
   theft_excess:money(protection?.theft_excess),
   covers:[...covers],excludes:[...excludes],
 };
 if(!safeProtection.deposit||!safeProtection.excess||
    !safeProtection.theft_excess)
   return reject("CARAVEL_QUOTE_PROTECTION_STORAGE_INVALID");
 enriched.protection=safeProtection;
 enriched.deposit={amount:{amount:0,currency:contract.currency}};
 const payload= {
   group_external_id:requested.vehicle_id,
   quote_reference:parsed.quote.quoteId,
   provider_quote_data:enriched,
   ride24_context:apiQuoteContext({
     pickupTime:args.pickupLocalTime,returnTime:args.dropoffLocalTime,
     pickupName:pickupRow.location_name as string,
     returnName:dropoffRow.location_name as string,
   }),
 };
 let safeLength:number;
 try{safeLength=JSON.stringify(payload).length;}
 catch{return reject("CARAVEL_QUOTE_STORAGE_SIZE_UNSAFE");}
 if(safeLength>55000)
   return reject("CARAVEL_QUOTE_STORAGE_SIZE_UNSAFE");
 let written:DbResult;
 try{
  written=await args.admin.from("api_quotes").insert({
    partner_id:PARTNER_ID,
    car_class_id:args.carClassId,
    external_group_id:requested.vehicle_id,
    pickup_location_external_id:requested.pickup.location_id,
    dropoff_location_external_id:requested.dropoff.location_id,
    start_date:args.startDate,end_date:args.endDate,
    public_price_per_day:Number(
      (contract.totalMinor/100/args.rentalDays).toFixed(6)),
    partner_discount_percent:0,
    platform_margin_percent:0,
    partner_net_total:amt(contract.totalMinor),
    commission_total:0,final_total:amt(contract.totalMinor),
    currency:contract.currency,
    external_quote_reference:parsed.quote.quoteId,
    raw_response:payload,
    expires_at:new Date(parsed.quote.expiresAtEpochMs).toISOString(),
  }).select("id").single();
 }catch{return reject("CARAVEL_QUOTE_DB_WRITE_FAILED");}
 if(written.error||!uuid(written.data?.id))
   return reject("CARAVEL_QUOTE_DB_WRITE_FAILED");
 return {ok:true,apiQuoteId:written.data.id as string,
   providerQuoteId:parsed.quote.quoteId,supplierId:args.supplierId,
   partnerPayableMinor:contract.totalMinor,
   expiresAt:new Date(parsed.quote.expiresAtEpochMs).toISOString()};
}
