import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGINS = new Set(["https://ride24.pl", "https://www.ride24.pl"]);

const GOOGLE_IMAGE_ASSETS = {
  landscape: [
    "customers/4627090780/assets/392582584881",
    "customers/4627090780/assets/392500085182",
    "customers/4627090780/assets/392500085161",
  ],
  square: [
    "customers/4627090780/assets/392500055968",
    "customers/4627090780/assets/392409691769",
    "customers/4627090780/assets/392409597923",
  ],
  logo: "customers/4627090780/assets/392493900646",
};

type JsonRecord = Record<string, unknown>;

type GoogleAdsCallResult = {
  response: Response;
  data: unknown;
  requestId: string | null;
};

type ResolvedRepeatedTextAssets = {
  headlineResourceNames: string[];
  descriptionResourceNames: string[];
  created: Array<{ text: string; resourceName: string }>;
  reused: Array<{ text: string; resourceName: string }>;
};

type CreatedGoogleResources = {
  campaignBudgetResourceName: string;
  campaignResourceName: string;
  assetGroupResourceName: string;
  longHeadlineAssetResourceName: string;
  businessNameAssetResourceName: string;
};

type InlineAssetOperationIndexes = {
  assetOperationIndex: number;
  linkOperationIndex: number;
};

function corsHeaders(origin: string | null): Record<string, string> {
  const allowedOrigin =
    origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://ride24.pl";

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
    Vary: "Origin",
  };
}

function jsonResponse(
  body: JsonRecord,
  status: number,
  origin: string | null,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders(origin),
  });
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();

  if (!value) {
    throw new Error(`Missing required secret: ${name}`);
  }

  return value;
}

function normalizeCustomerId(value: string): string {
  const normalized = value.replace(/-/g, "").trim();

  if (!/^\d{10}$/.test(normalized)) {
    throw new Error("Invalid Google Ads customer ID configuration.");
  }

  return normalized;
}

function normalizeApiVersion(value: string | undefined): string {
  const version = (value || "v24").trim();

  if (!/^v\d+$/.test(version)) {
    throw new Error("Invalid GOOGLE_ADS_API_VERSION configuration.");
  }

  return version;
}

function parsePositiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${field}.`);
  }

  return parsed;
}

function firstPositiveNumber(values: unknown[], field: string): number {
  for (const value of values) {
    const parsed = Number(value);

    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  throw new Error(`Invalid ${field}.`);
}

function resourceId(resourceName: string, expectedCollection: string): string {
  const pattern = new RegExp(
    `^customers\\/\\d+\\/${expectedCollection}\\/(\\d+)$`,
  );
  const match = resourceName.match(pattern);

  if (!match?.[1]) {
    throw new Error(
      `Google Ads returned an invalid ${expectedCollection} resource name.`,
    );
  }

  return match[1];
}

function postImageUrls(post: JsonRecord): string[] {
  const candidates = [post.image_url, post.imageUrl];
  const result: string[] = [];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      result.push(candidate.trim());
    }
  }

  if (Array.isArray(post.image_urls)) {
    for (const candidate of post.image_urls) {
      if (typeof candidate === "string" && candidate.trim()) {
        result.push(candidate.trim());
      }
    }
  }

  return Array.from(new Set(result));
}

function operationResponseResourceName(
  data: unknown,
  operationIndex: number,
  resultField: string,
): string {
  if (!data || typeof data !== "object") {
    throw new Error("Google Ads returned an empty mutate response.");
  }

  const responses = (data as JsonRecord).mutateOperationResponses;

  if (!Array.isArray(responses)) {
    throw new Error("Google Ads mutate response does not contain operation results.");
  }

  const operationResponse = responses[operationIndex];

  if (!operationResponse || typeof operationResponse !== "object") {
    throw new Error(
      `Google Ads mutate response is missing operation ${operationIndex}.`,
    );
  }

  const result = (operationResponse as JsonRecord)[resultField];

  if (!result || typeof result !== "object") {
    throw new Error(
      `Google Ads mutate response is missing ${resultField} at operation ${operationIndex}.`,
    );
  }

  const resourceName = (result as JsonRecord).resourceName;

  if (typeof resourceName !== "string" || !resourceName) {
    throw new Error(
      `Google Ads mutate response is missing a resource name for ${resultField}.`,
    );
  }

  return resourceName;
}

function extractCreatedGoogleResources(
  data: unknown,
  longHeadlineAssetOperationIndex: number,
  businessNameAssetOperationIndex: number,
): CreatedGoogleResources {
  return {
    campaignBudgetResourceName: operationResponseResourceName(
      data,
      0,
      "campaignBudgetResult",
    ),
    campaignResourceName: operationResponseResourceName(
      data,
      1,
      "campaignResult",
    ),
    assetGroupResourceName: operationResponseResourceName(
      data,
      2,
      "assetGroupResult",
    ),
    longHeadlineAssetResourceName: operationResponseResourceName(
      data,
      longHeadlineAssetOperationIndex,
      "assetResult",
    ),
    businessNameAssetResourceName: operationResponseResourceName(
      data,
      businessNameAssetOperationIndex,
      "assetResult",
    ),
  };
}

function clip(value: string, maxLength: number): string {
  const chars = Array.from(value.trim());

  if (chars.length <= maxLength) return chars.join("");

  return chars.slice(0, maxLength).join("").trimEnd();
}

function cleanMarketingText(value: string): string {
  return value
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/#[\p{L}\p{N}_-]+/gu, " ")
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstSentence(value: string): string {
  const cleaned = cleanMarketingText(value);
  const match = cleaned.match(/^(.+?[.!?])(?:\s|$)/);

  return match?.[1]?.trim() || cleaned;
}

function uniqueLimited(
  values: string[],
  maxLength: number,
  minimum: number,
): string[] {
  const result: string[] = [];

  for (const rawValue of values) {
    const value = clip(rawValue, maxLength);

    if (!value) continue;
    if (result.includes(value)) continue;

    result.push(value);
  }

  if (result.length < minimum) {
    throw new Error(
      `Could not build the minimum number of unique text assets (${minimum}).`,
    );
  }

  return result;
}

function microsFromPln(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Invalid campaign budget.");
  }

  return String(Math.round(value * 1_000_000));
}

type CampaignWindow = {
  startDateTime: string;
  endDateTime: string;
  requestedDays: number;
  googleScheduledCalendarDays: number;
  usesMinimumDurationSafetyBuffer: boolean;
};

function getWarsawTodayParts(): {
  year: number;
  month: number;
  day: number;
} {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Warsaw",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );

  const year = Number(values.year);
  const month = Number(values.month);
  const day = Number(values.day);

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    throw new Error("Could not determine the current Warsaw date.");
  }

  return { year, month, day };
}

function warsawCalendarDate(dayOffset: number): string {
  if (!Number.isInteger(dayOffset)) {
    throw new Error("Invalid campaign date offset.");
  }

  const today = getWarsawTodayParts();

  // UTC noon is used only for calendar arithmetic. This avoids DST changes
  // shifting the resulting Warsaw calendar date by one day.
  const date = new Date(
    Date.UTC(today.year, today.month - 1, today.day, 12, 0, 0),
  );

  date.setUTCDate(date.getUTCDate() + dayOffset);

  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function buildCampaignWindow(days: number): CampaignWindow {
  if (![3, 7].includes(days)) {
    throw new Error("Campaign duration must be 3 or 7 days.");
  }

  // Campaign starts tomorrow at daily granularity. Google requires at least
  // three complete days for a campaign total budget. A window from day 1
  // 00:00:00 through day 3 23:59:59 is one second shorter than 72 hours and
  // currently returns an UNKNOWN campaign error on end_date_time in API v24.
  // For the 3-day option we therefore give Google one additional calendar-day
  // safety buffer. The campaign is created as PAUSED, so it cannot serve or
  // generate spend. Before campaigns are enabled, the planned
  // google-ads-stop-campaign function will pause them after requestedDays.
  const usesMinimumDurationSafetyBuffer = days === 3;
  const googleScheduledCalendarDays = usesMinimumDurationSafetyBuffer
    ? 4
    : days;

  const startDate = warsawCalendarDate(1);
  const endDate = warsawCalendarDate(googleScheduledCalendarDays);

  return {
    startDateTime: `${startDate} 00:00:00`,
    endDateTime: `${endDate} 23:59:59`,
    requestedDays: days,
    googleScheduledCalendarDays,
    usesMinimumDurationSafetyBuffer,
  };
}

async function readJsonSafely(response: Response): Promise<unknown> {
  const text = await response.text();

  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 4000) };
  }
}

async function getGoogleAccessToken(): Promise<string> {
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: requiredEnv("GOOGLE_ADS_CLIENT_ID"),
      client_secret: requiredEnv("GOOGLE_ADS_CLIENT_SECRET"),
      refresh_token: requiredEnv("GOOGLE_ADS_REFRESH_TOKEN"),
      grant_type: "refresh_token",
    }),
  });

  const tokenData = (await readJsonSafely(tokenResponse)) as JsonRecord | null;

  if (!tokenResponse.ok) {
    throw new Error(`Google OAuth failed (${tokenResponse.status}).`);
  }

  const accessToken =
    typeof tokenData?.access_token === "string" ? tokenData.access_token : "";

  if (!accessToken) {
    throw new Error("Google OAuth did not return an access token.");
  }

  return accessToken;
}

function googleAdsHeaders(
  accessToken: string,
  loginCustomerId: string,
): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "developer-token": requiredEnv("GOOGLE_ADS_DEVELOPER_TOKEN"),
    "login-customer-id": loginCustomerId,
    "Content-Type": "application/json",
  };
}

function getRequestId(response: Response): string | null {
  return (
    response.headers.get("request-id") || response.headers.get("request_id")
  );
}

async function googleAdsMutate(
  apiVersion: string,
  customerId: string,
  accessToken: string,
  loginCustomerId: string,
  operations: JsonRecord[],
  validateOnly: boolean,
): Promise<GoogleAdsCallResult> {
  const response = await fetch(
    `https://googleads.googleapis.com/${apiVersion}/customers/${customerId}/googleAds:mutate`,
    {
      method: "POST",
      headers: googleAdsHeaders(accessToken, loginCustomerId),
      body: JSON.stringify({
        mutateOperations: operations,
        partialFailure: false,
        validateOnly,
      }),
    },
  );

  return {
    response,
    data: await readJsonSafely(response),
    requestId: getRequestId(response),
  };
}

async function findExistingTextAssets(
  apiVersion: string,
  customerId: string,
  accessToken: string,
  loginCustomerId: string,
): Promise<GoogleAdsCallResult & { assetsByText: Map<string, string> }> {
  const response = await fetch(
    `https://googleads.googleapis.com/${apiVersion}/customers/${customerId}/googleAds:searchStream`,
    {
      method: "POST",
      headers: googleAdsHeaders(accessToken, loginCustomerId),
      body: JSON.stringify({
        query: [
          "SELECT",
          "asset.resource_name,",
          "asset.text_asset.text",
          "FROM asset",
          "WHERE asset.type = 'TEXT'",
        ].join(" "),
      }),
    },
  );

  const data = await readJsonSafely(response);
  const assetsByText = new Map<string, string>();

  if (response.ok && Array.isArray(data)) {
    for (const batch of data) {
      if (!batch || typeof batch !== "object") continue;

      const results = (batch as JsonRecord).results;
      if (!Array.isArray(results)) continue;

      for (const row of results) {
        if (!row || typeof row !== "object") continue;

        const asset = (row as JsonRecord).asset;
        if (!asset || typeof asset !== "object") continue;

        const assetRecord = asset as JsonRecord;
        const resourceName = assetRecord.resourceName;
        const textAsset = assetRecord.textAsset;

        if (
          typeof resourceName !== "string" ||
          !textAsset ||
          typeof textAsset !== "object"
        ) {
          continue;
        }

        const text = (textAsset as JsonRecord).text;
        if (typeof text !== "string" || !text) continue;

        if (!assetsByText.has(text)) {
          assetsByText.set(text, resourceName);
        }
      }
    }
  }

  return {
    response,
    data,
    requestId: getRequestId(response),
    assetsByText,
  };
}

