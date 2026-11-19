/**
 * Caravel terms document canonical SHA-256 (Channel API v1.67.0, §3.9).
 *
 * Source (verbatim rule, TermsDocument.content_hash in the partner pack and
 * /v1/openapi.json, read 18 Nov 2026):
 *   "serialise `body` as JSON with every object's keys sorted at every level
 *    (arrays keep their order), no insignificant whitespace, escaped as
 *    JavaScript's JSON.stringify escapes, encoded UTF-8, and hash those bytes.
 *    This is not RFC 8785 (JCS): the two agree for documents whose leaves are
 *    all strings, as every clauses/v1 document's are, and nothing more is
 *    promised."
 *
 * Therefore this module:
 *  - accepts ONLY format "clauses/v1" (unknown formats are not rendered/sold);
 *  - validates the body against the published schema (TermsDocumentDetail.body,
 *    TermsClause, TermsTextRun) and requires every leaf to be a string — any
 *    number/boolean/null leaf is outside what Caravel promises and fails closed;
 *  - sorts object keys by UTF-16 code units (Array.prototype.sort default,
 *    identical to JCS for the ASCII keys this format has);
 *  - escapes strings with JSON.stringify and hashes the UTF-8 bytes.
 *
 * Pure: no network, no DB, no secrets.
 */
type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

const RUN_KEYS = new Set(["text", "mark"]);
const CLAUSE_KEYS = new Set(["number", "heading", "paragraphs", "clauses"]);
const BODY_KEYS = new Set(["title", "language", "clauses"]);
const MAX_DEPTH = 12;
const MAX_NODES = 20000;

function assertRun(run: unknown, ctx: {nodes: number}): void {
  if (!isObj(run) || typeof run.text !== "string") throw new Error("CARAVEL_TERMS_BODY_RUN_INVALID");
  for (const k of Object.keys(run)) if (!RUN_KEYS.has(k)) throw new Error("CARAVEL_TERMS_BODY_UNKNOWN_MEMBER");
  if (run.mark !== undefined && run.mark !== "strong" && run.mark !== "em")
    throw new Error("CARAVEL_TERMS_BODY_MARK_INVALID");
  if (++ctx.nodes > MAX_NODES) throw new Error("CARAVEL_TERMS_BODY_TOO_LARGE");
}

function assertClause(clause: unknown, depth: number, ctx: {nodes: number}): void {
  if (depth > MAX_DEPTH) throw new Error("CARAVEL_TERMS_BODY_TOO_DEEP");
  if (!isObj(clause) || typeof clause.number !== "string" || !clause.number ||
      !Array.isArray(clause.paragraphs))
    throw new Error("CARAVEL_TERMS_BODY_CLAUSE_INVALID");
  for (const k of Object.keys(clause)) if (!CLAUSE_KEYS.has(k)) throw new Error("CARAVEL_TERMS_BODY_UNKNOWN_MEMBER");
  if (clause.heading !== undefined && typeof clause.heading !== "string")
    throw new Error("CARAVEL_TERMS_BODY_CLAUSE_INVALID");
  for (const p of clause.paragraphs) {
    if (!Array.isArray(p)) throw new Error("CARAVEL_TERMS_BODY_PARAGRAPH_INVALID");
    for (const run of p) assertRun(run, ctx);
  }
  if (clause.clauses !== undefined) {
    if (!Array.isArray(clause.clauses)) throw new Error("CARAVEL_TERMS_BODY_CLAUSE_INVALID");
    for (const c of clause.clauses) assertClause(c, depth + 1, ctx);
  }
  if (++ctx.nodes > MAX_NODES) throw new Error("CARAVEL_TERMS_BODY_TOO_LARGE");
}

/** Validate a clauses/v1 body exactly against the published schema. */
export function assertCaravelClausesV1Body(body: unknown): asserts body is {
  title: string; language: string; clauses: unknown[];
} {
  if (!isObj(body) || typeof body.title !== "string" || !body.title ||
      typeof body.language !== "string" || !/^[a-z]{2,3}$/.test(body.language) ||
      !Array.isArray(body.clauses) || body.clauses.length === 0)
    throw new Error("CARAVEL_TERMS_BODY_INVALID");
  for (const k of Object.keys(body)) if (!BODY_KEYS.has(k)) throw new Error("CARAVEL_TERMS_BODY_UNKNOWN_MEMBER");
  const ctx = {nodes: 0};
  for (const c of body.clauses) assertClause(c, 1, ctx);
}

