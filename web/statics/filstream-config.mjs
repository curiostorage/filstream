/**
 * Browser-side FilStream upload config (`window.__FILSTREAM_CONFIG__`).
 *
 * Defaults match `statics/env.example` / Filecoin Calibration.
 * Override any key in an inline script before `ui.mjs` loads.
 *
 * Mapping from legacy `STORE_*` names:
 * - STORE_RPC_URL → storeRpcUrl
 * - STORE_CHAIN_ID → storeChainId
 * - STORE_PROVIDER_ID → storeProviderId
 * - STORE_SOURCE → storeSource
 * - STORE_FILSTREAM_ID → storeFilstreamId (empty: auto-generate UUID)
 * - STORE_MAX_PIECE_BYTES → storeMaxPieceBytes
 *
 * @typedef {{
 *   storeRpcUrl: string,
 *   storeChainId: number,
 *   storeProviderId: number,
 *   storeSource: string,
 *   storeFilstreamId: string,
 *   storeMaxPieceBytes: number,
 * }} FilstreamPublicConfig
 */

/** Same defaults as former Node `STORE_*` .env example (Filecoin Calibration). */
const DEFAULT_FILSTREAM_PUBLIC_CONFIG = {
  storeRpcUrl: "https://api.calibration.node.glif.io/rpc/v1",
  storeChainId: 314159,
  storeProviderId: 4,
  storeSource: "filstream",
  storeFilstreamId: "",
  storeMaxPieceBytes: 133_169_152,
};

const FILSTREAM_ID_STORAGE_KEY = "filstream_store_filstream_id_v1";

/** @type {FilstreamPublicConfig | null} */
let cached = null;

/**
 * @returns {Partial<FilstreamPublicConfig> | undefined}
 */
function readWindowConfig() {
  if (typeof globalThis === "undefined" || !("__FILSTREAM_CONFIG__" in globalThis)) {
    return undefined;
  }
  const c = /** @type {{ __FILSTREAM_CONFIG__?: unknown }} */ (globalThis).__FILSTREAM_CONFIG__;
  return c && typeof c === "object" && !Array.isArray(c)
    ? /** @type {Partial<FilstreamPublicConfig>} */ (c)
    : undefined;
}

/**
 * @returns {FilstreamPublicConfig}
 */
export function getFilstreamStoreConfig() {
  if (cached) return cached;
  const g = readWindowConfig();
  const maxFromG =
    typeof g?.storeMaxPieceBytes === "number" && Number.isFinite(g.storeMaxPieceBytes)
      ? Math.floor(g.storeMaxPieceBytes)
      : null;
  cached = {
    storeRpcUrl:
      typeof g?.storeRpcUrl === "string" && g.storeRpcUrl.trim() !== ""
        ? g.storeRpcUrl.trim()
        : DEFAULT_FILSTREAM_PUBLIC_CONFIG.storeRpcUrl,
    storeChainId:
      typeof g?.storeChainId === "number" &&
      Number.isInteger(g.storeChainId) &&
      g.storeChainId > 0
        ? g.storeChainId
        : DEFAULT_FILSTREAM_PUBLIC_CONFIG.storeChainId,
    storeProviderId:
      typeof g?.storeProviderId === "number" &&
      Number.isInteger(g.storeProviderId) &&
      g.storeProviderId > 0
        ? g.storeProviderId
        : DEFAULT_FILSTREAM_PUBLIC_CONFIG.storeProviderId,
    storeSource:
      typeof g?.storeSource === "string" && g.storeSource.trim() !== ""
        ? g.storeSource.trim()
        : DEFAULT_FILSTREAM_PUBLIC_CONFIG.storeSource,
    storeFilstreamId:
      typeof g?.storeFilstreamId === "string" && g.storeFilstreamId.trim() !== ""
        ? g.storeFilstreamId.trim()
        : DEFAULT_FILSTREAM_PUBLIC_CONFIG.storeFilstreamId,
    storeMaxPieceBytes: maxFromG ?? DEFAULT_FILSTREAM_PUBLIC_CONFIG.storeMaxPieceBytes,
  };
  return cached;
}

/**
 * Ensure FILSTREAM-ID exists (persisted in config object on window).
 *
 * @param {FilstreamPublicConfig} cfg
 * @returns {string}
 */
export function ensureFilstreamId(cfg) {
  const g = readWindowConfig();
  if (cfg.storeFilstreamId) return cfg.storeFilstreamId;
  if (g && typeof g === "object" && "storeFilstreamId" in g) {
    const existing = g.storeFilstreamId;
    if (typeof existing === "string" && existing.trim() !== "") return existing.trim();
  }
  if (typeof localStorage !== "undefined") {
    const persisted = localStorage.getItem(FILSTREAM_ID_STORAGE_KEY);
    if (typeof persisted === "string" && persisted.trim() !== "") {
      if (g && typeof g === "object") {
        g.storeFilstreamId = persisted.trim();
      }
      cfg.storeFilstreamId = persisted.trim();
      cached = { ...cfg, storeFilstreamId: persisted.trim() };
      return persisted.trim();
    }
  }
  const gen =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `fs_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  if (g && typeof g === "object") {
    g.storeFilstreamId = gen;
  }
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(FILSTREAM_ID_STORAGE_KEY, gen);
  }
  cfg.storeFilstreamId = gen;
  cached = { ...cfg, storeFilstreamId: gen };
  return gen;
}
