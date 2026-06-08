import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async () => {

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { data: settings } = await supabase
    .from("marketing_settings")
    .select("*")
    .eq("id", 1)
    .single();

  return new Response(
    JSON.stringify({
      success: true,
      marketing_active: settings?.is_active,
      monthly_budget: settings?.monthly_budget,
      daily_budget: settings?.daily_budget
    }),
    {
      headers: {
        "Content-Type": "application/json"
      }
    }
  );
});