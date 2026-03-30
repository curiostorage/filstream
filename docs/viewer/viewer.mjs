/**
 * Viewer entry:
 * - Discover: `index.html` · Playback: `viewer.html?videoId=<asset-id>[&embed=true]`
 *
 * Catalog discovery is on-chain (`CatalogRegistry`) with IndexedDB cache:
 * - entries are synced every ~30s when visible (or when hidden but video is playing)
 * - creator username/profile picture are refreshed for visible creators on the same cadence
 * - manifest.json is fetched once per `videoId` and then reused from cache
 */
import { html, render } from "https://cdn.jsdelivr.net/npm/lit-html@3.2.1/+esm";
import { FILSTREAM_BRAND, mountFilstreamHeader } from "../filstream-brand.mjs";
import "../components/viewer-share-actions.mjs";
import "../components/viewer-page-donate.mjs";
import "../components/viewer-meta-block.mjs";
import "../components/viewer-catalog-sidebar.mjs";
import {
  broadcastCopyFromMeta,
  formatUploadDateLabel,
} from "../filstream-broadcast-view.mjs";
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
  buildDiscoverHomeUrlWithSearchQuery,
  buildViewerUrlForVideoId,
  getFilstreamStoreConfig,
} from "../filstream-config.mjs";
import {
  CATALOG_CREATOR_PROFILE_SYNC_LIMIT,
  CATALOG_FULL_REFRESH_MS,
  CATALOG_PAGE_SIZE,
} from "../filstream-constants.mjs";
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
const metaBlock = document.getElementById("viewer-meta");
const shakaContainerEl = document.getElementById("viewer-shaka-container");
const catalogAside = document.getElementById("viewer-catalog");

