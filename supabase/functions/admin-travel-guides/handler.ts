export const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_HTML_BYTES * 6 + 8192;
const REPO = "expol1/ride24";
const BRANCH = "main";
const API = `https://api.github.com/repos/${REPO}`;
const ALLOWED_ORIGINS = new Set([
  "https://ride24.pl", "https://www.ride24.pl",
  "http://localhost:8080", "http://127.0.0.1:8080",
  "http://localhost:5500", "http://127.0.0.1:5500",
]);

export type Guide = { id: string; title: string; slug: string; folder_name: string; active: boolean };
export type GuideStore = {
  getToken(): Promise<string | null>;
  setToken(token: string): Promise<void>;
  findGuides(slug: string): Promise<Guide[]>;
  insertGuide(title: string, slug: string): Promise<Guide>;
};
type Dependencies = {
  authorize(req: Request): Promise<GuideStore>;
  fetch: typeof fetch;
};
class PublicError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

function headers(req: Request) {
  const origin = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : "https://ride24.pl",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin", "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  };
}

async function body(req: Request): Promise<Record<string, unknown>> {
  if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new PublicError("Wymagany jest formularz przesyłania HTML.", 415);
  }
  if (!req.body) throw new PublicError("Brak danych formularza.");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new PublicError("Plik jest zbyt duży. Maksymalny rozmiar HTML to 2 MB.", 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error();
    return value;
  } catch { throw new PublicError("Nieprawidłowe dane formularza."); }
}

export function validateGuide(input: Record<string, unknown>) {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const slug = typeof input.slug === "string" ? input.slug.trim() : "";
  const fileName = typeof input.file_name === "string" ? input.file_name : "";
  const html = typeof input.html === "string" ? input.html : "";
  if (!title || title.length > 120 || /[\u0000-\u001f]/.test(title)) {
    throw new PublicError("Podaj nazwę przewodnika (maksymalnie 120 znaków).");
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 80) {
    throw new PublicError("Nazwa pliku może zawierać małe litery, cyfry i myślniki, np. varna.");
  }
  if (!/^[^/\\\u0000]+\.html?$/i.test(fileName)) {
    throw new PublicError("Wybierz plik z rozszerzeniem .html lub .htm.");
  }
  const bytes = new TextEncoder().encode(html);
  if (!bytes.length || bytes.length > MAX_HTML_BYTES) {
    throw new PublicError("Plik HTML jest pusty lub przekracza 2 MB.", 413);
  }
  if (html.includes("\u0000") || !/<html(?:\s|>)/i.test(html) ||
      !/<body(?:\s|>)/i.test(html) || !/<\/html\s*>/i.test(html)) {
    throw new PublicError("Plik musi być kompletnym dokumentem HTML zapisanym w UTF-8.");
  }
  return { title, slug, html, bytes, path: `travel-guides/${slug}.html` };
}

async function gitBlobSha(bytes: Uint8Array) {
  const prefix = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const blob = new Uint8Array(prefix.length + bytes.length);
  blob.set(prefix); blob.set(bytes, prefix.length);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-1", blob)))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}
function base64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}
function githubFailure(response: Response) {
  if (response.status === 401 || response.status === 403) {
    return new PublicError("GitHub odrzucił dostęp. Sprawdź ważność tokena i uprawnienie Contents: Read and write dla ride24.", 502);
  }
  if (response.status === 429) return new PublicError("GitHub ograniczył liczbę żądań. Spróbuj ponownie za chwilę.", 429);
  return new PublicError("Nie udało się zapisać pliku w GitHub. Spróbuj ponownie.", 502);
}

