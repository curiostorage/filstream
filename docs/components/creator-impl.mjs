/**
 * Creator page (on-chain catalog):
 * - `user/?creator=0x...` to view a specific channel
 * - no query param: wallet-first owner mode (no implicit fallback channel)
 *
 * Edit capabilities (owner only):
 * - update username (`setMyUsername`)
 * - update profile picture (`setMyProfilePicturePieceCid`)
 * - remove videos (`deleteEntry`) using session key
 */
import {
  hydrateFilstreamHeaderProfile,
  mountFilstreamHeader,
} from "./filstream-brand.mjs";
import {
  buildCreatorUrlForAddress,
  buildViewerUrlForVideoId,
  ensureFilstreamId,
  getFilstreamStoreConfig,
} from "../services/filstream-config.mjs";
import {
  deleteCatalogEntryWithSessionKey,
  isCatalogConfigured,
  readCatalogByCreator,
  readCatalogLatest,
  readCatalogProfilePicturePieceCid,
  readCatalogUsername,
  resolveManifestUrl,
  setCatalogProfilePicturePieceCidWithWallet,
  setCatalogUsernameWithWallet,
} from "../services/filstream-catalog-chain.mjs";
import {
  createSynapseForSession,
  publishCreatorPosterImage,
  resolveOrCreateDataSet,
} from "../services/browser-store.mjs";
import {
  loadCachedCatalogEntries,
  loadCachedCreatorProfiles,
  loadManifestCache,
  saveManifestCache,
} from "../services/filstream-catalog-cache.mjs";
import { authorizeSessionKeyForUpload } from "../services/session-key-bootstrap.mjs";
import {
  clearSessionKeyFromStorage,
  expirationsForWizard,
  isSessionKeyRecoverable,
  loadSessionKeyFromStorage,
  saveSessionKeyToStorage,
} from "../services/session-key-storage.mjs";
import { html, nothing, render } from "https://cdn.jsdelivr.net/npm/lit-html@3.2.1/+esm";
import { repeat } from "https://cdn.jsdelivr.net/npm/lit-html@3.2.1/directives/repeat.js/+esm";
import { spinnerLit } from "./spinner.mjs";
import { getAddress } from "../vendor/synapse-browser.mjs";
import { awaitMovieLinkShowcaseUpdates } from "./movie-link-showcase.mjs";
import { hasWatchedTo95Percent } from "../services/filstream-watch-history.mjs";

const G_REF = /** @type {{ host: import("lit").LitElement | null }} */ ({ host: null });

/** @type {HTMLElement | null} */
let brandMount = null;
/** @type {HTMLElement | null} */
let statusEl = null;
/** @type {HTMLElement | null} */
let pageSpinnerMount = null;
/** @type {HTMLElement | null} */
let saveSpinnerMount = null;
/** @type {HTMLElement | null} */
let heroEl = null;
/** @type {HTMLImageElement | null} */
let posterImg = null;
/** @type {HTMLElement | null} */
let titleEl = null;
/** @type {HTMLElement | null} */
let roleLabel = null;
/** @type {HTMLElement | null} */
let datasetLabel = null;
/** @type {HTMLElement | null} */
let heroActionsEl = null;
/** @type {HTMLElement | null} */
let editSection = null;
/** @type {HTMLElement | null} */
let editHint = null;
/** @type {HTMLButtonElement | null} */
let enableEditBtn = null;
/** @type {HTMLButtonElement | null} */
let disconnectBtn = null;
/** @type {HTMLElement | null} */
let sessionKeyNoteEl = null;
/** @type {HTMLElement | null} */
let editForm = null;
/** @type {HTMLInputElement | null} */
let nameInput = null;
/** @type {HTMLInputElement | null} */
let posterFileInput = null;
/** @type {HTMLButtonElement | null} */
let posterBrowseBtn = null;
/** @type {HTMLElement | null} */
let posterStatusEl = null;
/** @type {HTMLButtonElement | null} */
let saveBtn = null;
/** @type {HTMLElement | null} */
let saveStatus = null;
/** @type {HTMLElement | null} */
let movieEditList = null;
/** @type {HTMLElement | null} */
let catalogSection = null;
/** @type {HTMLElement | null} */
let movieListEl = null;
/** @type {HTMLElement | null} */
let emptyStateSection = null;
/** @type {HTMLButtonElement | null} */
let emptyStateConnectBtn = null;
/** @type {HTMLElement | null} */
let browseSection = null;
/** @type {HTMLElement | null} */
let browseListEl = null;

