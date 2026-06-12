
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

if (post.status === "published") {
  throw new Error(
    "Post already published"
  );
}

if (post.facebook_post_id) {
  throw new Error(
    "Post already published"
  );
}
    const { data: social } = await supabase
      .from("social_connections")
      .select("*")
      .eq("platform", "facebook")
      .single();

    if (!social) {
      throw new Error("Facebook not connected");
    }

    const fbResponse = await fetch(
      `https://graph.facebook.com/v23.0/${social.page_id}/photos`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          url: post.image_url,
          caption: post.content,
          access_token: social.access_token
        })
      }
    );

    const fbData = await fbResponse.json();

    if (!fbData.id) {
      throw new Error(JSON.stringify(fbData));
    }

    await supabase
      .from("marketing_queue")
      .update({
        status: "published",
        published_facebook: true,
        facebook_post_id: fbData.id,
        published_at: new Date().toISOString()
      })
      .eq("id", postId);

    return new Response(
      JSON.stringify({
        success: true,
        facebook_post_id: fbData.id
      }),
      {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
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
          "Content-Type": "application/json"
        }
      }
    );

  }

});
