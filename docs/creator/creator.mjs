/**
 * GitHub Pages: `creator.html?catalog=<absolute-https-url-to-filstream_catalog.json>[&dataset=<pdp-data-set-id>]`
 * If the catalog URL is missing or 404, `?dataset=` plus app chain config can load the latest
 * `filstream_catalog.json` from PDP (same helper as refresh).
 *
 * Shows catalog identity, creator header, movie list, and (for the editor with a storage session)
 * editing: creator name/poster, movie order, save, and remove movie with PDP piece deletes.
 */
import {
  createSynapseForSession,
  deleteAllPiecesForAssetId,
  fetchLatestCatalogJsonForDataSet,
  getPieceRetrievalUrl,
  openDataSetContextForCatalog,
  publishFilstreamCatalogJson,
} from "../browser-store.mjs";
import { moviesFromCatalog, viewerHrefForMeta } from "../filstream-catalog-shared.mjs";
import { mountFilstreamBrand } from "../filstream-brand.mjs";
import { getFilstreamStoreConfig } from "../filstream-config.mjs";
import { authorizeSessionKeyForUpload } from "../session-key-bootstrap.mjs";

const brandMount = document.getElementById("creator-brand-mount");
if (brandMount) {
  mountFilstreamBrand(brandMount);
}

const statusEl = document.getElementById("creator-status");
const heroEl = document.getElementById("creator-hero");
const posterImg = document.getElementById("creator-poster");
const titleEl = document.getElementById("creator-title");
const datasetLabel = document.getElementById("creator-dataset-label");
const identityEl = document.getElementById("creator-identity");
const walletBlock = document.getElementById("creator-wallet-block");
const roleLabel = document.getElementById("creator-role-label");
const connectBtn = document.getElementById("creator-connect-wallet");
const editSection = document.getElementById("creator-edit-section");
const editHint = document.getElementById("creator-edit-hint");
const enableEditBtn = document.getElementById("creator-enable-edit");
const editForm = document.getElementById("creator-edit-form");
const nameInput = document.getElementById("creator-name-input");
const posterInput = document.getElementById("creator-poster-input");
const saveBtn = document.getElementById("creator-save-btn");
const saveStatus = document.getElementById("creator-save-status");
const movieEditList = document.getElementById("creator-movie-edit-list");
const catalogSection = document.getElementById("creator-catalog-section");
const movieListEl = document.getElementById("creator-movie-list");

/** @type {{ editorAddress: string | null, dataSetId: number | null, chainId: number | null, providerId: number | null } | null} */
let catalogIdentity = null;
/** @type {string | null} */
let connectedAddress = null;
/** @type {string | null} */
let sessionPrivateKey = null;
/** @type {Record<string, string> | null} */
let sessionExpirations = null;
/** @type {import("@filoz/synapse-sdk").Synapse | null} */
let synapseRef = null;
/** @type {import("@filoz/synapse-sdk/storage").StorageContext | null} */
let storageContext = null;

/** @type {string | null} */
let catalogUrl = null;
/** @type {number | null} Parsed non-negative `?dataset=` for links / refresh (optional). */
let datasetQueryParsed = null;
/** @type {{ title: string, metapath: string, posterUrl?: string }[]} */
let moviesState = [];
/** @type {Record<string, unknown> | null} */
let loadedCatalogRoot = null;

let saveBusy = false;

function setStatus(msg, kind) {
  if (!statusEl) return;
  statusEl.textContent = msg;
  statusEl.className = `creator-status${kind === "err" ? " err" : ""}`;
}

/**
 * @param {unknown} doc
 * @returns {{ editorAddress: string | null, dataSetId: number | null, chainId: number | null, providerId: number | null } | null}
 */
function parseCatalogIdentity(doc) {
  if (!doc || typeof doc !== "object" || doc === null) return null;
  const d = /** @type {Record<string, unknown>} */ (doc);
  const ed = d.editorAddress;
  const editorAddress =
    typeof ed === "string" && ed.trim() !== "" ? ed.trim() : null;
  const ds = d.dataSetId;
  const dataSetId = typeof ds === "number" && Number.isFinite(ds) ? ds : null;
  const ch = d.chainId;
  const chainId = typeof ch === "number" && Number.isFinite(ch) ? ch : null;
  const pr = d.providerId;
  const providerId = typeof pr === "number" && Number.isFinite(pr) ? pr : null;
  if (
    editorAddress == null &&
    dataSetId == null &&
    chainId == null &&
    providerId == null
  ) {
    return null;
  }
  return { editorAddress, dataSetId, chainId, providerId };
}

