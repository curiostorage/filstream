/**
 * GitHub Pages entry:
 * `viewer.html?meta=<absolute-https-url-to-meta.json>[&catalog=<absolute-url-to-filstream_catalog.json>]`
 *
 * Fetches `meta.json` for playback; optional `catalog` loads `filstream_catalog.json` and shows
 * a right column (newest first): poster 168px + title 192px. Catalog rows include `posterUrl` when
 * published by FilStream so the sidebar does not fetch each `meta.json` for posters; legacy
 * catalogs fall back to fetching `meta` per row when `posterUrl` is absent.
 *
 * Below the player: title, description, optional upload date, and donate (from `meta.json`), same
 * as the Review step used to show outside the iframe.
 *
 * Catalog documents include `dataSetId`, `editorAddress`, `chainId`, `providerId` so a connected
 * wallet can be compared to the catalog editor (vs viewer).
 */
import shaka from "https://esm.sh/shaka-player";
import {
  broadcastCopyFromMeta,
  formatUploadDateLabel,
} from "../filstream-broadcast-view.mjs";
import { mountFilstreamBrand } from "../filstream-brand.mjs";
import {
  donateConfigFromMeta,
  proposeDonateTransfer,
  resolveViewerProvider,
} from "../filstream-viewer-donate.mjs";

const brandMount = document.getElementById("viewer-brand-mount");
if (brandMount) {
  mountFilstreamBrand(brandMount);
}

const statusEl = document.getElementById("viewer-status");
const videoEl = document.getElementById("viewer-video");
const metaSection = document.getElementById("viewer-meta");
const titleEl = document.getElementById("viewer-title");
const uploadDateEl = document.getElementById("viewer-upload-date");
const descriptionEl = document.getElementById("viewer-description");
const donateRootEl = document.getElementById("viewer-donate-root");
const catalogAside = document.getElementById("viewer-catalog");
const identityEl = document.getElementById("viewer-identity");
const datasetLabel = document.getElementById("viewer-dataset-label");
const roleLabel = document.getElementById("viewer-role-label");
const connectBtn = document.getElementById("viewer-connect-wallet");

/** @type {{ editorAddress: string | null, dataSetId: number | null, chainId: number | null, providerId: number | null } | null} */
let catalogIdentity = null;
/** @type {string | null} */
let connectedAddress = null;

/** @type {unknown | null} */
let loadedMeta = null;
let donateBusy = false;
/** @type {string} */
let donateError = "";
/** @type {string} */
let donateTxHash = "";

function setStatus(msg, kind) {
  if (!statusEl) return;
  statusEl.textContent = msg;
  statusEl.className = `viewer-status${kind === "err" ? " err" : ""}`;
}

/**
 * @param {string} a
 * @param {string} b
 */
function sameMetaUrl(a, b) {
  if (a === b) return true;
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}

/**
 * @param {string} metapath
 * @param {string | null} catalogParam
 */
function viewerHrefForMeta(metapath, catalogParam) {
  const u = new URL(window.location.href);
  u.searchParams.set("meta", metapath);
  if (catalogParam && catalogParam.trim() !== "") {
    u.searchParams.set("catalog", catalogParam.trim());
  } else {
    u.searchParams.delete("catalog");
  }
  return u.href;
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
    typeof meta.poster.url === "string"
  ) {
    const u = meta.poster.url.trim();
    if (u) return u;
  }
  const m = meta && typeof meta === "object" && meta !== null ? meta : null;
  const pb =
    m &&
    typeof m.playback === "object" &&
    m.playback !== null &&
    typeof m.playback.posterUrl === "string"
      ? m.playback.posterUrl.trim()
      : "";
  return pb || null;
}

/**
 * @param {string} metapath
 * @returns {Promise<string | null>}
 */
async function fetchPosterUrlFromMeta(metapath) {
  try {
    const res = await fetch(metapath);
    if (!res.ok) return null;
    const meta = await res.json();
    return posterUrlFromMetaJson(meta);
  } catch {
    return null;
  }
}

