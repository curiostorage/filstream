/**
 * Catalog app page logic (discover + playback):
 * - Discover: `index.html` · Playback: `view/?videoId=<asset-id>[&embed=true]`
 *
 * Catalog discovery is on-chain (`CatalogRegistry`) with IndexedDB cache:
 * - entries are synced every ~30s when visible (or when hidden but video is playing)
 * - creator username/profile picture are refreshed for visible creators on the same cadence
 * - discover / “more from creator” sidebars skip DOM rebuild when the visible data is unchanged (no blink on no-op sync)
 * - manifest.json is fetched once per `videoId` and then reused from cache
 */
import { awaitMovieLinkShowcaseUpdates } from "./movie-link-showcase.mjs";
import { html, nothing, render, svg } from "https://cdn.jsdelivr.net/npm/lit-html@3.2.1/+esm";
import { repeat } from "https://cdn.jsdelivr.net/npm/lit-html@3.2.1/directives/repeat.js/+esm";
import {
  FILSTREAM_BRAND,
  hydrateFilstreamHeaderProfile,
  mountFilstreamHeader,
} from "./filstream-brand.mjs";
import {
  broadcastCopyFromMeta,
  formatUploadDateLabel,
} from "./filstream-broadcast-view.mjs";
import {
  cacheCatalogEntries,
  findCachedEntryByVideoId,
  loadCachedCatalogEntries,
  loadCachedCreatorProfiles,
  loadCatalogCursor,
  loadLastFullRefreshAtMs,
  loadManifestCache,
  saveCachedCreatorProfiles,
  saveCatalogCursor,
  saveLastFullRefreshAtMs,
  saveManifestCache,
} from "../services/filstream-catalog-cache.mjs";
import {
  buildPieceRetrievalUrl,
  isCatalogConfigured,
  readCatalogLatest,
  readCatalogNewerThan,
  readCatalogProfilePicturePieceCid,
  readCatalogUsername,
  resolveManifestUrl,
  resolveProviderServiceUrl,
} from "../services/filstream-catalog-chain.mjs";
import {
  buildAbsoluteViewerUrlForVideoId,
  buildCreatorUrlForAddress,
  buildDiscoverHomeUrlWithSearchQuery,
  buildViewerUrlForVideoId,
  getFilstreamStoreConfig,
} from "../services/filstream-config.mjs";
import {
  CATALOG_CREATOR_PROFILE_SYNC_LIMIT,
  CATALOG_FULL_REFRESH_MS,
  CATALOG_PAGE_SIZE,
} from "../services/filstream-constants.mjs";
import {
  clearResumePosition,
  getResumePositionSeconds,
  hasWatchedTo95Percent,
  markWatchedTo95Percent,
  setResumePositionSeconds,
} from "../services/filstream-watch-history.mjs";
import {
  donateConfigFromMeta,
  proposeDonateTransfer,
  resolveViewerProvider,
} from "./filstream-catalog-donate.mjs";

const shaka = (
  await import("https://esm.sh/shaka-player@4.7.11/dist/shaka-player.ui.js")
).default;

const params = new URLSearchParams(window.location.search);
const embedMode = params.get("embed") === "true";
const requestedVideoId = (params.get("videoId") || "").trim();
const LANDING_TOAST_STORAGE_KEY = "filstream-welcome-dismissed";

if (embedMode) {
  document.documentElement.classList.add("catalog-app-embed");
}

const G_REF = /** @type {{ host: import("lit").LitElement | null }} */ ({ host: null });

/** @type {HTMLElement | null} */
let statusEl = null;
/** @type {HTMLVideoElement | null} */
let videoEl = null;
/** @type {HTMLElement | null} */
let rootEl = null;
/** @type {HTMLElement | null} */
let playerBlockEl = null;
/** @type {HTMLElement | null} */
let metaSection = null;
/** @type {HTMLElement | null} */
let titleEl = null;
/** @type {HTMLElement | null} */
let uploadDateEl = null;
/** @type {HTMLElement | null} */
let descriptionEl = null;
/** @type {HTMLElement | null} */
let bylineEl = null;
/** @type {HTMLElement | null} */
let bylineCatalogEl = null;
/** @type {HTMLElement | null} */
let donateRootEl = null;
/** @type {HTMLElement | null} */
let viewerActionsEl = null;
/** @type {HTMLElement | null} */
let shakaContainerEl = null;
/** @type {HTMLElement | null} */
let catalogAside = null;
/** @type {HTMLElement | null} */
let brandMount = null;

function cacheCatalogPageRefs() {
  const h = G_REF.host;
  if (!h) return;
  statusEl = h.querySelector("#viewer-status");
  videoEl = /** @type {HTMLVideoElement | null} */ (h.querySelector("#viewer-video"));
  rootEl = h.querySelector("#root");
  playerBlockEl = h.querySelector(".viewer-player-block");
  metaSection = h.querySelector("#viewer-meta");
  titleEl = h.querySelector("#viewer-title");
  uploadDateEl = h.querySelector("#viewer-upload-date");
  descriptionEl = h.querySelector("#viewer-description");
  bylineEl = h.querySelector("#viewer-byline");
  bylineCatalogEl = h.querySelector("#viewer-byline-catalog");
  donateRootEl = h.querySelector("#viewer-donate-root");
  viewerActionsEl = h.querySelector("#viewer-actions");
  shakaContainerEl = h.querySelector("#viewer-shaka-container");
  catalogAside = h.querySelector("#viewer-catalog");
  brandMount = h.querySelector("#viewer-brand-mount");
}

/** @type {unknown | null} */
let loadedMeta = null;
let donateBusy = false;
let donateError = "";
let donateTxHash = "";
let theaterControlRegistered = false;
let filstreamOverflowRegistered = false;
/** @type {import("shaka-player").Player | null} */
let shakaPlayer = null;
/** @type {import("shaka-player").ui.Overlay | null} */
let shakaUiOverlay = null;
/** @type {import("../services/filstream-catalog-chain.mjs").CatalogEntry[]} */
let catalogEntries = [];
/** Fingerprint of the last sidebar paint; avoids tearing down the DOM when periodic sync is a no-op. */
let lastRenderedCatalogSidebarSignature = "";
/** @type {Map<string, { username: string, profilePieceCid: string, profileUrl: string, updatedAtMs: number }>} */
const creatorProfileCache = new Map();
let currentVideoId = requestedVideoId;
let catalogSearchQuery = (params.get("q") || "").trim();
let syncInFlight = false;
let syncIntervalId = 0;
let isVideoPlaying = false;
let destroyed = false;
/** Stops {@link installPlaybackEndClamp} listeners when aborted. */
let playbackEndClampAbort = null;
/** Stops {@link installWatchHistoryTracking} listeners when aborted. */
let watchHistoryTrackingAbort = null;
/** Stops {@link installResumePlaybackTracking} listeners and the 5s save interval. */
let resumePlaybackAbort = null;
let resumePlaybackIntervalId = 0;
/** Bumps {@link computeCatalogSidebarSignature} when a new “watched” marker is saved. */
let watchHistorySidebarRevision = 0;
const cfg = getFilstreamStoreConfig();
const syncIntervalMs = Math.max(5_000, cfg.catalogSyncIntervalMs);

async function unregisterLegacyPieceHeadServiceWorker() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return;
  }
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const reg of regs) {
      const scriptUrl =
        reg.active?.scriptURL || reg.waiting?.scriptURL || reg.installing?.scriptURL || "";
      if (!scriptUrl || !scriptUrl.includes("/piece-head-sw.js")) continue;
      await reg.unregister();
    }
  } catch {
    /* ignore cleanup errors */
  }
}

function setStatus(msg, kind) {
  if (!statusEl) return;
  statusEl.textContent = msg;
  statusEl.className = `viewer-status${kind === "err" ? " err" : ""}`;
}

const CATALOG_TOAST_ID = "filstream-catalog-toast";
/** @type {ReturnType<typeof setTimeout> | undefined} */
let catalogToastHideTimer;

/**
 * @param {string} message
 * @param {{ kind?: "ok" | "err", durationMs?: number }} [opts]
 */