function cacheCreatorRefs() {
  const h = G_REF.host;
  if (!h) return;
  brandMount = h.querySelector("#creator-brand-mount");
  statusEl = h.querySelector("#creator-status");
  pageSpinnerMount = h.querySelector("#creator-page-spinner");
  saveSpinnerMount = h.querySelector("#creator-save-spinner-mount");
  heroEl = h.querySelector("#creator-hero");
  posterImg = /** @type {HTMLImageElement | null} */ (h.querySelector("#creator-poster"));
  titleEl = h.querySelector("#creator-title");
  roleLabel = h.querySelector("#creator-title-role");
  datasetLabel = h.querySelector("#creator-dataset-label");
  heroActionsEl = h.querySelector("#creator-hero-actions");
  editSection = h.querySelector("#creator-edit-section");
  editHint = h.querySelector("#creator-edit-hint");
  enableEditBtn = /** @type {HTMLButtonElement | null} */ (h.querySelector("#creator-enable-edit"));
  disconnectBtn = /** @type {HTMLButtonElement | null} */ (h.querySelector("#creator-disconnect"));
  sessionKeyNoteEl = h.querySelector("#creator-sessionkey-note");
  editForm = h.querySelector("#creator-edit-form");
  nameInput = /** @type {HTMLInputElement | null} */ (h.querySelector("#creator-name-input"));
  posterFileInput = /** @type {HTMLInputElement | null} */ (h.querySelector("#creator-poster-file"));
  posterBrowseBtn = /** @type {HTMLButtonElement | null} */ (h.querySelector("#creator-poster-browse"));
  posterStatusEl = h.querySelector("#creator-poster-status");
  saveBtn = /** @type {HTMLButtonElement | null} */ (h.querySelector("#creator-save-btn"));
  saveStatus = h.querySelector("#creator-save-status");
  movieEditList = h.querySelector("#creator-movie-edit-list");
  catalogSection = h.querySelector("#creator-catalog-section");
  movieListEl = h.querySelector("#creator-movie-list");
  emptyStateSection = h.querySelector("#creator-empty-state");
  emptyStateConnectBtn = /** @type {HTMLButtonElement | null} */ (
    h.querySelector("#creator-empty-connect")
  );
  browseSection = h.querySelector("#creator-browse-section");
  browseListEl = h.querySelector("#creator-browse-list");
  h.querySelector("#creator-dev-paste-box")?.setAttribute("hidden", "");
}

/** @type {string | null} */
let connectedAddress = null;
/** @type {string | null} */
let creatorAddress = null;
/** @type {string} */
let creatorUsername = "";
/** @type {string} */
let creatorProfilePicturePieceCid = "";
/** @type {string} */
let creatorProfilePictureUrl = "";
/** @type {import("../services/filstream-catalog-chain.mjs").CatalogEntry[]} */
let creatorEntries = [];
/** @type {{ creator: string, activeCount: number, latestCreatedAt: number, username: string }[]} */
let browseCreators = [];
/** @type {string | null} */
let sessionPrivateKey = null;
/** @type {Record<number, boolean>} */
const deleteBusyByEntry = {};
let profileSaveBusy = false;
let profilePosterBusy = false;
const CREATOR_DISCONNECTED_STORAGE_KEY = "filstream_creator_disconnected_v1";

function isCreatorDisconnected() {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(CREATOR_DISCONNECTED_STORAGE_KEY) === "1";
}

function setCreatorDisconnected(next) {
  if (typeof localStorage === "undefined") return;
  if (next) {
    localStorage.setItem(CREATOR_DISCONNECTED_STORAGE_KEY, "1");
  } else {
    localStorage.removeItem(CREATOR_DISCONNECTED_STORAGE_KEY);
  }
}

function setStatus(msg, kind) {
  if (!statusEl) return;
  statusEl.textContent = msg;
  statusEl.className = `creator-status${kind === "err" ? " err" : ""}`;
}

function setSaveStatus(msg, kind) {
  if (!saveStatus) return;
  saveStatus.textContent = msg;
  saveStatus.className = `creator-save-status${kind === "err" ? " err" : ""}`;
}

function setPosterStatus(msg, kind) {
  if (!posterStatusEl) return;
  posterStatusEl.textContent = msg;
  posterStatusEl.className = `creator-poster-status${kind === "err" ? " err" : ""}`;
}

function showPageLoadSpinner() {
  if (!pageSpinnerMount) return;
  pageSpinnerMount.hidden = false;
  render(spinnerLit({ size: "sm" }), pageSpinnerMount);
}

