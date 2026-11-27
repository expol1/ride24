// Minimal RFC 5322/2045 MIME reader and RFC 6376 DKIM verifier (rsa-sha256,
// relaxed|simple). Pure WebCrypto: runs in Deno edge functions and Node 20+.
// Used only to authenticate inbound supplier confirmations; it never trusts
// the From header alone.

const enc = new TextEncoder();
const MAX_RAW = 15 * 1024 * 1024;

export function toCrlf(raw) {
  return String(raw).replace(/\r?\n/g, "\r\n");
}
function splitHeadBody(raw) {
  const i = raw.indexOf("\r\n\r\n");
  return i < 0 ? [raw, ""] : [raw.slice(0, i + 2), raw.slice(i + 4)];
}
// Raw header fields in order, each with its exact original text (for DKIM).
export function headerFields(head) {
  const out = [];
  for (const line of head.split(/(?<=\r\n)/)) {
    if (!line) continue;
    if (/^[ \t]/.test(line) && out.length) out[out.length - 1].raw += line;
    else {
      const c = line.indexOf(":");
      if (c <= 0) continue;
      out.push({ name: line.slice(0, c).trim(), raw: line });
    }
  }
  for (const f of out) f.value = f.raw.slice(f.raw.indexOf(":") + 1).replace(/\r\n[ \t]+/g, " ").replace(/\r\n$/, "").trim();
  return out;
}
const hget = (fields, name) => fields.find((f) => f.name.toLowerCase() === name.toLowerCase())?.value ?? null;
const hall = (fields, name) => fields.filter((f) => f.name.toLowerCase() === name.toLowerCase()).map((f) => f.value);

function params(v) {
  const out = {};
  for (const m of String(v).matchAll(/;\s*([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]+))/g)) out[m[1].toLowerCase()] = m[2] ?? m[3];
  return out;
}
function b64bytes(s) {
  const clean = String(s).replace(/[^A-Za-z0-9+/=]/g, "");
  if (typeof atob === "function") return Uint8Array.from(atob(clean), (c) => c.charCodeAt(0));
  return new Uint8Array(Buffer.from(clean, "base64"));
}
function qpBytes(s) {
  const t = String(s).replace(/=\r\n/g, "");
  const out = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(t.slice(i + 1, i + 3))) { out.push(parseInt(t.slice(i + 1, i + 3), 16)); i += 2; }
    else out.push(t.charCodeAt(i) & 0xff);
  }
  return new Uint8Array(out);
}
function decodeWord(v) {
  // RFC 2047 encoded words in filenames/subjects (UTF-8 B/Q only).
  return String(v ?? "").replace(/=\?utf-8\?([bq])\?([^?]*)\?=/gi, (_, e, t) => {
    const bytes = e.toLowerCase() === "b" ? b64bytes(t) : qpBytes(t.replace(/_/g, " "));
    return new TextDecoder().decode(bytes);
  });
}

/** Parse a raw message into headers and leaf parts (bounded depth). */
export function parseMime(rawInput) {
  const raw = toCrlf(rawInput);
  if (raw.length > MAX_RAW) throw Error("MAIL_TOO_LARGE");
  const [head, body] = splitHeadBody(raw);
  const fields = headerFields(head);
  const parts = [];
  walk(fields, body, 0);
  return { raw, head, body, fields, parts,
    get: (n) => hget(fields, n), all: (n) => hall(fields, n) };
  function walk(f, b, depth) {
    if (depth > 6 || parts.length > 50) return;
    const ct = hget(f, "content-type") || "text/plain";
    const type = ct.split(";")[0].trim().toLowerCase();
    const p = params(ct);
    if (type.startsWith("multipart/") && p.boundary) {
      const delim = "--" + p.boundary;
      const chunks = b.split(delim).slice(1);
      for (const c of chunks) {
        if (c.startsWith("--")) break;
        const part = c.replace(/^\r\n/, "");
        const [h, pb] = splitHeadBody(part.startsWith("\r\n") ? part : part);
        walk(headerFields(h), pb.replace(/\r\n$/, ""), depth + 1);
      }
      return;
    }
    const cte = (hget(f, "content-transfer-encoding") || "7bit").toLowerCase();
    const bytes = cte === "base64" ? b64bytes(b) : cte === "quoted-printable" ? qpBytes(b) : enc.encode(b);
    const disp = hget(f, "content-disposition") || "";
    const filename = decodeWord(params(disp).filename ?? p.name ?? "") || null;
    parts.push({ type, filename, bytes });
  }
}

