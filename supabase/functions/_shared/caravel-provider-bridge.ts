/**
 * Caravel -> Ride24 reservation result bridge. ISOLATED / NOT DEPLOYED.
 *
 * The shared Ride24 provider-adapters.ts does not yet route Caravel here.
 * This module must be called only AFTER Stripe payment is confirmed AND
 * immutable Caravel terms/quote, driver, supplier, insurance and
 * certification evidence were verified server-side.
 *
 * No secret values, automatic refunds, or background retries are handled.
 * A supplier write may have succeeded despite a network error: report
 * an ambiguous result for manual reconciliation rather than issuing a
 * fresh booking with a new idempotency key.
 */
import {prepareVerifiedCaravelDispatch} from "./caravel-dispatch-gate.ts";
import {verifyCaravelClaimedPaidBooking} from "./caravel-dispatch-proof.ts";
import {verifyCaravelBookingAgainstQuote} from "./caravel-booking.ts";
import {isUuid, type CaravelClient} from "./caravel-sandbox-adapter.ts";
import type {Ride24BookingInput,CaravelDraftOptions} from "./caravel-booking.ts";
import type {CaravelBookingTermsSnapshot} from "./caravel-terms-lifecycle.ts";
import type {CaravelTermsSnapshot} from "./caravel-terms-version.ts";

type ProductionGate=NonNullable<CaravelDraftOptions["production"]>;
type Result =
  |{ok:true;result:{
    booking_reference:string;reference:string;id:string;
    status:"confirmed";provider_payload:{
      booking_id:string;quote_id:string;revision:number;
      payment_model:"pay_on_arrival";
    };
  }}
  |{ok:false;action:"hold_for_manual_review";phase:
    "preflight"|"supplier_response"|"supplier_outcome_uncertain";
    reasons:string[];externalReference:string|null};

const obj=(v:unknown):v is Record<string,unknown> =>
  !!v && typeof v==="object" && !Array.isArray(v);
function centsExactly(amount:unknown):number|null {
  if(typeof amount!=="number" || !Number.isFinite(amount) || amount<=0)
    return null;
  const cents=Math.round(amount*100);
  return Number.isSafeInteger(cents) && Math.abs(cents/100-amount)<1e-7
    ? cents : null;
}

/**
 * Explicit final permission comes from trusted server-only configuration.
 * enableSupplierWrite=false is the safe default even with a fake/real client.
 * In addition to this gate the CaravelClient must separately be constructed
 * with allowProductionBookingWrites=true or it refuses the remote write.
 */
export async function submitVerifiedCaravelBooking(args:{
  client:Pick<CaravelClient,"environment"|"book">;
  enableSupplierWrite?:boolean;
  /** Fresh service-role row returned by the atomic post-Stripe dispatch claim. */
  persistedPaidBooking:unknown;
  partnerApiEnabled:boolean;
  currentExternalReference:string|null;
  bookingInput:Ride24BookingInput;
  nowEpochMs:number;
  productionGate:ProductionGate;
  reviewedTerms:CaravelTermsSnapshot;
  currentTermsMetadataList:unknown;
  persistedBookingTerms:CaravelBookingTermsSnapshot|null;
  persistedCoverageConsent?:unknown;
}):Promise<Result> {
  if(!args || args.enableSupplierWrite!==true ||
     args.client?.environment!=="production" ||
     args.partnerApiEnabled!==true ||
     args.currentExternalReference!==null)
    return {ok:false,action:"hold_for_manual_review",phase:"preflight",
      reasons:["CARAVEL_LIVE_DISPATCH_NOT_AUTHORIZED"],externalReference:null};

  // The booking must have been paid via a Stripe-validated webhook and
  // atomically claimed by THIS dispatcher in the database. A caller-provided
  // paymentConfirmed=true can never authorize an external supplier write.
  const claim=verifyCaravelClaimedPaidBooking({
    persistedBooking:args.persistedPaidBooking,
    ride24BookingId:args.bookingInput?.ride24_booking_id,
    providerQuote:args.bookingInput?.provider_quote_data,
    nowEpochMs:args.nowEpochMs,
  });
  if("reason" in claim)return {
    ok:false,action:"hold_for_manual_review",phase:"preflight",
    reasons:[claim.reason],externalReference:null,
  };
  const prepared=prepareVerifiedCaravelDispatch({
    bookingInput:args.bookingInput,
    nowEpochMs:args.nowEpochMs,
    productionGate:args.productionGate,
    reviewedTerms:args.reviewedTerms,
    currentTermsMetadataList:args.currentTermsMetadataList,
    persistedBookingTerms:args.persistedBookingTerms,
    persistedCoverageConsent:args.persistedCoverageConsent,
  });
  if("reasons" in prepared) return {
    ok:false,action:"hold_for_manual_review",phase:"preflight",
    reasons:prepared.reasons,externalReference:null,
  };
  const plan=prepared.plan;
  if(plan.idempotencyKey!==claim.idempotencyKey||
     plan.supplierId!==claim.supplierId||
     plan.request.quote_id!==claim.quoteId)
    return {ok:false,action:"hold_for_manual_review",phase:"preflight",
      reasons:["CARAVEL_DISPATCH_CLAIM_PLAN_MISMATCH"],externalReference:null};
  const expectedCents=centsExactly(args.bookingInput.partner_amount);
  const currency=args.bookingInput.currency;
  if(expectedCents===null || (currency!=="EUR"&&currency!=="GBP"))
    return {ok:false,action:"hold_for_manual_review",phase:"preflight",
      reasons:["CARAVEL_EXPECTED_PRICE_OR_CURRENCY_INVALID"],externalReference:null};

  let response:unknown;
  try {
    response=(await args.client.book(plan.request,plan.idempotencyKey,plan.supplierId)).data;
  }catch {
    // MAY HAVE BEEN CREATED REMOTELY: do not retry under a new key here.
    return {ok:false,action:"hold_for_manual_review",
      phase:"supplier_outcome_uncertain",
      reasons:["CARAVEL_CREATE_RESULT_UNKNOWN_RECONCILE_BEFORE_RETRY"],
      externalReference:null};
  }
  const record=obj(response)?response:{};
  const remoteId=typeof record.booking_id==="string" && isUuid(record.booking_id)
    ? record.booking_id:null;
  const check=verifyCaravelBookingAgainstQuote(record,{
    quoteId:plan.request.quote_id,
    totalAmountMinor:expectedCents,
    currency,
  }, {strictProductionPayment:true});
  // Require explicit collection on arrival even if other reference checks pass.
  const payment=obj(record.payment)?record.payment:null;
  const missingPayment=payment?.model!=="pay_on_arrival";
  if("errors" in check || missingPayment)
    return {ok:false,action:"hold_for_manual_review",phase:"supplier_response",
      reasons:[
        ...("errors" in check?check.errors:[]),
        ...(missingPayment?["PAYMENT_MODEL_NOT_PAY_ON_ARRIVAL"]:[]),
      ],externalReference:remoteId};
  return {ok:true,result:{
    booking_reference:check.bookingId,
    reference:check.bookingId,
    id:check.bookingId,
    status:"confirmed",
    // Minimal technical metadata: no personal data / raw API response.
    provider_payload:{
      booking_id:check.bookingId,
      quote_id:plan.request.quote_id,
      revision:check.revision,
      payment_model:"pay_on_arrival",
    },
  }};
}