function hidePageLoadSpinner() {
  if (pageSpinnerMount) {
    pageSpinnerMount.hidden = true;
    render(nothing, pageSpinnerMount);
  }
}

function setSaveSpinnerVisible(on) {
  if (!saveSpinnerMount) return;
  saveSpinnerMount.hidden = !on;
  if (on) {
    render(spinnerLit({ size: "sm" }), saveSpinnerMount);
  } else {
    render(nothing, saveSpinnerMount);
  }
}

function shortAddress(addr) {
  if (!addr) return "";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function buildCreatorProfileAssetId(addr) {
  return `creator_profile_${String(addr || "").trim().toLowerCase()}`;
}

function sameEthAddress(a, b) {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

function normalizeAddressOrNull(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    return getAddress(/** @type {`0x${string}`} */ (value.trim()));
  } catch {
    return null;
  }
}

function normalizeCreatorKey(value) {
  return String(value || "").trim().toLowerCase();
}

function clearLoadedCreatorState() {
  creatorAddress = null;
  creatorEntries = [];
  creatorUsername = "";
  creatorProfilePicturePieceCid = "";
  creatorProfilePictureUrl = "";
}

function hideCreatorContentSections() {
  if (heroEl) heroEl.hidden = true;
  if (editSection) editSection.hidden = true;
  if (catalogSection) catalogSection.hidden = true;
}

function hideLandingSections() {
  if (emptyStateSection) emptyStateSection.hidden = true;
  if (browseSection) browseSection.hidden = true;
}

function isOwner() {
  return Boolean(
    creatorAddress && connectedAddress && sameEthAddress(creatorAddress, connectedAddress),
  );
}

function queryCreatorAddress() {
  const raw = new URLSearchParams(window.location.search).get("creator");
  return normalizeAddressOrNull(raw);
}

function writeCreatorToUrl(addr) {
  if (!addr) return;
  const u = new URL(window.location.href);
  u.searchParams.set("creator", addr);
  window.history.replaceState({}, "", u.href);
}

function clearCreatorFromUrl() {
  const u = new URL(window.location.href);
  u.searchParams.delete("creator");
  window.history.replaceState({}, "", u.href);
}

async function refreshConnectedAccount() {
  if (isCreatorDisconnected()) {
    connectedAddress = null;
    return;
  }
  const eth = window.ethereum;
  if (!eth || typeof eth.request !== "function") {
    connectedAddress = null;
    return;
  }
  try {
    const accounts = /** @type {string[]} */ (
      await eth.request({ method: "eth_accounts" })
    );
    connectedAddress = normalizeAddressOrNull(accounts?.[0] ?? null);
  } catch {
    connectedAddress = null;
  }
}

function applyStoredSessionIfValid() {
  if (!connectedAddress) {
    sessionPrivateKey = null;
    return;
  }
  const stored = loadSessionKeyFromStorage();
  if (!stored) {
    sessionPrivateKey = null;
    return;
  }
  if (!isSessionKeyRecoverable(stored)) {
    sessionPrivateKey = null;
    return;
  }
  const root = normalizeAddressOrNull(stored.rootAddress);
  if (!root || !sameEthAddress(root, connectedAddress)) {
    sessionPrivateKey = null;
    return;
  }
  sessionPrivateKey = stored.sessionPrivateKey;
}

async function ensureSessionKey() {
  if (sessionPrivateKey && connectedAddress) return sessionPrivateKey;
  const provider = window.ethereum;
  if (!provider || !connectedAddress) {
    throw new Error("Connect wallet first.");
  }
  const { sessionPrivateKey: key, sessionExpirations } = await authorizeSessionKeyForUpload(
    provider,
    connectedAddress,
    {
      onTransactionSubmitted: (txHash) => {
        setStatus(`Authorizing session key… ${txHash.slice(0, 10)}…`, "");
      },
      afterLoginSync: () => {
        setStatus("Session key authorized.", "");
      },
    },
  );
  sessionPrivateKey = key;
  saveSessionKeyToStorage({
    rootAddress: connectedAddress,
    chainId: getFilstreamStoreConfig().storeChainId,
    sessionPrivateKey: key,
    sessionExpirations,
  });
  return key;
}

async function resolveCreatorAddress() {
  const fromQuery = queryCreatorAddress();
  if (fromQuery) return fromQuery;
  if (connectedAddress) return connectedAddress;
  return null;
}

/**
 * @param {import("../services/filstream-catalog-chain.mjs").CatalogEntry[]} rows
 * @returns {{ creator: string, activeCount: number, latestCreatedAt: number }[]}
 */
function collectBrowseCreators(rows) {
  /** @type {Map<string, { creator: string, activeCount: number, latestCreatedAt: number }>} */
  const buckets = new Map();
  for (const row of rows) {
    if (!row.active) continue;
    const creator = normalizeAddressOrNull(row.creator);
    if (!creator) continue;
    const key = normalizeCreatorKey(creator);
    const prev = buckets.get(key);
    if (!prev) {
      buckets.set(key, {
        creator,
        activeCount: 1,
        latestCreatedAt: row.createdAt,
      });
      continue;
    }
    prev.activeCount += 1;
    if (row.createdAt > prev.latestCreatedAt) {
      prev.latestCreatedAt = row.createdAt;
    }
  }
  return [...buckets.values()]
    .sort((a, b) => {
      if (a.activeCount !== b.activeCount) return b.activeCount - a.activeCount;
      if (a.latestCreatedAt !== b.latestCreatedAt) return b.latestCreatedAt - a.latestCreatedAt;
      return normalizeCreatorKey(a.creator).localeCompare(normalizeCreatorKey(b.creator));
    })
    .slice(0, 12);
}

async function loadBrowseCreatorData() {
  /** @type {import("../services/filstream-catalog-chain.mjs").CatalogEntry[]} */
  let sourceRows = [];
  try {
    sourceRows = await loadCachedCatalogEntries({ limit: 250, activeOnly: true });
  } catch {
    sourceRows = [];
  }
  if (!sourceRows.length) {
    try {
      sourceRows = await readCatalogLatest({ limit: 100, activeOnly: true });
    } catch {
      sourceRows = [];
    }
  }
  const buckets = collectBrowseCreators(sourceRows);
  if (!buckets.length) {
    browseCreators = [];
    return;
  }

  let profileRows = [];
  try {
    profileRows = await loadCachedCreatorProfiles(buckets.map((x) => x.creator));
  } catch {
    profileRows = [];
  }
  const usernamesByCreator = new Map(
    profileRows.map((row) => [
      normalizeCreatorKey(row.creator),
      typeof row.username === "string" ? row.username.trim() : "",
    ]),
  );

  browseCreators = buckets.map((row) => ({
    ...row,
    username: usernamesByCreator.get(normalizeCreatorKey(row.creator)) || "",
  }));
}

function renderBrowseCreators() {
  if (!browseSection || !browseListEl) return;
  if (connectedAddress) {
    browseSection.hidden = true;
    render(nothing, browseListEl);
    return;
  }
  browseSection.hidden = false;

  if (!browseCreators.length) {
    render(
      html`<p class="creator-status">No creators found yet.</p>`,
      browseListEl,
    );
    return;
  }

  render(
    html`
      ${repeat(
        browseCreators,
        (row) => row.creator,
        (row) => html`
          <a class="creator-browse-card" href=${buildCreatorUrlForAddress(row.creator)}>
            <span class="creator-browse-card-name">
              ${row.username || shortAddress(row.creator)}
            </span>
            <span class="creator-browse-card-meta">
              ${row.activeCount} video${row.activeCount === 1 ? "" : "s"} ·
              ${shortAddress(row.creator)}
            </span>
          </a>
        `,
      )}
    `,
    browseListEl,
  );
}

function renderWalletFirstLanding() {
  hideCreatorContentSections();
  if (emptyStateSection) emptyStateSection.hidden = false;
  if (emptyStateConnectBtn) {
    emptyStateConnectBtn.disabled = false;
    emptyStateConnectBtn.textContent = "Connect wallet";
  }
  renderBrowseCreators();
}

async function resolveProfilePictureUrlForPieceCid(pieceCid) {
  const cid = String(pieceCid || "").trim();
  if (!cid) return "";
  try {
    const cfg = getFilstreamStoreConfig();
    return await resolveManifestUrl(cfg.storeProviderId, cid);
  } catch {
    return "";
  }
}

async function loadCreatorData() {
  if (!creatorAddress) {
    creatorEntries = [];
    creatorUsername = "";
    creatorProfilePicturePieceCid = "";
    creatorProfilePictureUrl = "";
    return;
  }
  creatorUsername = await readCatalogUsername(creatorAddress);
  creatorProfilePicturePieceCid = await readCatalogProfilePicturePieceCid(creatorAddress);
  creatorProfilePictureUrl = await resolveProfilePictureUrlForPieceCid(
    creatorProfilePicturePieceCid,
  );
  /** @type {import("../services/filstream-catalog-chain.mjs").CatalogEntry[]} */
  const all = [];
  let offset = 0;
  const pageSize = 100;
  for (let i = 0; i < 20; i++) {
    const page = await readCatalogByCreator({
      creatorAddress,
      offset,
      limit: pageSize,
      activeOnly: false,
    });
    if (!page.length) break;
    all.push(...page);
    offset += page.length;
    if (page.length < pageSize) break;
  }
  creatorEntries = all;
}

async function manifestDocForEntry(entry) {
  const cached = await loadManifestCache(entry.assetId);
  if (cached?.manifestDoc) {
    return cached.manifestDoc;
  }
  const manifestUrl = await resolveManifestUrl(entry.providerId, entry.manifestCid);
  const res = await fetch(manifestUrl);
  if (!res.ok) return null;
  const doc = await res.json();
  await saveManifestCache({
    videoId: entry.assetId,
    manifestUrl,
    manifestDoc: doc,
  });
  return doc;
}

function posterFromManifestDoc(doc) {
  if (!doc || typeof doc !== "object" || doc === null) return null;
  const d = /** @type {Record<string, unknown>} */ (doc);
  const poster =
    d.poster && typeof d.poster === "object" && d.poster !== null
      ? /** @type {{ url?: unknown }} */ (d.poster).url
      : null;
  if (typeof poster === "string" && poster.trim() !== "") return poster.trim();
  const playback =
    d.playback && typeof d.playback === "object" && d.playback !== null
      ? /** @type {{ posterUrl?: unknown }} */ (d.playback)
      : {};
  return typeof playback.posterUrl === "string" && playback.posterUrl.trim() !== ""
    ? playback.posterUrl.trim()
    : null;
}

function posterAnimFromManifestDoc(doc) {
  if (!doc || typeof doc !== "object" || doc === null) return null;
  const d = /** @type {Record<string, unknown>} */ (doc);
  const pa =
    d.posterAnim && typeof d.posterAnim === "object" && d.posterAnim !== null
      ? /** @type {{ url?: unknown }} */ (d.posterAnim).url
      : null;
  if (typeof pa === "string" && pa.trim() !== "") return pa.trim();
  const playback =
    d.playback && typeof d.playback === "object" && d.playback !== null
      ? /** @type {{ posterAnimUrl?: unknown }} */ (d.playback)
      : {};
  return typeof playback.posterAnimUrl === "string" && playback.posterAnimUrl.trim() !== ""
    ? playback.posterAnimUrl.trim()
    : null;
}

function updateActions() {
  if (!enableEditBtn || !heroActionsEl) return;
  heroActionsEl.hidden = false;
  enableEditBtn.hidden = false;
  if (disconnectBtn) {
    disconnectBtn.hidden = !connectedAddress;
    disconnectBtn.disabled = false;
    disconnectBtn.textContent = "Logout";
  }
  if (sessionKeyNoteEl) {
    sessionKeyNoteEl.hidden = true;
    sessionKeyNoteEl.textContent = "";
  }
  if (!connectedAddress) {
    enableEditBtn.textContent = "Connect wallet";
    return;
  }
  if (!creatorAddress || !isOwner()) {
    enableEditBtn.textContent = "Open my channel";
    return;
  }
  enableEditBtn.textContent = sessionPrivateKey
    ? "Refresh delete key"
    : "Authorize delete key";
  if (sessionKeyNoteEl) {
    sessionKeyNoteEl.hidden = false;
    sessionKeyNoteEl.textContent = sessionPrivateKey
      ? "Delete key is ready. This key is only for removing videos."
      : "Delete key is only needed for removing videos.";
  }
}

function renderHero() {
  if (!heroEl || !titleEl || !datasetLabel || !roleLabel) return;
  heroEl.hidden = false;
  if (posterImg) {
    if (creatorProfilePictureUrl) {
      posterImg.src = creatorProfilePictureUrl;
      posterImg.hidden = false;
    } else {
      posterImg.hidden = true;
    }
  }
  const name = creatorUsername && creatorUsername.trim() ? creatorUsername.trim() : "";
  titleEl.textContent = name || (creatorAddress ? shortAddress(creatorAddress) : "Creator");
  const active = creatorEntries.filter((x) => x.active).length;
  const total = creatorEntries.length;
  datasetLabel.textContent = creatorAddress
    ? `${active} active videos · ${total} total · ${shortAddress(creatorAddress)}`
    : "No creator selected";
  roleLabel.textContent = isOwner()
    ? "Creator"
    : connectedAddress
      ? "Viewer"
      : "Connect wallet";
}

function renderEditSection() {
  if (!editSection || !editHint || !editForm || !movieEditList || !saveBtn) return;
  if (!isOwner()) {
    editSection.hidden = true;
    return;
  }
  editSection.hidden = false;
  editForm.hidden = false;
  editHint.textContent =
    "Name and profile picture updates use wallet signature. Delete uses the delete key.";
  if (nameInput && document.activeElement !== nameInput && !profileSaveBusy) {
    nameInput.value = creatorUsername || "";
  }
  saveBtn.textContent = profileSaveBusy ? "Saving…" : "Save name";
  saveBtn.disabled = profileSaveBusy || profilePosterBusy;
  if (posterBrowseBtn) {
    posterBrowseBtn.disabled = profileSaveBusy || profilePosterBusy;
    posterBrowseBtn.textContent = profilePosterBusy ? "Uploading…" : "Browse…";
  }
  render(
    html`
      ${repeat(
        creatorEntries,
        (entry) => entry.entryId,
        (entry) => html`
          <li class="creator-movie-edit-row">
            <span class="creator-movie-edit-title">
              ${entry.active ? entry.title : `${entry.title} (removed)`}
            </span>
            <div class="creator-movie-edit-actions">
              ${entry.active
                ? html`
                    <button
                      type="button"
                      class="creator-row-btn creator-row-btn--danger"
                      ?disabled=${Boolean(deleteBusyByEntry[entry.entryId])}
                      @click=${() => void handleDeleteEntry(entry.entryId)}
                    >
                      ${deleteBusyByEntry[entry.entryId] ? "Removing…" : "Remove"}
                    </button>
                  `
                : nothing}
            </div>
          </li>
        `,
      )}
    `,
    movieEditList,
  );
}

function renderMovieList() {
  if (!catalogSection || !movieListEl) return;
  catalogSection.hidden = false;
  const active = creatorEntries.filter((x) => x.active);
  if (!active.length) {
    movieListEl.className = "creator-movie-list";
    render(html`<p class="creator-status">No active videos.</p>`, movieListEl);
    return;
  }
  movieListEl.className = "creator-movie-list viewer-catalog-grid";
  render(
    html`
      ${repeat(
        active,
        (entry) => entry.entryId,
        (entry) => html`
          <movie-link-showcase
            .assetId=${entry.assetId}
            .href=${buildViewerUrlForVideoId(entry.assetId)}
            .videoTitle=${entry.title}
            .showCreator=${false}
            .variant=${"discover"}
            .openInNewTab=${true}
            .watched95=${hasWatchedTo95Percent(entry.assetId)}
          ></movie-link-showcase>
        `,
      )}
    `,
    movieListEl,
  );
  void hydrateMoviePosters(active);
}

/**
 * @param {import("../services/filstream-catalog-chain.mjs").CatalogEntry[]} activeEntries
 */
async function hydrateMoviePosters(activeEntries) {
  if (!movieListEl) return;
  await awaitMovieLinkShowcaseUpdates(movieListEl);
  const rows = movieListEl.querySelectorAll("movie-link-showcase");
  for (let i = 0; i < rows.length && i < activeEntries.length; i++) {
    const entry = activeEntries[i];
    const host = rows[i];
    const root = host.shadowRoot;
    if (!root) continue;
    const img = /** @type {HTMLImageElement | null} */ (
      root.querySelector(".viewer-catalog-card-thumb--still")
    );
    if (!img) continue;
    const wrap = root.querySelector(".viewer-catalog-card-thumb-wrap");
    try {
      const doc = await manifestDocForEntry(entry);
      const posterUrl = posterFromManifestDoc(doc);
      const animUrl = posterAnimFromManifestDoc(doc);
      if (posterUrl) img.src = posterUrl;
      if (posterUrl && animUrl && wrap instanceof HTMLElement) {
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
        motion.src = animUrl;
      }
      if (i === 0 && posterImg && posterUrl && posterImg.hidden) {
        posterImg.src = posterUrl;
        posterImg.hidden = false;
      }
    } catch {
      /* ignore */
    }
  }
}

function renderAll() {
  hideLandingSections();
  renderHero();
  updateActions();
  renderEditSection();
  renderMovieList();
  if (!isOwner()) {
    setPosterStatus("");
  } else if (creatorProfilePicturePieceCid) {
    setPosterStatus(`Current picture CID: ${creatorProfilePicturePieceCid}`);
  } else {
    setPosterStatus("No profile picture set.");
  }
}

async function refreshAll() {
  if (!isCatalogConfigured()) {
    setStatus("Catalog contract is not configured.", "err");
    hideLandingSections();
    hideCreatorContentSections();
    return;
  }
  showPageLoadSpinner();
  try {
    await refreshConnectedAccount();
    applyStoredSessionIfValid();
    const queryCreator = queryCreatorAddress();
    if (!queryCreator && !connectedAddress) {
      clearLoadedCreatorState();
      await loadBrowseCreatorData();
      renderWalletFirstLanding();
      updateActions();
      setStatus("Connect wallet to manage your creator channel.", "");
      return;
    }
    creatorAddress = await resolveCreatorAddress();
    if (!creatorAddress) {
      clearLoadedCreatorState();
      hideLandingSections();
      hideCreatorContentSections();
      setStatus("Could not resolve creator channel.", "err");
      return;
    }
    writeCreatorToUrl(creatorAddress);
    await loadCreatorData();
    renderAll();
    setStatus("");
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), "err");
  } finally {
    hidePageLoadSpinner();
    void hydrateFilstreamHeaderProfile(
      brandMount?.querySelector("[data-filstream-header]"),
      { force: true },
    );
  }
}