if (metaBlock) {
  metaBlock.addEventListener("filstream-viewer-donate-click", () => void handleViewerDonateClick());
  metaBlock.addEventListener("filstream-viewer-status", (e) => {
    const ev = /** @type {CustomEvent<{ message: string, kind?: string }>} */ (e);
    setStatus(ev.detail.message, ev.detail.kind || "");
  });
}
if (catalogAside) {
  catalogAside.addEventListener("filstream-catalog-rendered", (e) => {
    const ev =
      /** @type {CustomEvent<{ rows: import("../filstream-catalog-chain.mjs").CatalogEntry[] }>} */ (
        e
      );
    void hydrateCatalogPosters(ev.detail.rows);
  });
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
  wireGlobalSearch();
  initLandingToast();
} else if (brandMount) {
  brandMount.hidden = true;
}

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
  if (!watch && metaBlock) {
    metaBlock.hidden = true;
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
    const holder = document.createElement("div");
    render(
      html`
        <button
          type="button"
          class="shaka-theater-button material-icons-round shaka-tooltip shaka-no-propagation"
        ></button>
      `,
      holder,
    );
    const button = /** @type {HTMLButtonElement} */ (holder.firstElementChild);
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
    const holder = document.createElement("div");
    render(
      html`
        <button type="button" class="shaka-filstream-site-button shaka-no-propagation">
          <label
            class="shaka-overflow-button-label shaka-overflow-menu-only shaka-simple-overflow-button-label-inline"
          >
            <img
              src=${FILSTREAM_BRAND.logoSrc}
              alt=""
              width="24"
              height="24"
              decoding="async"
            />
            <span>Open on FilStream</span>
          </label>
        </button>
      `,
      holder,
    );
    const button = /** @type {HTMLButtonElement} */ (holder.firstElementChild);
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

function syncDonateUi() {
  const el = metaBlock?.querySelector("viewer-page-donate");
  if (!el || !("meta" in el)) return;
  el.meta = loadedMeta;
  el.donateBusy = donateBusy;
  el.donateError = donateError;
  el.donateTxHash = donateTxHash;
}

function syncShareActionsUi() {
  const el = metaBlock?.querySelector("viewer-share-actions");
  if (!el || !("videoId" in el)) return;
  el.videoId = currentVideoId || "";
  el.embed = embedMode;
}

/**
 * @param {unknown} metaDoc
 * @param {import("../filstream-catalog-chain.mjs").CatalogEntry | null} [entry]
 */
function renderViewerMeta(metaDoc, entry = null) {
  const meta = mergeMetaLikeDocument(metaDoc);
  loadedMeta = meta;
  if (!meta || !metaBlock) return;
  metaBlock.hidden = false;
  const copy = broadcastCopyFromMeta(meta);
  const desc = typeof copy.description === "string" ? copy.description.trim() : "";
  const when = formatUploadDateLabel(meta) || "";
  metaBlock.title = copy.title || entry?.title || "Untitled";
  metaBlock.description = desc;
  metaBlock.uploadDate = when;
  metaBlock.creatorAddress = entry?.creator ?? "";
  metaBlock.creatorProfiles = Object.fromEntries(creatorProfileCache);

  void metaBlock.updateComplete.then(() => {
    syncDonateUi();
    syncShareActionsUi();
  });
}

async function handleViewerDonateClick() {
  const meta = loadedMeta;
  if (!meta) return;
  const cfgLocal = donateConfigFromMeta(meta);
  if (!cfgLocal.enabled) return;
  const provider = resolveViewerProvider(null);
  if (!provider) {
    donateError = "No browser wallet found.";
    syncDonateUi();
    return;
  }
  donateBusy = true;
  donateError = "";
  donateTxHash = "";
  syncDonateUi();
  try {
    const { txHash } = await proposeDonateTransfer(provider, cfgLocal);
    donateTxHash = txHash;
  } catch (e) {
    donateError = e instanceof Error ? e.message : String(e);
  } finally {
    donateBusy = false;
    syncDonateUi();
  }
}

function renderCatalogSidebar() {
  if (!catalogAside || embedMode) return;
  const activeEl = document.activeElement;
  const shouldRestoreSearchFocus =
    activeEl instanceof HTMLInputElement && activeEl.id === "filstream-global-search";
  const selStart = shouldRestoreSearchFocus ? activeEl.selectionStart : null;
  const selEnd = shouldRestoreSearchFocus ? activeEl.selectionEnd : null;

  const el = /** @type {import("../components/viewer-catalog-sidebar.mjs").ViewerCatalogSidebar} */ (
    catalogAside
  );
  const active = sortEntriesNewestFirst(catalogEntries.filter((x) => x.active));
  el.mode = inWatchMode() ? "watch" : "discover";
  el.entries = active;
  el.currentVideoId = currentVideoId;
  el.searchQuery = catalogSearchQuery;
  el.creatorProfiles = Object.fromEntries(creatorProfileCache);
  el.hidden = false;

  void el.updateComplete.then(() => {
    const globalSearch = document.getElementById("filstream-global-search");
    if (shouldRestoreSearchFocus && globalSearch instanceof HTMLInputElement) {
      globalSearch.focus();
      if (selStart != null && selEnd != null) {
        globalSearch.setSelectionRange(selStart, selEnd);
      }
    }
  });
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
                const motionHolder = document.createElement("div");
                render(
                  html`<img
                    class="viewer-catalog-card-thumb viewer-catalog-card-thumb--motion"
                    alt=""
                    loading="lazy"
                    decoding="async"
                  />`,
                  motionHolder,
                );
                motion = /** @type {HTMLImageElement} */ (motionHolder.firstElementChild);
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
 * Best-effort on-chain lookup when local cache/cursor misses a known `videoId`.
 *
 * @param {string} videoId
 * @returns {Promise<import("../filstream-catalog-chain.mjs").CatalogEntry | null>}
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
 * @returns {Promise<import("../filstream-catalog-chain.mjs").CatalogEntry | null>}
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
  await unregisterLegacyPieceHeadServiceWorker();
  applyViewerModeLayout();
  await bootstrapCatalogState();
  if (requestedVideoId) {
    await openVideoById(requestedVideoId);
  } else {
    syncShareActionsUi();
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
