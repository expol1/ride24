// Test-only Node.js hook: load Supabase Edge Function TypeScript sources as ESM.
// Node picks the module format of a .ts file from the nearest package.json.
// The repository root has none (it is a static Cloudflare Pages site), so a
// package.json outside the checkout (e.g. a Windows home folder with
// "type": "commonjs") can make Node load these ESM sources as CommonJS.
// This hook pins only supabase/functions/**/*.ts to ESM for local test runs.
// It changes no source file, no package.json and no CI behaviour.
// Usage (from repo root):
//   node --import ./tests/local-ts-esm-loader.mjs --experimental-strip-types --test tests/caravel-*.test.mjs
import {register} from "node:module";

const EDGE_FUNCTION_TS = /\/supabase\/functions\/.+\.ts$/;

export async function load(url, context, nextLoad) {
  if (url.startsWith("file:") && EDGE_FUNCTION_TS.test(new URL(url).pathname)) {
    return nextLoad(url, {...context, format: "module-typescript"});
  }
  return nextLoad(url, context);
}

if (!globalThis.__localTsEsmLoaderRegistered) {
  globalThis.__localTsEsmLoaderRegistered = true;
  register(import.meta.url);
}
