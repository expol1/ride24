/**
 * Caravel Channel API v1.67.0 — isolated sandbox adapter.
 * NOT wired into Ride24 production dispatch.
 * Credentials must come from Supabase Edge Function secrets, never browser or database.
 * Sandbox bookings use invented customer data only.
 */
const SANDBOX = "https://sandbox-api.caravelway.com";
type Json = Record<string, unknown>;
export type Money = {amount: number; currency: string};
export type Supplier = {supplier_id:string; name:string; currency:string; payment_models?:string[]};
export type CaravelEnvelope<T> = {data:T; meta?:Json; request_id?:string};
export class CaravelError extends Error {
  public status:number; public code:string; public requestId:string|null;
  constructor(status:number, code:string, requestId:string|null) {
    super(`Caravel API: ${code} (HTTP ${status})`);
    this.status=status; this.code=code; this.requestId=requestId;
  }
}
export class CaravelSandboxClient {
  private readonly apiKey:string; private readonly baseUrl:string;
  constructor(apiKey:string, baseUrl=SANDBOX) {
    this.apiKey=apiKey; this.baseUrl=baseUrl;
    if (!apiKey || baseUrl !== SANDBOX) throw new Error("SANDBOX_ONLY");
  }
  private async request<T>(method:"GET"|"POST", path:string, body?:Json, idem?:string, supplierId?:string):Promise<CaravelEnvelope<T>> {
    if (!path.startsWith("/v1/") || path.includes("://")) throw new Error("INVALID_PATH");
    const headers:Record<string,string>={"X-API-Key":this.apiKey,"Accept":"application/json"};
    if(body){headers["Content-Type"]="application/json";}
    if(idem){headers["Idempotency-Key"]=idem;}
    if(supplierId){if(!/^[a-zA-Z0-9_-]{1,128}$/.test(supplierId)) throw new Error("INVALID_SUPPLIER_ID");headers["X-Supplier-Id"]=supplierId;}
    const response=await fetch(this.baseUrl+path,{method,headers,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(12000)});
    const envelope=await response.json().catch(()=>({error:{code:"INVALID_JSON"}})) as CaravelEnvelope<T> & {error?:{code?:string}};
    if(!response.ok && !envelope?.error) throw new CaravelError(response.status,"UPSTREAM_HTTP_ERROR",null);
    if(!response.ok) throw new CaravelError(response.status,envelope.error?.code??"UNKNOWN",envelope.request_id??null);
    if(!envelope || typeof envelope!=="object" || !("data" in envelope)) throw new CaravelError(response.status,"INVALID_RESPONSE_ENVELOPE",null);
    return envelope;
  }
  async capabilities() {
    const result=await this.request<{environment:string;api_version:string;quote_ttl_seconds:number}>("GET","/v1/capabilities");
    if(!result.data || typeof result.data!=="object" || result.data.environment!=="sandbox") throw new Error("SANDBOX_ENVIRONMENT_REQUIRED");
    return result;
  }
  async suppliers() {
    await this.capabilities();
    return this.request<Supplier[]>("GET","/v1/suppliers");
  }
  async locations(limit=200) {
    await this.capabilities();
    return this.request<Array<{location_id:string;supplier_id:string;code?:string;name:string;timezone?:string}>>("GET",`/v1/reference/locations?limit=${Math.max(1,Math.min(200,Math.floor(limit)))}`);
  }
  async vehicleClasses(limit=200) {
    await this.capabilities();
    return this.request<Array<Json>>("GET",`/v1/reference/vehicle-classes?limit=${Math.max(1,Math.min(200,Math.floor(limit)))}`);
  }
  async availability(params:{pickup_location_id:string;dropoff_location_id:string;pickup:string;dropoff:string},supplierId?:string) {
    await this.capabilities();
    const qs=new URLSearchParams(params);
    return this.request<Array<Json>>("GET",`/v1/availability?${qs.toString()}`,undefined,undefined,supplierId);
  }
  /**
   * Fail closed: do not offer a plan until protection and zero excess/deposit
   * are confirmed from the authoritative Caravel fields.
   * Shape-specific mapping must be validated against the live OpenAPI schema.
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
  async quote(input:{pickup:{location_id:string;at:string};dropoff:{location_id:string;at:string};vehicle_id:string;protection_id:string;plan?:string;drivers:Array<{age:number;role:"main"}>},idempotencyKey:string) {
    if(!idempotencyKey) throw new Error("IDEMPOTENCY_REQUIRED");
    await this.capabilities();
    return this.request<Json>("POST","/v1/quote",input as unknown as Json,idempotencyKey);
  }
  async bookSandbox(input:{quote_id:string;external_ref:string;drivers:Json[];customer:Json},idempotencyKey:string) {
    if(!idempotencyKey || typeof input.external_ref!=="string" || !input.external_ref.startsWith("ride24-sandbox-")) throw new Error("SANDBOX_BOOKING_GUARD");
    await this.capabilities();
    return this.request<Json>("POST","/v1/bookings",input as unknown as Json,idempotencyKey);
  }
  async cancelSandbox(bookingId:string,revision:number,idempotencyKey:string) {
    if(!bookingId || !Number.isInteger(revision) || revision<1 || !idempotencyKey) throw new Error("INVALID_CANCEL");
    await this.capabilities();
    return this.request<Json>("POST",`/v1/bookings/${encodeURIComponent(bookingId)}/cancel?ref_type=booking_id`,{expected_revision:revision,reason:"customer_request"},idempotencyKey);
  }
}