function showCatalogToast(message, opts = {}) {
  const kind = opts.kind === "err" ? "err" : "ok";
  const durationMs =
    typeof opts.durationMs === "number" && opts.durationMs > 0 ? opts.durationMs : 2600;
  let el = document.getElementById(CATALOG_TOAST_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = CATALOG_TOAST_ID;
    el.className = "filstream-catalog-toast";
    el.setAttribute("role", kind === "err" ? "alert" : "status");
    el.setAttribute("hidden", "");
    document.body.appendChild(el);
  }
  el.setAttribute("role", kind === "err" ? "alert" : "status");
  el.textContent = message;
  el.dataset.kind = kind;
  el.removeAttribute("hidden");
  if (catalogToastHideTimer !== undefined) clearTimeout(catalogToastHideTimer);
  catalogToastHideTimer = window.setTimeout(() => {
    el?.setAttribute("hidden", "");
    catalogToastHideTimer = undefined;
  }, durationMs);
}

function syncDiscoverSearchToUrl() {
  if (embedMode) return;
  if (inWatchMode()) return;
  const u = new URL(window.location.href);
  const q = catalogSearchQuery.trim();
  if (q) u.searchParams.set("q", q);
  else u.searchParams.delete("q");
  window.history.replaceState(null, "", u.toString());
}

function wireGlobalSearch() {
  if (embedMode) return;
  const searchEl = G_REF.host?.querySelector("#filstream-global-search");
  if (!(searchEl instanceof HTMLInputElement)) return;
  searchEl.value = catalogSearchQuery;
  searchEl.addEventListener("input", () => {
    const next = searchEl.value;
    if (next === catalogSearchQuery) return;
    catalogSearchQuery = next;
    syncDiscoverSearchToUrl();
    renderCatalogSidebar();
  });
  searchEl.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    if (!inWatchMode()) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    window.location.href = buildDiscoverHomeUrlWithSearchQuery(searchEl.value);
  });
}

function initLandingToast() {
  if (embedMode) return;
  const el = G_REF.host?.querySelector("#filstream-landing-toast");
  if (!el) return;
  if (requestedVideoId) return;
  if (
    typeof localStorage !== "undefined" &&
    localStorage.getItem(LANDING_TOAST_STORAGE_KEY) === "1"
  ) {
    return;
  }
  el.hidden = false;
  const btn = el.querySelector(".filstream-landing-toast-dismiss");
  btn?.addEventListener("click", () => {
    el.hidden = true;
    try {
      localStorage.setItem(LANDING_TOAST_STORAGE_KEY, "1");
    } catch {
      /* ignore */
    }
  });
}

function inWatchMode() {
  return Boolean(currentVideoId);
}

function applyCatalogPageLayout() {
  if (embedMode) return;
  const watch = inWatchMode();
  if (rootEl) {
    rootEl.classList.toggle("catalog-app--watch", watch);
    rootEl.classList.toggle("catalog-app--discover", !watch);
  }
  if (playerBlockEl instanceof HTMLElement) {
    playerBlockEl.hidden = !watch;
  }
  if (!watch && metaSection) {
    metaSection.hidden = true;
  }
}

function normalizeAddressLabel(addr) {
  if (typeof addr !== "string") return "";
  const t = addr.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(t)) return t;
  return `${t.slice(0, 6)}…${t.slice(-4)}`;
}

function normalizeCreatorKey(addr) {
  return String(addr || "").trim().toLowerCase();
}

function profileStateForCreator(addr) {
  return creatorProfileCache.get(normalizeCreatorKey(addr)) ?? null;
}

function bylineNameForCreator(addr) {
  const hit = profileStateForCreator(addr)?.username ?? "";
  if (hit && hit.trim() !== "") return hit.trim();
  return normalizeAddressLabel(addr);
}

function profileUrlForCreator(addr) {
  const url = profileStateForCreator(addr)?.profileUrl ?? "";
  return typeof url === "string" && url.trim() !== "" ? url.trim() : "";
}

function creatorInitialForAddress(addr) {
  const name = bylineNameForCreator(addr);
  const t = String(name || "").trim();
  if (!t) return "?";
  if (/^0x[a-fA-F0-9]{4,}$/.test(t)) {
    return t.slice(2, 3).toUpperCase();
  }
  return t.slice(0, 1).toUpperCase();
}

function sortEntriesNewestFirst(rows) {
  return [...rows].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
    return b.entryId - a.entryId;
  });
}

function computeCatalogSidebarSignature() {
  const active = sortEntriesNewestFirst(catalogEntries.filter((x) => x.active));
  const catalogPart = active.map((e) => ({
    entryId: e.entryId,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    creator: e.creator,
    assetId: e.assetId,
    providerId: e.providerId,
    manifestCid: e.manifestCid,
    title: e.title,
    active: e.active,
  }));
  return JSON.stringify({
    mode: inWatchMode() ? "watch" : "discover",
    videoId: currentVideoId || "",
    q: catalogSearchQuery.trim(),
    catalog: catalogPart,
    watchRev: watchHistorySidebarRevision,
  });
}

function matchesCreatorSearch(creator, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  const addr = String(creator || "").toLowerCase();
  const name = bylineNameForCreator(creator).toLowerCase();
  return addr.includes(q) || name.includes(q);
}

/**
 * @param {import("../services/filstream-catalog-chain.mjs").CatalogEntry[]} rows
 * @param {number} limit
 */
function collectCreatorsForProfileSync(rows, limit) {
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const creator = String(row.creator || "").trim();
    if (!creator) continue;
    const key = normalizeCreatorKey(creator);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(creator);
    if (out.length >= limit) break;
  }
  if (currentVideoId) {
    const current = rows.find((r) => r.assetId === currentVideoId);
    if (current?.creator) {
      const key = normalizeCreatorKey(current.creator);
      if (!seen.has(key)) out.push(current.creator);
    }
  }
  return out;
}

function shouldRunSyncTick() {
  if (destroyed) return false;
  if (document.visibilityState === "visible") return true;
  return isVideoPlaying;
}

function parsePlaybackBlock(doc) {
  if (!doc || typeof doc !== "object" || doc === null) return {};
  const d = /** @type {Record<string, unknown>} */ (doc);
  if (d.playback && typeof d.playback === "object" && d.playback !== null) {
    return /** @type {Record<string, unknown>} */ (d.playback);
  }
  if (
    d.metadata &&
    typeof d.metadata === "object" &&
    d.metadata !== null &&
    typeof /** @type {{ metadata?: { playback?: unknown } }} */ (d).metadata.playback === "object" &&
    /** @type {{ metadata?: { playback?: unknown } }} */ (d).metadata.playback !== null
  ) {
    return /** @type {{ metadata: { playback: Record<string, unknown> } }} */ (d).metadata
      .playback;
  }
  return {};
}

function mergeMetaLikeDocument(doc) {
  if (!doc || typeof doc !== "object" || doc === null) return null;
  const root = /** @type {Record<string, unknown>} */ (doc);
  const metadata =
    root.metadata && typeof root.metadata === "object" && root.metadata !== null
      ? /** @type {Record<string, unknown>} */ (root.metadata)
      : {};
  const out = {
    ...metadata,
    ...root,
  };
  const listing =
    (root.listing && typeof root.listing === "object" && root.listing !== null
      ? root.listing
      : null) ??
    (metadata.listing && typeof metadata.listing === "object" && metadata.listing !== null
      ? metadata.listing
      : null);
  if (listing) out.listing = listing;

  const donate =
    (root.donate && typeof root.donate === "object" && root.donate !== null
      ? root.donate
      : null) ??
    (metadata.donate && typeof metadata.donate === "object" && metadata.donate !== null
      ? metadata.donate
      : null);
  if (donate) out.donate = donate;

  const poster =
    (root.poster && typeof root.poster === "object" && root.poster !== null
      ? root.poster
      : null) ??
    (metadata.poster && typeof metadata.poster === "object" && metadata.poster !== null
      ? metadata.poster
      : null);
  if (poster) out.poster = poster;

  const posterAnim =
    (root.posterAnim && typeof root.posterAnim === "object" && root.posterAnim !== null
      ? root.posterAnim
      : null) ??
    (metadata.posterAnim && typeof metadata.posterAnim === "object" && metadata.posterAnim !== null
      ? metadata.posterAnim
      : null);
  if (posterAnim) out.posterAnim = posterAnim;

  const playback = parsePlaybackBlock(doc);
  if (playback && Object.keys(playback).length > 0) out.playback = playback;
  return out;
}