/**
 * Catalog row: `title`, `metapath` (meta.json URL), optional `posterUrl` (avoids per-row meta fetch).
 *
 * @param {unknown} doc
 * @returns {{ title: string, metapath: string, posterUrl?: string }[]}
 */
function moviesFromCatalog(doc) {
  if (!doc || typeof doc !== "object" || doc === null) return [];
  const movies = /** @type {{ movies?: unknown }} */ (doc).movies;
  if (!Array.isArray(movies)) return [];
  /** @type {{ title: string, metapath: string, posterUrl?: string }[]} */
  const out = [];
  for (const m of movies) {
    if (!m || typeof m !== "object") continue;
    const row = /** @type {{ title?: unknown, metapath?: unknown, posterUrl?: unknown }} */ (m);
    const title = typeof row.title === "string" ? row.title.trim() : "";
    const metapath = typeof row.metapath === "string" ? row.metapath.trim() : "";
    if (!metapath) continue;
    const pu =
      typeof row.posterUrl === "string" && row.posterUrl.trim() !== ""
        ? row.posterUrl.trim()
        : undefined;
    /** @type {{ title: string, metapath: string, posterUrl?: string }} */
    const item = { title: title || "Untitled", metapath };
    if (pu) item.posterUrl = pu;
    out.push(item);
  }
  return out;
}

/**
 * @param {string} catalogUrl
 * @param {string} currentMetaUrl
 * @param {string | null} catalogParam
 * @param {unknown} [currentMetaDoc] Loaded `meta.json` for the current page (skips an extra fetch for its poster)
 */
async function renderCatalogSidebar(catalogUrl, currentMetaUrl, catalogParam, currentMetaDoc) {
  if (!catalogAside) return;

  try {
    const res = await fetch(catalogUrl);
    if (!res.ok) {
      applyCatalogIdentity(null);
      catalogAside.hidden = false;
      catalogAside.innerHTML = `<p class="viewer-catalog-note">Catalog unavailable (${res.status})</p>`;
      return;
    }
    const doc = await res.json();
    applyCatalogIdentity(doc);
    const chronological = moviesFromCatalog(doc);
    if (chronological.length === 0) {
      catalogAside.hidden = true;
      catalogAside.innerHTML = "";
      return;
    }

    const newestFirst = [...chronological].reverse();

    const posterResults = await Promise.all(
      newestFirst.map((m) => {
        if (m.posterUrl) {
          return Promise.resolve(m.posterUrl);
        }
        if (sameMetaUrl(m.metapath, currentMetaUrl) && currentMetaDoc != null) {
          return Promise.resolve(posterUrlFromMetaJson(currentMetaDoc));
        }
        return fetchPosterUrlFromMeta(m.metapath);
      }),
    );

    catalogAside.hidden = false;
    catalogAside.innerHTML = "";

    const head = document.createElement("h2");
    head.className = "viewer-catalog-head";
    head.textContent = "In this catalog";
    catalogAside.appendChild(head);

    newestFirst.forEach((m, i) => {
      const posterUrl = posterResults[i];
      const a = document.createElement("a");
      a.className = "viewer-catalog-row";
      if (sameMetaUrl(m.metapath, currentMetaUrl)) {
        a.classList.add("viewer-catalog-row--current");
        a.setAttribute("aria-current", "page");
      }
      a.href = viewerHrefForMeta(m.metapath, catalogParam);
      a.title = m.title;

      const wrap = document.createElement("div");
      wrap.className = "viewer-catalog-poster-wrap";
      if (posterUrl) {
        const img = document.createElement("img");
        img.className = "viewer-catalog-poster";
        img.src = posterUrl;
        img.alt = "";
        img.loading = "lazy";
        img.decoding = "async";
        wrap.appendChild(img);
      }

      const titleEl = document.createElement("div");
      titleEl.className = "viewer-catalog-title";
      titleEl.textContent = m.title;

      a.appendChild(wrap);
      a.appendChild(titleEl);
      catalogAside.appendChild(a);
    });
  } catch (e) {
    applyCatalogIdentity(null);
    catalogAside.hidden = false;
    const msg = e instanceof Error ? e.message : String(e);
    catalogAside.innerHTML = `<p class="viewer-catalog-note">Catalog unavailable: ${escapeHtml(msg)}</p>`;
  }
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
 * @param {unknown} doc Catalog JSON, or `null` to hide the identity strip
 */
function applyCatalogIdentity(doc) {
  if (doc == null) {
    catalogIdentity = null;
    if (identityEl) identityEl.hidden = true;
    return;
  }
  catalogIdentity = parseCatalogIdentity(doc);
  if (!identityEl) return;
  if (!catalogIdentity) {
    identityEl.hidden = true;
    return;
  }
  identityEl.hidden = false;
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
  if (datasetLabel) {
    datasetLabel.textContent = parts.length ? parts.join(" · ") : "Catalog";
  }
  if (connectBtn) {
    connectBtn.hidden =
      !catalogIdentity.editorAddress || !window.ethereum;
  }
  void refreshConnectedAccount();
  refreshWalletRole();
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
  if (!catalogIdentity) {
    roleLabel.textContent = "";
    return;
  }
  if (!catalogIdentity.editorAddress) {
    roleLabel.textContent = "";
    return;
  }
  if (!window.ethereum) {
    roleLabel.textContent = "Install a wallet extension to verify role";
    return;
  }
  if (!connectedAddress) {
    roleLabel.textContent = "Connect wallet to verify role";
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
  } catch {
    connectedAddress = null;
    refreshWalletRole();
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
    } catch {
      /* user rejected or no wallet */
    }
  });
  if (typeof eth.on === "function") {
    eth.on("accountsChanged", (accs) => {
      const a = Array.isArray(accs) ? accs[0] : null;
      connectedAddress = typeof a === "string" ? a : null;
      refreshWalletRole();
    });
  }
}

