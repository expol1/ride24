/**
 * Isolated Caravel SANDBOX certification reference snapshots.
 * Uses a private RLS-protected Postgres table via restricted RPCs, NOT Storage:
 * the project's existing Storage policy admits authenticated uploads outside
 * its target bucket. No API keys, customer details or bookings are persisted.
 */
export const CARAVEL_CERT_TABLE = "caravel_sbx_reference_snapshots";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUPPLIER = /^[a-zA-Z0-9_-]{1,128}$/;
const KINDS = ["locations", "vehicles", "protections", "extras"];
const MAX_BYTES = 1024 * 1024; // 1 MiB max, upper bound for sandbox reference-only fixtures

function validateScope(sessionId, supplierId) {
  if (!UUID.test(sessionId) || !SUPPLIER.test(supplierId)) throw new Error("CERT_STATE_BAD_SCOPE");
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

// Postgres jsonb rejects U+0000. The in-memory catalogue keys use
// `supplier_id + "\\u0000" + opaque_id`. Encode only the *map keys* at the
// RPC boundary; the merge logic keeps original opaque IDs without guessing.
function toDatabaseSnapshot(value) {
  const normalized = JSON.parse(validateCaravelCertSnapshot(value));
  const stored = Object.fromEntries(KINDS.map(kind =>
    [kind, normalized[kind].map(([key,record]) => [encodeURIComponent(key), record])]));
  validateCaravelCertSnapshot(stored);
  return stored;
}
function fromDatabaseSnapshot(value) {
  validateCaravelCertSnapshot(value);
  const decoded = Object.fromEntries(KINDS.map(kind =>
    [kind, value[kind].map(([key,record]) => [decodeURIComponent(key), record])]));
  validateCaravelCertSnapshot(decoded);
  return decoded;
}

/**
 * @param {object} admin Supabase service-role client returned by requireAdmin()
 * @param {string} sessionId random UUID, same for all certification phase calls
 */
export function createCaravelSandboxReferenceRepository(admin, sessionId) {
  if (typeof admin?.rpc !== "function" || !UUID.test(sessionId))
    throw new Error("CERT_STATE_BAD_CONFIGURATION");
  const call = async (name, supplierId, snapshot) => {
    validateScope(sessionId, supplierId);
    const {data, error} = await admin.rpc(name, {
      p_session_id: sessionId, p_supplier_id: supplierId,
      ...(snapshot === undefined ? {} : {p_snapshot: snapshot}),
    });
    if (error) throw new Error("CERT_STATE_RPC_FAILED");
    return data;
  };
  return {
    async load(supplierId) {
      const value = await call("caravel_sbx_reference_load", supplierId);
      if (value === null) return null;
      return fromDatabaseSnapshot(value);
    },
    async save(supplierId, snapshot) {
      validateScope(sessionId, supplierId);
      const valid = toDatabaseSnapshot(snapshot);
      const result = await call("caravel_sbx_reference_save", supplierId, valid);
      if (result !== true) throw new Error("CERT_STATE_SAVE_UNCONFIRMED");
    },
    async clear(supplierId) {
      const result = await call("caravel_sbx_reference_clear", supplierId);
      if (typeof result !== "boolean") throw new Error("CERT_STATE_CLEAR_UNCONFIRMED");
    },
  };
}