function posterUrlFromDoc(doc) {
  if (!doc || typeof doc !== "object" || doc === null) return null;
  const d = /** @type {Record<string, unknown>} */ (doc);
  const poster =
    d.poster && typeof d.poster === "object" && d.poster !== null
      ? /** @type {{ url?: unknown }} */ (d.poster).url
      : null;
  if (typeof poster === "string" && poster.trim() !== "") return poster.trim();
  const playback = parsePlaybackBlock(doc);
  const playbackPoster = playback.posterUrl;
  return typeof playbackPoster === "string" && playbackPoster.trim() !== ""
    ? playbackPoster.trim()
    : null;
}

/**
 * URL of the uploaded `share.html` piece (Open Graph / Twitter Card). Falls back to the public viewer URL.
 *
 * @param {unknown} metaDoc
 * @param {import("../services/filstream-catalog-chain.mjs").CatalogEntry | null} entry
 * @returns {Promise<string>}
 */
async function resolveSharePageUrl(metaDoc, entry) {
  const fallback = () =>
    entry?.assetId ? buildAbsoluteViewerUrlForVideoId(entry.assetId) : "";
  if (!metaDoc || typeof metaDoc !== "object" || metaDoc === null || !entry) {
    return fallback();
  }
  const files = /** @type {Record<string, unknown>} */ (metaDoc).files;
  if (!Array.isArray(files)) return fallback();
  for (const f of files) {
    if (!f || typeof f !== "object" || f === null) continue;
    const fr = /** @type {Record<string, unknown>} */ (f);
    if (fr.path !== "share.html") continue;
    const ru = fr.retrievalUrl;
    if (typeof ru === "string" && ru.trim() !== "") return ru.trim();
    const cid = fr.pieceCid;
    if (typeof cid === "string" && cid.trim() !== "") {
      try {
        const serviceUrl = await resolveProviderServiceUrl(entry.providerId);
        return buildPieceRetrievalUrl(serviceUrl, cid.trim());
      } catch {
        return fallback();
      }
    }
  }
  return fallback();
}

function posterAnimUrlFromDoc(doc) {
  if (!doc || typeof doc !== "object" || doc === null) return null;
  const d = /** @type {Record<string, unknown>} */ (doc);
  const pa =
    d.posterAnim && typeof d.posterAnim === "object" && d.posterAnim !== null
      ? /** @type {{ url?: unknown }} */ (d.posterAnim).url
      : null;
  if (typeof pa === "string" && pa.trim() !== "") return pa.trim();
  const playback = parsePlaybackBlock(doc);
  const pb = playback.posterAnimUrl;
  return typeof pb === "string" && pb.trim() !== "" ? pb.trim() : null;
}

/**
 * @param {{ createdAt: number, entryId: number }} a
 * @param {{ createdAt: number, entryId: number }} b
 */
function tupleGreater(a, b) {
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt;
  return a.entryId > b.entryId;
}

/**
 * @param {import("../services/filstream-catalog-chain.mjs").CatalogEntry[]} rows
 * @returns {{ createdAt: number, entryId: number } | null}
 */
function maxCursorFromEntries(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  let best = { createdAt: rows[0].createdAt, entryId: rows[0].entryId };
  for (const row of rows) {
    const c = { createdAt: row.createdAt, entryId: row.entryId };
    if (tupleGreater(c, best)) best = c;
  }
  return best;
}

async function resolveProfilePictureUrlForPieceCid(pieceCid) {
  const cid = String(pieceCid || "").trim();
  if (!cid) return "";
  try {
    const cfgLocal = getFilstreamStoreConfig();
    return await resolveManifestUrl(cfgLocal.storeProviderId, cid);
  } catch {
    return "";
  }
}

function upsertCreatorProfileState(creator, next) {
  const key = normalizeCreatorKey(creator);
  if (!key) return false;
  const prev = creatorProfileCache.get(key) ?? null;
  const normalized = {
    username: typeof next.username === "string" ? next.username.trim() : "",
    profilePieceCid:
      typeof next.profilePieceCid === "string" ? next.profilePieceCid.trim() : "",
    profileUrl: typeof next.profileUrl === "string" ? next.profileUrl.trim() : "",
    updatedAtMs:
      Number.isFinite(next.updatedAtMs) && next.updatedAtMs > 0
        ? Math.floor(next.updatedAtMs)
        : Date.now(),
  };
  if (
    prev &&
    prev.username === normalized.username &&
    prev.profilePieceCid === normalized.profilePieceCid &&
    prev.profileUrl === normalized.profileUrl
  ) {
    return false;
  }
  creatorProfileCache.set(key, normalized);
  return true;
}

/**
 * @param {import("../services/filstream-catalog-chain.mjs").CatalogEntry[]} rows
 */
async function hydrateCreatorProfilesFromCache(rows) {
  const creators = collectCreatorsForProfileSync(rows, CATALOG_CREATOR_PROFILE_SYNC_LIMIT);
  if (!creators.length) return false;
  const cached = await loadCachedCreatorProfiles(creators);
  let changed = false;
  for (const row of cached) {
    if (upsertCreatorProfileState(row.creator, row)) changed = true;
  }
  return changed;
}

async function performCreatorProfileSync() {
  const active = catalogEntries.filter((x) => x.active);
  const creators = collectCreatorsForProfileSync(active, CATALOG_CREATOR_PROFILE_SYNC_LIMIT);
  if (!creators.length) return false;

  let changed = false;
  /** @type {{ creator: string, username: string, profilePieceCid: string, profileUrl: string, updatedAtMs: number }[]} */
  const writes = [];

  for (const creator of creators) {
    const key = normalizeCreatorKey(creator);
    const prev = creatorProfileCache.get(key) ?? {
      username: "",
      profilePieceCid: "",
      profileUrl: "",
      updatedAtMs: 0,
    };

    let username = prev.username;
    let profilePieceCid = prev.profilePieceCid;

    try {
      username = await readCatalogUsername(creator);
    } catch {
      /* keep previous value on transient read errors */
    }
    try {
      profilePieceCid = await readCatalogProfilePicturePieceCid(creator);
    } catch {
      /* keep previous value on transient read errors */
    }

    let profileUrl = prev.profileUrl;
    if (
      profilePieceCid !== prev.profilePieceCid ||
      (profilePieceCid && !prev.profileUrl)
    ) {
      profileUrl = profilePieceCid
        ? await resolveProfilePictureUrlForPieceCid(profilePieceCid)
        : "";
    }

    const next = {
      username,
      profilePieceCid,
      profileUrl,
      updatedAtMs: Date.now(),
    };
    if (!upsertCreatorProfileState(creator, next)) continue;
    changed = true;
    writes.push({
      creator: key,
      username: next.username,
      profilePieceCid: next.profilePieceCid,
      profileUrl: next.profileUrl,
      updatedAtMs: next.updatedAtMs,
    });
  }

  if (writes.length) {
    await saveCachedCreatorProfiles(writes);
  }
  return changed;
}

async function refreshEntriesFromCache() {
  catalogEntries = await loadCachedCatalogEntries({ limit: 250, activeOnly: false });
  const profileHydrationChanged = await hydrateCreatorProfilesFromCache(catalogEntries);
  if (embedMode) return;
  const nextSig = computeCatalogSidebarSignature();
  if (nextSig === lastRenderedCatalogSidebarSignature && !profileHydrationChanged) {
    return;
  }
  renderCatalogSidebar();
}

/**
 * @param {import("../services/filstream-catalog-chain.mjs").CatalogEntry[]} rows
 */
async function upsertEntriesAndAdvanceCursor(rows) {
  if (!rows.length) return;
  await cacheCatalogEntries(rows);
  const existing = await loadCatalogCursor();
  const incoming = maxCursorFromEntries(rows);
  if (!incoming) return;
  if (!existing || tupleGreater(incoming, existing)) {
    await saveCatalogCursor(incoming);
  }
}