/**
 * @param {string} s
 */
function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Title, description, optional upload date, donate — same data as the old Review chrome below the iframe.
 *
 * @param {unknown} meta
 */
function renderViewerMeta(meta) {
  loadedMeta = meta;
  donateBusy = false;
  donateError = "";
  donateTxHash = "";
  if (!metaSection || !titleEl || !descriptionEl || !donateRootEl) return;

  const copy = broadcastCopyFromMeta(meta);
  const title = copy.title.trim() || "Untitled";
  const desc = copy.description.trim();

  titleEl.textContent = title;
  document.title = `${title} · FilStream viewer`;

  if (uploadDateEl) {
    const when = formatUploadDateLabel(meta);
    if (when) {
      uploadDateEl.hidden = false;
      uploadDateEl.textContent = `Uploaded ${when}`;
      uploadDateEl.title = "Listing completed";
    } else {
      uploadDateEl.hidden = true;
      uploadDateEl.textContent = "";
      uploadDateEl.removeAttribute("title");
    }
  }

  descriptionEl.innerHTML = "";
  if (desc) {
    const p = document.createElement("p");
    p.className = "broadcast-desc-body";
    p.textContent = desc;
    descriptionEl.appendChild(p);
  } else {
    const p = document.createElement("p");
    p.className = "broadcast-desc-empty";
    p.textContent = "No description";
    descriptionEl.appendChild(p);
  }

  donateRootEl.innerHTML = "";
  renderDonateBlock(meta);

  metaSection.hidden = false;
}

/**
 * @param {unknown} meta
 */
