import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

serve(async () => {

  return new Response(
    JSON.stringify({
      success: true
    }),
    {
      headers: {
        "Content-Type":
          "application/json"
      }
    }
  );

});