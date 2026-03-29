/**
 * Viewer entry:
 * - Discover: `index.html` · Playback: `viewer.html?videoId=<asset-id>[&embed=true]`
 *
 * Catalog discovery is on-chain (`CatalogRegistry`) with IndexedDB cache:
 * - entries are synced every ~30s when visible (or when hidden but video is playing)
 * - creator username/profile picture are refreshed for visible creators on the same cadence
 * - manifest.json is fetched once per `videoId` and then reused from cache
 */
import {
  CATALOG_CREATOR_PROFILE_SYNC_LIMIT,
  CATALOG_FULL_REFRESH_MS,
  CATALOG_PAGE_SIZE,
} from "../filstream-constants.mjs";
import {
  broadcastCopyFromMeta,
  formatUploadDateLabel,
} from "../filstream-broadcast-view.mjs";
import {
  hydrateFilstreamHeaderProfile,
  FILSTREAM_BRAND,
  mountFilstreamHeader,
} from "../filstream-brand.mjs";
import {
  buildCreatorUrlForAddress,
  buildDiscoverHomeUrlWithSearchQuery,
  buildViewerUrlForVideoId,
  getFilstreamStoreConfig,
} from "../filstream-config.mjs";
import {
  cacheCatalogEntries,
  findCachedEntryByVideoId,
  loadCachedCatalogEntries,
  loadCatalogCursor,
  loadCachedCreatorProfiles,
  loadLastFullRefreshAtMs,
  loadManifestCache,
  saveCatalogCursor,
  saveCachedCreatorProfiles,
  saveLastFullRefreshAtMs,
  saveManifestCache,
} from "../filstream-catalog-cache.mjs";
import {
  isCatalogConfigured,
  readCatalogLatest,
  readCatalogNewerThan,
  readCatalogProfilePicturePieceCid,
  readCatalogUsername,
  resolveManifestUrl,
} from "../filstream-catalog-chain.mjs";
import {
  donateConfigFromMeta,
  proposeDonateTransfer,
  resolveViewerProvider,
} from "../filstream-viewer-donate.mjs";

const shaka = (
  await import("https://esm.sh/shaka-player@4.7.11/dist/shaka-player.ui.js")
).default;

const params = new URLSearchParams(window.location.search);
const embedMode = params.get("embed") === "true";
const requestedVideoId = (params.get("videoId") || "").trim();
const LANDING_TOAST_STORAGE_KEY = "filstream-welcome-dismissed";

if (embedMode) {
  document.documentElement.classList.add("viewer-embed");
}

const statusEl = document.getElementById("viewer-status");
const videoEl = /** @type {HTMLVideoElement | null} */ (document.getElementById("viewer-video"));
const rootEl = document.getElementById("root");
const playerBlockEl = document.querySelector(".viewer-player-block");
const metaSection = document.getElementById("viewer-meta");
const titleEl = document.getElementById("viewer-title");
const uploadDateEl = document.getElementById("viewer-upload-date");
const descriptionEl = document.getElementById("viewer-description");
const bylineEl = document.getElementById("viewer-byline");
const bylineCatalogEl = document.getElementById("viewer-byline-catalog");
const donateRootEl = document.getElementById("viewer-donate-root");
const viewerActionsEl = document.getElementById("viewer-actions");
const shakaContainerEl = document.getElementById("viewer-shaka-container");
const catalogAside = document.getElementById("viewer-catalog");

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
/** @type {import("../filstream-catalog-chain.mjs").CatalogEntry[]} */
let catalogEntries = [];
/** @type {Map<string, { username: string, profilePieceCid: string, profileUrl: string, updatedAtMs: number }>} */
const creatorProfileCache = new Map();
let currentVideoId = requestedVideoId;
let catalogSearchQuery = (params.get("q") || "").trim();
let syncInFlight = false;
let syncIntervalId = 0;
let isVideoPlaying = false;
let destroyed = false;
const cfg = getFilstreamStoreConfig();
const syncIntervalMs = Math.max(5_000, cfg.catalogSyncIntervalMs);

const brandMount = document.getElementById("viewer-brand-mount");
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

