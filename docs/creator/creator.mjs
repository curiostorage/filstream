/**
 * Creator page (on-chain catalog):
 * - `creator.html?creator=0x...` to view a specific channel
 * - no query param: wallet-first owner mode (no implicit fallback channel)
 *
 * Edit capabilities (owner only):
 * - update username (`setMyUsername`)
 * - update profile picture (`setMyProfilePicturePieceCid`)
 * - remove videos (`deleteEntry`) using session key
 */
import { mountFilstreamHeader } from "../filstream-brand.mjs";
import {
  buildCreatorUrlForAddress,
  buildViewerUrlForVideoId,
  ensureFilstreamId,
  getFilstreamStoreConfig,
} from "../filstream-config.mjs";
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
} from "../filstream-catalog-chain.mjs";
import {
  createSynapseForSession,
  publishCreatorPosterImage,
  resolveOrCreateDataSet,
} from "../browser-store.mjs";
import {
  loadCachedCatalogEntries,
  loadCachedCreatorProfiles,
  loadManifestCache,
  saveManifestCache,
} from "../filstream-catalog-cache.mjs";
import { authorizeSessionKeyForUpload } from "../session-key-bootstrap.mjs";
import {
  clearSessionKeyFromStorage,
  expirationsForWizard,
  isSessionKeyRecoverable,
  loadSessionKeyFromStorage,
  saveSessionKeyToStorage,
} from "../session-key-storage.mjs";
import { createSpinnerElement } from "../spinner.mjs";
import { getAddress } from "../vendor/synapse-browser.mjs";

const brandMount = document.getElementById("creator-brand-mount");
if (brandMount) {
  mountFilstreamHeader(brandMount, { active: "creator" });
}

const statusEl = document.getElementById("creator-status");
const pageSpinnerMount = document.getElementById("creator-page-spinner");
const saveSpinnerMount = document.getElementById("creator-save-spinner-mount");
const heroEl = document.getElementById("creator-hero");
const posterImg = /** @type {HTMLImageElement | null} */ (document.getElementById("creator-poster"));
const titleEl = document.getElementById("creator-title");
const roleLabel = document.getElementById("creator-title-role");
const datasetLabel = document.getElementById("creator-dataset-label");
const heroActionsEl = document.getElementById("creator-hero-actions");
const editSection = document.getElementById("creator-edit-section");
const editHint = document.getElementById("creator-edit-hint");
const enableEditBtn = /** @type {HTMLButtonElement | null} */ (
  document.getElementById("creator-enable-edit")
);
const disconnectBtn = /** @type {HTMLButtonElement | null} */ (
  document.getElementById("creator-disconnect")
);
const sessionKeyNoteEl = document.getElementById("creator-sessionkey-note");
const editForm = document.getElementById("creator-edit-form");
const nameInput = /** @type {HTMLInputElement | null} */ (document.getElementById("creator-name-input"));
const posterFileInput = /** @type {HTMLInputElement | null} */ (
  document.getElementById("creator-poster-file")
);
const posterBrowseBtn = /** @type {HTMLButtonElement | null} */ (
  document.getElementById("creator-poster-browse")
);
const posterStatusEl = document.getElementById("creator-poster-status");
const saveBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById("creator-save-btn"));
const saveStatus = document.getElementById("creator-save-status");
const movieEditList = document.getElementById("creator-movie-edit-list");
const catalogSection = document.getElementById("creator-catalog-section");
const movieListEl = document.getElementById("creator-movie-list");
const emptyStateSection = document.getElementById("creator-empty-state");
const emptyStateConnectBtn = /** @type {HTMLButtonElement | null} */ (
  document.getElementById("creator-empty-connect")
);
const browseSection = document.getElementById("creator-browse-section");
const browseListEl = document.getElementById("creator-browse-list");

// Legacy dev-only paste box remains hidden in on-chain mode.
document.getElementById("creator-dev-paste-box")?.setAttribute("hidden", "");

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
/** @type {import("../filstream-catalog-chain.mjs").CatalogEntry[]} */
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
  if (!pageSpinnerMount.querySelector(".filstream-spinner")) {
    pageSpinnerMount.appendChild(createSpinnerElement({ size: "sm" }));
  }
}

function hidePageLoadSpinner() {
  if (pageSpinnerMount) pageSpinnerMount.hidden = true;
}

