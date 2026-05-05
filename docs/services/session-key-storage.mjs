/**
 * Persist Synapse session-key material in shared browser storage (`localStorage`) so
 * tabs can reuse the same key and avoid repeated auth popups.
 */
import {
  FILSTREAM_SESSION_CHANNEL_NAME as SHARED_FILSTREAM_SESSION_CHANNEL_NAME,
  FILSTREAM_SESSION_CLEANUP_LOCK_KEY as SHARED_FILSTREAM_SESSION_CLEANUP_LOCK_KEY,
  FILSTREAM_SESSION_STORAGE_KEY as SHARED_FILSTREAM_SESSION_STORAGE_KEY,
  FILSTREAM_WALLET_STORAGE_KEY as SHARED_FILSTREAM_WALLET_STORAGE_KEY,
  SESSION_RECOVER_MAX_AGE_MS as SHARED_SESSION_RECOVER_MAX_AGE_MS,
} from "./filstream-constants.mjs";
import { getAddress, privateKeyToAccount } from "../vendor/synapse-browser.mjs";

export const FILSTREAM_SESSION_STORAGE_KEY = SHARED_FILSTREAM_SESSION_STORAGE_KEY;
export const FILSTREAM_SESSION_CHANNEL_NAME = SHARED_FILSTREAM_SESSION_CHANNEL_NAME;
export const FILSTREAM_SESSION_CLEANUP_LOCK_KEY = SHARED_FILSTREAM_SESSION_CLEANUP_LOCK_KEY;

/** Last connected EIP-1193 wallet (shared across tabs). */
export const FILSTREAM_WALLET_STORAGE_KEY = SHARED_FILSTREAM_WALLET_STORAGE_KEY;

/** Stored sessions older than this are not re-applied after reload (must re-authorize). */
export const SESSION_RECOVER_MAX_AGE_MS = SHARED_SESSION_RECOVER_MAX_AGE_MS;

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
 * @typedef {{
 *   keyId: string,
 *   sessionPrivateKey: string,
 *   sessionExpirations: Record<string, string>,
 *   authorizedAtMs: number,
 *   retiredAtMs: number,
 *   state: "retired" | "sweep_pending" | "revoked",
 *   sweepTxHash?: string,
 *   revokeTxHash?: string,
 *   lastError?: string,
 * }} StoredRetiredSessionV3
 */

/**
 * @typedef {{
 *   version: 3,
 *   authorizedAtMs: number,
 *   rootAddress: string,
 *   chainId: number,
 *   sessionPrivateKey: string,
 *   sessionExpirations: Record<string, string>,
 *   sessionKeyId: string,
 *   retiredSessions: StoredRetiredSessionV3[],
 *   updatedAtMs?: number,
 * }} StoredSessionPayloadV3
 */

/**
 * @typedef {StoredSessionPayloadV1 | StoredSessionPayloadV2 | StoredSessionPayloadV3} StoredSessionPayload
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, string>}
 */
function isStringMap(value) {
  if (!isRecord(value)) return false;
  return Object.values(value).every((v) => typeof v === "string");
}

/**
 * @param {unknown} value
 * @returns {Record<string, string> | null}
 */
function normalizeExpirationMap(value) {
  if (!isRecord(value)) return null;
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, raw] of Object.entries(value)) {
    if (typeof raw === "bigint") {
      out[k] = raw.toString();
      continue;
    }
    if (typeof raw === "number" && Number.isFinite(raw)) {
      out[k] = String(Math.floor(raw));
      continue;
    }
    if (typeof raw === "string" && raw.trim() !== "") {
      out[k] = raw.trim();
      continue;
    }
    return null;
  }
  return out;
}

/**
 * @param {unknown} value
 * @returns {value is StoredRetiredSessionV3}
 */
function isRetiredSession(value) {
  if (!isRecord(value)) return false;
  return (
    typeof value.keyId === "string" &&
    value.keyId.trim() !== "" &&
    typeof value.sessionPrivateKey === "string" &&
    value.sessionPrivateKey.trim() !== "" &&
    isStringMap(value.sessionExpirations) &&
    typeof value.authorizedAtMs === "number" &&
    Number.isFinite(value.authorizedAtMs) &&
    typeof value.retiredAtMs === "number" &&
    Number.isFinite(value.retiredAtMs) &&
    (value.state === "retired" || value.state === "sweep_pending" || value.state === "revoked")
  );
}

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
  if (o.version === 3) {
    return (
      typeof o.authorizedAtMs === "number" &&
      Number.isFinite(o.authorizedAtMs) &&
      typeof o.sessionKeyId === "string" &&
      o.sessionKeyId.trim() !== "" &&
      Array.isArray(o.retiredSessions) &&
      o.retiredSessions.every((x) => isRetiredSession(x))
    );
  }
  return false;
}