/** Caravel canonical serialisation: sorted keys, arrays in order, compact, JSON.stringify escaping. */
export function canonicalCaravelJson(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalCaravelJson).join(",") + "]";
  if (isObj(value)) {
    const keys = Object.keys(value).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalCaravelJson(value[k])).join(",") + "}";
  }
  // clauses/v1 promises string leaves only; anything else is unverifiable.
  throw new Error("CARAVEL_TERMS_CANONICAL_NON_STRING_LEAF");
}

export async function computeCaravelTermsContentHash(body: unknown): Promise<string> {
  assertCaravelClausesV1Body(body);
  const bytes = new TextEncoder().encode(canonicalCaravelJson(body));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type CaravelTermsHashVerification = {
  verified: true; contentHash: string; documentId: string; language: string; version: number;
};

/**
 * Independently recompute content_hash from the fetched body and compare it
 * with the provider-declared value. Also enforces body.title/language equal
 * the record's (Caravel's own publication guard). Throws on any mismatch.
 */
export async function verifyCaravelTermsDocumentHash(doc: unknown): Promise<CaravelTermsHashVerification> {
  if (!isObj(doc) || doc.format !== "clauses/v1") throw new Error("CARAVEL_TERMS_FORMAT_UNSUPPORTED");
  const declared = typeof doc.content_hash === "string" ? doc.content_hash : "";
  if (!/^[0-9a-f]{64}$/.test(declared)) throw new Error("CARAVEL_TERMS_DECLARED_HASH_INVALID");
  if (typeof doc.document_id !== "string" || !doc.document_id) throw new Error("CARAVEL_TERMS_DOCUMENT_INVALID");
  const body = doc.body;
  assertCaravelClausesV1Body(body);
  if (body.title !== doc.title || body.language !== doc.language)
    throw new Error("CARAVEL_TERMS_BODY_RECORD_MISMATCH");
  const actual = await computeCaravelTermsContentHash(body);
  if (actual !== declared) throw new Error("CARAVEL_TERMS_CONTENT_HASH_MISMATCH");
  return {verified: true, contentHash: actual, documentId: doc.document_id,
    language: doc.language as string, version: Number(doc.version)};
}

/** Escape text for HTML templates (runs are literal text, never markup). */
export function escapeCaravelTermsText(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c] as string));
}

/**
 * Render a verified clauses/v1 body to safe HTML for the pre-Stripe consent
 * screen and the voucher annex. Clause numbers are rendered as given
 * (frozen supplier text); marks map only to <strong>/<em>.
 */
export function renderCaravelTermsHtml(body: unknown): string {
  assertCaravelClausesV1Body(body);
  const run = (r: Json) => {
    const t = escapeCaravelTermsText(r.text as string);
    return r.mark === "strong" ? `<strong>${t}</strong>` : r.mark === "em" ? `<em>${t}</em>` : t;
  };
  const clause = (c: Json, depth: number): string => {
    const head = `<span class="cv-num">${escapeCaravelTermsText(c.number as string)}</span>` +
      (typeof c.heading === "string" ? ` <span class="cv-head">${escapeCaravelTermsText(c.heading)}</span>` : "");
    const paras = (c.paragraphs as Json[][]).map((p) => `<p>${p.map(run).join("")}</p>`).join("");
    const subs = Array.isArray(c.clauses) ? (c.clauses as Json[]).map((s) => clause(s, depth + 1)).join("") : "";
    return `<section class="cv-clause cv-d${Math.min(depth, 4)}"><h${Math.min(depth + 2, 6)}>${head}</h${Math.min(depth + 2, 6)}>${paras}${subs}</section>`;
  };
  return `<article class="cv-terms" lang="${escapeCaravelTermsText(body.language)}"><h2>${escapeCaravelTermsText(body.title)}</h2>${
    (body.clauses as Json[]).map((c) => clause(c, 1)).join("")}</article>`;
}

/** Plain-text rendering (emails/PDF), clause numbers preserved. */
export function renderCaravelTermsText(body: unknown): string {
  assertCaravelClausesV1Body(body);
  const out: string[] = [body.title, ""];
  const walk = (c: Json, depth: number) => {
    const pad = "  ".repeat(depth - 1);
    out.push(`${pad}${c.number}${typeof c.heading === "string" ? " " + c.heading : ""}`);
    for (const p of c.paragraphs as Json[][]) out.push(pad + p.map((r) => r.text as string).join(""));
    if (Array.isArray(c.clauses)) for (const s of c.clauses as Json[]) walk(s, depth + 1);
  };
  for (const c of body.clauses as Json[]) walk(c, 1);
  return out.join("\n");
}
