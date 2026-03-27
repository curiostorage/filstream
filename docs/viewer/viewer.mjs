/**
 * GitHub Pages entry:
 * `viewer.html?meta=<absolute-https-url-to-meta.json>[&catalog=<absolute-url-to-filstream_catalog.json>][&dataset=<pdp-data-set-id>]`
 *
 * Fetches `meta.json` for playback. When `catalog` is present, the viewer always fetches that
 * `filstream_catalog.json` URL for the sidebar and byline. Optional `dataset` is propagated on
 * creator and sibling viewer links so the creator page can resolve the latest catalog on-chain.
 * The sidebar shows
 * a right column (newest first): poster 168px + title 192px. Catalog rows include `posterUrl` when
 * published by FilStream so the sidebar does not fetch each `meta.json` for posters; legacy
 * catalogs fall back to fetching `meta` per row when `posterUrl` is absent.
 *
 * Below the player: title, optional upload date, byline (catalog creator + donate when
 * `?catalog=`), description in a panel, and donate from `meta.json` (same data as Review chrome).
 *
 */
import shaka from "https://esm.sh/shaka-player";
import {
  broadcastCopyFromMeta,
  formatUploadDateLabel,
} from "../filstream-broadcast-view.mjs";
import { mountFilstreamBrand } from "../filstream-brand.mjs";
import {
  creatorHrefForCatalog,
  creatorInfoFromCatalog,
  moviesFromCatalog,
  viewerHrefForMeta,
} from "../filstream-catalog-shared.mjs";
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
const bylineEl = document.getElementById("viewer-byline");
const bylineCatalogEl = document.getElementById("viewer-byline-catalog");
const donateRootEl = document.getElementById("viewer-donate-root");
const catalogAside = document.getElementById("viewer-catalog");

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
 * @param {string} catalogUrl
 * @param {string} currentMetaUrl
 * @param {string | null} catalogParam
 * @param {unknown} [currentMetaDoc] Loaded `meta.json` for the current page (skips an extra fetch for its poster)
 */
/**
 * @param {string} catalogUrl
 * @param {string} currentMetaUrl
 * @param {string | null} catalogParam
 * @param {number | null} datasetIdForLinks
 * @param {unknown} [currentMetaDoc]
 * @param {unknown | null} [preloadedDoc] Fetched catalog JSON, or `null` if fetch already failed (skip refetch)
 */