async function performCatalogFullRefresh() {
  let offset = 0;
  let pageCount = 0;
  /** @type {import("../services/filstream-catalog-chain.mjs").CatalogEntry[]} */
  const all = [];
  while (pageCount < 100) {
    const page = await readCatalogLatest({
      offset,
      limit: CATALOG_PAGE_SIZE,
      activeOnly: false,
    });
    if (!page.length) break;
    all.push(...page);
    offset += page.length;
    pageCount += 1;
    if (page.length < CATALOG_PAGE_SIZE) break;
  }
  if (all.length) {
    await cacheCatalogEntries(all);
    const c = maxCursorFromEntries(all);
    if (c) await saveCatalogCursor(c);
  }
  await saveLastFullRefreshAtMs(Date.now());
}

async function performCatalogIncrementalSync() {
  let cursor = await loadCatalogCursor();
  if (!cursor) {
    await performCatalogFullRefresh();
    return;
  }
  for (let i = 0; i < 20; i++) {
    const newer = await readCatalogNewerThan({
      cursorCreatedAt: cursor.createdAt,
      cursorEntryId: cursor.entryId,
      limit: CATALOG_PAGE_SIZE,
      activeOnly: false,
    });
    if (!newer.length) break;
    await upsertEntriesAndAdvanceCursor(newer);
    const newest = maxCursorFromEntries(newer);
    if (newest) cursor = newest;
    if (newer.length < CATALOG_PAGE_SIZE) break;
  }
  const lastFull = await loadLastFullRefreshAtMs();
  if (!lastFull || Date.now() - lastFull >= CATALOG_FULL_REFRESH_MS) {
    await performCatalogFullRefresh();
  }
}

async function syncCatalogOnce(force = false) {
  if (!isCatalogConfigured()) return;
  if (syncInFlight) return;
  if (!force && !shouldRunSyncTick()) return;
  syncInFlight = true;
  try {
    await performCatalogIncrementalSync();
    await refreshEntriesFromCache();
    const creatorProfileChanged = await performCreatorProfileSync();
    if (creatorProfileChanged) {
      renderCatalogSidebar();
      if (loadedMeta && currentVideoId) {
        const currentEntry = await findCachedEntryByVideoId(currentVideoId);
        if (currentEntry?.active) {
          await renderViewerMeta(loadedMeta, currentEntry);
        }
      }
    }
    if (currentVideoId) {
      const entry = await findCachedEntryByVideoId(currentVideoId);
      if (!entry || !entry.active) {
        setStatus("Selected video is no longer active.", "err");
      }
    }
  } catch (e) {
    console.warn("[filstream viewer] catalog sync failed", e);
  } finally {
    syncInFlight = false;
  }
}

function startCatalogSyncLoop() {
  if (!isCatalogConfigured()) return;
  if (syncIntervalId) return;
  syncIntervalId = window.setInterval(() => {
    void syncCatalogOnce(false);
  }, syncIntervalMs);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void syncCatalogOnce(true);
    }
  });
}

function buildViewerUrlWithoutEmbed() {
  const videoId = (new URLSearchParams(window.location.search).get("videoId") || "").trim();
  return buildViewerUrlForVideoId(videoId);
}

class TheaterModeButton extends shaka.ui.Element {
  /**
   * @param {HTMLElement} parent
   * @param {*} controls
   */
  constructor(parent, controls) {
    super(parent, controls);
    const container = shakaContainerEl;
    const button = document.createElement("button");
    button.type = "button";
    button.classList.add("shaka-theater-button");
    button.classList.add("material-icons-round");
    button.classList.add("shaka-tooltip");
    button.classList.add("shaka-no-propagation");
    const sync = () => {
      const on = Boolean(container?.classList.contains("viewer-shaka-theater"));
      button.textContent = on ? "fullscreen_exit" : "fit_screen";
      button.setAttribute("aria-pressed", on ? "true" : "false");
      button.setAttribute("aria-label", on ? "Exit theater mode" : "Theater mode");
    };
    sync();
    this.eventManager.listen(button, "click", () => {
      if (!container) return;
      container.classList.toggle("viewer-shaka-theater");
      sync();
    });
    this.parent.appendChild(button);
  }
}

TheaterModeButton.Factory = class {
  /**
   * @param {HTMLElement} rootElement
   * @param {*} controls
   */
  create(rootElement, controls) {
    return new TheaterModeButton(rootElement, controls);
  }
};

class FilstreamSiteButton extends shaka.ui.Element {
  /**
   * @param {HTMLElement} parent
   * @param {*} controls
   */
  constructor(parent, controls) {
    super(parent, controls);
    const button = document.createElement("button");
    button.type = "button";
    button.classList.add("shaka-filstream-site-button");
    button.classList.add("shaka-no-propagation");
    const label = document.createElement("label");
    label.classList.add("shaka-overflow-button-label");
    label.classList.add("shaka-overflow-menu-only");
    label.classList.add("shaka-simple-overflow-button-label-inline");
    const img = document.createElement("img");
    img.src = FILSTREAM_BRAND.logoSrc;
    img.alt = "";
    img.width = 24;
    img.height = 24;
    img.decoding = "async";
    const text = document.createElement("span");
    text.textContent = "Open on FilStream";
    label.append(img, text);
    button.appendChild(label);
    button.setAttribute("aria-label", "Open FilStream page");
    this.parent.appendChild(button);
    this.eventManager.listen(button, "click", () => {
      window.open(buildViewerUrlWithoutEmbed(), "_blank", "noopener,noreferrer");
    });
  }
}

FilstreamSiteButton.Factory = class {
  /**
   * @param {HTMLElement} rootElement
   * @param {*} controls
   */
  create(rootElement, controls) {
    return new FilstreamSiteButton(rootElement, controls);
  }
};

function registerShakaCustomUi() {
  if (!filstreamOverflowRegistered && shaka.ui?.OverflowMenu?.registerElement) {
    filstreamOverflowRegistered = true;
    shaka.ui.OverflowMenu.registerElement("filstream", new FilstreamSiteButton.Factory());
  }
  if (!theaterControlRegistered && shaka.ui?.Controls?.registerElement && shakaContainerEl) {
    theaterControlRegistered = true;
    shaka.ui.Controls.registerElement("theater", new TheaterModeButton.Factory());
  }
}

function isApplePlaybackPlatform() {
  const v = navigator.vendor;
  if (typeof v === "string" && v.includes("Apple")) return true;
  return /iPhone|iPad|iPod/i.test(navigator.userAgent);
}

/**
 * @param {unknown} err
 */
function isShakaVideoError3016(err) {
  return (
    err !== null &&
    typeof err === "object" &&
    "code" in err &&
    /** @type {{ code?: number }} */ (err).code === 3016
  );
}

/**
 * @param {import("shaka-player").Player} player
 * @param {string} uri
 */
async function loadMasterWithMimeFallback(player, uri) {
  try {
    await player.load(uri, undefined, "application/x-mpegurl");
  } catch (firstErr) {
    try {
      await player.load(uri, undefined, "application/vnd.apple.mpegurl");
    } catch {
      throw firstErr;
    }
  }
}

/**
 * @param {import("shaka-player").Player} player
 * @param {string} uri
 */
async function loadMasterWithAppleMseFallback(player, uri) {
  try {
    await loadMasterWithMimeFallback(player, uri);
  } catch (e) {
    if (!isApplePlaybackPlatform() || !isShakaVideoError3016(e)) {
      throw e;
    }
    await player.unload();
    player.configure({
      streaming: {
        preferNativeHls: false,
        useNativeHlsOnSafari: false,
      },
    });
    await loadMasterWithMimeFallback(player, uri);
  }
}

/**
 * Shaka hides the buffering spinner when `pollBufferState_()` runs, which is
 * tied to media element events (`progress`, `canplaythrough`, …). On a cold
 * first load, those events can lag behind `load()` resolving so the internal
 * buffer observer stays STARVING with nothing left to fetch. Nudging the same
 * poll path after load fixes the stuck overlay; refresh often worked because
 * timing/caches aligned.
 *
 * @param {HTMLMediaElement | null} mediaEl
 */
