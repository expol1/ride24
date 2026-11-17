// Caravel Channel API v1.67.0 — LIVE sandbox acceptance run (not a unit test).
// Server-side only (GitHub Actions via PR label, or the approved sandbox test function):
//   CARAVEL_SANDBOX_API_KEY  required; never printed (GitHub also masks it)
//   CARAVEL_LIVE_BOOKING=1   also run the booking flow with invented data (pay_on_arrival); every booking is cancelled
// The flow itself lives in supabase/functions/_shared/caravel-acceptance.mjs.
import {appendFileSync} from "node:fs";
import {runCaravelAcceptance} from "../supabase/functions/_shared/caravel-acceptance.mjs";
import {CaravelSandboxClient,selectCurrentCaravelTerms} from "../supabase/functions/_shared/caravel-sandbox-adapter.ts";

const key = process.env.CARAVEL_SANDBOX_API_KEY || "";
const booking = process.env.CARAVEL_LIVE_BOOKING === "1";
const run = await runCaravelAcceptance(key, {booking, runId: process.env.GITHUB_RUN_ID || "local", budgetMs: 300000});
// Authority check against current API terms, WITHOUT ever printing body or secrets.
// A GitHub action run reads terms but makes no document/booking/database writes.
const termsSummary=[];
let termsFailed=false;
if(key){
  try{
    const client=new CaravelSandboxClient(key);
    const suppliers=(await client.suppliers()).data;
    for(const supplier of suppliers){
      if(typeof supplier?.supplier_id!=="string")throw new Error("CARAVEL_SUPPLIER_UNVERIFIED");
      const list=(await client.referenceTerms(supplier.supplier_id)).data;
      const en=selectCurrentCaravelTerms(list,"en");
      const detailed=(await client.referenceTermsDocument(en.document_id,supplier.supplier_id)).data;
      if(detailed.content_hash!==en.content_hash || detailed.version!==en.version ||
         detailed.published_at!==en.published_at || detailed.withdrawn_at!==null)
        throw new Error("CARAVEL_TERMS_LIST_DETAIL_MISMATCH");
      termsSummary.push([supplier.supplier_id,en.document_id,en.version,en.format,en.content_hash,en.published_at]);
    }
  }catch(error){
    termsFailed=true;
    termsSummary.push(["TERMS_AUDIT_FAILED",String(error instanceof Error?error.message:error).slice(0,80)]);
  }
}else{termsFailed=true;termsSummary.push(["SANDBOX_KEY_UNCONFIGURED"])}
const lines = ["# Caravel sandbox live run", "", `booking flow: ${booking ? "enabled (invented data, pay_on_arrival, cancelled)" : "disabled"}`, "",
  "| Step | Outcome | Summary |", "| --- | --- | --- |",
  ...run.results.map(r => `| ${r.endpoint} | ${r.outcome} | ${r.summary ? JSON.stringify(r.summary).replace(/\|/g, "/").slice(0, 1200) : ""} |`),
  "", "## Current authoritative terms metadata (read-only; no document bodies logged)",
  ...termsSummary.map(x=>`- ${x.map(y=>String(y).replace(/\\|/g,"/")).join(" / ")}`)];
const text = key ? lines.join("\n").split(key).join("***") : lines.join("\n");
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n");
process.exit(run.failed || termsFailed ? 1 : 0);