async function handleSaveProfileName() {
  if (!isOwner() || !nameInput || !saveBtn) return;
  const provider = window.ethereum;
  if (!provider || !connectedAddress) {
    setSaveStatus("Connect wallet first.", "err");
    return;
  }
  const nextName = nameInput.value.trim();
  if (!nextName) {
    setSaveStatus("Username cannot be empty.", "err");
    return;
  }
  profileSaveBusy = true;
  setSaveSpinnerVisible(true);
  setSaveStatus("Saving name on-chain…");
  renderEditSection();
  try {
    await setCatalogUsernameWithWallet({
      provider,
      walletAddress: connectedAddress,
      username: nextName,
      onTransactionSubmitted: (txHash) => {
        setSaveStatus(`Transaction sent: ${txHash.slice(0, 10)}…`);
      },
    });
    creatorUsername = await readCatalogUsername(connectedAddress);
    setSaveStatus("Name updated.");
    renderAll();
  } catch (e) {
    setSaveStatus(e instanceof Error ? e.message : String(e), "err");
  } finally {
    profileSaveBusy = false;
    setSaveSpinnerVisible(false);
    renderEditSection();
  }
}

async function ensureSessionForStorageOps() {
  if (!connectedAddress) {
    throw new Error("Connect wallet first.");
  }
  const stored = loadSessionKeyFromStorage();
  const root = normalizeAddressOrNull(stored?.rootAddress ?? null);
  if (
    stored &&
    isSessionKeyRecoverable(stored) &&
    root &&
    sameEthAddress(root, connectedAddress)
  ) {
    sessionPrivateKey = stored.sessionPrivateKey;
    return {
      sessionPrivateKey: stored.sessionPrivateKey,
      sessionExpirations: expirationsForWizard(stored),
    };
  }
  await ensureSessionKey();
  const refreshed = loadSessionKeyFromStorage();
  const refreshedRoot = normalizeAddressOrNull(refreshed?.rootAddress ?? null);
  if (
    !refreshed ||
    !isSessionKeyRecoverable(refreshed) ||
    !refreshedRoot ||
    !sameEthAddress(refreshedRoot, connectedAddress)
  ) {
    throw new Error("Session key not available for storage upload.");
  }
  sessionPrivateKey = refreshed.sessionPrivateKey;
  return {
    sessionPrivateKey: refreshed.sessionPrivateKey,
    sessionExpirations: expirationsForWizard(refreshed),
  };
}