function extractCreatedAssetResourceNames(
  data: unknown,
  expectedCount: number,
): string[] {
  if (!data || typeof data !== "object") {
    throw new Error("Google Ads did not return an asset creation response.");
  }

  const responses = (data as JsonRecord).mutateOperationResponses;

  if (!Array.isArray(responses) || responses.length !== expectedCount) {
    throw new Error(
      "Google Ads returned an unexpected number of text asset results.",
    );
  }

  return responses.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`Missing text asset result at index ${index}.`);
    }

    const assetResult = (item as JsonRecord).assetResult;

    if (!assetResult || typeof assetResult !== "object") {
      throw new Error(`Missing assetResult at index ${index}.`);
    }

    const resourceName = (assetResult as JsonRecord).resourceName;

    if (typeof resourceName !== "string" || !resourceName) {
      throw new Error(`Missing asset resource name at index ${index}.`);
    }

    return resourceName;
  });
}

async function resolveRepeatedTextAssets(
  apiVersion: string,
  customerId: string,
  accessToken: string,
  loginCustomerId: string,
  headlines: string[],
  descriptions: string[],
): Promise<{
  result: ResolvedRepeatedTextAssets | null;
  errorCall: GoogleAdsCallResult | null;
  errorStage: string | null;
}> {
  const desiredTexts = Array.from(new Set([...headlines, ...descriptions]));

  const lookup = await findExistingTextAssets(
    apiVersion,
    customerId,
    accessToken,
    loginCustomerId,
  );

  if (!lookup.response.ok) {
    return {
      result: null,
      errorCall: lookup,
      errorStage: "google_ads_text_asset_lookup",
    };
  }

  const resourcesByText = new Map(lookup.assetsByText);
  const missingTexts = desiredTexts.filter(
    (text) => !resourcesByText.has(text),
  );

  const created: Array<{ text: string; resourceName: string }> = [];

  if (missingTexts.length > 0) {
    const createOperations: JsonRecord[] = missingTexts.map((text) => ({
      assetOperation: {
        create: {
          textAsset: { text },
        },
      },
    }));

    // Google requires repeated PMax text assets (HEADLINE and DESCRIPTION)
    // to exist before the atomic campaign/asset-group mutate request. This
    // call creates only reusable account-level text assets. It does not create
    // or enable a campaign and cannot generate advertising spend.
    const creation = await googleAdsMutate(
      apiVersion,
      customerId,
      accessToken,
      loginCustomerId,
      createOperations,
      false,
    );

    if (!creation.response.ok) {
      return {
        result: null,
        errorCall: creation,
        errorStage: "google_ads_text_asset_creation",
      };
    }

    const resourceNames = extractCreatedAssetResourceNames(
      creation.data,
      missingTexts.length,
    );

    missingTexts.forEach((text, index) => {
      const resourceName = resourceNames[index];
      resourcesByText.set(text, resourceName);
      created.push({ text, resourceName });
    });
  }

  const reused = desiredTexts
    .filter((text) => !missingTexts.includes(text))
    .map((text) => ({
      text,
      resourceName: resourcesByText.get(text) || "",
    }))
    .filter((item) => item.resourceName);

  const headlineResourceNames = headlines.map((text) => {
    const resourceName = resourcesByText.get(text);
    if (!resourceName) {
      throw new Error(`Could not resolve headline asset: ${text}`);
    }
    return resourceName;
  });

  const descriptionResourceNames = descriptions.map((text) => {
    const resourceName = resourcesByText.get(text);
    if (!resourceName) {
      throw new Error(`Could not resolve description asset: ${text}`);
    }
    return resourceName;
  });

  return {
    result: {
      headlineResourceNames,
      descriptionResourceNames,
      created,
      reused,
    },
    errorCall: null,
    errorStage: null,
  };
}


