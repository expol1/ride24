import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://ride24.pl",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods":
    "GET, POST, OPTIONS"
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

    const { postId } = await req.json();

    const { data: post } = await supabase
      .from("marketing_queue")
      .select("*")
      .eq("id", postId)
      .single();

    if (!post) {
      throw new Error("Post not found");
    }

    const { data: social } = await supabase
      .from("social_connections")
      .select("*")
      .eq("platform", "x")
      .single();

    if (!social) {
      throw new Error("X not connected");
    }

    const response = await fetch(
      "https://api.twitter.com/2/tweets",
      {
        method: "POST",
        headers: {
          "Authorization":
            `Bearer ${social.access_token}`,
          "Content-Type":
            "application/json"
        },
        body: JSON.stringify({
          text: post.content
        })
      }
    );

    const result = await response.json();

    console.log(result);

    if (!result?.data?.id) {
      throw new Error(
        JSON.stringify(result)
      );
    }

    await supabase
      .from("marketing_queue")
      .update({
        published_x: true,
        x_post_id: result.data.id
      })
      .eq("id", postId);

    return new Response(
      JSON.stringify({
        success: true,
        x_post_id: result.data.id
      }),
      {
        headers: {
          ...corsHeaders,
          "Content-Type":
            "application/json"
        }
      }
    );

  } catch (err) {

    return new Response(
      JSON.stringify({
        success: false,
        error: String(err)
      }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type":
            "application/json"
        }
      }
    );

  }

});