function normalizeSessionPrivateKeyHex(sessionPrivateKey) {
  const raw = String(sessionPrivateKey || "").trim();
  if (!raw) return "";
  return raw.startsWith("0x") || raw.startsWith("0X") ? raw : `0x${raw}`;
}

/**
 * @param {string} sessionPrivateKey
 * @returns {string}
 */
export function sessionKeyIdFromPrivateKey(sessionPrivateKey) {
  try {
    const normalized = normalizeSessionPrivateKeyHex(sessionPrivateKey);
    if (!normalized) return "";
    const addr = privateKeyToAccount(/** @type {`0x${string}`} */ (normalized)).address;
    return getAddress(addr).toLowerCase();
  } catch {
    return "";
  }
}

/**
 * @param {StoredRetiredSessionV3[]} list
 * @param {string} activeKeyId
 * @returns {StoredRetiredSessionV3[]}
 */
function dedupeRetiredSessions(list, activeKeyId) {
  /** @type {Map<string, StoredRetiredSessionV3>} */
  const byKey = new Map();
  for (const item of list) {
    if (!isRetiredSession(item)) continue;
    const keyId = item.keyId.toLowerCase();
    if (!keyId || keyId === activeKeyId.toLowerCase()) continue;
    const prev = byKey.get(keyId);
    if (!prev || item.retiredAtMs >= prev.retiredAtMs) {
      byKey.set(keyId, {
        keyId,
        sessionPrivateKey: normalizeSessionPrivateKeyHex(item.sessionPrivateKey),
        sessionExpirations: { ...item.sessionExpirations },
        authorizedAtMs: Math.floor(item.authorizedAtMs),
        retiredAtMs: Math.floor(item.retiredAtMs),
        state: item.state,
        ...(item.sweepTxHash ? { sweepTxHash: item.sweepTxHash } : {}),
        ...(item.revokeTxHash ? { revokeTxHash: item.revokeTxHash } : {}),
        ...(item.lastError ? { lastError: item.lastError } : {}),
      });
    }
  }
  return [...byKey.values()].sort((a, b) => b.retiredAtMs - a.retiredAtMs);
}

/**
 * @param {StoredSessionPayload | null} stored
 * @returns {StoredSessionPayloadV3 | null}
 */
function normalizeToV3(stored) {
  if (!stored) return null;
  const normalizedKey = normalizeSessionPrivateKeyHex(stored.sessionPrivateKey);
  const expirations = normalizeExpirationMap(stored.sessionExpirations);
  if (!normalizedKey || !expirations) return null;
  const activeKeyId =
    stored.version === 3 && typeof stored.sessionKeyId === "string"
      ? stored.sessionKeyId.trim().toLowerCase()
      : sessionKeyIdFromPrivateKey(normalizedKey);
  const sessionKeyId = activeKeyId || `unknown-${Date.now()}`;

  /** @type {StoredRetiredSessionV3[]} */
  let retiredSessions = [];
  if (stored.version === 3 && Array.isArray(stored.retiredSessions)) {
    retiredSessions = dedupeRetiredSessions(stored.retiredSessions, sessionKeyId);
  }

  return {
    version: 3,
    authorizedAtMs:
      stored.version === 2 || stored.version === 3
        ? Math.floor(stored.authorizedAtMs)
        : (() => {
            const minExp = minSessionExpirationEpochSec(expirations);
            if (minExp == null) return Date.now();
            return Math.max(0, (minExp - 3600) * 1000);
          })(),
    rootAddress: stored.rootAddress,
    chainId: stored.chainId,
    sessionPrivateKey: normalizedKey,
    sessionExpirations: expirations,
    sessionKeyId,
    retiredSessions,
    ...(stored.version === 3 && typeof stored.updatedAtMs === "number"
      ? { updatedAtMs: Math.floor(stored.updatedAtMs) }
      : {}),
  };
}