function renderDonateBlock(meta) {
  if (!donateRootEl) return;
  donateRootEl.innerHTML = "";
  const cfg = donateConfigFromMeta(meta);
  if (!cfg.enabled) return;

  const wrap = document.createElement("div");
  wrap.className = "viewer-donate";
  wrap.setAttribute("aria-label", "Donate to creator");

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn btn-primary viewer-donate-btn";
  btn.disabled = donateBusy;
  btn.textContent = donateBusy ? "Connecting…" : `Donate ${cfg.amountHuman} ${cfg.token.symbol}`;
  btn.addEventListener("click", () => {
    void handleViewerDonateClick();
  });
  wrap.appendChild(btn);

  const noWallet = !resolveViewerProvider(null);
  if (noWallet) {
    const hint = document.createElement("p");
    hint.className = "viewer-donate-hint";
    hint.textContent = "Install a browser wallet to donate.";
    wrap.appendChild(hint);
  }
  if (donateError) {
    const err = document.createElement("p");
    err.className = "viewer-donate-err";
    err.setAttribute("role", "alert");
    err.textContent = donateError;
    wrap.appendChild(err);
  }
  if (donateTxHash) {
    const tx = document.createElement("p");
    tx.className = "viewer-donate-tx";
    tx.setAttribute("aria-live", "polite");
    tx.append("Transaction sent: ");
    const code = document.createElement("code");
    code.textContent = donateTxHash;
    tx.appendChild(code);
    wrap.appendChild(tx);
  }
  const rec = document.createElement("p");
  rec.className = "viewer-donate-recipient subtle";
  rec.append("Fund wallet (creator, step 2) ");
  const mono = document.createElement("span");
  mono.className = "mono";
  mono.textContent = cfg.recipient;
  rec.appendChild(mono);
  wrap.appendChild(rec);

  donateRootEl.appendChild(wrap);
}

async function handleViewerDonateClick() {
  const meta = loadedMeta;
  if (!meta) return;
  const cfg = donateConfigFromMeta(meta);
  if (!cfg.enabled) return;
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
    const { txHash } = await proposeDonateTransfer(provider, cfg);
    donateTxHash = txHash;
  } catch (e) {
    donateError = e instanceof Error ? e.message : String(e);
  } finally {
    donateBusy = false;
    renderDonateBlock(meta);
  }
}

initWalletConnect();

const params = new URLSearchParams(window.location.search);
const metaUrl = params.get("meta");
const catalogUrlRaw = params.get("catalog");
const catalogUrl =
  catalogUrlRaw && /^https?:\/\//i.test(catalogUrlRaw.trim())
    ? catalogUrlRaw.trim()
    : null;

if (catalogUrlRaw && !catalogUrl) {
  console.warn("[filstream viewer] Ignoring invalid catalog query param (expected absolute http(s) URL).");
}

if (!metaUrl || !/^https?:\/\//i.test(metaUrl)) {
  setStatus("Missing or invalid ?meta= URL (must be absolute http or https).", "err");
} else {
  void (async () => {
    try {
      const res = await fetch(metaUrl);
      if (!res.ok) {
        throw new Error(`meta.json HTTP ${res.status}`);
      }
      const meta = await res.json();
      const master =
        meta &&
        typeof meta.playback === "object" &&
        meta.playback !== null &&
        typeof meta.playback.masterAppUrl === "string"
          ? meta.playback.masterAppUrl.trim()
          : "";
      if (!master) {
        throw new Error("meta.json has no playback.masterAppUrl");
      }
      const poster = posterUrlFromMetaJson(meta) || "";
      if (poster && videoEl) {
        videoEl.setAttribute("poster", poster);
      }
      renderViewerMeta(meta);
      setStatus("");
      shaka.polyfill.installAll();
      const player = new shaka.Player();
      await player.attach(/** @type {HTMLVideoElement} */ (videoEl));
      try {
        await player.load(master, undefined, "application/x-mpegurl");
      } catch (firstErr) {
        try {
          await player.load(master, undefined, "application/vnd.apple.mpegurl");
        } catch {
          throw firstErr;
        }
      }

      if (catalogUrl) {
        void renderCatalogSidebar(catalogUrl, metaUrl, catalogUrl, meta);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus(`Playback failed: ${msg}`, "err");
    }
  })();
}
