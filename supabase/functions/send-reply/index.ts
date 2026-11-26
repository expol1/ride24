import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import nodemailer from "npm:nodemailer@6.9.16";
import {
  corsHeaders,
  enforceRateLimit,
  escapeHtml,
  isUuid,
  jsonResponse,
  publicErrorMessage,
  requireAdmin,
} from "../_shared/ride24-security.ts";

type RequestBody = {
  to?: unknown;
  message?: unknown;
  message_id?: unknown;
};

type ContactMessageRow = {
  id: string;
  email: string;
  name: string | null;
  previousReply: string | null;
};

const MAX_REQUEST_BYTES = 64_000;
const MAX_EMAIL_LENGTH = 254;
const MAX_MESSAGE_LENGTH = 8_000;
const MAX_NAME_LENGTH = 150;
const SMTP_TIMEOUT_MS = 15_000;
const RATE_LIMIT_REQUESTS = 10;
const RATE_LIMIT_WINDOW_SECONDS = 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanText(
  value: unknown,
  maxLength: number,
  fallback: string | null = null,
): string | null {
  if (value == null) return fallback;
  if (typeof value !== "string" && typeof value !== "number") return fallback;

  const text = String(value)
    .normalize("NFKC")
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .trim();

  if (!text) return fallback;
  if (text.length > maxLength) return null;
  return text;
}