/**
 * @param {File | null | undefined} file
 */
async function handleProfilePosterSelected(file) {
  if (!file) return;
  if (!isOwner() || !connectedAddress) {
    setPosterStatus("Open your own channel to edit profile picture.", "err");
    return;
  }
  if (!file.type.startsWith("image/")) {
    setPosterStatus("Please select an image file.", "err");
    return;
  }
  const provider = window.ethereum;
  if (!provider) {
    setPosterStatus("No wallet provider found.", "err");
    return;
  }

  profilePosterBusy = true;
  setSaveSpinnerVisible(true);
  setPosterStatus("Uploading profile picture…");
  setSaveStatus("Uploading profile picture piece…");
  renderEditSection();

  try {
    const cfg = getFilstreamStoreConfig();
    const session = await ensureSessionForStorageOps();
    const synapse = await createSynapseForSession(
      {
        rpcUrl: cfg.storeRpcUrl,
        chainId: cfg.storeChainId,
        source: cfg.storeSource,
      },
      connectedAddress,
      session.sessionPrivateKey,
      session.sessionExpirations,
    );
    const filstreamId = ensureFilstreamId(cfg);
    const { context } = await resolveOrCreateDataSet({
      synapse,
      providerId: cfg.storeProviderId,
      clientAddress: connectedAddress,
      filstreamId,
    });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const uploaded = await publishCreatorPosterImage({
      context,
      synapse,
      bytes,
      assetId: buildCreatorProfileAssetId(connectedAddress),
    });
    await setCatalogProfilePicturePieceCidWithWallet({
      provider,
      walletAddress: connectedAddress,
      pieceCid: uploaded.pieceCid,
      onTransactionSubmitted: (txHash) => {
        setSaveStatus(`Profile tx: ${txHash.slice(0, 10)}…`);
      },
    });
    creatorProfilePicturePieceCid = uploaded.pieceCid;
    creatorProfilePictureUrl =
      uploaded.retrievalUrl || (await resolveProfilePictureUrlForPieceCid(uploaded.pieceCid));
    if (posterImg && creatorProfilePictureUrl) {
      posterImg.src = creatorProfilePictureUrl;
      posterImg.hidden = false;
    }
    setPosterStatus("Profile picture updated.");
    setSaveStatus("Profile picture updated.");
    renderAll();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setPosterStatus(msg, "err");
    setSaveStatus(msg, "err");
  } finally {
    profilePosterBusy = false;
    setSaveSpinnerVisible(false);
    renderEditSection();
  }
}