async function renderCatalogSidebar(
  catalogUrl,
  currentMetaUrl,
  catalogParam,
  datasetIdForLinks,
  currentMetaDoc,
  preloadedDoc,
) {
  if (!catalogAside) return;

  try {
    let doc;
    if (preloadedDoc === undefined) {
      const res = await fetch(catalogUrl);
      if (!res.ok) {
        catalogAside.hidden = false;
        catalogAside.innerHTML = `<p class="viewer-catalog-note">Catalog unavailable (${res.status})</p>`;
        return;
      }
      doc = await res.json();
    } else if (preloadedDoc === null) {
      catalogAside.hidden = false;
      catalogAside.innerHTML = `<p class="viewer-catalog-note">Catalog unavailable</p>`;
      return;
    } else {
      doc = preloadedDoc;
    }
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
      a.href = viewerHrefForMeta(m.metapath, catalogParam, undefined, datasetIdForLinks);
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
    catalogAside.hidden = false;
    const msg = e instanceof Error ? e.message : String(e);
    catalogAside.innerHTML = `<p class="viewer-catalog-note">Catalog unavailable: ${escapeHtml(msg)}</p>`;
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
 * Prefer `dataSetId` from loaded catalog JSON; fall back to `?dataset=` (viewer / share links).
 *
 * @param {unknown} doc
 * @param {string | null} datasetQuery
 * @returns {number | null}
 */
function resolveDatasetIdForCatalog(doc, datasetQuery) {
  if (doc && typeof doc === "object" && doc !== null) {
    const ds = /** @type {Record<string, unknown>} */ (doc).dataSetId;
    if (typeof ds === "number" && Number.isFinite(ds)) {
      return ds;
    }
  }
  if (datasetQuery != null && datasetQuery.trim() !== "") {
    const n = Number.parseInt(datasetQuery.trim(), 10);
    if (Number.isFinite(n) && n >= 0) {
      return n;
    }
  }
  return null;
}

/**
 * @param {unknown} meta
 * @param {{ catalogUrl: string | null, catalogDoc: unknown | null, datasetId: number | null }} [catalogCtx]
 */
function renderByline(meta, catalogCtx) {
  const catalogUrl = catalogCtx?.catalogUrl ?? null;
  const catalogDoc = catalogCtx?.catalogDoc ?? null;
  const datasetId = catalogCtx?.datasetId ?? null;
  if (!bylineEl || !bylineCatalogEl || !donateRootEl) return;

  const cfg = donateConfigFromMeta(meta);
  const showDonate = cfg.enabled;
  const showCatalogStrip = !!catalogUrl;

  if (!showDonate && !showCatalogStrip) {
    bylineEl.hidden = true;
    bylineCatalogEl.innerHTML = "";
    donateRootEl.innerHTML = "";
    return;
  }

  bylineEl.hidden = false;
  bylineCatalogEl.innerHTML = "";

  if (showCatalogStrip && catalogUrl) {
    const href = creatorHrefForCatalog(catalogUrl, undefined, datasetId);
    const { creatorName, creatorPosterUrl } = creatorInfoFromCatalog(catalogDoc);
    const nameLabel = creatorName || "Creator";

    const cluster = document.createElement("div");
    cluster.className = "viewer-creator-cluster";

    const avatarLink = document.createElement("a");
    avatarLink.className = "viewer-creator-avatar-link";
    avatarLink.href = href;
    avatarLink.title = "Open creator page";

    if (creatorPosterUrl) {
      const img = document.createElement("img");
      img.className = "viewer-creator-avatar";
      img.src = creatorPosterUrl;
      img.alt = "";
      img.width = 40;
      img.height = 40;
      img.decoding = "async";
      img.loading = "lazy";
      avatarLink.appendChild(img);
    } else {
      const ph = document.createElement("span");
      ph.className = "viewer-creator-avatar viewer-creator-avatar--placeholder";
      ph.setAttribute("aria-hidden", "true");
      ph.textContent = nameLabel.slice(0, 1).toUpperCase() || "?";
      avatarLink.appendChild(ph);
    }

    const nameLink = document.createElement("a");
    nameLink.className = "viewer-creator-name";
    nameLink.href = href;
    nameLink.textContent = nameLabel;
    nameLink.title = "Open creator page";

    cluster.appendChild(avatarLink);
    cluster.appendChild(nameLink);
    bylineCatalogEl.appendChild(cluster);
  }

  donateRootEl.innerHTML = "";
  renderDonateBlock(meta);
}

/**
 * Title, description, optional upload date, byline (catalog + donate), description panel — same data as Review chrome.
 *
 * @param {unknown} meta
 * @param {{ catalogUrl: string | null, catalogDoc: unknown | null, datasetId: number | null }} [catalogCtx]
 */
function renderViewerMeta(meta, catalogCtx) {
  loadedMeta = meta;
  donateBusy = false;
  donateError = "";
  donateTxHash = "";
  if (!metaSection || !titleEl || !descriptionEl || !donateRootEl) return;

  const ctx = catalogCtx ?? { catalogUrl: null, catalogDoc: null, datasetId: null };

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

  renderByline(meta, ctx);

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

const params = new URLSearchParams(window.location.search);
const metaUrl = params.get("meta");
const catalogUrlRaw = params.get("catalog");
/** @type {string | null} */
const datasetQueryRaw = params.get("dataset");
const catalogUrl =
  catalogUrlRaw && /^https?:\/\//i.test(catalogUrlRaw.trim())
    ? catalogUrlRaw.trim()
    : null;

if (catalogUrlRaw && !catalogUrl) {
  console.warn("[filstream viewer] Ignoring invalid catalog query param (expected absolute http(s) URL).");
}
if (datasetQueryRaw && datasetQueryRaw.trim() !== "") {
  const test = Number.parseInt(datasetQueryRaw.trim(), 10);
  if (!Number.isFinite(test) || test < 0) {
    console.warn("[filstream viewer] Ignoring invalid dataset query param (expected non-negative integer).");
  }
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

      /** @type {unknown | null} */
      let catalogDocPreload = null;
      let catalogFetchOk = false;
      if (catalogUrl) {
        try {
          const cres = await fetch(catalogUrl);
          if (cres.ok) {
            catalogDocPreload = await cres.json();
            catalogFetchOk = true;
          }
        } catch {
          /* leave null */
        }
      }

      const resolvedDatasetId = resolveDatasetIdForCatalog(
        catalogFetchOk ? catalogDocPreload : null,
        datasetQueryRaw,
      );
      renderViewerMeta(meta, {
        catalogUrl,
        catalogDoc: catalogFetchOk ? catalogDocPreload : null,
        datasetId: resolvedDatasetId,
      });
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
        void renderCatalogSidebar(
          catalogUrl,
          metaUrl,
          catalogUrl,
          resolvedDatasetId,
          meta,
          catalogFetchOk ? catalogDocPreload : null,
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus(`Playback failed: ${msg}`, "err");
    }
  })();
}