function cleanSingleLine(
  value: unknown,
  maxLength: number,
  fallback: string | null = null,
): string | null {
  const text = cleanText(value, maxLength, fallback);
  if (!text) return fallback;

  return text
    .replace(/[\u0001-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength) || fallback;
}

function cleanEmail(value: unknown): string | null {
  const email = cleanSingleLine(value, MAX_EMAIL_LENGTH)?.toLowerCase() || null;

  if (
    !email
    || email.includes("\r")
    || email.includes("\n")
    || !/^[^\s@,;<>:"()\[\]\\]+@(?:[a-z0-9-]+\.)+[a-z0-9-]+$/i.test(email)
  ) {
    return null;
  }

  return email;
}

async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
  const contentType = (req.headers.get("content-type") || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();

  if (contentType !== "application/json") {
    throw new Error("Wymagane dane w formacie JSON");
  }

  const declaredLength = Number(req.headers.get("content-length") || "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new Error("Nieprawidłowy rozmiar danych wejściowych");
  }

  const reader = req.body?.getReader();
  if (!reader) throw new Error("Wymagane dane odpowiedzi");

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;

      totalBytes += value.length;
      if (totalBytes > MAX_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Nieprawidłowy rozmiar danych wejściowych");
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("Nieprawidłowy format JSON");
  }

  if (!isRecord(parsed)) throw new Error("Nieprawidłowe dane wejściowe");
  return parsed;
}

function normalizeContactMessage(value: unknown): ContactMessageRow | null {
  if (!isRecord(value) || !isUuid(value.id)) return null;

  const email = cleanEmail(value.email);
  if (!email) return null;

  return {
    id: value.id,
    email,
    name: cleanSingleLine(value.name, MAX_NAME_LENGTH),
    previousReply: value.replied_at ? cleanText(value.admin_reply, MAX_MESSAGE_LENGTH) : null,
  };
}

function messageHtml(
  recipientName: string | null,
  message: string,
): string {
  const greeting = recipientName
    ? `Dzień dobry ${escapeHtml(recipientName)},`
    : "Dzień dobry,";

  const safeParagraphs = message
    .split(/\n{2,}/)
    .map((paragraph) =>
      `<p style="font-size:16px;line-height:1.65;color:#334155;margin:0 0 16px">${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Odpowiedź od Ride24</title>
</head>
<body style="font-family:Arial,sans-serif;background:#F8FAFC;color:#0F172A;margin:0;padding:0">
  <div style="width:100%;padding:40px 0;background:#F8FAFC">
    <div style="max-width:620px;margin:0 auto;background:#ffffff;border-radius:20px;overflow:hidden;border:1px solid #E2E8F0;border-top:8px solid #73D700">
      <div style="padding:30px;text-align:center;background:#1E3A8A">
        <img src="https://ride24.pl/assets/bez.png" width="160" alt="Ride24">
      </div>
      <div style="padding:38px 34px">
        <p style="font-size:16px;line-height:1.65;color:#334155;margin:0 0 20px">${greeting}</p>
        ${safeParagraphs}
        <p style="font-size:16px;line-height:1.65;color:#334155;margin:24px 0 0">Pozdrawiamy,<br><strong>Zespół Ride24</strong></p>
      </div>
      <div style="padding:22px;text-align:center;font-size:13px;color:#94A3B8;background:#0F172A">
        &copy; 2026 Ride24.pl
      </div>
    </div>
  </div>
</body>
</html>`;
}

function smtpConfiguration(): {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  fromName: string;
} {
  const user = cleanEmail(Deno.env.get("ZOHO_SMTP_USER"));
  const password = Deno.env.get("ZOHO_SMTP_APP_PASSWORD")?.trim();
  const host = Deno.env.get("ZOHO_SMTP_HOST")?.trim() || "smtp.zoho.eu";
  const port = Number(Deno.env.get("ZOHO_SMTP_PORT") || "465");
  const fromName = cleanSingleLine(
    Deno.env.get("ZOHO_FROM_NAME"),
    100,
    "Ride24",
  ) || "Ride24";

  if (
    !user
    || !password
    || password.length < 8
    || password.length > 500
    || /[\u0000\r\n]/.test(password)
    || !/^[A-Za-z0-9.-]+$/.test(host)
    || !Number.isInteger(port)
    || port < 1
    || port > 65535
  ) {
    throw new Error("EMAIL_CONFIGURATION_MISSING");
  }

  return {
    host,
    port,
    secure: port === 465,
    user,
    password,
    fromName,
  };
}

async function loadContactMessage(
  admin: Awaited<ReturnType<typeof requireAdmin>>["admin"],
  email: string,
  messageId: string | null,
): Promise<ContactMessageRow | null> {
  let query = admin
    .from("contact_messages")
    .select("id, email, name, admin_reply, replied_at");

  if (messageId) {
    query = query.eq("id", messageId);
  } else {
    query = query.eq("email", email).order("created_at", { ascending: false }).limit(1);
  }

  const { data, error } = await query.maybeSingle();
  if (error) throw new Error("CONTACT_MESSAGE_LOOKUP_FAILED");

  return normalizeContactMessage(data);
}

async function fingerprint(contact: ContactMessageRow, message: string) {
  const messageFingerprint = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${contact.id}\n${contact.email}\n${message}`),
  );
  return Array.from(new Uint8Array(messageFingerprint))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sendReplyEmail(
  contact: ContactMessageRow,
  message: string,
  messageIdToken: string,
): Promise<string> {
  const smtp = smtpConfiguration();
  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: {
      user: smtp.user,
      pass: smtp.password,
    },
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
    pool: false,
    tls: {
      minVersion: "TLSv1.2",
      rejectUnauthorized: true,
    },
  });

  try {
    const result = await transporter.sendMail({
      from: {
        name: smtp.fromName,
        address: smtp.user,
      },
      to: { name: "", address: contact.email },
      replyTo: smtp.user,
      subject: "Odpowiedź od Ride24",
      text: message,
      html: messageHtml(contact.name, message),
      messageId: `<ride24-reply-${messageIdToken}@ride24.pl>`,
      headers: {
        "X-Ride24-Contact-Message": contact.id,
        "X-Auto-Response-Suppress": "All",
      },
    });

    return cleanSingleLine(result.messageId, 500)
      || `<ride24-reply-${messageIdToken}@ride24.pl>`;
  } finally {
    transporter.close();
  }
}

async function saveReplyBestEffort(
  admin: Awaited<ReturnType<typeof requireAdmin>>["admin"],
  contact: ContactMessageRow,
  message: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from("contact_messages")
    .update({
      admin_reply: message,
      replied_at: new Date().toISOString(),
      status: "replied",
    })
    .eq("id", contact.id)
    .select("id")
    .maybeSingle();

  if (error || !data) {
    console.error("send-reply contact message update failed");
    return false;
  }

  return true;
}

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
    const { admin } = await requireAdmin(req);

    await enforceRateLimit(
      admin,
      req,
      "send-reply",
      RATE_LIMIT_REQUESTS,
      RATE_LIMIT_WINDOW_SECONDS,
    );

    const body = await readJsonObject(req) as RequestBody;
    const recipient = cleanEmail(body.to);
    const message = cleanText(body.message, MAX_MESSAGE_LENGTH);
    const messageId = body.message_id == null || body.message_id === ""
      ? null
      : isUuid(body.message_id)
      ? body.message_id
      : null;

    if (!recipient) {
      return jsonResponse(req, { error: "Nieprawidłowy adres odbiorcy" }, 400);
    }
    if (!message) {
      return jsonResponse(
        req,
        { error: "Treść wiadomości jest pusta albo zbyt długa" },
        400,
      );
    }
    if (
      body.message_id != null
      && body.message_id !== ""
      && messageId === null
    ) {
      return jsonResponse(req, { error: "Nieprawidłowy message_id" }, 400);
    }

    const contact = await loadContactMessage(
      admin,
      recipient,
      messageId,
    );

    if (!contact || contact.email !== recipient) {
      return jsonResponse(
        req,
        {
          error:
            "Adres nie jest powiązany z wiadomością otrzymaną przez Ride24",
        },
        404,
      );
    }

    if (contact.previousReply === message) {
      return jsonResponse(req, { success: true, already_sent: true });
    }

    const key = await fingerprint(contact, message);
    const delivery = { contact_id: contact.id, fingerprint: key };
    const deliveries = admin.from("contact_reply_deliveries");
    // Commit the claim before contacting SMTP. An interrupted DATA exchange
    // may have been accepted, so its claim must survive a client retry.
    smtpConfiguration();
    const { error: claimError } = await deliveries.insert(delivery);
    if (claimError?.code === "23505") {
      const { data, error } = await deliveries.select("state").match(delivery).maybeSingle();
      if (error) throw new Error("DELIVERY_LOOKUP_FAILED");
      if (data?.state === "sent") {
        return jsonResponse(req, { success: true, already_sent: true });
      }
      return jsonResponse(req, { error: "Wysyłka w toku lub bez potwierdzenia. Sprawdź stan poprzedniej próby." }, 409);
    }
    if (claimError) throw new Error("DELIVERY_CLAIM_FAILED");

    let smtpMessageId: string;
    try {
      smtpMessageId = await sendReplyEmail(contact, message, key);
    } catch (error) {
      const failure = isRecord(error) ? error : {};
      const code = String(failure.code || "UNKNOWN");
      const command = String(failure.command || "UNKNOWN");
      const status = Number(failure.responseCode) || 0;
      const rejected = (status >= 400 && status < 600) || ["EAUTH", "EDNS", "EENVELOPE"].includes(code)
        || (command === "CONN" && ["ECONNREFUSED", "ENOTFOUND", "EDNS"].includes(code))
        || ["EHLO", "HELO", "STARTTLS", "MAIL FROM", "RCPT TO"].includes(command);
      console.error("send-reply SMTP", {
        id: contact.id,
        code: /^[A-Z0-9_]{1,30}$/.test(code) ? code : "UNKNOWN",
        command: /^[A-Z ]{1,16}$/.test(command) ? command : "UNKNOWN",
        status,
      });
      if (rejected) {
        const { error: releaseError } = await deliveries.delete().match(delivery).eq("state", "pending");
        if (releaseError) throw new Error("DELIVERY_RELEASE_FAILED");
      }
      return jsonResponse(req, { error: rejected
        ? "Serwer poczty odrzucił próbę wysyłki. Treść odpowiedzi została zachowana."
        : "Brak potwierdzenia z serwera poczty. Przed ponowieniem sprawdź poprzednią wysyłkę." }, 502);
    }
    const { error: sentError } = await deliveries.update({ state: "sent" }).match(delivery);
    if (sentError) console.error("send-reply delivery receipt save failed", contact.id);
    const saved = await saveReplyBestEffort(admin, contact, message);

    return jsonResponse(req, {
      success: true,
      contact_message_id: contact.id,
      saved_in_database: saved,
      message_id: smtpMessageId,
    });
  } catch (error) {
    console.error(
      "send-reply",
      error instanceof Error
        ? error.message === "AUTH_REQUIRED"
          ? "AUTH_REQUIRED"
          : error.message === "ADMIN_REQUIRED"
          ? "ADMIN_REQUIRED"
          : error.message === "RATE_LIMITED"
          ? "RATE_LIMITED"
          : error.message === "EMAIL_CONFIGURATION_MISSING"
          ? "EMAIL_CONFIGURATION_MISSING"
          : /^(CONTACT_MESSAGE_LOOKUP_FAILED|DELIVERY_[A-Z_]+)$/.test(error.message) ? error.message : "REQUEST_FAILED"
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
