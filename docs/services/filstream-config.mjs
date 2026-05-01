/**
 * Browser-side FilStream upload config (`window.__FILSTREAM_CONFIG__`).
 *
 * Defaults match `docs/env.example` / Filecoin Calibration.
 * Override any key in an inline script before `components/ui.mjs` loads.
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
 *   viewBaseUrl: string,
 *   catalogContractAddress: string,
 *   sessionKeyFundAttoFil: string,
 *   catalogSyncIntervalMs: number,
 * }} FilstreamPublicConfig
 */
import {
  DEFAULT_FILSTREAM_PUBLIC_CONFIG,
  FILSTREAM_ID_STORAGE_KEY,
} from "./filstream-constants.mjs";

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
  const catalogSyncIntervalMs =
    typeof g?.catalogSyncIntervalMs === "number" &&
    Number.isFinite(g.catalogSyncIntervalMs) &&
    g.catalogSyncIntervalMs >= 5_000
      ? Math.floor(g.catalogSyncIntervalMs)
      : DEFAULT_FILSTREAM_PUBLIC_CONFIG.catalogSyncIntervalMs;
  const sessionKeyFundAttoFil =
    typeof g?.sessionKeyFundAttoFil === "string" &&
    /^[0-9]+$/.test(g.sessionKeyFundAttoFil.trim())
      ? g.sessionKeyFundAttoFil.trim()
      : DEFAULT_FILSTREAM_PUBLIC_CONFIG.sessionKeyFundAttoFil;
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
    viewBaseUrl:
      typeof g?.viewBaseUrl === "string"
        ? g.viewBaseUrl.trim()
        : DEFAULT_FILSTREAM_PUBLIC_CONFIG.viewBaseUrl,
    catalogContractAddress:
      typeof g?.catalogContractAddress === "string"
        ? g.catalogContractAddress.trim()
        : DEFAULT_FILSTREAM_PUBLIC_CONFIG.catalogContractAddress,
    sessionKeyFundAttoFil,
    catalogSyncIntervalMs,
  };
  return cached;
}

/**
 * Relative path to the catalog discover home (`index.html` at site root). Resolves correctly from
 * routed app pages (`view/`, `user/`, `upload/`) when those documents use `<base href="../">`.
 *
 * @returns {string}
 */
export function resolveViewerIndexPageUrl() {
  return "index.html";
}

/**
 * Discover home with optional catalog search (`q`). Same-directory relative URL.
 *
 * @param {string} [rawQuery]
 * @returns {string}
 */
export function buildDiscoverHomeUrlWithSearchQuery(rawQuery) {
  const q = String(rawQuery || "").trim();
  const sp = new URLSearchParams();
  if (q) sp.set("q", q);
  const qs = sp.toString();
  return qs ? `index.html?${qs}` : "index.html";
}

/**
 * Primary playback URL: `view/?videoId=<asset-id>` (relative to site root; works with `<base href="../">` on routed pages).
 *
 * @param {string} videoId
 * @param {{ embed?: boolean }} [opts]
 * @returns {string}
 */
export function buildViewerUrlForVideoId(videoId, opts = {}) {
  const id = String(videoId || "").trim();
  const sp = new URLSearchParams();
  if (id) sp.set("videoId", id);
  if (opts.embed === true) sp.set("embed", "true");
  const qs = sp.toString();
  return qs ? `view/?${qs}` : "view/";
}

/**
 * Same as {@link buildViewerUrlForVideoId} but resolved against `viewBaseUrl` so links work from
 * non-app origins (e.g. `share.html` served as a PDP piece, Open Graph meta tags).
 *
 * @param {string} videoId
 * @param {{ embed?: boolean }} [opts]
 * @returns {string}
 */
export function buildAbsoluteViewerUrlForVideoId(videoId, opts = {}) {
  const rel = buildViewerUrlForVideoId(videoId, opts);
  const base = getFilstreamStoreConfig().viewBaseUrl.trim();
  if (!base) return rel;
  const normalized = base.endsWith("/") ? base : `${base}/`;
  return new URL(rel, normalized).href;
}

/**
 * Creator page URL: `user/?creator=<wallet-address>` (relative to site root).
 *
 * @param {string} creatorAddress
 * @returns {string}
 */
export function buildCreatorUrlForAddress(creatorAddress) {
  const addr = String(creatorAddress || "").trim();
  const sp = new URLSearchParams();
  if (addr) sp.set("creator", addr);
  const qs = sp.toString();
  return qs ? `user/?${qs}` : "user/";
}

/**
 * @param {null | { videoId?: string | null, assetId?: string | null }} result
 * @returns {string}
 */
export function resolveVideoIdFromFinalize(result) {
  if (!result) return "";
  const direct = typeof result.videoId === "string" ? result.videoId.trim() : "";
  if (direct) return direct;
  const fallback = typeof result.assetId === "string" ? result.assetId.trim() : "";
  return fallback;
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