function setStatus(msg, kind) {
  if (!statusEl) return;
  statusEl.textContent = msg;
  statusEl.className = `viewer-status${kind === "err" ? " err" : ""}`;
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
  const searchEl = document.getElementById("filstream-global-search");
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
  const el = document.getElementById("filstream-landing-toast");
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

function applyViewerModeLayout() {
  if (embedMode) return;
  const watch = inWatchMode();
  if (rootEl) {
    rootEl.classList.toggle("viewer-layout--watch", watch);
    rootEl.classList.toggle("viewer-layout--discover", !watch);
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

function matchesCreatorSearch(creator, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  const addr = String(creator || "").toLowerCase();
  const name = bylineNameForCreator(creator).toLowerCase();
  return addr.includes(q) || name.includes(q);
}

/**
 * @param {import("../filstream-catalog-chain.mjs").CatalogEntry[]} rows
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
 * @param {import("../filstream-catalog-chain.mjs").CatalogEntry[]} rows
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
 * @param {import("../filstream-catalog-chain.mjs").CatalogEntry[]} rows
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
  await hydrateCreatorProfilesFromCache(catalogEntries);
  renderCatalogSidebar();
}

/**
 * @param {import("../filstream-catalog-chain.mjs").CatalogEntry[]} rows
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
  /** @type {import("../filstream-catalog-chain.mjs").CatalogEntry[]} */
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
          renderViewerMeta(loadedMeta, currentEntry);
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

function renderViewerActions(videoId) {
  if (!viewerActionsEl) return;
  if (embedMode || !videoId) {
    viewerActionsEl.hidden = true;
    viewerActionsEl.replaceChildren();
    return;
  }
  viewerActionsEl.hidden = false;
  const wrap = document.createDocumentFragment();

  const shareBtn = document.createElement("button");
  shareBtn.type = "button";
  shareBtn.className = "viewer-action-btn--round";
  shareBtn.title = "Copy share URL";
  shareBtn.setAttribute("aria-label", "Copy share URL");
  shareBtn.innerHTML =
    '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18 16a3 3 0 0 0-2.816 1.98L8.91 14.77a3.02 3.02 0 0 0 0-1.54l6.273-3.21A3 3 0 1 0 14 8a3.02 3.02 0 0 0 .09.77L7.816 12A3 3 0 1 0 8 15a3.02 3.02 0 0 0-.09-.77l6.273 3.21A3 3 0 1 0 18 16Z"/></svg>';
  shareBtn.addEventListener("click", async () => {
    try {
      const url = buildViewerUrlForVideoId(videoId);
      const mode = await copyTextToClipboardBestEffort(url);
      if (mode === "clipboard") {
        setStatus("Share URL copied.", "");
      } else if (mode === "prompt") {
        setStatus("Share URL ready to copy.", "");
      } else {
        setStatus("Share copy cancelled.", "err");
      }
    } catch {
      setStatus("Could not copy share URL.", "err");
    }
  });
  wrap.appendChild(shareBtn);

  const embedBtn = document.createElement("button");
  embedBtn.type = "button";
  embedBtn.className = "viewer-action-btn--round";
  embedBtn.title = "Copy embed URL";
  embedBtn.setAttribute("aria-label", "Copy embed URL");
  embedBtn.innerHTML =
    '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="m8.6 16.6 1.4-1.4L6.8 12 10 8.8 8.6 7.4 4 12l4.6 4.6Zm6.8 0L20 12l-4.6-4.6-1.4 1.4L17.2 12 14 15.2l1.4 1.4Z"/></svg>';
  embedBtn.addEventListener("click", async () => {
    try {
      const url = buildViewerUrlForVideoId(videoId, { embed: true });
      const mode = await copyTextToClipboardBestEffort(url);
      if (mode === "clipboard") {
        setStatus("Embed URL copied.", "");
      } else if (mode === "prompt") {
        setStatus("Embed URL ready to copy.", "");
      } else {
        setStatus("Embed copy cancelled.", "err");
      }
    } catch {
      setStatus("Could not copy embed URL.", "err");
    }
  });
  wrap.appendChild(embedBtn);

  viewerActionsEl.replaceChildren(wrap);
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
  donateRootEl.innerHTML = "";
  const cfgLocal = donateConfigFromMeta(metaLike);
  if (!cfgLocal.enabled) return;
  const wrap = document.createElement("div");
  wrap.className = "viewer-donate";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn btn-primary viewer-donate-btn";
  btn.disabled = donateBusy;
  btn.textContent = donateBusy
    ? "Connecting…"
    : `Donate ${cfgLocal.amountHuman} ${cfgLocal.token.symbol}`;
  btn.addEventListener("click", () => void handleViewerDonateClick());
  wrap.appendChild(btn);

  if (donateError) {
    const err = document.createElement("p");
    err.className = "viewer-donate-err";
    err.textContent = donateError;
    wrap.appendChild(err);
  }
  if (donateTxHash) {
    const tx = document.createElement("p");
    tx.className = "viewer-donate-tx";
    tx.textContent = `Transaction sent: ${donateTxHash}`;
    wrap.appendChild(tx);
  }
  donateRootEl.appendChild(wrap);
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

function createCreatorAvatarElement(creator, className) {
  const url = profileUrlForCreator(creator);
  if (url) {
    const img = document.createElement("img");
    img.className = className;
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    img.src = url;
    return img;
  }
  const placeholder = document.createElement("div");
  placeholder.className = `${className} viewer-creator-avatar--placeholder`;
  placeholder.setAttribute("aria-hidden", "true");
  placeholder.textContent = creatorInitialForAddress(creator);
  return placeholder;
}

function createCatalogCard(row, opts = {}) {
  const showCreator = opts.showCreator !== false;
  const variant = opts.variant === "watch" ? "watch" : "discover";
  const safeTitle =
    String(row.title ?? "").trim() || String(row.assetId ?? "").trim() || "Untitled";
  const a = document.createElement("a");
  a.className = "viewer-catalog-card";
  if (variant === "watch") {
    a.classList.add("viewer-catalog-card--watch");
  }
  if (currentVideoId && row.assetId === currentVideoId) {
    a.classList.add("viewer-catalog-card--current");
  }
  a.href = buildViewerUrlForVideoId(row.assetId);
  a.title = safeTitle;

  const thumbWrap = document.createElement("div");
  thumbWrap.className = "viewer-catalog-card-thumb-wrap";
  const thumb = document.createElement("img");
  thumb.className = "viewer-catalog-card-thumb viewer-catalog-card-thumb--still";
  thumb.alt = "";
  thumb.loading = "lazy";
  thumb.decoding = "async";
  thumb.dataset.videoId = row.assetId;
  thumbWrap.appendChild(thumb);

  const body = document.createElement("div");
  body.className = "viewer-catalog-card-body";
  const title = document.createElement("div");
  title.className = "viewer-catalog-card-title";
  title.textContent = safeTitle;
  body.appendChild(title);

  if (showCreator) {
    const creatorLine = document.createElement("div");
    creatorLine.className = "viewer-catalog-card-creator";
    creatorLine.appendChild(
      createCreatorAvatarElement(row.creator, "viewer-catalog-card-creator-avatar"),
    );
    const creatorName = document.createElement("span");
    creatorName.className = "viewer-catalog-card-creator-name";
    creatorName.textContent = bylineNameForCreator(row.creator);
    creatorLine.appendChild(creatorName);
    body.appendChild(creatorLine);
  }

  a.append(thumbWrap, body);
  return a;
}

/**
 * @param {unknown} metaDoc
 * @param {import("../filstream-catalog-chain.mjs").CatalogEntry | null} [entry]
 */
function renderViewerMeta(metaDoc, entry = null) {
  const meta = mergeMetaLikeDocument(metaDoc);
  loadedMeta = meta;
  if (!meta || !metaSection) return;
  metaSection.hidden = false;
  const copy = broadcastCopyFromMeta(meta);

  if (titleEl) titleEl.textContent = copy.title || entry?.title || "Untitled";
  if (descriptionEl) {
    descriptionEl.innerHTML = "";
    const desc =
      typeof copy.description === "string" ? copy.description.trim() : "";
    const p = document.createElement("p");
    if (desc) {
      p.className = "broadcast-desc-body";
      p.textContent = desc;
    } else {
      p.className = "broadcast-desc-empty";
      p.textContent = "No description";
    }
    descriptionEl.appendChild(p);
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
      bylineCatalogEl.innerHTML = "";
      const cluster = document.createElement("div");
      cluster.className = "viewer-creator-cluster";

      const avatarLink = document.createElement("a");
      avatarLink.href = buildCreatorUrlForAddress(creator);
      avatarLink.className = "viewer-creator-avatar-link";
      avatarLink.title = creatorName;
      avatarLink.appendChild(createCreatorAvatarElement(creator, "viewer-creator-avatar"));

      const link = document.createElement("a");
      link.href = buildCreatorUrlForAddress(creator);
      link.className = "viewer-creator-name";
      link.textContent = `By ${creatorName}`;

      cluster.append(avatarLink, link);
      bylineCatalogEl.appendChild(cluster);
    } else {
      bylineEl.hidden = true;
      bylineCatalogEl.textContent = "";
    }
  }
  renderDonateBlock(meta);
  renderViewerActions(currentVideoId || "");
}

function renderCatalogDiscovery(active) {
  if (!catalogAside) return;
  const activeEl = document.activeElement;
  const shouldRestoreSearchFocus =
    activeEl instanceof HTMLInputElement && activeEl.id === "filstream-global-search";
  const selStart = shouldRestoreSearchFocus ? activeEl.selectionStart : null;
  const selEnd = shouldRestoreSearchFocus ? activeEl.selectionEnd : null;

  catalogAside.hidden = false;
  catalogAside.innerHTML = "";

  const toolbar = document.createElement("div");
  toolbar.className = "viewer-catalog-toolbar";
  const heading = document.createElement("h2");
  heading.className = "viewer-catalog-head";
  heading.textContent = "Discover";
  toolbar.appendChild(heading);
  catalogAside.appendChild(toolbar);

  const globalSearch = document.getElementById("filstream-global-search");
  if (shouldRestoreSearchFocus && globalSearch instanceof HTMLInputElement) {
    globalSearch.focus();
    if (selStart != null && selEnd != null) {
      globalSearch.setSelectionRange(selStart, selEnd);
    }
  }

  if (!active.length) {
    const p = document.createElement("p");
    p.className = "viewer-catalog-note";
    p.textContent = "No videos yet.";
    catalogAside.appendChild(p);
    return;
  }
  const query = catalogSearchQuery.trim().toLowerCase();

  /** @type {import("../filstream-catalog-chain.mjs").CatalogEntry[]} */
  const renderedRows = [];

  const latestRows = active
    .filter((row) => matchesCreatorSearch(row.creator, query))
    .slice(0, 10);
  const latestSection = document.createElement("section");
  latestSection.className = "viewer-catalog-section";
  const latestHead = document.createElement("h3");
  latestHead.className = "viewer-catalog-section-head";
  latestHead.textContent = "Latest uploads";
  latestSection.appendChild(latestHead);
  if (!latestRows.length) {
    const p = document.createElement("p");
    p.className = "viewer-catalog-note";
    p.textContent = "No videos match this search.";
    latestSection.appendChild(p);
  } else {
    const strip = document.createElement("div");
    strip.className = "viewer-catalog-strip";
    for (const row of latestRows) {
      strip.appendChild(createCatalogCard(row, { showCreator: true }));
      renderedRows.push(row);
    }
    latestSection.appendChild(strip);
  }
  catalogAside.appendChild(latestSection);

  /** @type {Map<string, { creator: string, rows: import("../filstream-catalog-chain.mjs").CatalogEntry[], count: number, latestCreatedAt: number }>} */
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
    const creatorSection = document.createElement("section");
    creatorSection.className = "viewer-catalog-section";

    const creatorHead = document.createElement("div");
    creatorHead.className = "viewer-catalog-creator-head";
    const creatorLink = document.createElement("a");
    creatorLink.className = "viewer-catalog-creator-link";
    creatorLink.href = buildCreatorUrlForAddress(bucket.creator);
    creatorLink.appendChild(
      createCreatorAvatarElement(bucket.creator, "viewer-catalog-creator-head-avatar"),
    );
    const creatorTitle = document.createElement("span");
    creatorTitle.className = "viewer-catalog-creator-head-title";
    creatorTitle.textContent = bylineNameForCreator(bucket.creator);
    creatorLink.appendChild(creatorTitle);
    creatorHead.appendChild(creatorLink);

    const creatorCount = document.createElement("span");
    creatorCount.className = "viewer-catalog-creator-count";
    creatorCount.textContent = `${bucket.count} upload${bucket.count === 1 ? "" : "s"}`;
    creatorHead.appendChild(creatorCount);
    creatorSection.appendChild(creatorHead);

    const strip = document.createElement("div");
    strip.className = "viewer-catalog-strip";
    const rows = sortEntriesNewestFirst(bucket.rows);
    for (const row of rows) {
      strip.appendChild(createCatalogCard(row, { showCreator: false }));
      renderedRows.push(row);
    }
    creatorSection.appendChild(strip);
    catalogAside.appendChild(creatorSection);
  }

  if (!topCreators.length) {
    const p = document.createElement("p");
    p.className = "viewer-catalog-note";
    p.textContent = "No creators match this search.";
    catalogAside.appendChild(p);
  }

  void hydrateCatalogPosters(renderedRows);
}

function renderCatalogWatch(active) {
  if (!catalogAside) return;
  catalogAside.hidden = false;
  catalogAside.innerHTML = "";

  const heading = document.createElement("h2");
  heading.className = "viewer-catalog-head";
  heading.textContent = "More from creator";
  catalogAside.appendChild(heading);

  if (!active.length) {
    const p = document.createElement("p");
    p.className = "viewer-catalog-note";
    p.textContent = "No videos yet.";
    catalogAside.appendChild(p);
    return;
  }

  const current = active.find((row) => row.assetId === currentVideoId) ?? null;
  if (!current) {
    const p = document.createElement("p");
    p.className = "viewer-catalog-note";
    p.textContent = "Creator list is loading…";
    catalogAside.appendChild(p);
    return;
  }

  const creatorLink = document.createElement("a");
  creatorLink.className = "viewer-watch-creator-link";
  creatorLink.href = buildCreatorUrlForAddress(current.creator);
  creatorLink.appendChild(
    createCreatorAvatarElement(current.creator, "viewer-catalog-creator-head-avatar"),
  );
  const creatorTitle = document.createElement("span");
  creatorTitle.className = "viewer-catalog-creator-head-title";
  creatorTitle.textContent = bylineNameForCreator(current.creator);
  creatorLink.appendChild(creatorTitle);
  catalogAside.appendChild(creatorLink);

  const sameCreator = sortEntriesNewestFirst(
    active.filter(
      (row) =>
        row.assetId !== currentVideoId &&
        normalizeCreatorKey(row.creator) === normalizeCreatorKey(current.creator),
    ),
  );

  const count = document.createElement("p");
  count.className = "viewer-watch-count";
  count.textContent = `${sameCreator.length} other video${sameCreator.length === 1 ? "" : "s"}`;
  catalogAside.appendChild(count);

  if (!sameCreator.length) {
    const p = document.createElement("p");
    p.className = "viewer-catalog-note";
    p.textContent = "No other videos from this creator yet.";
    catalogAside.appendChild(p);
    return;
  }

  const list = document.createElement("div");
  list.className = "viewer-watch-list";
  const renderedRows = sameCreator;
  for (const row of renderedRows) {
    list.appendChild(createCatalogCard(row, { showCreator: false, variant: "watch" }));
  }
  catalogAside.appendChild(list);
  void hydrateCatalogPosters(renderedRows);
}

function renderCatalogSidebar() {
  if (!catalogAside || embedMode) return;
  const active = sortEntriesNewestFirst(catalogEntries.filter((x) => x.active));
  if (inWatchMode()) {
    renderCatalogWatch(active);
    return;
  }
  renderCatalogDiscovery(active);
}

/**
 * @param {import("../filstream-catalog-chain.mjs").CatalogEntry[]} rows
 */
async function hydrateCatalogPosters(rows) {
  if (!catalogAside) return;
  /** @type {Map<string, HTMLImageElement[]>} */
  const imagesByVideoId = new Map();
  const cards = catalogAside.querySelectorAll(".viewer-catalog-card-thumb--still");
  for (const node of cards) {
    const img = /** @type {HTMLImageElement} */ (node);
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
 * @param {import("../filstream-catalog-chain.mjs").CatalogEntry} entry
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
 * @param {string} videoId
 * @returns {Promise<import("../filstream-catalog-chain.mjs").CatalogEntry | null>}
 */
async function resolveEntryForVideo(videoId) {
  let entry = await findCachedEntryByVideoId(videoId);
  if (entry && entry.active) return entry;
  await syncCatalogOnce(true);
  entry = await findCachedEntryByVideoId(videoId);
  if (entry && entry.active) return entry;
  return null;
}

/**
 * @param {string} videoId
 */
async function openVideoById(videoId) {
  currentVideoId = videoId.trim();
  applyViewerModeLayout();
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
  renderViewerMeta(merged ?? manifestDoc, entry);
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

try {
  applyViewerModeLayout();
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

window.addEventListener("beforeunload", () => {
  destroyed = true;
  if (syncIntervalId) {
    clearInterval(syncIntervalId);
    syncIntervalId = 0;
  }
  if (shakaPlayer) {
    void shakaPlayer.destroy();
    shakaPlayer = null;
  }
});