function customTextAssets(c: JsonRecord): {headlines:string[];longHeadline:string;descriptions:string[];businessName:string} {
  const values=(v:unknown,max:number,min:number,limit:number):string[]=>{
    if(!Array.isArray(v)||v.length<min||v.length>limit) throw new Error("Nieprawidłowa liczba nagłówków lub opisów.");
    const out=v.map(x=>typeof x==="string"?x.trim():"");
    if(out.some(x=>!x||Array.from(x).length>max)||new Set(out.map(x=>x.toLowerCase())).size!==out.length)
      throw new Error("Nieprawidłowe lub powtarzające się teksty reklamy.");
    return out;
  };
  const headlines=values(c.headlines,30,3,15);
  const descriptions=values(c.descriptions,90,2,5);
  const longHeadline=String(c.long_headline||"").trim();
  if(!longHeadline||Array.from(longHeadline).length>90) throw new Error("Długi nagłówek przekracza 90 znaków.");
  return {headlines,longHeadline,descriptions,businessName:"Ride24"};
}
function customLandingPage(raw:unknown):string {
  if(typeof raw!=="string"||raw.length>2000)throw new Error("Nieprawidłowy adres reklamy.");
  const url=new URL(raw);
  if(url.protocol!=="https:"||!["ride24.pl","www.ride24.pl"].includes(url.hostname)||
     url.username||url.password||url.port)throw new Error("Adres docelowy musi wskazywać stronę HTTPS ride24.pl.");
  return url.toString();
}
async function loadAdImage(raw:unknown):Promise<string> {
  const root=Deno.env.get("SUPABASE_URL")||"";
  const prefix=root+"/storage/v1/object/public/marketing-images/google-ads/";
  if(typeof raw!=="string"||!raw.startsWith(prefix)||!raw.endsWith(".jpg")||raw.includes(".."))
    throw new Error("Nieprawidłowy plik graficzny Google Ads.");
  const res=await fetch(raw,{signal:AbortSignal.timeout(15000)});
  if(!res.ok||!(res.headers.get("content-type")||"").startsWith("image/jpeg"))
    throw new Error("Grafika Google Ads jest niedostępna lub ma zły format.");
  const bytes=new Uint8Array(await res.arrayBuffer());
  if(bytes.length<100||bytes.length>5_120_000||bytes[0]!==0xff||bytes[1]!==0xd8)
    throw new Error("Nieprawidłowy rozmiar lub format grafiki.");
  const pieces:string[]=[];
  for(let i=0;i<bytes.length;i+=8192)pieces.push(String.fromCharCode(...bytes.subarray(i,i+8192)));
  return btoa(pieces.join(""));
}
function addUploadedImage(ops:JsonRecord[],customerId:string,group:string,tempId:number,data:string,type:string):void {
  const resourceName=`customers/${customerId}/assets/${tempId}`;
  ops.push({assetOperation:{create:{resourceName,type:"IMAGE",
    name:`Ride24 ${type} ${Date.now()} ${Math.abs(tempId)}`,imageAsset:{data}}}});
  addExistingImageLink(ops,group,resourceName,type);
}

function buildTextAssets(post: JsonRecord): {
  headlines: string[];
  longHeadline: string;
  descriptions: string[];
  businessName: string;
} {
  const city =
    typeof post.city === "string" && post.city.trim()
      ? post.city.trim()
      : "wybraną lokalizację";

  const country =
    typeof post.country === "string" && post.country.trim()
      ? post.country.trim()
      : "";

  const headline =
    typeof post.headline === "string" ? cleanMarketingText(post.headline) : "";

  const content = typeof post.content === "string" ? post.content : "";

  const headlines = uniqueLimited(
    [
      headline,
      `Wynajem auta w ${city}`,
      "Kaucja do 200 EUR",
      "Bez karty kredytowej",
      "Pełne ubezpieczenie",
      country ? `Odkrywaj ${country} z Ride24` : "",
    ],
    30,
    3,
  ).slice(0, 5);

  const longHeadline = clip(
    `Wynajmij auto w ${city} z pełnym ubezpieczeniem i bez karty kredytowej. Kaucja do 200 EUR.`,
    90,
  );

  const contentDescription = clip(firstSentence(content), 90);

  const descriptions = uniqueLimited(
    [
      contentDescription,
      "Pełne ubezpieczenie, bez karty kredytowej. Kaucja do 200 EUR zależnie od oferty.",
      `Zwiedzaj ${city} we własnym tempie. Prosta rezerwacja online z Ride24.`,
    ],
    90,
    2,
  ).slice(0, 4);

  return {
    headlines,
    longHeadline,
    descriptions,
    businessName: "Ride24",
  };
}

function addTextAssetAndLink(
  operations: JsonRecord[],
  customerId: string,
  assetGroupResource: string,
  tempId: number,
  text: string,
  fieldType: string,
): InlineAssetOperationIndexes {
  const assetResource = `customers/${customerId}/assets/${tempId}`;
  const assetOperationIndex = operations.length;

  operations.push({
    assetOperation: {
      create: {
        resourceName: assetResource,
        textAsset: {
          text,
        },
      },
    },
  });

  const linkOperationIndex = operations.length;

  operations.push({
    assetGroupAssetOperation: {
      create: {
        asset: assetResource,
        assetGroup: assetGroupResource,
        fieldType,
      },
    },
  });

  return {
    assetOperationIndex,
    linkOperationIndex,
  };
}

function addExistingAssetLink(
  operations: JsonRecord[],
  assetGroupResource: string,
  assetResource: string,
  fieldType: string,
): void {
  operations.push({
    assetGroupAssetOperation: {
      create: {
        asset: assetResource,
        assetGroup: assetGroupResource,
        fieldType,
      },
    },
  });
}

function addExistingImageLink(
  operations: JsonRecord[],
  assetGroupResource: string,
  assetResource: string,
  fieldType: string,
): void {
  addExistingAssetLink(
    operations,
    assetGroupResource,
    assetResource,
    fieldType,
  );
}

