import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const allowedOrigins = new Set([
  "https://ride24.pl",
  "https://www.ride24.pl",
]);

type JsonRecord = Record<string, unknown>;

function corsHeaders(origin: string | null): Record<string, string> {
  const allowedOrigin =
    origin && allowedOrigins.has(origin)
      ? origin
      : "https://ride24.pl";

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
    Vary: "Origin",
  };
}

function jsonResponse(
  body: JsonRecord,
  status: number,
  origin: string | null,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders(origin),
  });
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();

  if (!value) {
    throw new Error(`Brak wymaganego sekretu: ${name}`);
  }

  return value;
}

async function readJsonSafely(response: Response): Promise<unknown> {
  const text = await response.text();

  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 4000) };
  }
}

serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    return new Response("ok", {
      status: 200,
      headers: corsHeaders(origin),
    });
  }

  if (req.method !== "POST") {
    return jsonResponse(
      {
        success: false,
        stage: "request",
        error: "Dozwolona jest wyłącznie metoda POST.",
      },
      405,
      origin,
    );
  }

  try {
    const authHeader =
      req.headers.get("Authorization") ||
      req.headers.get("authorization");

    if (!authHeader?.startsWith("Bearer ")) {
      return jsonResponse(
        {
          success: false,
          stage: "authorization",
          error: "Brak sesji użytkownika.",
        },
        401,
        origin,
      );
    }

    const supabaseUrl = requiredEnv("SUPABASE_URL");
    const anonKey = requiredEnv("SUPABASE_ANON_KEY");
    const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");

    const userClient = createClient(
      supabaseUrl,
      anonKey,
      {
        global: {
          headers: {
            Authorization: authHeader,
          },
        },
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      },
    );

    const adminClient = createClient(
      supabaseUrl,
      serviceRoleKey,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      },
    );

    const {
      data: { user },
      error: userError,
    } = await userClient.auth.getUser();

    if (userError || !user) {
      return jsonResponse(
        {
          success: false,
          stage: "authorization",
          error: "Sesja wygasła albo jest nieprawidłowa.",
        },
        401,
        origin,
      );
    }

    const {
      data: profile,
      error: profileError,
    } = await adminClient
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();

    if (profileError) {
      return jsonResponse(
        {
          success: false,
          stage: "authorization",
          error: "Nie udało się sprawdzić roli administratora.",
        },
        500,
        origin,
      );
    }

    if (!profile || profile.role !== "admin") {
      return jsonResponse(
        {
          success: false,
          stage: "authorization",
          error: "Publikacja wymaga roli administratora.",
        },
        403,
        origin,
      );
    }

    let requestBody: JsonRecord;

    try {
      requestBody = await req.json() as JsonRecord;
    } catch {
      return jsonResponse(
        {
          success: false,
          stage: "request",
          error: "Treść żądania musi być prawidłowym JSON-em.",
        },
        400,
        origin,
      );
    }

    const postId = Number(requestBody.postId);

    if (!Number.isSafeInteger(postId) || postId <= 0) {
      return jsonResponse(
        {
          success: false,
          stage: "request",
          error: "Nieprawidłowy identyfikator posta.",
        },
        400,
        origin,
      );
    }

    const {
      data: post,
      error: postError,
    } = await adminClient
      .from("marketing_queue")
      .select("*")
      .eq("id", postId)
      .maybeSingle();

    if (postError) {
      return jsonResponse(
        {
          success: false,
          stage: "post_lookup",
          error: postError.message,
        },
        500,
        origin,
      );
    }

    if (!post) {
      return jsonResponse(
        {
          success: false,
          stage: "post_lookup",
          error: "Nie znaleziono posta.",
        },
        404,
        origin,
      );
    }

    // Facebook is the only supported social publication channel.
    // Older drafts with platform=all are still Facebook-compatible.
    if (!["facebook", "all"].includes(String(post.platform || ""))) {
      return jsonResponse(
        {
          success: false,
          stage: "platform_validation",
          error: "Post nie jest przeznaczony do publikacji na Facebooku.",
        },
        400,
        origin,
      );
    }

    if (post.status === "published" || post.facebook_post_id) {
      return jsonResponse(
        {
          success: true,
          stage: "already_published",
          alreadyPublished: true,
          facebookPostId: post.facebook_post_id || null,
        },
        200,
        origin,
      );
    }

    if (!post.image_url || !/^https:\/\//i.test(post.image_url)) {
      return jsonResponse(
        {
          success: false,
          stage: "post_validation",
          error: "Post nie ma prawidłowego publicznego adresu grafiki HTTPS.",
        },
        400,
        origin,
      );
    }

    if (!post.content || !String(post.content).trim()) {
      return jsonResponse(
        {
          success: false,
          stage: "post_validation",
          error: "Post nie ma treści do publikacji.",
        },
        400,
        origin,
      );
    }

    const {
      data: social,
      error: socialError,
    } = await adminClient
      .from("social_connections")
      .select("page_id, access_token")
      .eq("platform", "facebook")
      .maybeSingle();

    if (socialError) {
      return jsonResponse(
        {
          success: false,
          stage: "facebook_connection",
          error: socialError.message,
        },
        500,
        origin,
      );
    }

    if (!social?.page_id || !social?.access_token) {
      return jsonResponse(
        {
          success: false,
          stage: "facebook_connection",
          error: "Facebook nie jest połączony albo brakuje tokena strony.",
        },
        400,
        origin,
      );
    }

    const facebookBody = new URLSearchParams({
      url: String(post.image_url),
      caption: String(post.content),
      access_token: String(social.access_token),
    });

    const facebookResponse = await fetch(
      `https://graph.facebook.com/v23.0/${encodeURIComponent(String(social.page_id))}/photos`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        },
        body: facebookBody,
      },
    );

    const facebookData =
      await readJsonSafely(facebookResponse) as JsonRecord | null;

    const facebookPostId =
      typeof facebookData?.id === "string"
        ? facebookData.id
        : "";

    if (!facebookResponse.ok || !facebookPostId) {
      console.error("Facebook publish error:", facebookData);

      return jsonResponse(
        {
          success: false,
          stage: "facebook_publish",
          error:
            ((facebookData?.error as JsonRecord | undefined)?.message as string | undefined) ||
            `Facebook Graph API zwróciło HTTP ${facebookResponse.status}.`,
          facebookHttpStatus: facebookResponse.status,
          facebookError: facebookData,
        },
        502,
        origin,
      );
    }

    const publishedAt = new Date().toISOString();

    const {
      error: updateError,
    } = await adminClient
      .from("marketing_queue")
      .update({
        status: "published",
        published_facebook: true,
        facebook_post_id: facebookPostId,
        published_at: publishedAt,
      })
      .eq("id", postId);

    if (updateError) {
      return jsonResponse(
        {
          success: false,
          stage: "database_update",
          error:
            "Facebook opublikował post, ale zapis statusu w Supabase nie powiódł się: " +
            updateError.message,
          facebookPostId,
        },
        500,
        origin,
      );
    }

    return jsonResponse(
      {
        success: true,
        stage: "published",
        facebookPostId,
        publishedAt,
      },
      200,
      origin,
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Nieoczekiwany błąd publikacji.";

    console.error("publish-facebook error:", error);

    return jsonResponse(
      {
        success: false,
        stage: "server",
        error: message,
      },
      500,
      origin,
    );
  }
});