function setSaveSpinnerVisible(on) {
  if (!saveSpinnerMount) return;
  saveSpinnerMount.hidden = !on;
  if (on && !saveSpinnerMount.querySelector(".filstream-spinner")) {
    saveSpinnerMount.appendChild(createSpinnerElement({ size: "sm" }));
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
 * @param {import("../filstream-catalog-chain.mjs").CatalogEntry[]} rows
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
  /** @type {import("../filstream-catalog-chain.mjs").CatalogEntry[]} */
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
    browseListEl.innerHTML = "";
    return;
  }
  browseSection.hidden = false;
  browseListEl.innerHTML = "";

  if (!browseCreators.length) {
    const p = document.createElement("p");
    p.className = "creator-status";
    p.textContent = "No creators found yet.";
    browseListEl.appendChild(p);
    return;
  }

  for (const row of browseCreators) {
    const a = document.createElement("a");
    a.className = "creator-browse-card";
    a.href = buildCreatorUrlForAddress(row.creator);

    const name = document.createElement("span");
    name.className = "creator-browse-card-name";
    name.textContent = row.username || shortAddress(row.creator);

    const meta = document.createElement("span");
    meta.className = "creator-browse-card-meta";
    meta.textContent = `${row.activeCount} video${row.activeCount === 1 ? "" : "s"} · ${shortAddress(row.creator)}`;

    a.append(name, meta);
    browseListEl.appendChild(a);
  }
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
  /** @type {import("../filstream-catalog-chain.mjs").CatalogEntry[]} */
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
  movieEditList.innerHTML = "";

  for (const entry of creatorEntries) {
    const li = document.createElement("li");
    li.className = "creator-movie-edit-row";
    const title = document.createElement("span");
    title.className = "creator-movie-edit-title";
    title.textContent = entry.active ? entry.title : `${entry.title} (removed)`;
    li.appendChild(title);

    const actions = document.createElement("div");
    actions.className = "creator-movie-edit-actions";
    if (entry.active) {
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "creator-row-btn creator-row-btn--danger";
      delBtn.disabled = Boolean(deleteBusyByEntry[entry.entryId]);
      delBtn.textContent = deleteBusyByEntry[entry.entryId] ? "Removing…" : "Remove";
      delBtn.addEventListener("click", () => {
        void handleDeleteEntry(entry.entryId);
      });
      actions.appendChild(delBtn);
    }
    li.appendChild(actions);
    movieEditList.appendChild(li);
  }
}

function renderMovieList() {
  if (!catalogSection || !movieListEl) return;
  catalogSection.hidden = false;
  movieListEl.innerHTML = "";
  const active = creatorEntries.filter((x) => x.active);
  if (!active.length) {
    movieListEl.innerHTML = '<p class="creator-status">No active videos.</p>';
    return;
  }
  for (const entry of active) {
    const a = document.createElement("a");
    a.className = "creator-catalog-row";
    a.href = buildViewerUrlForVideoId(entry.assetId);
    a.target = "_blank";
    a.rel = "noopener noreferrer";

    const posterWrap = document.createElement("div");
    posterWrap.className = "creator-catalog-poster-wrap";
    const poster = document.createElement("img");
    poster.className = "creator-catalog-poster creator-catalog-poster--still";
    poster.alt = "";
    poster.loading = "lazy";
    poster.decoding = "async";
    posterWrap.appendChild(poster);

    const title = document.createElement("div");
    title.className = "creator-catalog-title";
    title.textContent = entry.title;

    a.append(posterWrap, title);
    movieListEl.appendChild(a);
  }
  void hydrateMoviePosters(active);
}

/**
 * @param {import("../filstream-catalog-chain.mjs").CatalogEntry[]} activeEntries
 */
async function hydrateMoviePosters(activeEntries) {
  if (!movieListEl) return;
  const rows = movieListEl.querySelectorAll(".creator-catalog-row");
  for (let i = 0; i < rows.length && i < activeEntries.length; i++) {
    const entry = activeEntries[i];
    const row = rows[i];
    const img = /** @type {HTMLImageElement | null} */ (
      row.querySelector(".creator-catalog-poster--still")
    );
    if (!img) continue;
    const wrap = row.querySelector(".creator-catalog-poster-wrap");
    try {
      const doc = await manifestDocForEntry(entry);
      const posterUrl = posterFromManifestDoc(doc);
      const animUrl = posterAnimFromManifestDoc(doc);
      if (posterUrl) img.src = posterUrl;
      if (posterUrl && animUrl && wrap instanceof HTMLElement) {
        wrap.classList.add("creator-catalog-poster-wrap--anim");
        let motion = wrap.querySelector(".creator-catalog-poster--motion");
        if (!(motion instanceof HTMLImageElement)) {
          motion = document.createElement("img");
          motion.className = "creator-catalog-poster creator-catalog-poster--motion";
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

bindEvents();
void refreshAll();
