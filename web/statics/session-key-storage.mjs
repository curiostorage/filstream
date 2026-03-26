/**
 * Persist Synapse session-key material for the current browser tab (`sessionStorage`).
 * Cleared on wallet disconnect or when the stored root/chain no longer matches config.
 */

export const FILSTREAM_SESSION_STORAGE_KEY = "filstream_synapse_session_v1";

/** Last connected EIP-1193 wallet (survives full page reload in this tab). */
export const FILSTREAM_WALLET_STORAGE_KEY = "filstream_wallet_v1";

/** Stored sessions older than this are not re-applied after reload (must re-authorize). */
export const SESSION_RECOVER_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * @typedef {{
 *   version: 1,
 *   rootAddress: string,
 *   chainId: number,
 *   sessionPrivateKey: string,
 *   sessionExpirations: Record<string, string>,
 * }} StoredSessionPayloadV1
 */

/**
 * @typedef {{
 *   version: 2,
 *   authorizedAtMs: number,
 *   rootAddress: string,
 *   chainId: number,
 *   sessionPrivateKey: string,
 *   sessionExpirations: Record<string, string>,
 * }} StoredSessionPayloadV2
 */

/**
 * @typedef {StoredSessionPayloadV1 | StoredSessionPayloadV2} StoredSessionPayload
 */

/**
 * @param {unknown} value
 * @returns {value is StoredSessionPayload}
 */
function isStoredSessionPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const o = /** @type {Record<string, unknown>} */ (value);
  const base =
    typeof o.rootAddress === "string" &&
    typeof o.sessionPrivateKey === "string" &&
    typeof o.chainId === "number" &&
    Number.isInteger(o.chainId) &&
    o.sessionExpirations != null &&
    typeof o.sessionExpirations === "object" &&
    !Array.isArray(o.sessionExpirations);
  if (!base) return false;
  if (o.version === 1) return true;
  if (o.version === 2) {
    return typeof o.authorizedAtMs === "number" && Number.isFinite(o.authorizedAtMs);
  }
  return false;
}

/**
 * @param {Record<string, string>} expirations
 * @returns {number | null} earliest on-chain expiry as epoch seconds
 */
export function minSessionExpirationEpochSec(expirations) {
  let m = Infinity;
  for (const v of Object.values(expirations)) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) m = Math.min(m, n);
  }
  return m === Infinity ? null : m;
}

/**
 * Whether a payload may be loaded into the wizard after a tab reload. Older sessions are rejected
 * so users re-authorize before uploads (on-chain auth is ~1h; we only reuse the first 30 minutes).
 *
 * @param {StoredSessionPayload} stored
 * @param {number} [nowMs]
 */
export function isSessionKeyRecoverable(stored, nowMs = Date.now()) {
  if (stored.version === 2) {
    return nowMs - stored.authorizedAtMs <= SESSION_RECOVER_MAX_AGE_MS;
  }
  const minExp = minSessionExpirationEpochSec(stored.sessionExpirations);
  if (minExp == null) return false;
  const approxAuthMs = (minExp - 3600) * 1000;
  if (!Number.isFinite(approxAuthMs)) return false;
  return nowMs - approxAuthMs <= SESSION_RECOVER_MAX_AGE_MS;
}

/**
 * @param {{
 *   rootAddress: string,
 *   chainId: number,
 *   sessionPrivateKey: string,
 *   sessionExpirations: Record<string, string>,
 * }} input
 */
export function saveSessionKeyToStorage(input) {
  if (typeof sessionStorage === "undefined") return;
  /** @type {StoredSessionPayloadV2} */
  const payload = {
    version: 2,
    authorizedAtMs: Date.now(),
    rootAddress: input.rootAddress,
    chainId: input.chainId,
    sessionPrivateKey: input.sessionPrivateKey,
    sessionExpirations: input.sessionExpirations,
  };
  sessionStorage.setItem(FILSTREAM_SESSION_STORAGE_KEY, JSON.stringify(payload));
}

/**
 * @returns {StoredSessionPayload | null}
 */
export function loadSessionKeyFromStorage() {
  if (typeof sessionStorage === "undefined") return null;
  const raw = sessionStorage.getItem(FILSTREAM_SESSION_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return isStoredSessionPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function clearSessionKeyFromStorage() {
  if (typeof sessionStorage === "undefined") return;
  sessionStorage.removeItem(FILSTREAM_SESSION_STORAGE_KEY);
}

/**
 * @param {StoredSessionPayload} stored
 * @returns {{ [k: string]: string | number | bigint }}
 */
export function expirationsForWizard(stored) {
  /** @type {Record<string, string | number | bigint>} */
  const out = {};
  for (const [k, v] of Object.entries(stored.sessionExpirations)) {
    out[k] = v;
  }
  return out;
}

/**
 * @typedef {{
 *   version: number,
 *   address: string,
 *   walletUuid: string,
 *   walletName: string,
 * }} StoredWalletPayload
 */

/**
 * @param {unknown} value
 * @returns {value is StoredWalletPayload}
 */
function isStoredWalletPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const o = /** @type {Record<string, unknown>} */ (value);
  return (
    o.version === 1 &&
    typeof o.address === "string" &&
    typeof o.walletUuid === "string" &&
    typeof o.walletName === "string"
  );
}

/**
 * @param {{ address: string, walletUuid: string, walletName: string }} input
 */
export function saveWalletToStorage(input) {
  if (typeof sessionStorage === "undefined") return;
  /** @type {StoredWalletPayload} */
  const payload = {
    version: 1,
    address: input.address,
    walletUuid: input.walletUuid,
    walletName: input.walletName,
  };
  sessionStorage.setItem(FILSTREAM_WALLET_STORAGE_KEY, JSON.stringify(payload));
}

/**
 * @returns {StoredWalletPayload | null}
 */
export function loadWalletFromStorage() {
  if (typeof sessionStorage === "undefined") return null;
  const raw = sessionStorage.getItem(FILSTREAM_WALLET_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return isStoredWalletPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function clearWalletFromStorage() {
  if (typeof sessionStorage === "undefined") return;
  sessionStorage.removeItem(FILSTREAM_WALLET_STORAGE_KEY);
}
