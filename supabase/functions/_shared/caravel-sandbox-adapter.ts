/**
 * Caravel Channel API v1.67.0 — isolated sandbox adapter.
 * NOT wired into Ride24 production dispatch.
 * Credentials must come from Supabase Edge Function secrets, never browser or database.
 * Sandbox bookings use invented customer data only.
 */
const SANDBOX = "https://sandbox-api.caravelway.com";
const PRODUCTION = "https://api.caravelway.com";
/** The two documented hosts (OpenAPI v1.67.0 `servers`). The base URL is configuration, never free text. */
export const CARAVEL_BASE_URLS = Object.freeze({sandbox: SANDBOX, production: PRODUCTION});
export type CaravelEnvironment = keyof typeof CARAVEL_BASE_URLS;
export type CaravelClientOptions = {
  apiKey: string;
  environment: CaravelEnvironment;
  /** Required to talk to production at all. */
  allowProduction?: boolean;
  /** Required for booking create/cancel against production. Never set by tests or sandbox runs. */
  allowProductionBookingWrites?: boolean;
  timeoutMs?: number;
  /** Maximum attempts for 429/503 and transient network failures (1–3). */
  retryMaxAttempts?: number;
  /** Maximum acceptable server Retry-After in ms; longer waits are delegated to a later job. */
  retryMaxWaitMs?: number;
};
type Json = Record<string, unknown>;
export type Money = {amount: number; currency: string};
/** OpenAPI v1.67.0 Supplier. payment_models absent = "not stated", never "nothing permitted". */
export type Supplier = {supplier_id:string; name:string; status:string; currency:string; tax_inclusive:boolean; payment_models?:Array<"pay_on_arrival"|"partial"|"prepaid">};
export type CaravelEnvelope<T> = {data:T; meta?:Json; request_id?:string};
/** OpenAPI v1.67.0 StopInput, preferred instant form. */
export type CaravelStopInput = {location_id:string; at:string};
export type CaravelQuoteRequest = {
  pickup:CaravelStopInput; dropoff:CaravelStopInput;
  vehicle_id:string; protection_id:string;
  plan?:"basic"|"medium"|"premium"|"no_deposit_with_excess";
  currency?:string;
  extras?:Array<{extra_id:string; quantity:number}>;
  drivers:Array<{age:number; role:"main"|"additional"; country?:string}>;
};
export type CaravelQuotedBookingRequest = {
  quote_id:string; external_ref:string;
  drivers:Array<{first_name?:string; last_name?:string; age:number; role:"main"|"additional"; country?:string}>;
  customer:{first_name:string; last_name:string; email:string; phone?:string; country?:string; locale?:string};
  flight_number?:string|null; notes?:string|null; meta?:Json;
  payment_model?:"pay_on_arrival"|"prepaid"|"partial";
};
/** OpenAPI v1.67.0: Idempotency-Key is a client-generated UUID (quote, booking create, cancel). */
export function isUuid(value:unknown):value is string {
  return typeof value==="string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
/** Retry-After may be seconds or an HTTP-date. Invalid/negative values do not override backoff. */
export function parseCaravelRetryAfter(value: string | null | undefined, nowMs = Date.now()): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const v = value.trim();
  if (/^\d{1,6}$/.test(v)) return Number(v) * 1000;
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat), /.test(v)) return null;
  const epoch = Date.parse(v);
  if (!Number.isFinite(epoch)) return null;
  return Math.max(0, epoch - nowMs);
}
const waitCaravel = (milliseconds:number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
export class CaravelError extends Error {
  public status:number; public code:string; public requestId:string|null;
  /** Error.details[] {field, issue} — branch on issue, never on message. */
  public details:Array<{field?:string; issue?:string}>;
  constructor(status:number, code:string, requestId:string|null, details:Array<{field?:string; issue?:string}>=[]) {
    super(`Caravel API: ${code} (HTTP ${status})`);
    this.status=status; this.code=code; this.requestId=requestId; this.details=details;
  }
}
/**
 * Caravel Channel API v1.67.0 client. The environment picks one of the two
 * documented hosts; production needs `allowProduction`, and booking writes on
 * production additionally need `allowProductionBookingWrites`, so a sandbox
 * test or a misconfigured run can never create a live booking.
 */
export class CaravelClient {
  protected readonly apiKey:string; protected readonly baseUrl:string;
  readonly environment:CaravelEnvironment;
  private readonly productionBookingWrites:boolean;
  private readonly timeoutMs:number;
  private readonly retryMaxAttempts:number;
  private readonly retryMaxWaitMs:number;
  constructor(options:CaravelClientOptions) {
    const env=options?.environment;
    if(!options?.apiKey || (env!=="sandbox" && env!=="production")) throw new Error("INVALID_CARAVEL_CONFIG");
    if(env==="production" && options.allowProduction!==true) throw new Error("PRODUCTION_NOT_ALLOWED");
    this.apiKey=options.apiKey; this.environment=env; this.baseUrl=CARAVEL_BASE_URLS[env];
    this.productionBookingWrites=env==="production" && options.allowProductionBookingWrites===true;
    this.timeoutMs=Number.isSafeInteger(options.timeoutMs) && (options.timeoutMs as number)>0 ? options.timeoutMs as number : 12000;
    this.retryMaxAttempts=Number.isSafeInteger(options.retryMaxAttempts) && (options.retryMaxAttempts as number)>=1 &&
      (options.retryMaxAttempts as number)<=3 ? options.retryMaxAttempts as number : 3;
    this.retryMaxWaitMs=Number.isSafeInteger(options.retryMaxWaitMs) && (options.retryMaxWaitMs as number)>=0 &&
      (options.retryMaxWaitMs as number)<=10000 ? options.retryMaxWaitMs as number : 10000;
  }
  /** Booking create/cancel/modify guard. */
  protected assertBookingWrites() {
    if(this.environment==="production" && !this.productionBookingWrites) throw new Error("PRODUCTION_BOOKING_WRITES_DISABLED");
  }
  protected async request<T>(method:"GET"|"POST", path:string, body?:Json, idem?:string, supplierId?:string):Promise<CaravelEnvelope<T>> {
    if (!path.startsWith("/v1/") || path.includes("://")) throw new Error("INVALID_PATH");
    const headers:Record<string,string>={"X-API-Key":this.apiKey,"Accept":"application/json"};
    if(body){headers["Content-Type"]="application/json";}
    if(idem){headers["Idempotency-Key"]=idem;}
    if(supplierId){if(!/^[a-zA-Z0-9_-]{1,128}$/.test(supplierId)) throw new Error("INVALID_SUPPLIER_ID");headers["X-Supplier-Id"]=supplierId;}
    // GET is safe to replay; POST is safe ONLY with the same client UUID idempotency key.
    // Never generate a fresh key in this loop. A retry after a lost POST response
    // must replay the identical body and key, not create a duplicate booking.
    const retrySafe=method==="GET" || (method==="POST" && isUuid(idem));
    const attempts=retrySafe ? this.retryMaxAttempts : 1;
    const payload=body ? JSON.stringify(body) : undefined;
    let response:Response | undefined;
    for(let attempt=1;attempt<=attempts;attempt++){
      try {
        response=await fetch(this.baseUrl+path,{method,headers,body:payload,signal:AbortSignal.timeout(this.timeoutMs)});
      } catch(error) {
        const name=error && typeof error==="object" && "name" in error ? String(error.name) : "";
        if(attempt>=attempts || !["TypeError","AbortError","TimeoutError"].includes(name)) throw error;
        const delayMs=Math.min(this.retryMaxWaitMs,250*2**(attempt-1));
        await waitCaravel(delayMs);
        continue;
      }
      if((response.status===429 || response.status===503) && attempt<attempts){
        const retryAfter=parseCaravelRetryAfter(response.headers.get("Retry-After"));
        const delayMs=retryAfter ?? 250*2**(attempt-1);
        // No uncontrolled sleeping or aggressive retries when the server has
        // requested a longer wait. Let the scheduler retry at a later time.
        if(delayMs<=this.retryMaxWaitMs){
          await waitCaravel(delayMs);
          continue;
        }
      }
      break;
    }
    if(!response) throw new Error("CARAVEL_TRANSIENT_NETWORK_FAILURE");
    const envelope=await response.json().catch(()=>({error:{code:"INVALID_JSON"}})) as CaravelEnvelope<T> & {error?:{code?:string;request_id?:string;details?:unknown}};
    if(!response.ok && !envelope?.error) throw new CaravelError(response.status,"UPSTREAM_HTTP_ERROR",null);
    // OpenAPI v1.67.0 Error: {error:{code,message,request_id,doc_url,details[]}}.
    if(!response.ok) {
      const details=Array.isArray(envelope.error?.details) ? (envelope.error!.details as Json[]).slice(0,20).map(d=>({field:typeof d?.field==="string"?d.field:undefined, issue:typeof d?.issue==="string"?d.issue:undefined})) : [];
      throw new CaravelError(response.status,envelope.error?.code??"UNKNOWN",envelope.error?.request_id??envelope.request_id??null,details);
    }
    if(!envelope || typeof envelope!=="object" || !("data" in envelope)) throw new CaravelError(response.status,"INVALID_RESPONSE_ENVELOPE",null);
    return envelope;
  }
  private capabilitiesCache:{expiresAt:number;value:Promise<CaravelEnvelope<{environment:string;api_version:string;quote_ttl_seconds:number}>>}|null=null;
  /** Environment check (the host must report the configured environment), cached 5 minutes; failures are never cached. The key is sent here too (certification runs attach to it). */
  async capabilities() {
    const now=Date.now();
    if(this.capabilitiesCache && this.capabilitiesCache.expiresAt>now) return this.capabilitiesCache.value;
    const value=(async()=>{
      const result=await this.request<{environment:string;api_version:string;quote_ttl_seconds:number}>("GET","/v1/capabilities");
      if(!result.data || typeof result.data!=="object" || result.data.environment!==this.environment)
        throw new Error(this.environment==="sandbox" ? "SANDBOX_ENVIRONMENT_REQUIRED" : "ENVIRONMENT_MISMATCH");
      return result;
    })();
    this.capabilitiesCache={expiresAt:now+300000,value};
    try { return await value; }
    catch(error) { this.capabilitiesCache=null; throw error; }
  }
  async suppliers() {
    await this.capabilities();
    return this.request<Supplier[]>("GET","/v1/suppliers");
  }
  /** GET /v1/whoami — own account configuration (opt-ins, scopes, webhook state). */
  async whoami() {
    await this.capabilities();
    return this.request<Json>("GET","/v1/whoami");
  }
  /**
   * Read the complete reference catalogue by following the *opaque* meta.next_page
   * token returned by Caravel. Never reuse a token across endpoints or suppliers,
   * never generate or parse it, and refuse cycles/overlong chains.
   */
  private async allReferencePages<T>(path:string,supplierId?:string,limit?:number):Promise<CaravelEnvelope<T[]>> {
    await this.capabilities();
    const base=limit===undefined ? path : `${path}?limit=${Math.max(1,Math.min(200,Math.floor(limit)))}`;
    let nextPage:string|null=null;
    const seen=new Set<string>();
    const rows:T[]=[];
    let pages=0;
    let firstRequestId:string|undefined;
    let lastMeta:Json|undefined;
    while(true){
      if(pages>=30) throw new Error("CARAVEL_PAGINATION_LIMIT");
      const endpoint=nextPage===null ? base : `${base}${base.includes("?") ? "&" : "?"}page_token=${encodeURIComponent(nextPage)}`;
      const page=await this.request<T[]>("GET",endpoint,undefined,undefined,supplierId);
      if(!Array.isArray(page.data)) throw new Error("CARAVEL_PAGINATION_INVALID_ROWS");
      firstRequestId??=page.request_id;
      lastMeta=page.meta;
      rows.push(...page.data);
      if(rows.length>6000) throw new Error("CARAVEL_PAGINATION_TOO_MANY_ROWS");
      pages++;
      const cursor=page.meta?.next_page;
      if(cursor===undefined || cursor===null || cursor==="")
        return {data:rows,meta:{...lastMeta,page_count:pages,next_page:null},request_id:firstRequestId};
      if(typeof cursor!=="string" || cursor.length>2048 || /[\u0000-\u001F\u007F]/.test(cursor) || seen.has(cursor))
        throw new Error("CARAVEL_PAGINATION_BAD_OR_REPEATED_TOKEN");
      seen.add(cursor);
      nextPage=cursor;
    }
  }
  async locations(limit=200,supplierId?:string) {
    return this.allReferencePages<{location_id:string;supplier_id:string;code?:string;name:string;timezone?:string}>("/v1/reference/locations",supplierId,limit);
  }
  async vehicleClasses(limit=200,supplierId?:string) {
    return this.allReferencePages<Json>("/v1/reference/vehicles",supplierId,limit);
  }
  /** GET /v1/reference/{extras|protections|policies|fees} (scope read:reference). */
  async reference(kind:"extras"|"protections"|"policies"|"fees",supplierId?:string) {
    if(!["extras","protections","policies","fees"].includes(kind)) throw new Error("INVALID_REFERENCE");
    return this.allReferencePages<Json>(`/v1/reference/${kind}`,supplierId);
  }
  /** GET /v1/availability. `driver_age` prices age fees into the row (OpenAPI v1.67.0). There is no `plan` query parameter: rows carry `plan`; request params are strict (unknown = 422). */
  async availability(params:{pickup_location_id:string;dropoff_location_id:string;pickup:string;dropoff:string;driver_age?:number;currency?:string},supplierId?:string) {
    const {driver_age,currency,...required}=params;
    if(driver_age!==undefined && (!Number.isSafeInteger(driver_age) || driver_age<16 || driver_age>120)) throw new Error("INVALID_DRIVER_AGE");
    if(currency!==undefined && !/^[A-Z]{3}$/.test(currency)) throw new Error("INVALID_CURRENCY");
    await this.capabilities();
    const qs=new URLSearchParams(required);
    if(driver_age!==undefined) qs.set("driver_age",String(driver_age));
    if(currency) qs.set("currency",currency);
    return this.request<Array<Json>>("GET",`/v1/availability?${qs.toString()}`,undefined,undefined,supplierId);
  }
  /**
   * Fail closed: Ride24 sells only the `premium` plan, and only when the row's
   * protection states zero `excess` and zero `deposit` (OpenAPI v1.67.0
   * AvailabilityItem.plan / protection.excess / protection.deposit). Tier names
   * are nominal per the spec, so the numbers decide, not the word.
   */
  static isPremiumZeroRisk(row:Json):boolean {
    const protection=row.protection;
    if(!protection || typeof protection!=="object") return false;
    const p=protection as Json;
    const plan=String(row.plan??p.tier??"").toLowerCase();
    if(plan!=="premium") return false;
    const excess=p.excess as Json|undefined;
    const deposit=p.deposit as Json|undefined;
    return !!excess && !!deposit && excess.amount===0 && deposit.amount===0 &&
      typeof excess.currency==="string" && /^[A-Z]{3}$/.test(excess.currency) && excess.currency===deposit.currency;
  }
  /** POST /v1/quote (QuoteRequest, OpenAPI v1.67.0). Request schemas are strict: send only documented fields. */
  async quote(input:CaravelQuoteRequest,idempotencyKey:string,supplierId?:string) {
    if(!isUuid(idempotencyKey)) throw new Error("IDEMPOTENCY_REQUIRED");
    const drivers=Array.isArray(input?.drivers)?input.drivers:[];
    if(!input?.pickup?.location_id || !input?.dropoff?.location_id || !input.pickup.at || !input.dropoff.at ||
      !input.vehicle_id || !input.protection_id || drivers.length<1 || drivers.length>9 ||
      drivers.filter(d=>d?.role==="main").length!==1 ||
      drivers.some(d=>!Number.isSafeInteger(d?.age) || !["main","additional"].includes(d?.role) || (d.country!==undefined && !/^[A-Z]{2}$/.test(d.country))) ||
      (input.plan!==undefined && !["basic","medium","premium","no_deposit_with_excess"].includes(input.plan)) ||
      (input.currency!==undefined && !/^[A-Z]{3}$/.test(input.currency)) ||
      (input.extras ?? []).some(e=>!e?.extra_id || !Number.isSafeInteger(e?.quantity) || e.quantity<1 || e.quantity>9))
      throw new Error("INVALID_QUOTE_REQUEST");
    await this.capabilities();
    return this.request<Json>("POST","/v1/quote",input as unknown as Json,idempotencyKey,supplierId);
  }
  /**
   * POST /v1/bookings, quoted shape (CreateQuotedBookingRequest). Ride24 sells
   * only pay_on_arrival: Caravel collects grand_total at the desk.
   * Sandbox: external_ref must start with ride24-sandbox-; production writes need
   * allowProductionBookingWrites and an external_ref starting with ride24-.
   */
  async book(input:CaravelQuotedBookingRequest,idempotencyKey:string,supplierId?:string) {
    this.assertBookingWrites();
    const prefix=this.environment==="sandbox" ? "ride24-sandbox-" : "ride24-";
    if(!isUuid(idempotencyKey) || typeof input?.external_ref!=="string" || !input.external_ref.startsWith(prefix) ||
      (this.environment==="production" && input.external_ref.startsWith("ride24-sandbox-")) ||
      !/^[A-Za-z0-9._-]{1,64}$/.test(input.external_ref) || !isUuid(input.quote_id) || input.payment_model!=="pay_on_arrival")
      throw new Error("SANDBOX_BOOKING_GUARD");
    await this.capabilities();
    return this.request<Json>("POST","/v1/bookings",input as unknown as Json,idempotencyKey,supplierId);
  }
  /** Sandbox-only alias kept for the sandbox harness. */
  async bookSandbox(input:CaravelQuotedBookingRequest,idempotencyKey:string,supplierId?:string) {
    if(this.environment!=="sandbox") throw new Error("SANDBOX_BOOKING_GUARD");
    return this.book(input,idempotencyKey,supplierId);
  }
  /** GET /v1/bookings?updated_since= — reconciliation list (summaries); recovery after missed webhooks. */
  async listBookings(params:{updated_since?:string; page_token?:string},supplierId?:string) {
    const qs=new URLSearchParams();
    if(params?.updated_since!==undefined){ if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(params.updated_since)) throw new Error("INVALID_UPDATED_SINCE"); qs.set("updated_since",params.updated_since); }
    if(params?.page_token!==undefined){ if(typeof params.page_token!=="string" || !params.page_token || params.page_token.length>2048 || /[\u0000-\u001F\u007F]/.test(params.page_token)) throw new Error("INVALID_PAGE_TOKEN"); qs.set("page_token",params.page_token); }
    await this.capabilities();
    const q=qs.toString();
    return this.request<Array<Json>>("GET",`/v1/bookings${q?"?"+q:""}`,undefined,undefined,supplierId);
  }
  /** Recovery after missed webhooks: consume every page without discarding a booking. */
  async listAllBookings(params:{updated_since?:string;page_token?:string}={},supplierId?:string):Promise<CaravelEnvelope<Json[]>> {
    let token=params.page_token;
    const seen=new Set<string>();
    const bookings:Json[]=[];
    let pages=0;
    let lastMeta:Json|undefined;
    while(true){
      if(pages>=30) throw new Error("CARAVEL_PAGINATION_LIMIT");
      const page=await this.listBookings({...params,...(token===undefined?{}:{page_token:token})},supplierId);
      if(!Array.isArray(page.data)) throw new Error("CARAVEL_PAGINATION_INVALID_ROWS");
      bookings.push(...page.data);
      if(bookings.length>6000) throw new Error("CARAVEL_PAGINATION_TOO_MANY_ROWS");
      pages++;
      lastMeta=page.meta;
      const next=page.meta?.next_page;
      if(next===null || next===undefined || next==="")
        return {data:bookings,meta:{...lastMeta,page_count:pages,next_page:null}};
      if(typeof next!=="string" || next.length>2048 || /[\u0000-\u001F\u007F]/.test(next) || seen.has(next))
        throw new Error("CARAVEL_PAGINATION_BAD_OR_REPEATED_TOKEN");
      seen.add(next);
      token=next;
    }
  }
  /** GET /v1/reference/constants — the enum and code lists (scope read:reference). */
  async constants() {
    await this.capabilities();
    return this.request<Json>("GET","/v1/reference/constants");
  }
  /** GET /v1/bookings/{ref}?ref_type=booking_id (OpenAPI v1.67.0 getBooking). */
  async bookingStatusSandbox(bookingId:string,supplierId?:string) {
    if(!bookingId || !/^[A-Za-z0-9_-]{1,128}$/.test(bookingId)) throw new Error("INVALID_BOOKING_ID");
    await this.capabilities();
    return this.request<Json>("GET",`/v1/bookings/${encodeURIComponent(bookingId)}?ref_type=booking_id`,undefined,undefined,supplierId);
  }
  async cancel(bookingId:string,revision:number,idempotencyKey:string,supplierId?:string) {
    this.assertBookingWrites();
    if(!bookingId || !/^[A-Za-z0-9_-]{1,128}$/.test(bookingId) || !Number.isInteger(revision) || revision<1 || !isUuid(idempotencyKey)) throw new Error("INVALID_CANCEL");
    await this.capabilities();
    return this.request<Json>("POST",`/v1/bookings/${encodeURIComponent(bookingId)}/cancel?ref_type=booking_id`,{expected_revision:revision,reason:"customer_request"},idempotencyKey,supplierId);
  }
  async cancelSandbox(bookingId:string,revision:number,idempotencyKey:string,supplierId?:string) {
    if(this.environment!=="sandbox") throw new Error("INVALID_CANCEL");
    return this.cancel(bookingId,revision,idempotencyKey,supplierId);
  }
}
/** Sandbox-only client (kept for existing callers and tests). */
export class CaravelSandboxClient extends CaravelClient {
  constructor(apiKey:string, baseUrl=SANDBOX) {
    if (!apiKey || baseUrl !== SANDBOX) throw new Error("SANDBOX_ONLY");
    super({apiKey, environment:"sandbox"});
  }
}