async function handleDeleteEntry(entryId) {
  if (!isOwner() || !connectedAddress) return;
  deleteBusyByEntry[entryId] = true;
  renderEditSection();
  try {
    const session = await ensureSessionForStorageOps();
    await deleteCatalogEntryWithSessionKey({
      claimedUser: connectedAddress,
      sessionPrivateKey: session.sessionPrivateKey,
      entryId,
      onTransactionSubmitted: (txHash) => {
        setSaveStatus(`Remove tx: ${txHash.slice(0, 10)}…`);
      },
    });
    setSaveStatus("Video removed.");
    await loadCreatorData();
    renderAll();
  } catch (e) {
    setSaveStatus(e instanceof Error ? e.message : String(e), "err");
  } finally {
    deleteBusyByEntry[entryId] = false;
    renderEditSection();
  }
}

async function handlePrimaryAction() {
  const provider = window.ethereum;
  if (!provider || typeof provider.request !== "function") {
    setStatus("Install a browser wallet extension.", "err");
    return;
  }
  if (!connectedAddress) {
    try {
      setCreatorDisconnected(false);
      await provider.request({ method: "eth_requestAccounts" });
      await refreshAll();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), "err");
    }
    return;
  }
  if (!creatorAddress || !isOwner()) {
    creatorAddress = connectedAddress;
    writeCreatorToUrl(creatorAddress);
    await refreshAll();
    return;
  }
  try {
    sessionPrivateKey = null;
    await ensureSessionKey();
    setStatus("Session key ready.");
    renderAll();
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), "err");
  }
}