function nudgeShakaBufferingPollAfterLoad(mediaEl) {
  if (!mediaEl) return;
  const nudge = () => {
    mediaEl.dispatchEvent(new Event("progress"));
    mediaEl.dispatchEvent(new Event("canplaythrough"));
  };
  nudge();
  queueMicrotask(nudge);
  requestAnimationFrame(() => nudge());
  mediaEl.addEventListener("loadeddata", nudge, { once: true });
  mediaEl.addEventListener("canplay", nudge, { once: true });
}

function stopPlaybackEndClamp() {
  playbackEndClampAbort?.abort();
  playbackEndClampAbort = null;
}

function stopWatchHistoryTracking() {
  watchHistoryTrackingAbort?.abort();
  watchHistoryTrackingAbort = null;
}

function stopResumePlaybackTracking() {
  if (resumePlaybackIntervalId) {
    clearInterval(resumePlaybackIntervalId);
    resumePlaybackIntervalId = 0;
  }
  resumePlaybackAbort?.abort();
  resumePlaybackAbort = null;
}

/**
 * @param {import("shaka-player").Player} player
 * @param {HTMLVideoElement} video
 */
function mediaDurationOrSeekEnd(player, video) {
  let dur = video.duration;
  if (!Number.isFinite(dur) || dur <= 0) {
    try {
      const end = player.seekRange().end;
      if (Number.isFinite(end) && end > 0) dur = end;
    } catch {
      /* ignore */
    }
  }
  return Number.isFinite(dur) && dur > 0 ? dur : null;
}

/**
 * @param {import("shaka-player").Player} player
 * @param {HTMLVideoElement} video
 * @param {string} videoId
 * @param {AbortSignal} signal
 */
function applyResumePlaybackOnLoad(player, video, videoId, signal) {
  const id = String(videoId || "").trim();
  if (!id) return;
  const raw = getResumePositionSeconds(id);
  if (raw == null || raw < 0) return;
  if (raw === 0) {
    clearResumePosition(id);
    return;
  }

  const run = () => {
    if (signal.aborted) return;
    const dur = mediaDurationOrSeekEnd(player, video);
    if (dur == null) return;
    const endFloor = Math.floor(dur);
    if (raw >= endFloor - 1) {
      clearResumePosition(id);
      return;
    }
    const clamped = Math.min(raw, Math.max(0, endFloor - 2));
    try {
      video.currentTime = clamped;
    } catch {
      /* ignore */
    }
  };

  queueMicrotask(run);
  video.addEventListener("loadedmetadata", run, { once: true, signal });
}

/**
 * Every 5s while playing, save `position-<videoId>` (whole seconds). Clear at start, end, or `ended`.
 *
 * @param {import("shaka-player").Player} player
 * @param {HTMLVideoElement} video
 * @param {string} videoId
 */
function installResumePlaybackTracking(player, video, videoId) {
  stopResumePlaybackTracking();
  const id = String(videoId || "").trim();
  if (!id) return;

  const ac = new AbortController();
  resumePlaybackAbort = ac;
  const { signal } = ac;

  applyResumePlaybackOnLoad(player, video, id, signal);

  /** Avoid saving until real playback has started (resume seek + buffer may lag behind `play`). */
  let persistEnabled = false;
  video.addEventListener(
    "playing",
    () => {
      persistEnabled = true;
    },
    { once: true, signal },
  );

  const persistTick = () => {
    if (signal.aborted || !persistEnabled || video.paused || video.ended) return;
    const dur = mediaDurationOrSeekEnd(player, video);
    const sec = Math.floor(video.currentTime);
    if (sec <= 0) {
      clearResumePosition(id);
      return;
    }
    if (dur != null && sec >= Math.floor(dur) - 1) {
      clearResumePosition(id);
      return;
    }
    setResumePositionSeconds(id, sec);
  };

  const startInterval = () => {
    if (signal.aborted) return;
    if (resumePlaybackIntervalId) {
      clearInterval(resumePlaybackIntervalId);
      resumePlaybackIntervalId = 0;
    }
    resumePlaybackIntervalId = window.setInterval(persistTick, 5000);
  };

  const stopInterval = () => {
    if (resumePlaybackIntervalId) {
      clearInterval(resumePlaybackIntervalId);
      resumePlaybackIntervalId = 0;
    }
  };

  video.addEventListener(
    "play",
    () => {
      startInterval();
    },
    { signal },
  );
  video.addEventListener("pause", stopInterval, { signal });
  video.addEventListener(
    "ended",
    () => {
      clearResumePosition(id);
      stopInterval();
    },
    { signal },
  );
}

/**
 * When playback crosses 95% of duration, persist a marker so catalog preview tiles show the bar.
 *
 * @param {import("shaka-player").Player} player
 * @param {HTMLVideoElement} video
 * @param {string} videoId
 */
function installWatchHistoryTracking(player, video, videoId) {
  stopWatchHistoryTracking();
  const id = String(videoId || "").trim();
  if (!id) return;

  const ratio = () => {
    let dur = video.duration;
    if (!Number.isFinite(dur) || dur <= 0) {
      try {
        const end = player.seekRange().end;
        if (Number.isFinite(end) && end > 0) dur = end;
      } catch {
        /* ignore */
      }
    }
    if (!Number.isFinite(dur) || dur <= 0) return null;
    return video.currentTime / dur;
  };

  const onProgress = () => {
    const r = ratio();
    if (r == null || r < 0.95) return;
    try {
      if (markWatchedTo95Percent(id)) {
        watchHistorySidebarRevision += 1;
      }
      if (!embedMode) {
        renderCatalogSidebar();
      }
    } finally {
      stopWatchHistoryTracking();
    }
  };

  const ac = new AbortController();
  watchHistoryTrackingAbort = ac;
  const { signal } = ac;

  video.addEventListener("timeupdate", onProgress, { signal });
  video.addEventListener("loadedmetadata", onProgress, { signal });
}

/**
 * Stopgap: when segment retrieval returns 200 (full piece) instead of 206, the
 * buffered timeline can extend past the real HLS duration and the player may
 * loop extra data. Clamp playback to Shaka's manifest-derived seek range end.
 *
 * @param {import("shaka-player").Player} player
 * @param {HTMLVideoElement} video
 */
function installPlaybackEndClamp(player, video) {
  stopPlaybackEndClamp();
  const ac = new AbortController();
  playbackEndClampAbort = ac;
  const { signal } = ac;

  const nearEndSlackSec = 0.12;
  const seekBackResetSec = 0.45;
  let clampedUntilSeekBack = false;

  const onTimeUpdate = () => {
    if (signal.aborted) return;
    let end;
    try {
      end = player.seekRange().end;
    } catch {
      return;
    }
    if (!Number.isFinite(end) || end <= 0) return;

    if (video.currentTime < end - seekBackResetSec) {
      clampedUntilSeekBack = false;
    }
    if (video.currentTime < end - nearEndSlackSec) return;
    if (clampedUntilSeekBack) return;
    clampedUntilSeekBack = true;

    video.pause();
    try {
      if (video.currentTime > end) {
        video.currentTime = end;
      }
    } catch {
      /* ignore */
    }
  };

  video.addEventListener("timeupdate", onTimeUpdate, { signal });
}

async function ensurePlayer() {
  if (shakaPlayer) return shakaPlayer;
  if (!shakaContainerEl || !videoEl) {
    throw new Error("viewer player elements missing");
  }
  registerShakaCustomUi();
  shaka.polyfill.installAll();
  shakaPlayer = new shaka.Player();
  shakaUiOverlay = new shaka.ui.Overlay(shakaPlayer, shakaContainerEl, videoEl);
  await shakaPlayer.attach(videoEl);
  const apple = isApplePlaybackPlatform();
  const reloadStrategy = shaka.config?.CodecSwitchingStrategy?.RELOAD ?? "reload";
  shakaPlayer.configure({
    abr: { enabled: true, useNetworkInformation: false },
    ...(apple
      ? {
          streaming: { preferNativeHls: true, useNativeHlsOnSafari: true },
          mediaSource: { codecSwitchingStrategy: reloadStrategy },
          preferredVideoCodecs: ["avc1", "avc3", "hvc1", "hev1"],
          preferredAudioCodecs: ["mp4a.40.2", "mp4a.40.5"],
        }
      : {}),
  });
  shakaUiOverlay.configure({
    controlPanelElements: [
      "play_pause",
      "time_and_duration",
      "spacer",
      "mute",
      "volume",
      "spacer",
      ...(theaterControlRegistered ? ["theater"] : []),
      "fullscreen",
      "overflow_menu",
    ],
    overflowMenuButtons: ["playback_rate", "quality", "filstream"],
    playbackRates: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2],
    enableTooltips: true,
  });
  videoEl.addEventListener("play", () => {
    isVideoPlaying = true;
  });
  const markStopped = () => {
    isVideoPlaying = false;
  };
  videoEl.addEventListener("pause", markStopped);
  videoEl.addEventListener("ended", markStopped);
  return shakaPlayer;
}

