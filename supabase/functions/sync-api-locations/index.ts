import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import {
  corsHeaders,
  jsonResponse,
  publicErrorMessage,
  requireAdmin,
} from "../_shared/ride24-security.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(req) });
  }

  if (req.method !== "POST") {
    return jsonResponse(
      req,
      { error: "METHOD_NOT_ALLOWED" },
      405,
      { Allow: "POST, OPTIONS" },
    );
  }

  try {
    await requireAdmin(req);

    return jsonResponse(
      req,
      {
        success: false,
        error: "ENDPOINT_MOVED",
        message: "Użyj api-partner-admin z action=sync",
      },
      410,
      {
        Deprecation: "true",
        "X-Ride24-Replacement": "api-partner-admin?action=sync",
      },
    );
  } catch (error) {
    console.error(
      "sync-api-locations",
      error instanceof Error
        ? error.message === "AUTH_REQUIRED"
          ? "AUTH_REQUIRED"
          : error.message === "ADMIN_REQUIRED"
          ? "ADMIN_REQUIRED"
          : "REQUEST_FAILED"
        : "UNKNOWN_ERROR",
    );

    const publicError = publicErrorMessage(error);
    return jsonResponse(
      req,
      { error: publicError.message },
      publicError.status,
    );
  }
});