async function handleDisconnectAction() {
  setCreatorDisconnected(true);
  clearSessionKeyFromStorage();
  sessionPrivateKey = null;
  connectedAddress = null;
  clearCreatorFromUrl();
  await refreshAll();
}

function bindEvents() {
  enableEditBtn?.addEventListener("click", () => {
    void handlePrimaryAction();
  });
  disconnectBtn?.addEventListener("click", () => {
    void handleDisconnectAction();
  });
  emptyStateConnectBtn?.addEventListener("click", () => {
    void handlePrimaryAction();
  });
  saveBtn?.addEventListener("click", () => {
    void handleSaveProfileName();
  });
  posterBrowseBtn?.addEventListener("click", () => {
    posterFileInput?.click();
  });
  posterFileInput?.addEventListener("change", () => {
    const file = posterFileInput.files?.[0];
    void handleProfilePosterSelected(file);
    posterFileInput.value = "";
  });
  const eth = window.ethereum;
  if (eth && typeof eth.on === "function") {
    eth.on("accountsChanged", () => {
      void refreshAll();
    });
  }
}

export function initCreatorPage(host) {
  G_REF.host = host;
  cacheCreatorRefs();
  if (brandMount) {
    mountFilstreamHeader(brandMount, { active: "creator" });
  }
  bindEvents();
  void refreshAll();
}