/** Delivery time stamped by the final receiving MTA (topmost Received). */
export function deliveredAtMs(msg) {
  const top = msg.all("received")[0];
  if (!top || top.lastIndexOf(";") < 0) return NaN;
  const ms = Date.parse(top.slice(top.lastIndexOf(";") + 1).trim().replace(/\s*\([^)]*\)\s*$/, ""));
  const date = Date.parse(msg.get("date") || "");
  // Never earlier than the sender's own Date header (minus clock skew).
  return Number.isFinite(ms) && Number.isFinite(date) && ms >= date - 10 * 60000 ? ms : NaN;
}

export function addressOf(v) {
  const m = /<([^<>@\s]+@[^<>\s]+)>/.exec(String(v ?? "")) || /([^\s<>"',;]+@[^\s<>"',;]+)/.exec(String(v ?? ""));
  return m ? m[1].toLowerCase() : null;
}
export const domainOf = (addr) => (String(addr ?? "").split("@")[1] || "").toLowerCase();

// ---- DKIM -------------------------------------------------------------
function tags(v) {
  const out = {};
  for (const kv of String(v).split(";")) {
    const i = kv.indexOf("=");
    if (i > 0) out[kv.slice(0, i).trim().toLowerCase()] = kv.slice(i + 1).replace(/\s+/g, "").trim();
  }
  return out;
}
function relaxedHeader(raw) {
  const i = raw.indexOf(":");
  const name = raw.slice(0, i).trim().toLowerCase();
  const value = raw.slice(i + 1).replace(/\r\n/g, "").replace(/[ \t]+/g, " ").trim();
  return name + ":" + value;
}
function canonBody(body, mode) {
  let b = body;
  if (mode === "relaxed") b = b.split("\r\n").map((l) => l.replace(/[ \t]+/g, " ").replace(/ +$/, "")).join("\r\n");
  b = b.replace(/(\r\n)*$/, "");
  return b.length ? b + "\r\n" : (mode === "simple" ? "\r\n" : "");
}
async function sha256b64(text) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
  return btoa(String.fromCharCode(...d));
}
export async function sha256hex(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(d, (x) => x.toString(16).padStart(2, "0")).join("");
}
function derFromKey(p) { return b64bytes(p); }

/**
 * Verify every DKIM-Signature; returns [{domain, selector, result, reason}].
 * resolveTxt(name) must return the TXT record strings for the key.
 */
export async function verifyDkim(msg, resolveTxt) {
  const results = [];
  const sigFields = msg.fields.filter((f) => f.name.toLowerCase() === "dkim-signature").slice(0, 5);
  for (const sig of sigFields) {
    const t = tags(sig.value);
    const out = { domain: (t.d || "").toLowerCase(), selector: t.s || "", result: "fail", reason: "" };
    results.push(out);
    try {
      if (t.v !== "1" || t.a !== "rsa-sha256" || !t.d || !t.s || !t.bh || !t.b || !t.h) { out.reason = "UNSUPPORTED_SIGNATURE"; continue; }
      if (t.x && Number(t.x) * 1000 < Date.now()) { out.reason = "SIGNATURE_EXPIRED"; continue; }
      if (t.l) { out.reason = "BODY_LENGTH_LIMIT_REJECTED"; continue; }
      const [hc, bc = "simple"] = (t.c || "simple/simple").toLowerCase().split("/");
      if (!/^(simple|relaxed)$/.test(hc) || !/^(simple|relaxed)$/.test(bc)) { out.reason = "CANON"; continue; }
      const bh = await sha256b64(canonBody(msg.body, bc));
      if (bh !== t.bh) { out.reason = "BODY_HASH"; continue; }
      // Headers are taken bottom-up per name, as RFC 6376 5.4.2 requires.
      const pool = {};
      for (const f of msg.fields) (pool[f.name.toLowerCase()] ||= []).push(f);
      const used = {};
      let data = "";
      for (const nameRaw of t.h.split(":")) {
        const name = nameRaw.trim().toLowerCase();
        const list = pool[name] || [];
        const n = (used[name] = (used[name] || 0) + 1);
        const f = list[list.length - n];
        if (!f) continue;
        data += hc === "relaxed" ? relaxedHeader(f.raw) + "\r\n" : f.raw;
      }
      const sigRaw = sig.raw.replace(/(\bb=)[^;]*/, (_m, p) => p);
      data += hc === "relaxed" ? relaxedHeader(sigRaw) : sigRaw.replace(/\r\n$/, "");
      const txt = (await resolveTxt(`${t.s}._domainkey.${t.d}`)).join("");
      const k = tags(txt);
      if (!k.p) { out.reason = "NO_KEY"; continue; }
      if (k.k && k.k !== "rsa") { out.reason = "KEY_TYPE"; continue; }
      const key = await crypto.subtle.importKey("spki", derFromKey(k.p), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64bytes(t.b), enc.encode(data));
      out.result = ok ? "pass" : "fail";
      out.reason = ok ? "" : "SIGNATURE";
      out.identity = t.i || null;
    } catch (e) {
      out.result = "temperror";
      out.reason = String(e?.message || e).slice(0, 80);
    }
  }
  return results;
}

/** Topmost Authentication-Results from a trusted receiving MTA only. */
export function trustedAuthResults(msg, trustedIds) {
  const first = msg.all("authentication-results")[0];
  if (!first) return null;
  const authserv = first.split(";")[0].trim().toLowerCase().split(/\s+/)[0];
  if (!trustedIds.some((re) => re.test(authserv))) return null;
  const grab = (method) => {
    const m = new RegExp("\\b" + method + "=([a-z]+)([^;]*)", "i").exec(first);
    return m ? { result: m[1].toLowerCase(), props: m[2] } : null;
  };
  const dkim = grab("dkim"), spf = grab("spf"), dmarc = grab("dmarc");
  const dkimDomain = dkim && (/header\.d=([^\s;]+)/i.exec(dkim.props)?.[1] || /header\.i=@?(?:[^@\s;]*@)?([^\s;]+)/i.exec(dkim.props)?.[1] || "").toLowerCase();
  const spfDomain = spf && ((/smtp\.mailfrom=([^\s;]+)/i.exec(spf.props)?.[1] || "").split("@").pop() || "").toLowerCase();
  return { authserv, dkim: dkim?.result ?? "none", dkim_domain: dkimDomain || null,
    spf: spf?.result ?? "none", spf_domain: spfDomain || null, dmarc: dmarc?.result ?? "none", raw: first.slice(0, 1000) };
}

/**
 * Sender authenticity: From must be @domain and either our own DKIM check
 * passes for d=domain (aligned), or — for messages fetched straight from our
 * own mailbox provider — that provider's topmost Authentication-Results says
 * dkim=pass for the same domain. SPF alone is NOT enough (the supplier's SPF
 * redirects to a shared consumer mail platform).
 */
export function senderVerdict({ msg, dkim, authResults, domain }) {
  const from = addressOf(msg.get("from"));
  const fromCount = msg.all("from").length;
  const reasons = [];
  if (fromCount !== 1 || !from) reasons.push("FROM_INVALID");
  else if (domainOf(from) !== domain) reasons.push("FROM_DOMAIN");
  const dkimAligned = dkim.some((d) => d.result === "pass" && d.domain === domain);
  const providerAligned = !!authResults && authResults.dkim === "pass" && authResults.dkim_domain === domain;
  if (!dkimAligned && !providerAligned) reasons.push("DKIM_NOT_ALIGNED_PASS");
  if (authResults && (authResults.dmarc === "fail")) reasons.push("DMARC_FAIL");
  return { ok: reasons.length === 0, from, dkim_verified: dkimAligned, provider_dkim_pass: providerAligned,
    spf: authResults?.spf ?? null, dmarc: authResults?.dmarc ?? null, reasons };
}
