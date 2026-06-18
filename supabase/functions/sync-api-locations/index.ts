import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {

    const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const { partner_id } = await req.json();

const { data: partner, error } = await supabase
    .from("partners")
    .select("*")
    .eq("id", partner_id)
    .single();

if (error) {

    return new Response(

        JSON.stringify({

            success: false,

            message: error.message

        }),

        {

            status: 400,

            headers: {

                "Content-Type": "application/json"

            }

        }

    );

}

    return new Response(

        JSON.stringify({

            success: true,
            message: "sync-api-locations ready"

        }),

        {
            headers: {
                "Content-Type": "application/json"
            }
        }

    );

});