Deno.serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    return new Response("ok", {
      status: 200,
      headers: corsHeaders(origin),
    });
  }

  if (req.method !== "POST") {
    return jsonResponse(
      {
        success: false,
        error: "Method not allowed.",
      },
      405,
      origin,
    );
  }

  try {
    const authHeader =
      req.headers.get("Authorization") || req.headers.get("authorization");

    if (!authHeader?.startsWith("Bearer ")) {
      return jsonResponse(
        {
          success: false,
          error: "Missing or invalid Authorization header.",
        },
        401,
        origin,
      );
    }

    const supabaseUrl = requiredEnv("SUPABASE_URL");
    const anonKey = requiredEnv("SUPABASE_ANON_KEY");
    const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");

    const userClient = createClient(supabaseUrl, anonKey, {
      global: {
        headers: {
          Authorization: authHeader,
        },
      },
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const {
      data: { user },
      error: userError,
    } = await userClient.auth.getUser();

    if (userError || !user) {
      return jsonResponse(
        {
          success: false,
          error: "Invalid or expired user session.",
        },
        401,
        origin,
      );
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const { data: profile, error: profileError } = await adminClient
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();

    if (profileError) {
      console.error("Profile lookup failed:", profileError.message);

      return jsonResponse(
        {
          success: false,
          error: "Could not verify administrator permissions.",
        },
        500,
        origin,
      );
    }

    if (profile?.role !== "admin") {
      return jsonResponse(
        {
          success: false,
          error: "Administrator role is required.",
        },
        403,
        origin,
      );
    }

    let body: JsonRecord;

    try {
      body = (await req.json()) as JsonRecord;
    } catch {
      return jsonResponse(
        {
          success: false,
          error: "Request body must be valid JSON.",
        },
        400,
        origin,
      );
    }

    const postId = parsePositiveInteger(body.postId, "postId");
    const days = parsePositiveInteger(body.days, "days");

    if (![3, 7].includes(days)) {
      return jsonResponse(
        {
          success: false,
          error: "days must be 3 or 7.",
        },
        400,
        origin,
      );
    }

    const { data: validation, error: validationError } = await adminClient.rpc(
      "validate_google_ads_promotion",
      {
        p_post_id: postId,
        p_days: days,
      },
    );

    if (validationError) {
      console.error(
        "Promotion validation RPC failed:",
        validationError.message,
      );

      return jsonResponse(
        {
          success: false,
          error: "Promotion validation failed.",
        },
        500,
        origin,
      );
    }

    const validationObject =
      validation && typeof validation === "object"
        ? (validation as JsonRecord)
        : null;

    if (
      !validationObject ||
      validationObject.success !== true ||
      validationObject.can_start !== true
    ) {
      return jsonResponse(
        {
          success: false,
          validateOnly: false,
          campaignCreated: false,
          stage: "business_validation",
          validation,
        },
        409,
        origin,
      );
    }

    const post =
      validationObject.post && typeof validationObject.post === "object"
        ? (validationObject.post as JsonRecord)
        : null;

    const budget =
      validationObject.budget && typeof validationObject.budget === "object"
        ? (validationObject.budget as JsonRecord)
        : null;

    if (!post || !budget) {
      throw new Error("Validation response is incomplete.");
    }

    const estimatedTotalBudget = Number(budget.estimated_total_budget);

    if (!Number.isFinite(estimatedTotalBudget) || estimatedTotalBudget <= 0) {
      throw new Error("Validation returned an invalid total budget.");
    }

    const dailyBudget = firstPositiveNumber(
      [
        budget.daily_budget,
        budget.daily_budget_pln,
        budget.dailyBudget,
        estimatedTotalBudget / days,
      ],
      "daily budget",
    );

    const customerId = normalizeCustomerId(
      requiredEnv("GOOGLE_ADS_CUSTOMER_ID"),
    );

    const loginCustomerId = normalizeCustomerId(
      requiredEnv("GOOGLE_ADS_LOGIN_CUSTOMER_ID"),
    );

    // In this integration the MCC used in the login-customer-id header is also
    // the manager account stored in google_ads_campaigns.
    const managerId = loginCustomerId;

    const apiVersion = normalizeApiVersion(
      Deno.env.get("GOOGLE_ADS_API_VERSION"),
    );

    const {
      data: existingCampaigns,
      error: existingCampaignError,
    } = await adminClient
      .from("google_ads_campaigns")
      .select(`
        id,
        status,
        google_status,
        google_campaign_id,
        google_campaign_resource_name,
        launched_at,
        paused_at,
        created_at
      `)
      .eq("marketing_queue_id", postId)
      .in("status", [
        "creating",
        "paused",
        "enabled",
      ])
      .order("created_at", {
        ascending: false,
      })
      .limit(20);

    if (existingCampaignError) {
      console.error(
        "Existing Google Ads campaign lookup failed:",
        existingCampaignError.message,
      );

      return jsonResponse(
        {
          success: false,
          campaignCreated: false,
          stage: "database_duplicate_check",
          error:
            "Could not verify whether this post already has a campaign.",
        },
        500,
        origin,
      );
    }

    /*
     * Blokujemy utworzenie kolejnej kampanii, jeżeli:
     *
     * 1. poprzednia jest właśnie tworzona,
     * 2. poprzednia jest nadal aktywna,
     * 3. poprzednia jest PAUSED, ale nigdy nie została uruchomiona.
     *
     * Kampania PAUSED z uzupełnionym launched_at została wcześniej
     * uruchomiona i później zakończona. Nie blokuje kolejnej promocji.
     */

    const blockingCampaign =
      (existingCampaigns || []).find(
        (campaign) =>
          campaign.status === "creating" ||
          campaign.status === "enabled" ||
          (
            campaign.status === "paused" &&
            !campaign.launched_at
          ),
      );

    if (blockingCampaign) {
      return jsonResponse(
        {
          success: false,
          campaignCreated: false,
          stage: "duplicate_campaign_prevention",
          error:
            blockingCampaign.status === "paused"
              ? "Dla tego posta istnieje już przygotowana kampania Google Ads, która nie została jeszcze uruchomiona."
              : "Dla tego posta istnieje już tworzona albo aktywna kampania Google Ads.",
          existingCampaign: blockingCampaign,
        },
        409,
        origin,
      );
    }

    const {data:creative,error:creativeError}=await adminClient.from("google_ads_creatives")
      .select("*").eq("marketing_queue_id",postId).maybeSingle();
    if(creativeError)return jsonResponse({success:false,campaignCreated:false,
      stage:"creative_lookup",error:"Nie udało się odczytać własnej reklamy."},500,origin);
    if(creative?.objective==="app_install")return jsonResponse({success:false,campaignCreated:false,
      stage:"app_campaign_required",
      error:"Reklama instalacji aplikacji wymaga kampanii App Campaign, nie Performance Max."},409,origin);
    let finalUrl="https://ride24.pl/";
    let landscapeData:string|null=null,squareData:string|null=null;
    let textAssets=buildTextAssets(post);
    if(creative){
      try{
        finalUrl=customLandingPage(creative.final_url);
        textAssets=customTextAssets(creative as JsonRecord);
        if(!creative.landscape_url||!creative.square_url)throw new Error("Brakuje własnej grafiki.");
        [landscapeData,squareData]=await Promise.all([loadAdImage(creative.landscape_url),loadAdImage(creative.square_url)]);
      }catch(e){return jsonResponse({success:false,campaignCreated:false,stage:"creative_validation",
        error:e instanceof Error?e.message:String(e)},400,origin);}
    }
    const campaignWindow = buildCampaignWindow(days);
    const accessToken = await getGoogleAccessToken();

    const repeatedTextAssetResolution = await resolveRepeatedTextAssets(
      apiVersion,
      customerId,
      accessToken,
      loginCustomerId,
      textAssets.headlines,
      textAssets.descriptions,
    );

    if (
      !repeatedTextAssetResolution.result ||
      repeatedTextAssetResolution.errorCall ||
      repeatedTextAssetResolution.errorStage
    ) {
      const failedCall = repeatedTextAssetResolution.errorCall;

      console.error(
        "Google Ads repeated text asset preparation failed:",
        repeatedTextAssetResolution.errorStage,
        failedCall?.response.status,
        failedCall?.requestId,
        failedCall?.data,
      );

      return jsonResponse(
        {
          success: false,
          validateOnly: false,
          campaignCreated: false,
          stage:
            repeatedTextAssetResolution.errorStage ||
            "google_ads_text_asset_preparation",
          error: failedCall
            ? `Google Ads API returned HTTP ${failedCall.response.status}.`
            : "Could not prepare required text assets.",
          requestId: failedCall?.requestId || null,
          googleError: failedCall?.data || null,
          preview: {
            postId,
            days,
            estimatedTotalBudget,
            dailyBudget,
            textAssets,
            campaignWindow,
          },
        },
        502,
        origin,
      );
    }

    const repeatedTextAssets = repeatedTextAssetResolution.result;
    const stamp = Date.now();
    const campaignName = `Ride24 PMax post ${postId} ${stamp}`;
    const budgetName = `Ride24 PMax budget post ${postId} ${stamp}`;
    const assetGroupName = `Ride24 asset group post ${postId} ${stamp}`;
    const budgetResource = `customers/${customerId}/campaignBudgets/-1`;
    const campaignResource = `customers/${customerId}/campaigns/-2`;
    const assetGroupResource = `customers/${customerId}/assetGroups/-3`;

    const operations: JsonRecord[] = [
      {
        campaignBudgetOperation: {
          create: {
            resourceName: budgetResource,
            name: budgetName,
            deliveryMethod: "STANDARD",
            totalAmountMicros: microsFromPln(estimatedTotalBudget),
            explicitlyShared: false,
            period: "CUSTOM_PERIOD",
          },
        },
      },
      {
        campaignOperation: {
          create: {
            resourceName: campaignResource,
            name: campaignName,
            status: "PAUSED",
            advertisingChannelType: "PERFORMANCE_MAX",
            campaignBudget: budgetResource,
            maximizeConversions: {},
            brandGuidelinesEnabled: false,
            // Only the user's own copy, artwork and landing page in custom campaigns.
            ...(creative ? { assetAutomationSettings: [
              {assetAutomationType:"FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION",assetAutomationStatus:"OPTED_OUT"},
              {assetAutomationType:"TEXT_ASSET_AUTOMATION",assetAutomationStatus:"OPTED_OUT"},
              {assetAutomationType:"GENERATE_IMAGE_ENHANCEMENT",assetAutomationStatus:"OPTED_OUT"}
            ]} : {}),
            containsEuPoliticalAdvertising:
              "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
            startDateTime: campaignWindow.startDateTime,
            endDateTime: campaignWindow.endDateTime,
          },
        },
      },
      {
        assetGroupOperation: {
          create: {
            resourceName: assetGroupResource,
            name: assetGroupName,
            campaign: campaignResource,
            finalUrls: [finalUrl],
            finalMobileUrls: [finalUrl],
            status: "PAUSED",
          },
        },
      },
    ];

    let nextTempId = -10;

    for (const assetResource of repeatedTextAssets.headlineResourceNames) {
      addExistingAssetLink(
        operations,
        assetGroupResource,
        assetResource,
        "HEADLINE",
      );
    }

    const longHeadlineIndexes = addTextAssetAndLink(
      operations,
      customerId,
      assetGroupResource,
      nextTempId--,
      textAssets.longHeadline,
      "LONG_HEADLINE",
    );

    for (const assetResource of repeatedTextAssets.descriptionResourceNames) {
      addExistingAssetLink(
        operations,
        assetGroupResource,
        assetResource,
        "DESCRIPTION",
      );
    }

    const businessNameIndexes = addTextAssetAndLink(
      operations,
      customerId,
      assetGroupResource,
      nextTempId--,
      textAssets.businessName,
      "BUSINESS_NAME",
    );

    if(landscapeData&&squareData){
      addUploadedImage(operations,customerId,assetGroupResource,nextTempId--,landscapeData,"MARKETING_IMAGE");
      addUploadedImage(operations,customerId,assetGroupResource,nextTempId--,squareData,"SQUARE_MARKETING_IMAGE");
    }else{
    for (const asset of GOOGLE_IMAGE_ASSETS.landscape) {
      addExistingImageLink(
        operations,
        assetGroupResource,
        asset,
        "MARKETING_IMAGE",
      );
    }

    for (const asset of GOOGLE_IMAGE_ASSETS.square) {
      addExistingImageLink(
        operations,
        assetGroupResource,
        asset,
        "SQUARE_MARKETING_IMAGE",
      );
    }
    }

    addExistingImageLink(
      operations,
      assetGroupResource,
      GOOGLE_IMAGE_ASSETS.logo,
      "LOGO",
    );

    const googleRequestPayload = {
      mutateOperations: operations,
      partialFailure: false,
      validateOnly: false,
    };

    const requestSnapshot: JsonRecord = {
      createdAt: new Date().toISOString(),
      postId,
      requestedDays: days,
      estimatedTotalBudget,
      dailyBudget,
      campaignWindow,
      names: {
        campaignName,
        budgetName,
        assetGroupName,
      },
      textAssets,
      repeatedTextAssets: {
        headlineResourceNames: repeatedTextAssets.headlineResourceNames,
        descriptionResourceNames: repeatedTextAssets.descriptionResourceNames,
        created: repeatedTextAssets.created,
        reused: repeatedTextAssets.reused,
      },
      imageAssets: creative ? {landscape:[creative.landscape_url],square:[creative.square_url],logo:GOOGLE_IMAGE_ASSETS.logo} : GOOGLE_IMAGE_ASSETS,
      googleRequest: creative ? {...googleRequestPayload,
        mutateOperations:operations.map(op=>op.assetOperation?.create?.imageAsset?.data
          ? {assetOperation:{create:{...op.assetOperation.create,imageAsset:{data:"[REDACTED]"}}}} : op)
      } : googleRequestPayload,
    };

    const initialGoogleAssetResourceNames = {
      headlines: repeatedTextAssets.headlineResourceNames,
      descriptions: repeatedTextAssets.descriptionResourceNames,
      landscapeImages: creative ? [creative.landscape_url] : GOOGLE_IMAGE_ASSETS.landscape,
      squareImages: creative ? [creative.square_url] : GOOGLE_IMAGE_ASSETS.square,
      logo: GOOGLE_IMAGE_ASSETS.logo,
    };

    const { data: campaignRow, error: campaignInsertError } = await adminClient
      .from("google_ads_campaigns")
      .insert({
        marketing_queue_id: postId,
        created_by: user.id,
        customer_id: customerId,
        manager_id: managerId,
        login_customer_id: loginCustomerId,
        campaign_type: "PERFORMANCE_MAX",
        campaign_name: campaignName,
        status: "creating",
        daily_budget: dailyBudget,
        currency: "PLN",
        start_date: campaignWindow.startDateTime.slice(0, 10),
        end_date: campaignWindow.endDateTime.slice(0, 10),
        country_code: "PL",
        language_code: "pl",
        final_url: finalUrl,
        headlines: textAssets.headlines,
        long_headlines: [textAssets.longHeadline],
        descriptions: textAssets.descriptions,
        image_urls: creative ? [creative.landscape_url,creative.square_url] : postImageUrls(post),
        google_asset_resource_names: initialGoogleAssetResourceNames,
        request_snapshot: requestSnapshot,
        last_error: null,
      })
      .select("id")
      .single();

    if (campaignInsertError || !campaignRow?.id) {
      console.error(
        "Could not create google_ads_campaigns row:",
        campaignInsertError?.message,
      );

      return jsonResponse(
        {
          success: false,
          campaignCreated: false,
          stage: "database_prepare",
          error: "Could not prepare the campaign record in Supabase.",
          databaseError: campaignInsertError?.message || null,
        },
        500,
        origin,
      );
    }

    const databaseCampaignId = String(campaignRow.id);

    const campaignCreation = await googleAdsMutate(
      apiVersion,
      customerId,
      accessToken,
      loginCustomerId,
      operations,
      false,
    );

    const googleResponse = campaignCreation.response;
    const googleData = campaignCreation.data;
    const requestId = campaignCreation.requestId;

    if (!googleResponse.ok) {
      const lastError = {
        stage: "google_ads_campaign_creation",
        httpStatus: googleResponse.status,
        requestId,
        googleError: googleData,
        occurredAt: new Date().toISOString(),
      };

      const { error: failureUpdateError } = await adminClient
        .from("google_ads_campaigns")
        .update({
          status: "failed",
          last_error: lastError,
          request_snapshot: {
            ...requestSnapshot,
            googleRequestId: requestId,
          },
          updated_at: new Date().toISOString(),
        })
        .eq("id", databaseCampaignId);

      if (failureUpdateError) {
        console.error(
          "Could not save Google Ads creation failure:",
          failureUpdateError.message,
        );
      }

      console.error(
        "Google Ads campaign creation failed:",
        googleResponse.status,
        requestId,
        googleData,
      );

      return jsonResponse(
        {
          success: false,
          validateOnly: false,
          campaignCreated: false,
          stage: "google_ads_campaign_creation",
          error: `Google Ads API returned HTTP ${googleResponse.status}.`,
          requestId,
          googleError: googleData,
          databaseCampaignId,
        },
        502,
        origin,
      );
    }

    let createdResources: CreatedGoogleResources;

    try {
      createdResources = extractCreatedGoogleResources(
        googleData,
        longHeadlineIndexes.assetOperationIndex,
        businessNameIndexes.assetOperationIndex,
      );
    } catch (responseParseError) {
      const parseMessage =
        responseParseError instanceof Error
          ? responseParseError.message
          : "Could not parse the Google Ads response.";

      const { error: parseUpdateError } = await adminClient
        .from("google_ads_campaigns")
        .update({
          status: "creating",
          last_error: {
            stage: "google_ads_response_parse",
            error: parseMessage,
            requestId,
            googleResponse: googleData,
            occurredAt: new Date().toISOString(),
          },
          request_snapshot: {
            ...requestSnapshot,
            googleRequestId: requestId,
            googleResponse: googleData,
          },
          updated_at: new Date().toISOString(),
        })
        .eq("id", databaseCampaignId);

      if (parseUpdateError) {
        console.error(
          "Could not save response parsing failure:",
          parseUpdateError.message,
        );
      }

      return jsonResponse(
        {
          success: false,
          validateOnly: false,
          campaignCreated: true,
          campaignPaused: true,
          stage: "google_ads_response_parse",
          error: parseMessage,
          requestId,
          databaseCampaignId,
          googleResponse: googleData,
        },
        500,
        origin,
      );
    }

    const googleCampaignId = resourceId(
      createdResources.campaignResourceName,
      "campaigns",
    );
    const googleBudgetId = resourceId(
      createdResources.campaignBudgetResourceName,
      "campaignBudgets",
    );
    const googleAssetGroupId = resourceId(
      createdResources.assetGroupResourceName,
      "assetGroups",
    );

    // Resolve actual asset resource names returned for the user's uploaded artwork.
    const uploadedImageResources = creative && googleData && typeof googleData === "object"
      ? operations.flatMap((op, index) => {
          if (!op.assetOperation?.create?.imageAsset?.data) return [];
          try {
            return [{
              fieldType: operations[index + 1]?.assetGroupAssetOperation?.create?.fieldType,
              resource: operationResponseResourceName(googleData, index, "assetResult"),
            }];
          } catch { return []; }
        })
      : [];
    const finalGoogleAssetResourceNames = {
      headlines: repeatedTextAssets.headlineResourceNames,
      longHeadline: createdResources.longHeadlineAssetResourceName,
      descriptions: repeatedTextAssets.descriptionResourceNames,
      businessName: createdResources.businessNameAssetResourceName,
      landscapeImages: creative
        ? uploadedImageResources.filter(a=>a.fieldType==="MARKETING_IMAGE").map(a=>a.resource)
        : GOOGLE_IMAGE_ASSETS.landscape,
      squareImages: creative
        ? uploadedImageResources.filter(a=>a.fieldType==="SQUARE_MARKETING_IMAGE").map(a=>a.resource)
        : GOOGLE_IMAGE_ASSETS.square,
      logo: GOOGLE_IMAGE_ASSETS.logo,
    };

    const finalRequestSnapshot = {
      ...requestSnapshot,
      googleRequestId: requestId,
      googleResponseSummary: {
        campaignBudgetResourceName:
          createdResources.campaignBudgetResourceName,
        campaignResourceName: createdResources.campaignResourceName,
        assetGroupResourceName: createdResources.assetGroupResourceName,
        longHeadlineAssetResourceName:
          createdResources.longHeadlineAssetResourceName,
        businessNameAssetResourceName:
          createdResources.businessNameAssetResourceName,
      },
    };

    const { data: finalizedCampaign, error: campaignFinalizeError } =
      await adminClient
        .from("google_ads_campaigns")
        .update({
          status: "paused",
          google_status: "PAUSED",
          google_primary_status: null,
          google_campaign_id: googleCampaignId,
          google_campaign_resource_name:
            createdResources.campaignResourceName,
          google_budget_id: googleBudgetId,
          google_budget_resource_name:
            createdResources.campaignBudgetResourceName,
          google_asset_group_id: googleAssetGroupId,
          google_asset_group_resource_name:
            createdResources.assetGroupResourceName,
          google_asset_resource_names: finalGoogleAssetResourceNames,
          request_snapshot: finalRequestSnapshot,
          last_error: null,
          paused_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", databaseCampaignId)
        .select(
          "id,marketing_queue_id,campaign_name,status,google_status,google_campaign_id,google_campaign_resource_name,google_budget_id,google_budget_resource_name,google_asset_group_id,google_asset_group_resource_name,daily_budget,currency,start_date,end_date,created_at,updated_at",
        )
        .single();

    if (campaignFinalizeError || !finalizedCampaign) {
      const finalizeMessage =
        campaignFinalizeError?.message ||
        "Google campaign was created, but the Supabase record could not be finalized.";

      const { error: recoveryUpdateError } = await adminClient
        .from("google_ads_campaigns")
        .update({
          status: "creating",
          google_status: "PAUSED",
          google_campaign_id: googleCampaignId,
          google_campaign_resource_name:
            createdResources.campaignResourceName,
          google_budget_id: googleBudgetId,
          google_budget_resource_name:
            createdResources.campaignBudgetResourceName,
          google_asset_group_id: googleAssetGroupId,
          google_asset_group_resource_name:
            createdResources.assetGroupResourceName,
          google_asset_resource_names: finalGoogleAssetResourceNames,
          request_snapshot: finalRequestSnapshot,
          last_error: {
            stage: "database_finalize",
            error: finalizeMessage,
            requestId,
            occurredAt: new Date().toISOString(),
          },
          paused_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", databaseCampaignId);

      if (recoveryUpdateError) {
        console.error(
          "Could not save Google campaign recovery data:",
          recoveryUpdateError.message,
        );
      }

      return jsonResponse(
        {
          success: false,
          validateOnly: false,
          campaignCreated: true,
          campaignPaused: true,
          stage: "database_finalize",
          error: finalizeMessage,
          requestId,
          databaseCampaignId,
          googleCampaignId,
          googleCampaignResourceName:
            createdResources.campaignResourceName,
          googleBudgetId,
          googleBudgetResourceName:
            createdResources.campaignBudgetResourceName,
          googleAssetGroupId,
          googleAssetGroupResourceName:
            createdResources.assetGroupResourceName,
        },
        500,
        origin,
      );
    }

    return jsonResponse(
      {
        success: true,
        validateOnly: false,
        campaignCreated: true,
        campaignPaused: true,
        marketingQueuePromotedChanged: false,
        stage: "campaign_created_paused",
        requestId,
        campaign: finalizedCampaign,
        assets: finalGoogleAssetResourceNames,
      },
      200,
      origin,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected server error.";

    console.error("google-ads-create-campaign failed:", error);

    return jsonResponse(
      {
        success: false,
        validateOnly: false,
        campaignCreated: false,
        stage: "server",
        error: message,
      },
      500,
      origin,
    );
  }
});
