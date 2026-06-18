import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ProviderManager } from "./providerManager.ts";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*", // później zmienimy na https://ride24.pl
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json"
};

serve(async (req) => {

    if (req.method === "OPTIONS") {
        return new Response("ok", {
            headers: corsHeaders
        });
    }

    try {

        const supabase = createClient(
            Deno.env.get("SUPABASE_URL")!,
            Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
        );

        const body = await req.json();

        const {
            pickupCountry,
            pickupRegion,
            pickupLocation,
            pickupDate,
            returnDate
        } = body;

        const { data, error } = await supabase

            .from("partner_locations")

            .select(`
                *,
                partners!inner(
                    id,
                    company_name,
                    provider_type,
                    api_provider,
                    api_enabled,
                    api_settings,
                    discount_percent,
                    active
                )
            `)

            .eq("country", pickupCountry)
            .eq("region", pickupRegion)
            .eq("location_name", pickupLocation)
            .eq("active", true)
            .eq("partners.active", true);

        if (error) {
            throw error;
        }

        const cars = [];

        if (data) {

            for (const location of data) {

                const result = await ProviderManager.search(

                    {
                        provider: location.partners.provider_type,
                        settings: location.partners.api_settings
                    },

                    {
                        pickupLocation,
                        dropoffLocation: pickupLocation,
                        pickupDate,
                        returnDate
                    }

                );

                if (result.success) {
                    cars.push(...result.cars);
                }

            }

        }

        return new Response(

            JSON.stringify({

                success: true,

                partners: data,

                cars,

                count: cars.length

            }),

            {
                headers: corsHeaders
            }

        );

    } catch (err: any) {

        console.error(err);

        return new Response(

            JSON.stringify({

                success: false,

                error: err.message

            }),

            {
                status: 400,
                headers: corsHeaders
            }

        );

    }

});