/**
 * @param {string} videoId
 * @param {string} sharePageUrl — `share.html` retrieval URL (OG) or viewer URL fallback
 */
function renderViewerActions(videoId, sharePageUrl) {
  if (!viewerActionsEl) return;
  if (embedMode || !videoId) {
    viewerActionsEl.hidden = true;
    render(nothing, viewerActionsEl);
    return;
  }
  viewerActionsEl.hidden = false;
  const shareIcon = svg`
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M18 16a3 3 0 0 0-2.816 1.98L8.91 14.77a3.02 3.02 0 0 0 0-1.54l6.273-3.21A3 3 0 1 0 14 8a3.02 3.02 0 0 0 .09.77L7.816 12A3 3 0 1 0 8 15a3.02 3.02 0 0 0-.09-.77l6.273 3.21A3 3 0 1 0 18 16Z"
      />
    </svg>
  `;
  const embedIcon = svg`
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="m8.6 16.6 1.4-1.4L6.8 12 10 8.8 8.6 7.4 4 12l4.6 4.6Zm6.8 0L20 12l-4.6-4.6-1.4 1.4L17.2 12 14 15.2l1.4 1.4Z"
      />
    </svg>
  `;
  const onShareClick = async () => {
    try {
      const url =
        typeof sharePageUrl === "string" && sharePageUrl.trim() !== ""
          ? sharePageUrl.trim()
          : buildAbsoluteViewerUrlForVideoId(videoId);
      const mode = await copyTextToClipboardBestEffort(url);
      if (mode === "clipboard") {
        showCatalogToast("URL copied");
      } else if (mode === "prompt") {
        showCatalogToast("URL ready — copy from the prompt");
      } else {
        showCatalogToast("Copy cancelled", { kind: "err" });
      }
    } catch {
      showCatalogToast("Could not copy URL", { kind: "err" });
    }
  };
  const onEmbedClick = async () => {
    try {
      const url = buildViewerUrlForVideoId(videoId, { embed: true });
      const mode = await copyTextToClipboardBestEffort(url);
      if (mode === "clipboard") {
        showCatalogToast("Embed URL copied");
      } else if (mode === "prompt") {
        showCatalogToast("Embed URL ready — copy from the prompt");
      } else {
        showCatalogToast("Copy cancelled", { kind: "err" });
      }
    } catch {
      showCatalogToast("Could not copy embed URL", { kind: "err" });
    }
  };
  render(
    html`
      <button
        type="button"
        class="viewer-action-btn--round"
        title="Copy share URL"
        aria-label="Copy share URL"
        @click=${() => void onShareClick()}
      >
        ${shareIcon}
      </button>
      <button
        type="button"
        class="viewer-action-btn--round"
        title="Copy embed URL"
        aria-label="Copy embed URL"
        @click=${() => void onEmbedClick()}
      >
        ${embedIcon}
      </button>
    `,
    viewerActionsEl,
  );
}

async function copyTextToClipboardBestEffort(text) {
  const t = String(text || "");
  if (!t) throw new Error("Nothing to copy");
  if (
    typeof navigator !== "undefined" &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === "function"
  ) {
    try {
      await navigator.clipboard.writeText(t);
      return "clipboard";
    } catch {
      /* fall through */
    }
  }
  const shown = window.prompt("Copy URL", t);
  return shown === null ? "cancelled" : "prompt";
}

function renderDonateBlock(metaLike) {
  if (!donateRootEl) return;
  const cfgLocal = donateConfigFromMeta(metaLike);
  if (!cfgLocal.enabled) {
    render(nothing, donateRootEl);
    return;
  }
  render(
    html`
      <div class="viewer-donate">
        <button
          type="button"
          class="btn btn-primary viewer-donate-btn"
          ?disabled=${donateBusy}
          @click=${() => void handleViewerDonateClick()}
        >
          ${donateBusy
            ? "Connecting…"
            : `Donate ${cfgLocal.amountHuman} ${cfgLocal.token.symbol}`}
        </button>
        ${donateError
          ? html`<p class="viewer-donate-err">${donateError}</p>`
          : nothing}
        ${donateTxHash
          ? html`<p class="viewer-donate-tx">Transaction sent: ${donateTxHash}</p>`
          : nothing}
      </div>
    `,
    donateRootEl,
  );
}

async function handleViewerDonateClick() {
  const meta = loadedMeta;
  if (!meta) return;
  const cfgLocal = donateConfigFromMeta(meta);
  if (!cfgLocal.enabled) return;
  const provider = resolveViewerProvider(null);
  if (!provider) {
    donateError = "No browser wallet found.";
    renderDonateBlock(meta);
    return;
  }
  donateBusy = true;
  donateError = "";
  donateTxHash = "";
  renderDonateBlock(meta);
  try {
    const { txHash } = await proposeDonateTransfer(provider, cfgLocal);
    donateTxHash = txHash;
  } catch (e) {
    donateError = e instanceof Error ? e.message : String(e);
  } finally {
    donateBusy = false;
    renderDonateBlock(meta);
  }
}

/**
 * @param {string} creator
 * @param {string} className
 */
function createCreatorAvatarLit(creator, className) {
  const url = profileUrlForCreator(creator);
  if (url) {
    return html`
      <img
        class=${className}
        alt=""
        loading="lazy"
        decoding="async"
        src=${url}
      />
    `;
  }
  return html`
    <div class=${`${className} viewer-creator-avatar--placeholder`} aria-hidden="true">
      ${creatorInitialForAddress(creator)}
    </div>
  `;
}

/**
 * @param {import("../services/filstream-catalog-chain.mjs").CatalogEntry} row
 * @param {{ showCreator?: boolean, variant?: string }} [opts]
 */
function movieShowcaseLit(row, opts = {}) {
  const showCreator = opts.showCreator !== false;
  const variant = opts.variant === "watch" ? "watch" : "discover";
  const safeTitle =
    String(row.title ?? "").trim() || String(row.assetId ?? "").trim() || "Untitled";
  return html`
    <movie-link-showcase
      .assetId=${row.assetId}
      .href=${buildViewerUrlForVideoId(row.assetId)}
      .videoTitle=${safeTitle}
      .showCreator=${showCreator}
      .creatorAddress=${row.creator}
      .creatorDisplayName=${bylineNameForCreator(row.creator)}
      .creatorAvatarUrl=${profileUrlForCreator(row.creator)}
      .variant=${variant}
      .current=${Boolean(currentVideoId && row.assetId === currentVideoId)}
      .watched95=${hasWatchedTo95Percent(row.assetId)}
    ></movie-link-showcase>
  `;
}

/**
 * @param {unknown} metaDoc
 * @param {import("../services/filstream-catalog-chain.mjs").CatalogEntry | null} [entry]
 */
