import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

serve(async () => {

    return new Response(

        JSON.stringify({

            success: true,

            message: "Ride24 Search API Ready"

        }),

        {

            headers: {

                "Content-Type": "application/json"

            }

        }

    );

});