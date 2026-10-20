import { makeSearchMissHandler } from "../_shared/search-miss-handler.mjs";

Deno.serve(makeSearchMissHandler({
  url: Deno.env.get("SUPABASE_URL"),
  serviceKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
  internalSecret: Deno.env.get("RIDE24_INTERNAL_SECRET"),
  publicKeys: [
    Deno.env.get("SUPABASE_ANON_KEY"),
    // Public key already used by assets/helper/supabaseConfig.js, not a secret.
    "sb_publishable_KMeRBCZCQH-S0Ubnr80v6w_Gub3vcQf"
  ]
}));