async function renderViewerMeta(metaDoc, entry = null) {
  const meta = mergeMetaLikeDocument(metaDoc);
  loadedMeta = meta;
  if (!meta || !metaSection) return;
  metaSection.hidden = false;
  const copy = broadcastCopyFromMeta(meta);

  if (titleEl) titleEl.textContent = copy.title || entry?.title || "Untitled";
  if (descriptionEl) {
    const desc =
      typeof copy.description === "string" ? copy.description.trim() : "";
    render(
      html`<p class=${desc ? "broadcast-desc-body" : "broadcast-desc-empty"}>
        ${desc || "No description"}
      </p>`,
      descriptionEl,
    );
  }
  if (uploadDateEl) {
    const when = formatUploadDateLabel(meta);
    uploadDateEl.hidden = !when;
    uploadDateEl.textContent = when || "";
  }
  if (bylineEl && bylineCatalogEl) {
    const creator = entry?.creator ?? "";
    const creatorName = creator ? bylineNameForCreator(creator) : "";
    if (creatorName) {
      bylineEl.hidden = false;
      render(
        html`
          <div class="viewer-creator-cluster">
            <a
              class="viewer-creator-avatar-link"
              href=${buildCreatorUrlForAddress(creator)}
              title=${creatorName}
            >
              ${createCreatorAvatarLit(creator, "viewer-creator-avatar")}
            </a>
            <a class="viewer-creator-name" href=${buildCreatorUrlForAddress(creator)}>
              ${creatorName}
            </a>
          </div>
        `,
        bylineCatalogEl,
      );
    } else {
      bylineEl.hidden = true;
      render(nothing, bylineCatalogEl);
    }
  }
  renderDonateBlock(meta);
  const shareUrl = await resolveSharePageUrl(metaDoc, entry);
  renderViewerActions(currentVideoId || "", shareUrl);
}

function renderCatalogDiscovery(active) {
  if (!catalogAside) return;
  const activeEl = document.activeElement;
  const shouldRestoreSearchFocus =
    activeEl instanceof HTMLInputElement && activeEl.id === "filstream-global-search";
  const selStart = shouldRestoreSearchFocus ? activeEl.selectionStart : null;
  const selEnd = shouldRestoreSearchFocus ? activeEl.selectionEnd : null;

  catalogAside.hidden = false;

  const toolbar = html`
    <div class="viewer-catalog-toolbar">
      <h2 class="viewer-catalog-head">Discover</h2>
    </div>
  `;

  if (!active.length) {
    render(
      html`${toolbar}<p class="viewer-catalog-note">No videos yet.</p>`,
      catalogAside,
    );
    const globalSearch = G_REF.host?.querySelector("#filstream-global-search");
    if (shouldRestoreSearchFocus && globalSearch instanceof HTMLInputElement) {
      requestAnimationFrame(() => {
        globalSearch.focus();
        if (selStart != null && selEnd != null) {
          globalSearch.setSelectionRange(selStart, selEnd);
        }
      });
    }
    return;
  }
  const query = catalogSearchQuery.trim().toLowerCase();

  /** @type {import("../services/filstream-catalog-chain.mjs").CatalogEntry[]} */
  const renderedRows = [];

  const latestRows = active
    .filter((row) => matchesCreatorSearch(row.creator, query))
    .slice(0, 10);
  for (const row of latestRows) renderedRows.push(row);

  const latestSection = html`
    <section class="viewer-catalog-section">
      <h3 class="viewer-catalog-section-head">Latest uploads</h3>
      ${!latestRows.length
        ? html`<p class="viewer-catalog-note">No videos match this search.</p>`
        : html`
            <div class="viewer-catalog-grid">
              ${repeat(
                latestRows,
                (row) => row.assetId,
                (row) => movieShowcaseLit(row, { showCreator: true }),
              )}
            </div>
          `}
    </section>
  `;

  /** @type {Map<string, { creator: string, rows: import("../services/filstream-catalog-chain.mjs").CatalogEntry[], count: number, latestCreatedAt: number }>} */
  const creatorBuckets = new Map();
  for (const row of active) {
    const key = normalizeCreatorKey(row.creator);
    if (!creatorBuckets.has(key)) {
      creatorBuckets.set(key, {
        creator: row.creator,
        rows: [],
        count: 0,
        latestCreatedAt: row.createdAt,
      });
    }
    const bucket = creatorBuckets.get(key);
    if (!bucket) continue;
    bucket.rows.push(row);
    bucket.count += 1;
    if (row.createdAt > bucket.latestCreatedAt) {
      bucket.latestCreatedAt = row.createdAt;
    }
  }

  const topCreators = [...creatorBuckets.values()]
    .sort((a, b) => {
      if (a.count !== b.count) return b.count - a.count;
      if (a.latestCreatedAt !== b.latestCreatedAt) {
        return b.latestCreatedAt - a.latestCreatedAt;
      }
      return normalizeCreatorKey(a.creator).localeCompare(normalizeCreatorKey(b.creator));
    })
    .slice(0, 10)
    .filter((bucket) => matchesCreatorSearch(bucket.creator, query));

  for (const bucket of topCreators) {
    for (const row of sortEntriesNewestFirst(bucket.rows)) renderedRows.push(row);
  }

  const creatorSections = repeat(
    topCreators,
    (bucket) => normalizeCreatorKey(bucket.creator),
    (bucket) => html`
      <section class="viewer-catalog-section">
        <div class="viewer-catalog-creator-head">
          <a class="viewer-catalog-creator-link" href=${buildCreatorUrlForAddress(bucket.creator)}>
            ${createCreatorAvatarLit(bucket.creator, "viewer-catalog-creator-head-avatar")}
            <span class="viewer-catalog-creator-head-title">
              ${bylineNameForCreator(bucket.creator)}
            </span>
          </a>
          <span class="viewer-catalog-creator-count">
            ${bucket.count} upload${bucket.count === 1 ? "" : "s"}
          </span>
        </div>
        <div class="viewer-catalog-grid">
          ${repeat(
            sortEntriesNewestFirst(bucket.rows),
            (row) => row.assetId,
            (row) => movieShowcaseLit(row, { showCreator: false }),
          )}
        </div>
      </section>
    `,
  );

  render(
    html`
      ${toolbar}
      ${latestSection}
      ${creatorSections}
      ${!topCreators.length
        ? html`<p class="viewer-catalog-note">No creators match this search.</p>`
        : nothing}
    `,
    catalogAside,
  );

  const globalSearch = G_REF.host?.querySelector("#filstream-global-search");
  if (shouldRestoreSearchFocus && globalSearch instanceof HTMLInputElement) {
    requestAnimationFrame(() => {
      globalSearch.focus();
      if (selStart != null && selEnd != null) {
        globalSearch.setSelectionRange(selStart, selEnd);
      }
    });
  }

  void hydrateCatalogPosters(renderedRows);
}

function renderCatalogWatch(active) {
  if (!catalogAside) return;
  catalogAside.hidden = false;

  const heading = html`<h2 class="viewer-catalog-head">More from creator</h2>`;

  if (!active.length) {
    render(
      html`${heading}<p class="viewer-catalog-note">No videos yet.</p>`,
      catalogAside,
    );
    return;
  }

  const current = active.find((row) => row.assetId === currentVideoId) ?? null;
  if (!current) {
    render(
      html`${heading}<p class="viewer-catalog-note">Creator list is loading…</p>`,
      catalogAside,
    );
    return;
  }

  const sameCreator = sortEntriesNewestFirst(
    active.filter(
      (row) =>
        row.assetId !== currentVideoId &&
        normalizeCreatorKey(row.creator) === normalizeCreatorKey(current.creator),
    ),
  );

  if (!sameCreator.length) {
    render(
      html`
        ${heading}
        <a class="viewer-watch-creator-link" href=${buildCreatorUrlForAddress(current.creator)}>
          ${createCreatorAvatarLit(current.creator, "viewer-catalog-creator-head-avatar")}
          <span class="viewer-catalog-creator-head-title">
            ${bylineNameForCreator(current.creator)}
          </span>
        </a>
        <p class="viewer-catalog-note">No other videos from this creator yet.</p>
      `,
      catalogAside,
    );
    return;
  }

  const renderedRows = sameCreator;
  render(
    html`
      ${heading}
      <a class="viewer-watch-creator-link" href=${buildCreatorUrlForAddress(current.creator)}>
        ${createCreatorAvatarLit(current.creator, "viewer-catalog-creator-head-avatar")}
        <span class="viewer-catalog-creator-head-title">
          ${bylineNameForCreator(current.creator)}
        </span>
      </a>
      <div class="viewer-watch-list">
        ${repeat(
          renderedRows,
          (row) => row.assetId,
          (row) => movieShowcaseLit(row, { showCreator: false, variant: "watch" }),
        )}
      </div>
    `,
    catalogAside,
  );
  void hydrateCatalogPosters(renderedRows);
}

