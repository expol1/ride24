// Caravel Channel API v1.67.0 — LIVE sandbox acceptance run (not a unit test).
// Server-side only (GitHub Actions via PR label, or the approved sandbox test function):
//   CARAVEL_SANDBOX_API_KEY  required; never printed (GitHub also masks it)
//   CARAVEL_LIVE_BOOKING=1   also run the booking flow with invented data (pay_on_arrival); every booking is cancelled
// The flow itself lives in supabase/functions/_shared/caravel-acceptance.mjs.
import {appendFileSync} from "node:fs";
import {runCaravelAcceptance} from "../supabase/functions/_shared/caravel-acceptance.mjs";

const key = process.env.CARAVEL_SANDBOX_API_KEY || "";
const booking = process.env.CARAVEL_LIVE_BOOKING === "1";
const run = await runCaravelAcceptance(key, {booking, runId: process.env.GITHUB_RUN_ID || "local", budgetMs: 300000});
const lines = ["# Caravel sandbox live run", "", `booking flow: ${booking ? "enabled (invented data, pay_on_arrival, cancelled)" : "disabled"}`, "",
  "| Step | Outcome | Summary |", "| --- | --- | --- |",
  ...run.results.map(r => `| ${r.endpoint} | ${r.outcome} | ${r.summary ? JSON.stringify(r.summary).replace(/\|/g, "/").slice(0, 1200) : ""} |`)];
const text = key ? lines.join("\n").split(key).join("***") : lines.join("\n");
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n");
process.exit(run.failed ? 1 : 0);