function readStoredPayload() {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(FILSTREAM_SESSION_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return isStoredSessionPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * @param {StoredSessionPayloadV3} payload
 */
function writeStoredPayload(payload) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(FILSTREAM_SESSION_STORAGE_KEY, JSON.stringify(payload));
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
 * so users re-authorize before uploads (on-chain auth is ~1h; we reuse up to that same window).
 *
 * @param {StoredSessionPayload} stored
 * @param {number} [nowMs]
 */
export function isSessionKeyRecoverable(stored, nowMs = Date.now()) {
  if (stored.version === 2 || stored.version === 3) {
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
 * @returns {StoredSessionPayloadV3 | null}
 */
export function saveSessionKeyToStorage(input) {
  if (typeof localStorage === "undefined") return null;
  const nextKey = normalizeSessionPrivateKeyHex(input.sessionPrivateKey);
  const nextExp = normalizeExpirationMap(input.sessionExpirations);
  if (!nextKey || !nextExp) return null;
  const nextKeyId = sessionKeyIdFromPrivateKey(nextKey) || `unknown-${Date.now()}`;
  const current = loadSessionStateFromStorage();
  const sameRoot =
    current &&
    current.rootAddress.toLowerCase() === String(input.rootAddress || "").trim().toLowerCase();
  const sameChain = current && current.chainId === input.chainId;
  /** @type {StoredRetiredSessionV3[]} */
  const retiredSessions = sameRoot && sameChain ? [...current.retiredSessions] : [];
  if (sameRoot && sameChain && current.sessionPrivateKey !== nextKey) {
    const prevKeyId =
      current.sessionKeyId && current.sessionKeyId.trim() !== ""
        ? current.sessionKeyId.trim().toLowerCase()
        : sessionKeyIdFromPrivateKey(current.sessionPrivateKey);
    if (prevKeyId && prevKeyId !== nextKeyId.toLowerCase()) {
      retiredSessions.unshift({
        keyId: prevKeyId,
        sessionPrivateKey: current.sessionPrivateKey,
        sessionExpirations: { ...current.sessionExpirations },
        authorizedAtMs: current.authorizedAtMs,
        retiredAtMs: Date.now(),
        state: "retired",
      });
    }
  }
  /** @type {StoredSessionPayloadV3} */
  const payload = {
    version: 3,
    authorizedAtMs: Date.now(),
    rootAddress: String(input.rootAddress || "").trim(),
    chainId: input.chainId,
    sessionPrivateKey: nextKey,
    sessionExpirations: nextExp,
    sessionKeyId: nextKeyId.toLowerCase(),
    retiredSessions: dedupeRetiredSessions(retiredSessions, nextKeyId),
    updatedAtMs: Date.now(),
  };
  writeStoredPayload(payload);
  return payload;
}

/**
 * @returns {StoredSessionPayloadV3 | null}
 */
export function loadSessionStateFromStorage() {
  const raw = readStoredPayload();
  return normalizeToV3(raw);
}

/**
 * Backward-compatible accessor (returns normalized v3 payload).
 *
 * @returns {StoredSessionPayloadV3 | null}
 */
export function loadSessionKeyFromStorage() {
  return loadSessionStateFromStorage();
}

export function clearSessionKeyFromStorage() {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(FILSTREAM_SESSION_STORAGE_KEY);
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
 * @returns {StoredRetiredSessionV3[]}
 */
export function loadRetiredSessionKeysFromStorage() {
  const stored = loadSessionStateFromStorage();
  if (!stored) return [];
  return stored.retiredSessions.map((x) => ({ ...x }));
}

/**
 * @param {string} keyId
 * @param {Partial<StoredRetiredSessionV3>} patch
 * @returns {StoredSessionPayloadV3 | null}
 */
export function patchRetiredSessionKeyInStorage(keyId, patch) {
  const wanted = String(keyId || "").trim().toLowerCase();
  if (!wanted) return null;
  const stored = loadSessionStateFromStorage();
  if (!stored) return null;
  const nextRetired = stored.retiredSessions.map((item) =>
    item.keyId.toLowerCase() === wanted
      ? {
          ...item,
          ...patch,
          keyId: wanted,
          sessionPrivateKey: normalizeSessionPrivateKeyHex(
            patch.sessionPrivateKey ?? item.sessionPrivateKey,
          ),
          sessionExpirations:
            normalizeExpirationMap(patch.sessionExpirations ?? item.sessionExpirations) ??
            item.sessionExpirations,
        }
      : item,
  );
  const next = {
    ...stored,
    retiredSessions: dedupeRetiredSessions(nextRetired, stored.sessionKeyId),
    updatedAtMs: Date.now(),
  };
  writeStoredPayload(next);
  return next;
}

/**
 * @param {string} keyId
 * @returns {StoredSessionPayloadV3 | null}
 */
export function removeRetiredSessionKeyFromStorage(keyId) {
  const wanted = String(keyId || "").trim().toLowerCase();
  if (!wanted) return null;
  const stored = loadSessionStateFromStorage();
  if (!stored) return null;
  const next = {
    ...stored,
    retiredSessions: stored.retiredSessions.filter(
      (item) => item.keyId.toLowerCase() !== wanted,
    ),
    updatedAtMs: Date.now(),
  };
  writeStoredPayload(next);
  return next;
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
  if (typeof localStorage === "undefined") return;
  /** @type {StoredWalletPayload} */
  const payload = {
    version: 1,
    address: input.address,
    walletUuid: input.walletUuid,
    walletName: input.walletName,
  };
  localStorage.setItem(FILSTREAM_WALLET_STORAGE_KEY, JSON.stringify(payload));
}

/**
 * @returns {StoredWalletPayload | null}
 */
export function loadWalletFromStorage() {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(FILSTREAM_WALLET_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return isStoredWalletPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function clearWalletFromStorage() {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(FILSTREAM_WALLET_STORAGE_KEY);
}