function renderCatalogSidebar() {
  if (!catalogAside || embedMode) return;
  const active = sortEntriesNewestFirst(catalogEntries.filter((x) => x.active));
  if (inWatchMode()) {
    renderCatalogWatch(active);
  } else {
    renderCatalogDiscovery(active);
  }
  lastRenderedCatalogSidebarSignature = computeCatalogSidebarSignature();
}

/**
 * @param {import("../services/filstream-catalog-chain.mjs").CatalogEntry[]} rows
 */
async function hydrateCatalogPosters(rows) {
  if (!catalogAside) return;
  await awaitMovieLinkShowcaseUpdates(catalogAside);
  /** @type {Map<string, HTMLImageElement[]>} */
  const imagesByVideoId = new Map();
  const hosts = catalogAside.querySelectorAll("movie-link-showcase");
  for (const host of hosts) {
    const img = /** @type {HTMLImageElement | null} */ (
      host.shadowRoot?.querySelector(".viewer-catalog-card-thumb--still")
    );
    if (!img) continue;
    const videoId = String(img.dataset.videoId || "").trim();
    if (!videoId) continue;
    const list = imagesByVideoId.get(videoId) ?? [];
    list.push(img);
    imagesByVideoId.set(videoId, list);
  }

  const seen = new Set();
  /** @type {Promise<void>[]} */
  const tasks = [];
  for (const row of rows) {
    const videoId = String(row.assetId || "").trim();
    if (!videoId || seen.has(videoId)) continue;
    seen.add(videoId);
    const targets = imagesByVideoId.get(videoId) ?? [];
    if (!targets.length) continue;
    tasks.push(
      (async () => {
        try {
          const { manifestDoc } = await loadManifestForVideo(videoId, row);
          const still = posterUrlFromDoc(manifestDoc);
          const anim = posterAnimUrlFromDoc(manifestDoc);
          for (const img of targets) {
            const wrap = img.parentElement;
            if (still) img.src = still;
            if (still && anim && wrap instanceof HTMLElement) {
              wrap.classList.add("viewer-catalog-card-thumb-wrap--anim");
              let motion = wrap.querySelector(".viewer-catalog-card-thumb--motion");
              if (!(motion instanceof HTMLImageElement)) {
                motion = document.createElement("img");
                motion.className =
                  "viewer-catalog-card-thumb viewer-catalog-card-thumb--motion";
                motion.alt = "";
                motion.loading = "lazy";
                motion.decoding = "async";
                wrap.appendChild(motion);
              }
              motion.src = anim;
            }
          }
        } catch {
          /* ignore per-item failures */
        }
      })(),
    );
  }
  await Promise.all(tasks);
}

/**
 * @param {string} videoId
 * @param {import("../services/filstream-catalog-chain.mjs").CatalogEntry} entry
 * @returns {Promise<{ manifestUrl: string, manifestDoc: unknown }>}
 */
async function loadManifestForVideo(videoId, entry) {
  const cached = await loadManifestCache(videoId);
  if (cached?.manifestDoc) {
    return {
      manifestUrl: cached.manifestUrl,
      manifestDoc: cached.manifestDoc,
    };
  }
  const manifestUrl = await resolveManifestUrl(entry.providerId, entry.manifestCid);
  const res = await fetch(manifestUrl);
  if (!res.ok) {
    throw new Error(`manifest.json HTTP ${res.status}`);
  }
  const manifestDoc = await res.json();
  await saveManifestCache({ videoId, manifestUrl, manifestDoc });
  return { manifestUrl, manifestDoc };
}

/**
 * Best-effort on-chain lookup when local cache/cursor misses a known `videoId`.
 *
 * @param {string} videoId
 * @returns {Promise<import("../services/filstream-catalog-chain.mjs").CatalogEntry | null>}
 */
async function findEntryByVideoIdFromChain(videoId) {
  const target = String(videoId || "").trim();
  if (!target || !isCatalogConfigured()) return null;
  const pageSize = Math.min(250, Math.max(25, CATALOG_PAGE_SIZE));
  let offset = 0;
  for (let pageCount = 0; pageCount < 100; pageCount++) {
    const page = await readCatalogLatest({
      offset,
      limit: pageSize,
      activeOnly: false,
    });
    if (!page.length) return null;
    await cacheCatalogEntries(page);
    const hit = page.find((row) => row.assetId === target && row.active);
    if (hit) return hit;
    offset += page.length;
    if (page.length < pageSize) return null;
  }
  return null;
}

/**
 * @param {string} videoId
 * @returns {Promise<import("../services/filstream-catalog-chain.mjs").CatalogEntry | null>}
 */
async function resolveEntryForVideo(videoId) {
  let entry = await findCachedEntryByVideoId(videoId);
  if (entry && entry.active) return entry;
  await syncCatalogOnce(true);
  entry = await findCachedEntryByVideoId(videoId);
  if (entry && entry.active) return entry;
  entry = await findEntryByVideoIdFromChain(videoId);
  if (entry && entry.active) return entry;
  return null;
}

/**
 * @param {string} videoId
 */
async function openVideoById(videoId) {
  currentVideoId = videoId.trim();
  stopPlaybackEndClamp();
  stopWatchHistoryTracking();
  stopResumePlaybackTracking();
  applyCatalogPageLayout();
  renderCatalogSidebar();
  if (!currentVideoId) {
    setStatus("", "");
    return;
  }
  if (!isCatalogConfigured()) {
    setStatus("Catalog is not configured on this deployment.", "err");
    return;
  }
  setStatus("Loading video…", "");
  const entry = await resolveEntryForVideo(currentVideoId);
  if (!entry) {
    setStatus("Video not found in catalog.", "err");
    return;
  }
  renderCatalogSidebar();
  const { manifestDoc } = await loadManifestForVideo(currentVideoId, entry);
  const playback = parsePlaybackBlock(manifestDoc);
  const master =
    typeof playback.masterAppUrl === "string" ? playback.masterAppUrl.trim() : "";
  if (!master) {
    throw new Error("manifest.json has no playback.masterAppUrl");
  }
  const merged = mergeMetaLikeDocument(manifestDoc);
  const poster = posterUrlFromDoc(manifestDoc) || "";
  if (poster && videoEl) {
    videoEl.setAttribute("poster", poster);
  }
  const player = await ensurePlayer();
  await loadMasterWithAppleMseFallback(player, master);
  nudgeShakaBufferingPollAfterLoad(videoEl);
  if (videoEl) {
    installPlaybackEndClamp(player, videoEl);
    installWatchHistoryTracking(player, videoEl, currentVideoId);
    installResumePlaybackTracking(player, videoEl, currentVideoId);
  }
  await renderViewerMeta(merged ?? manifestDoc, entry);
  setStatus("");
}

async function bootstrapCatalogState() {
  if (!isCatalogConfigured()) return;
  await refreshEntriesFromCache();
  if (!(await loadCatalogCursor())) {
    const c = maxCursorFromEntries(catalogEntries);
    if (c) await saveCatalogCursor(c);
  }
  await syncCatalogOnce(true);
  startCatalogSyncLoop();
}

/** @param {import("lit").LitElement} host */
export async function initCatalogPage(host) {
  G_REF.host = host;
  cacheCatalogPageRefs();
  if (brandMount && !embedMode) {
    mountFilstreamHeader(brandMount, { active: "", searchManaged: true });
    void hydrateFilstreamHeaderProfile(
      brandMount.querySelector("[data-filstream-header]"),
    );
    wireGlobalSearch();
    initLandingToast();
  } else if (brandMount) {
    brandMount.hidden = true;
  }

  try {
    await unregisterLegacyPieceHeadServiceWorker();
    applyCatalogPageLayout();
    await bootstrapCatalogState();
    if (requestedVideoId) {
      await openVideoById(requestedVideoId);
    } else {
      renderViewerActions("");
      setStatus("", "");
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setStatus(`Playback failed: ${msg}`, "err");
  }
}

window.addEventListener("beforeunload", () => {
  destroyed = true;
  stopPlaybackEndClamp();
  stopWatchHistoryTracking();
  stopResumePlaybackTracking();
  if (syncIntervalId) {
    clearInterval(syncIntervalId);
    syncIntervalId = 0;
  }
  if (shakaPlayer) {
    void shakaPlayer.destroy();
    shakaPlayer = null;
  }
});