/**
 * @param {string} a
 * @param {string} b
 */
function sameEthAddress(a, b) {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

function refreshWalletRole() {
  if (!roleLabel) return;
  if (!catalogIdentity?.editorAddress) {
    roleLabel.textContent = "";
    return;
  }
  if (!window.ethereum) {
    roleLabel.textContent = "Install a wallet extension";
    return;
  }
  if (!connectedAddress) {
    roleLabel.textContent = "Connect wallet";
    return;
  }
  roleLabel.textContent = sameEthAddress(connectedAddress, catalogIdentity.editorAddress)
    ? "Editor"
    : "Viewer";
}

async function refreshConnectedAccount() {
  const eth = window.ethereum;
  if (!eth || typeof eth.request !== "function") return;
  try {
    const accounts = /** @type {string[]} */ (await eth.request({ method: "eth_accounts" }));
    connectedAddress = accounts?.[0] ?? null;
    refreshWalletRole();
    refreshEditVisibility();
  } catch {
    connectedAddress = null;
    refreshWalletRole();
    refreshEditVisibility();
  }
}

function initWalletConnect() {
  const eth = window.ethereum;
  if (!connectBtn || !eth || typeof eth.request !== "function") return;
  connectBtn.addEventListener("click", async () => {
    try {
      const accounts = /** @type {string[]} */ (
        await eth.request({ method: "eth_requestAccounts" })
      );
      connectedAddress = accounts?.[0] ?? null;
      refreshWalletRole();
      refreshEditVisibility();
    } catch {
      /* user rejected */
    }
  });
  if (typeof eth.on === "function") {
    eth.on("accountsChanged", (accs) => {
      const a = Array.isArray(accs) ? accs[0] : null;
      connectedAddress = typeof a === "string" ? a : null;
      refreshWalletRole();
      refreshEditVisibility();
    });
  }
}

/**
 * @param {unknown} meta
 * @returns {string | null}
 */
function assetIdFromMeta(meta) {
  if (!meta || typeof meta !== "object" || meta === null) return null;
  const f = /** @type {{ filstream?: unknown }} */ (meta).filstream;
  if (f && typeof f === "object" && f !== null) {
    const aid = /** @type {{ assetId?: unknown }} */ (f).assetId;
    if (typeof aid === "string" && aid.trim() !== "") return aid.trim();
  }
  return null;
}

/**
 * @param {unknown} meta
 * @returns {string | null}
 */
function posterUrlFromMetaJson(meta) {
  if (
    meta &&
    typeof meta === "object" &&
    meta !== null &&
    typeof meta.poster === "object" &&
    meta.poster !== null &&
    typeof /** @type {{ url?: string }} */ (meta.poster).url === "string"
  ) {
    const u = /** @type {{ url?: string }} */ (meta.poster).url.trim();
    if (u) return u;
  }
  const m = meta && typeof meta === "object" && meta !== null ? meta : null;
  const pb =
    m &&
    typeof m.playback === "object" &&
    m.playback !== null &&
    typeof /** @type {{ posterUrl?: string }} */ (m.playback).posterUrl === "string"
      ? /** @type {{ posterUrl?: string }} */ (m.playback).posterUrl.trim()
      : "";
  return pb || null;
}

function viewerBaseHref() {
  return new URL("viewer.html", window.location.href).href;
}

function isEditorConnected() {
  return Boolean(
    catalogIdentity?.editorAddress &&
      connectedAddress &&
      sameEthAddress(connectedAddress, catalogIdentity.editorAddress),
  );
}

function refreshEditVisibility() {
  if (!editSection || !editHint || !enableEditBtn || !editForm) return;
  const editor = isEditorConnected();
  const storageReady = Boolean(sessionPrivateKey && synapseRef && storageContext);
  if (!catalogIdentity?.editorAddress) {
    editSection.hidden = true;
    return;
  }
  editSection.hidden = false;
  if (!editor) {
    editHint.textContent =
      "Connect with the catalog editor wallet to reorder entries, edit the channel name, or remove movies.";
    enableEditBtn.hidden = true;
    editForm.hidden = true;
    return;
  }
  editHint.textContent = storageReady
    ? "Edits are saved as a new on-chain catalog piece. Removing a movie deletes its PDP pieces first, then updates the catalog."
    : "Authorize a storage session (same as the upload wizard) to edit this catalog on-chain.";
  enableEditBtn.hidden = storageReady;
  editForm.hidden = !storageReady;
  if (storageReady && nameInput && posterInput) {
    const cn = loadedCatalogRoot && /** @type {{ creatorName?: unknown }} */ (loadedCatalogRoot).creatorName;
    const cpu =
      loadedCatalogRoot && /** @type {{ creatorPosterUrl?: unknown }} */ (loadedCatalogRoot).creatorPosterUrl;
    nameInput.value = typeof cn === "string" ? cn : "";
    posterInput.value = typeof cpu === "string" ? cpu : "";
  }
}

function buildPublishDoc() {
  if (!catalogIdentity || !loadedCatalogRoot) {
    throw new Error("Catalog not loaded");
  }
  const ed = catalogIdentity.editorAddress;
  if (!ed) {
    throw new Error("Catalog has no editorAddress");
  }
  const cn = nameInput?.value?.trim() ?? "";
  const cpu = posterInput?.value?.trim() ?? "";
  /** @type {Record<string, unknown>} */
  const doc = {
    kind: "filstream v1",
    editorAddress: ed,
    movies: moviesState.map((m) => {
      /** @type {{ title: string, metapath: string, posterUrl?: string }} */
      const row = { title: m.title, metapath: m.metapath };
      if (m.posterUrl) row.posterUrl = m.posterUrl;
      return row;
    }),
  };
  if (catalogIdentity.dataSetId != null) doc.dataSetId = catalogIdentity.dataSetId;
  if (catalogIdentity.providerId != null) doc.providerId = catalogIdentity.providerId;
  if (catalogIdentity.chainId != null) doc.chainId = catalogIdentity.chainId;
  if (cn) doc.creatorName = cn;
  if (cpu) doc.creatorPosterUrl = cpu;
  return doc;
}

async function handleSaveCatalog() {
  if (!storageContext || !synapseRef || !catalogIdentity?.dataSetId || saveBusy) return;
  const cfg = getFilstreamStoreConfig();
  saveBusy = true;
  if (saveStatus) saveStatus.textContent = "Saving…";
  if (saveBtn) saveBtn.disabled = true;
  try {
    const doc = buildPublishDoc();
    const assetId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `cat_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const { pieceCid } = await publishFilstreamCatalogJson({
      context: storageContext,
      synapse: synapseRef,
      assetId,
      catalogDoc: doc,
    });
    loadedCatalogRoot = doc;
    const newCatalogUrl = await getPieceRetrievalUrl(storageContext, pieceCid);
    if (newCatalogUrl) {
      catalogUrl = newCatalogUrl;
      if (catalogIdentity?.dataSetId != null) {
        replaceBrowserUrlForCatalog(catalogUrl, catalogIdentity.dataSetId);
      }
    }
    renderMovieLists();
    if (saveStatus) saveStatus.textContent = "Saved.";
    setStatus("");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (saveStatus) saveStatus.textContent = `Save failed: ${msg}`;
  } finally {
    saveBusy = false;
    if (saveBtn) saveBtn.disabled = false;
  }
}

/**
 * @param {number} index
 */
async function handleRemoveMovie(index) {
  if (!storageContext || !synapseRef || !catalogIdentity || catalogIdentity.dataSetId == null) {
    return;
  }
  const row = moviesState[index];
  if (!row) return;
  if (
    !window.confirm(
      `Remove “${row.title}” from the catalog and delete its stored pieces? This cannot be undone.`,
    )
  ) {
    return;
  }
  const cfg = getFilstreamStoreConfig();
  saveBusy = true;
  if (saveStatus) saveStatus.textContent = "Removing…";
  try {
    const res = await fetch(row.metapath);
    if (!res.ok) {
      throw new Error(`meta.json HTTP ${res.status}`);
    }
    const meta = await res.json();
    const assetId = assetIdFromMeta(meta);
    if (!assetId) {
      throw new Error(
        "This listing has no filstream.assetId in meta.json — cannot delete PDP pieces automatically.",
      );
    }
    const del = await deleteAllPiecesForAssetId({
      context: storageContext,
      synapse: synapseRef,
      chainId: cfg.storeChainId,
      dataSetId: catalogIdentity.dataSetId,
      assetId,
    });
    if (del.errors.length > 0) {
      throw new Error(del.errors[0] ?? "Delete failed");
    }
    moviesState.splice(index, 1);
    renderMovieLists();
    saveBusy = false;
    await handleSaveCatalog();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (saveStatus) saveStatus.textContent = `Remove failed: ${msg}`;
  } finally {
    saveBusy = false;
  }
}

/**
 * @param {number} index
 * @param {number} delta
 */
function moveMovie(index, delta) {
  const j = index + delta;
  if (j < 0 || j >= moviesState.length) return;
  const t = moviesState[index];
  moviesState[index] = moviesState[j];
  moviesState[j] = t;
  renderMovieLists();
}

function renderMovieEditList() {
  if (!movieEditList) return;
  movieEditList.innerHTML = "";
  const storageReady = Boolean(sessionPrivateKey && synapseRef && storageContext);
  moviesState.forEach((m, i) => {
    const li = document.createElement("li");
    li.className = "creator-movie-edit-row";
    const title = document.createElement("span");
    title.className = "creator-movie-edit-title";
    title.textContent = m.title;
    const actions = document.createElement("div");
    actions.className = "creator-movie-edit-actions";
    if (storageReady) {
      const up = document.createElement("button");
      up.type = "button";
      up.className = "creator-row-btn";
      up.textContent = "Up";
      up.disabled = i === 0;
      up.addEventListener("click", () => moveMovie(i, -1));
      const down = document.createElement("button");
      down.type = "button";
      down.className = "creator-row-btn";
      down.textContent = "Down";
      down.disabled = i === moviesState.length - 1;
      down.addEventListener("click", () => moveMovie(i, 1));
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "creator-row-btn creator-row-btn--danger";
      rm.textContent = "Remove";
      rm.addEventListener("click", () => void handleRemoveMovie(i));
      actions.append(up, down, rm);
    }
    li.append(title, actions);
    movieEditList.appendChild(li);
  });
}

function renderMovieReadonlyList() {
  if (!movieListEl || !catalogUrl) return;
  movieListEl.innerHTML = "";
  const chronological = [...moviesState];
  const newestFirst = chronological.reverse();
  newestFirst.forEach((m) => {
    const a = document.createElement("a");
    a.className = "creator-catalog-row";
    a.href = viewerHrefForMeta(
      m.metapath,
      catalogUrl,
      viewerBaseHref(),
      catalogIdentity?.dataSetId ?? datasetQueryParsed,
    );
    a.title = m.title;

    const wrap = document.createElement("div");
    wrap.className = "creator-catalog-poster-wrap";
    if (m.posterUrl) {
      const img = document.createElement("img");
      img.className = "creator-catalog-poster";
      img.src = m.posterUrl;
      img.alt = "";
      img.loading = "lazy";
      wrap.appendChild(img);
    }

    const te = document.createElement("div");
    te.className = "creator-catalog-title";
    te.textContent = m.title;

    a.appendChild(wrap);
    a.appendChild(te);
    movieListEl.appendChild(a);
  });
}

function renderMovieLists() {
  renderMovieReadonlyList();
  renderMovieEditList();
}

/**
 * @param {Record<string, unknown>} doc
 */
async function applyHeroFromDoc(doc) {
  if (!heroEl || !titleEl) return;
  const cn = typeof doc.creatorName === "string" ? doc.creatorName.trim() : "";
  const cpu = typeof doc.creatorPosterUrl === "string" ? doc.creatorPosterUrl.trim() : "";
  let title = cn || "Catalog";
  let poster = cpu || null;

  if (!cn && moviesState.length > 0) {
    title = moviesState[0].title || title;
    if (!poster && moviesState[0].posterUrl) {
      poster = moviesState[0].posterUrl;
    }
  }
  if (!poster && moviesState[0]?.metapath) {
    try {
      const res = await fetch(moviesState[0].metapath);
      if (res.ok) {
        const meta = await res.json();
        poster = posterUrlFromMetaJson(meta);
      }
    } catch {
      /* ignore */
    }
  }

  titleEl.textContent = title;
  if (posterImg) {
    if (poster) {
      posterImg.src = poster;
      posterImg.hidden = false;
    } else {
      posterImg.removeAttribute("src");
      posterImg.hidden = true;
    }
  }
  heroEl.hidden = false;
}

/**
 * @param {unknown} doc
 */
function applyCatalogIdentity(doc) {
  if (!datasetLabel) return;

  if (doc == null) {
    catalogIdentity = null;
    if (identityEl) identityEl.hidden = true;
    return;
  }

  catalogIdentity = parseCatalogIdentity(doc);
  if (identityEl) identityEl.hidden = false;

  if (!catalogIdentity) {
    datasetLabel.textContent =
      "This catalog has no dataSetId, providerId, chainId, or editorAddress fields.";
    if (connectBtn) connectBtn.hidden = true;
    return;
  }

  const parts = [];
  if (catalogIdentity.dataSetId != null) {
    parts.push(`Dataset ${catalogIdentity.dataSetId}`);
  }
  if (catalogIdentity.providerId != null) {
    parts.push(`provider ${catalogIdentity.providerId}`);
  }
  if (catalogIdentity.chainId != null) {
    parts.push(`chain ${catalogIdentity.chainId}`);
  }
  datasetLabel.textContent = parts.length ? parts.join(" · ") : "Catalog";

  if (connectBtn) {
    connectBtn.hidden = !catalogIdentity.editorAddress || !window.ethereum;
  }
  void refreshConnectedAccount();
  refreshWalletRole();
  refreshEditVisibility();
}

/**
 * @param {unknown} doc
 * @param {string} url Absolute `filstream_catalog.json` retrieval URL.
 */
async function applyLoadedCatalogDoc(doc, url) {
  loadedCatalogRoot =
    doc && typeof doc === "object" && doc !== null
      ? /** @type {Record<string, unknown>} */ (doc)
      : null;
  catalogUrl = url;
  moviesState = moviesFromCatalog(doc);
  applyCatalogIdentity(doc);
  await applyHeroFromDoc(loadedCatalogRoot ?? {});
  if (catalogSection) catalogSection.hidden = moviesState.length === 0;
  setStatus("");
  document.title = "FilStream catalog · creator";
}

/**
 * @param {string} catalogUrlStr
 * @param {number | null} dataSetId
 */
function replaceBrowserUrlForCatalog(catalogUrlStr, dataSetId) {
  const u = new URL(window.location.href);
  u.searchParams.set("catalog", catalogUrlStr);
  if (dataSetId != null && Number.isFinite(dataSetId) && dataSetId >= 0) {
    u.searchParams.set("dataset", String(dataSetId));
  }
  history.replaceState({}, "", u);
}

/**
 * If the loaded URL points at an old piece but a newer catalog exists on-chain, switch to it.
 * Always re-renders movie links last so `?catalog=` on viewer URLs matches the current piece URL.
 */
async function upgradeCatalogFromChainIfNewer() {
  try {
    if (catalogIdentity?.dataSetId == null || catalogIdentity.chainId == null) {
      return;
    }
    const refreshed = await fetchLatestCatalogJsonForDataSet({
      chainId: catalogIdentity.chainId,
      dataSetId: catalogIdentity.dataSetId,
    });
    if (!refreshed?.doc || typeof refreshed.doc !== "object") {
      return;
    }
    const nextUrl = refreshed.retrievalUrl.trim();
    const prevUrl = catalogUrl?.trim() ?? "";
    if (!nextUrl || nextUrl === prevUrl) {
      return;
    }
    catalogUrl = nextUrl;
    loadedCatalogRoot =
      refreshed.doc && typeof refreshed.doc === "object" && refreshed.doc !== null
        ? /** @type {Record<string, unknown>} */ (refreshed.doc)
        : loadedCatalogRoot;
    moviesState = moviesFromCatalog(refreshed.doc);
    applyCatalogIdentity(refreshed.doc);
    await applyHeroFromDoc(loadedCatalogRoot ?? {});
    if (catalogSection) catalogSection.hidden = moviesState.length === 0;
    if (catalogIdentity.dataSetId != null) {
      replaceBrowserUrlForCatalog(catalogUrl, catalogIdentity.dataSetId);
    }
  } finally {
    renderMovieLists();
  }
}

async function handleEnableEditing() {
  const eth = window.ethereum;
  if (!eth || !connectedAddress || !catalogIdentity?.dataSetId || !catalogIdentity.providerId) {
    return;
  }
  if (enableEditBtn) {
    enableEditBtn.disabled = true;
    enableEditBtn.textContent = "Authorizing…";
  }
  try {
    const auth = await authorizeSessionKeyForUpload(eth, connectedAddress, {});
    sessionPrivateKey = auth.sessionPrivateKey;
    sessionExpirations = auth.sessionExpirations;
    const cfg = getFilstreamStoreConfig();
    const syn = await createSynapseForSession(
      {
        rpcUrl: cfg.storeRpcUrl,
        chainId: cfg.storeChainId,
        source: cfg.storeSource,
      },
      connectedAddress,
      sessionPrivateKey,
      sessionExpirations,
    );
    synapseRef = syn;
    storageContext = await openDataSetContextForCatalog({
      synapse: syn,
      providerId: catalogIdentity.providerId,
      dataSetId: catalogIdentity.dataSetId,
      catalogChainId: catalogIdentity.chainId,
    });
    if (enableEditBtn) {
      enableEditBtn.textContent = "Enable editing";
      enableEditBtn.disabled = false;
    }
    refreshEditVisibility();
    renderMovieLists();
  } catch (e) {
    if (enableEditBtn) {
      enableEditBtn.disabled = false;
      enableEditBtn.textContent = "Enable editing";
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (saveStatus) saveStatus.textContent = `Session failed: ${msg}`;
  }
}

function wireEditControls() {
  if (enableEditBtn) {
    enableEditBtn.addEventListener("click", () => void handleEnableEditing());
  }
  if (saveBtn) {
    saveBtn.addEventListener("click", () => void handleSaveCatalog());
  }
  if (nameInput) {
    nameInput.addEventListener("input", () => {
      /* optional live hero update */
    });
  }
}

initWalletConnect();
wireEditControls();

const params = new URLSearchParams(window.location.search);
const catalogUrlRaw = params.get("catalog");
catalogUrl =
  catalogUrlRaw && /^https?:\/\//i.test(catalogUrlRaw.trim())
    ? catalogUrlRaw.trim()
    : null;
const datasetQueryRaw = params.get("dataset");
if (datasetQueryRaw && datasetQueryRaw.trim() !== "") {
  const n = Number.parseInt(datasetQueryRaw.trim(), 10);
  if (Number.isFinite(n) && n >= 0) {
    datasetQueryParsed = n;
  } else {
    console.warn(
      "[filstream creator] Ignoring invalid dataset query param (expected non-negative integer).",
    );
  }
}

if (catalogUrlRaw && !catalogUrl) {
  console.warn(
    "[filstream creator] Ignoring invalid catalog query param (expected absolute http(s) URL).",
  );
}

if (!catalogUrl && datasetQueryParsed == null) {
  setStatus(
    "Missing ?catalog= (absolute https URL) or ?dataset= (PDP data set id to load from chain).",
    "err",
  );
} else {
  void (async () => {
    /** @type {Error | null} */
    let loadError = null;

    if (catalogUrl) {
      try {
        const res = await fetch(catalogUrl);
        if (!res.ok) {
          loadError = new Error(`Catalog HTTP ${res.status}`);
        } else {
          const doc = await res.json();
          await applyLoadedCatalogDoc(doc, catalogUrl);
          if (
            datasetQueryParsed != null &&
            catalogIdentity?.dataSetId != null &&
            datasetQueryParsed !== catalogIdentity.dataSetId
          ) {
            console.warn(
              "[filstream creator] ?dataset= does not match catalog dataSetId; using catalog identity.",
            );
          }
          await upgradeCatalogFromChainIfNewer();
          return;
        }
      } catch (e) {
        loadError = e instanceof Error ? e : new Error(String(e));
      }
    }

    if (datasetQueryParsed != null) {
      const cfg = getFilstreamStoreConfig();
      const recovered = await fetchLatestCatalogJsonForDataSet({
        chainId: cfg.storeChainId,
        dataSetId: datasetQueryParsed,
      });
      if (recovered?.doc && typeof recovered.doc === "object") {
        await applyLoadedCatalogDoc(recovered.doc, recovered.retrievalUrl.trim());
        const ds = catalogIdentity?.dataSetId ?? datasetQueryParsed;
        replaceBrowserUrlForCatalog(catalogUrl, ds);
        await upgradeCatalogFromChainIfNewer();
        if (loadError) {
          console.warn(
            "[filstream creator] Recovered using on-chain catalog (catalog URL was missing or failed):",
            loadError.message,
          );
        }
        return;
      }
    }

    applyCatalogIdentity(null);
    if (heroEl) heroEl.hidden = true;
    if (catalogSection) catalogSection.hidden = true;
    const hint =
      datasetQueryParsed != null
        ? " On-chain recovery failed (wrong network: set window.__FILSTREAM_CONFIG__ storeRpcUrl / storeChainId to match this data set)."
        : "";
    setStatus(
      `Could not load catalog${loadError ? `: ${loadError.message}` : ""}.${hint}`,
      "err",
    );
  })();
}
