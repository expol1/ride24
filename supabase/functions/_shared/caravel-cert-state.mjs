/**
 * Isolated Caravel SANDBOX certification reference snapshots.
 * This is a storage adapter, NOT a production integration.
 * Requires a pre-created private Supabase Storage bucket with no user policies.
 * serviceClient() may be supplied ONLY after requireAdmin() succeeds.
 * No API keys, customer details, bookings or payments may be stored here.
 */
export const CARAVEL_CERT_BUCKET = "caravel-sandbox-cert-state";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUPPLIER = /^[a-zA-Z0-9_-]{1,128}$/;
const KINDS = ["locations", "vehicles", "protections", "extras"];
const MAX_BYTES = 1024 * 1024; // 1 MiB max, upper bound for sandbox reference-only fixtures

function pathOf(sessionId, supplierId) {
  if (!UUID.test(sessionId) || !SUPPLIER.test(supplierId)) throw new Error("CERT_STATE_BAD_SCOPE");
  return `${sessionId}/${supplierId}.json`;
}
export function validateCaravelCertSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CERT_STATE_BAD_SNAPSHOT");
  if (Object.keys(value).some(k => !KINDS.includes(k))) throw new Error("CERT_STATE_BAD_SNAPSHOT");
  for (const kind of KINDS) {
    if (!Array.isArray(value[kind])) throw new Error("CERT_STATE_BAD_SNAPSHOT");
    if (value[kind].length > 300) throw new Error("CERT_STATE_TOO_LARGE");
    for (const item of value[kind]) {
      if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string" ||
          !item[1] || typeof item[1] !== "object" || Array.isArray(item[1]) ||
          typeof item[1].id !== "string" || item[1].id.length > 256 ||
          typeof item[1].data !== "object" || !item[1].data || Array.isArray(item[1].data))
        throw new Error("CERT_STATE_BAD_ENTRY");
    }
  }
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).length > MAX_BYTES) throw new Error("CERT_STATE_TOO_LARGE");
  // Sensitive data is intentionally never included by the caller: the snapshot
  // contains only Caravel's public provider location/vehicle/protection/extra records.
  return serialized;
}

/**
 * @param {object} admin Supabase service-role client returned by requireAdmin()
 * @param {string} sessionId random UUID, same for all certification phase calls
 */
export function createCaravelSandboxReferenceRepository(admin, sessionId) {
  if (!admin?.storage?.from || !UUID.test(sessionId)) throw new Error("CERT_STATE_BAD_CONFIGURATION");
  const bucket = admin.storage.from(CARAVEL_CERT_BUCKET);
  return {
    async load(supplierId) {
      const path = pathOf(sessionId, supplierId);
      const {data, error} = await bucket.download(path);
      if (error) {
        // Supabase Storage returns 404 for an absent snapshot (first phase).
        if (String(error.statusCode ?? error.status ?? "") === "404" || error.name === "StorageUnknownError" && /404/.test(String(error.message)))
          return null;
        throw new Error("CERT_STATE_READ_FAILED");
      }
      const raw = await data.text();
      const value = JSON.parse(raw);
      validateCaravelCertSnapshot(value);
      return value;
    },
    async save(supplierId, snapshot) {
      const path = pathOf(sessionId, supplierId);
      const contents = validateCaravelCertSnapshot(snapshot);
      const {error} = await bucket.upload(path, new Blob([contents], {type: "application/json"}), {
        upsert: true, contentType: "application/json", cacheControl: "0",
      });
      if (error) throw new Error("CERT_STATE_WRITE_FAILED");
    },
    async clear(supplierId) {
      const path = pathOf(sessionId, supplierId);
      const {error} = await bucket.remove([path]);
      if (error) throw new Error("CERT_STATE_CLEAR_FAILED");
    },
  };
}