export function createGuideHandler(deps: Dependencies) {
  return async (req: Request): Promise<Response> => {
    const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: headers(req) });
    const origin = req.headers.get("origin");
    if (origin && !ALLOWED_ORIGINS.has(origin)) return reply({ error: "Niedozwolona strona wysyłająca." }, 403);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: headers(req) });
    if (req.method !== "POST") return reply({ error: "Dozwolone jest tylko przesyłanie formularza." }, 405);
    try {
      // Validate the user with Supabase Auth and the immutable database admin role
      // BEFORE accessing any secret or making any request to GitHub.
      const store = await deps.authorize(req);
      const input = await body(req);
      const action = input.action ?? "upload";
      const github = (token: string, url: string, init: RequestInit = {}, accept = "application/vnd.github+json") => deps.fetch(url, {
        ...init, redirect: "error", signal: AbortSignal.timeout(20000),
        headers: {
          "Accept": accept,
          "Authorization": `Bearer ${token}`,
          "X-GitHub-Api-Version": "2026-03-10",
          "Content-Type": "application/json",
        },
      });
      if (action === "status") return reply({ configured: !!(await store.getToken()), repository: REPO });
      if (action === "configure") {
        const token = typeof input.token === "string" ? input.token.trim() : "";
        if (!/^github_pat_[A-Za-z0-9_]{20,}$/.test(token) || token.length > 4096) {
          throw new PublicError("Wklej token fine-grained GitHub przeznaczony dla repozytorium ride24.");
        }
        const response = await github(token, API);
        if (!response.ok) throw githubFailure(response);
        const repo = await response.json();
        if (repo.full_name !== REPO || repo.permissions?.push === false) {
          throw new PublicError("Token nie daje dostępu do repozytorium expol1/ride24.");
        }
        await store.setToken(token);
        return reply({ configured: true });
      }
      if (action !== "upload") throw new PublicError("Nieznana akcja.");
      const guide = validateGuide(input);
      const existingGuides = await store.findGuides(guide.slug);
      const token = await store.getToken();
      if (!token) throw new PublicError("Najpierw połącz wysyłanie z GitHub w sekcji Autoprzewodniki.", 503);
      const url = `${API}/contents/${guide.path}`;
      const expectedSha = await gitBlobSha(guide.bytes);
      const readFile = async () => {
        const response = await github(token, `${url}?ref=${BRANCH}`, {}, "application/vnd.github.object+json");
        if (response.status === 404) return null;
        if (!response.ok) throw githubFailure(response);
        const value = await response.json();
        if (value.type !== "file" || typeof value.sha !== "string") {
          throw new PublicError("Ta nazwa jest już zajęta w GitHub. Wybierz inną nazwę pliku.", 409);
        }
        return value;
      };
      let file = await readFile();
      if (file && file.sha !== expectedSha) {
        throw new PublicError("Plik o tej nazwie już istnieje. Wybierz inną nazwę; obecny przewodnik nie został nadpisany.", 409);
      }
      if (existingGuides.length) {
        const existing = existingGuides[0];
        if (existingGuides.length === 1 && file && existing.title === guide.title &&
            existing.slug === guide.slug && existing.folder_name === guide.slug && existing.active) {
          return reply({ success: true, already_saved: true, guide: existing, path: `/${guide.path}`, commit: null });
        }
        throw new PublicError("Przewodnik o tej nazwie pliku już istnieje. Wybierz inną nazwę.", 409);
      }
      let commit: string | null = null;
      if (!file) {
        const response = await github(token, url, {
          method: "PUT",
          // Intentionally no SHA: this endpoint never overwrites an existing file.
          body: JSON.stringify({ message: `Add travel guide ${guide.slug} via admin panel`, branch: BRANCH, content: base64(guide.bytes) }),
        });
        if (!response.ok) {
          if (response.status === 409 || response.status === 422) {
            file = await readFile();
            if (!file || file.sha !== expectedSha) {
              throw new PublicError("Nazwa pliku została już zajęta. Wybierz inną nazwę.", 409);
            }
          } else throw githubFailure(response);
        } else {
          const saved = await response.json();
          commit = typeof saved.commit?.sha === "string" ? saved.commit.sha : null;
        }
      }
      let saved: Guide;
      try { saved = await store.insertGuide(guide.title, guide.slug); }
      catch {
        // Handle duplicate/retried requests without deleting or replacing files.
        const retry = await store.findGuides(guide.slug);
        if (retry.length !== 1 || retry[0].title !== guide.title || retry[0].slug !== guide.slug ||
            retry[0].folder_name !== guide.slug || !retry[0].active) {
          throw new PublicError("Plik jest zapisany w GitHub, ale wpis nie został dodany do bazy. Wyślij ten sam plik ponownie, aby dokończyć zapis.", 502);
        }
        saved = retry[0];
      }
      return reply({ success: true, guide: saved, path: `/${guide.path}`, commit });
    } catch (error) {
      if (error instanceof PublicError) return reply({ error: error.message }, error.status);
      const message = error instanceof Error ? error.message : "";
      if (message === "AUTH_REQUIRED") return reply({ error: "Zaloguj się ponownie." }, 401);
      if (message === "ADMIN_REQUIRED") return reply({ error: "Brak uprawnień administratora." }, 403);
      // Never send token values, upstream bodies, stack traces or SDK errors.
      return reply({ error: "Nie udało się zakończyć operacji. Spróbuj ponownie; istniejące pliki nie są nadpisywane." }, 500);
    }
  };
}
