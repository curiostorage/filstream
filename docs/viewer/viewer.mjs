/**
 * GitHub Pages entry:
 * `viewer.html?meta=<absolute-https-url-to-meta.json>[&catalog=<absolute-url-to-filstream_catalog.json>][&dataset=<pdp-data-set-id>][&embed=true]`
 *
 * Fetches `meta.json` for playback. When `catalog` is present, the viewer fetches that
 * `filstream_catalog.json` URL for the sidebar and byline. If the row for this `meta` has no `share`
 * URL (or the catalog request failed) but `dataset` / `dataSetId` is known, the viewer loads the
 * latest catalog piece from chain (same helper as the creator) and updates `?catalog=` via
 * `history.replaceState`.
 * The sidebar shows
 * a right column (newest first): poster 168px + title 192px. Catalog rows include `posterUrl` and
 * optional `posterAnimUrl` (mini animated WebP) when published by FilStream so the sidebar avoids
 * fetching each `meta.json`; legacy catalogs fall back to fetching `meta` per row when URLs are absent.
 * Hovering a row swaps the still poster for the animation when `posterAnimUrl` is present.
 *
 * Below the player: title, optional upload date, byline (catalog creator + donate when
 * `?catalog=`), description in a panel, and donate from `meta.json` (same data as Review chrome).
 *
 * `?embed=true` shows only the video and Shaka controls (⋯ menu: speed, quality, FilStream);
 * share/embed actions and catalog/meta are omitted.
 *
 * When `?catalog=` is present, the Share control is shown only if that catalog row for this `meta`
 * includes a `share` URL (Open Graph landing page published at finalize).
 *
 */
import {
  broadcastCopyFromMeta,
  formatUploadDateLabel,
} from "../filstream-broadcast-view.mjs";
import { FILSTREAM_BRAND, mountFilstreamBrand } from "../filstream-brand.mjs";
import {
  creatorHrefForCatalog,
  creatorInfoFromCatalog,
  moviesFromCatalog,
  posterAnimUrlFromMetaJson,
  viewerHrefForMeta,
} from "../filstream-catalog-shared.mjs";
import { fetchLatestCatalogJsonForDataSet } from "../browser-store.mjs";
import { getFilstreamStoreConfig, resolveViewerIndexPageUrl } from "../filstream-config.mjs";
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

if (embedMode) {
  document.documentElement.classList.add("viewer-embed");
}

const brandMount = document.getElementById("viewer-brand-mount");
if (brandMount && !embedMode) {
  mountFilstreamBrand(brandMount);
} else if (brandMount) {
  brandMount.hidden = true;
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
const viewerActionsEl = document.getElementById("viewer-actions");
const shakaContainerEl = document.getElementById("viewer-shaka-container");
const catalogAside = document.getElementById("viewer-catalog");

/** @type {unknown | null} */
let loadedMeta = null;
let donateBusy = false;
/** @type {string} */
let donateError = "";
/** @type {string} */
let donateTxHash = "";

let filstreamOverflowRegistered = false;

/** Opens the full viewer page (no embed) from the Shaka ⋯ overflow menu. */
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
    const nameSpan = document.createElement("span");
    nameSpan.textContent = "Open on FilStream";
    label.append(img, nameSpan);
    button.appendChild(label);
    button.setAttribute("aria-label", "Open FilStream viewer page");
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

function registerFilstreamOverflowElement() {
  if (filstreamOverflowRegistered) return;
  if (!shaka.ui?.OverflowMenu?.registerElement) return;
  filstreamOverflowRegistered = true;
  shaka.ui.OverflowMenu.registerElement("filstream", new FilstreamSiteButton.Factory());
}

registerFilstreamOverflowElement();

function setStatus(msg, kind) {
  if (!statusEl) return;
  statusEl.textContent = msg;
  statusEl.className = `viewer-status${kind === "err" ? " err" : ""}`;
}

/**
 * WebKit-on-Apple (Safari, all iOS browsers). The shaka-player.ui bundle from esm.sh does not
 * always attach `shaka.util.Platform`, so we do not call into Shaka for this.
 */
function isApplePlaybackPlatform() {
  const v = navigator.vendor;
  if (typeof v === "string" && v.includes("Apple")) return true;
  return /iPhone|iPad|iPod/i.test(navigator.userAgent);
}

/** @param {unknown} err */
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
 * Native HLS on Apple sometimes fails with Shaka 3016 while MSE playback works for H.264+AAC.
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
 * Resolve catalog row `metapath` against the catalog JSON URL so relative paths fetch the real `meta.json`
 * (fetch would otherwise resolve against the viewer page and miss `posterAnim`).
 *
 * @param {string} metapath
 * @param {string} catalogBaseUrl Absolute `filstream_catalog.json` URL
 * @returns {string}
 */
function resolveCatalogMetapath(metapath, catalogBaseUrl) {
  try {
    return new URL(metapath, catalogBaseUrl).href;
  } catch {
    return metapath;
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
 * @param {string} metapath Absolute meta.json URL (use {@link resolveCatalogMetapath} when the catalog row may be relative)
 * @returns {Promise<{ poster: string | null, posterAnim: string | null }>}
 */
async function fetchPosterPairFromMeta(metapath) {
  try {
    const res = await fetch(metapath);
    if (!res.ok) return { poster: null, posterAnim: null };
    const meta = await res.json();
    return {
      poster: posterUrlFromMetaJson(meta),
      posterAnim: posterAnimUrlFromMetaJson(meta),
    };
  } catch {
    return { poster: null, posterAnim: null };
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

    const pairResults = await Promise.all(
      newestFirst.map(async (m) => {
        const metapathResolved = resolveCatalogMetapath(m.metapath, catalogUrl);
        const catP = m.posterUrl ?? null;
        const catA = m.posterAnimUrl ?? null;
        const same = sameMetaUrl(metapathResolved, currentMetaUrl) && currentMetaDoc != null;
        if (same) {
          return {
            poster: catP ?? posterUrlFromMetaJson(currentMetaDoc),
            posterAnim: catA ?? posterAnimUrlFromMetaJson(currentMetaDoc),
          };
        }
        if (catP != null && catA != null) {
          return { poster: catP, posterAnim: catA };
        }
        const fetched = await fetchPosterPairFromMeta(metapathResolved);
        return {
          poster: catP ?? fetched.poster,
          posterAnim: catA ?? fetched.posterAnim,
        };
      }),
    );

    catalogAside.hidden = false;
    catalogAside.innerHTML = "";

    const head = document.createElement("h2");
    head.className = "viewer-catalog-head";
    head.textContent = "In this catalog";
    catalogAside.appendChild(head);

    newestFirst.forEach((m, i) => {
      const metapathResolved = resolveCatalogMetapath(m.metapath, catalogUrl);
      const posterUrl = pairResults[i].poster;
      const posterAnimUrl = pairResults[i].posterAnim;
      const a = document.createElement("a");
      a.className = "viewer-catalog-row";
      if (sameMetaUrl(metapathResolved, currentMetaUrl)) {
        a.classList.add("viewer-catalog-row--current");
        a.setAttribute("aria-current", "page");
      }
      a.href = viewerHrefForMeta(metapathResolved, catalogParam, undefined, datasetIdForLinks);
      a.title = m.title;

      const wrap = document.createElement("div");
      wrap.className = "viewer-catalog-poster-wrap";
      if (posterUrl && posterAnimUrl) {
        wrap.classList.add("viewer-catalog-poster-wrap--anim");
        const imgStill = document.createElement("img");
        imgStill.className = "viewer-catalog-poster viewer-catalog-poster--still";
        imgStill.src = posterUrl;
        imgStill.alt = "";
        imgStill.loading = "lazy";
        imgStill.decoding = "async";
        const imgAnim = document.createElement("img");
        imgAnim.className = "viewer-catalog-poster viewer-catalog-poster--motion";
        imgAnim.src = posterAnimUrl;
        imgAnim.alt = "";
        imgAnim.loading = "eager";
        imgAnim.decoding = "async";
        wrap.appendChild(imgStill);
        wrap.appendChild(imgAnim);
      } else if (posterUrl) {
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
 * @param {string} s
 */
function escapeHtmlAttr(s) {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/**
 * Current viewer URL without `embed` (full page).
 * @returns {string}
 */
function buildViewerUrlWithoutEmbed() {
  const u = new URL(window.location.href);
  u.searchParams.delete("embed");
  return u.href;
}

/**
 * Public iframe `src`: hosted at `resolveViewerIndexPageUrl()` (not `localhost`).
 * `meta` is the remote `meta.json` URL — encode with `encodeURIComponent`.
 * `catalog`, `dataset`, and `embed` are viewer routing for this page — not the same as `meta`;
 * use `encodeURI` for catalog (readable `https://…`) and plain values for dataset / embed.
 *
 * @returns {string}
 */
function buildEmbedIframeSnippet() {
  const base = new URL(resolveViewerIndexPageUrl());
  const here = new URL(window.location.href);
  const meta = here.searchParams.get("meta");
  const catalog = here.searchParams.get("catalog");
  const dataset = here.searchParams.get("dataset");

  const parts = [];
  if (meta) parts.push(`meta=${encodeURIComponent(meta)}`);
  if (catalog) parts.push(`catalog=${encodeURI(catalog)}`);
  if (dataset !== null && dataset !== "") parts.push(`dataset=${dataset}`);
  parts.push("embed=true");
  base.search = parts.join("&");
  const src = base.href;
  return `<iframe src="${escapeHtmlAttr(src)}" width="560" height="315" style="border:0" allowfullscreen title="FilStream player"></iframe>`;
}

/**
 * @param {string} text
 */
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {unknown} catalogDoc
 * @param {string} currentMetaUrl
 * @param {string | null} [catalogBaseUrl] Absolute catalog URL — required to match relative `metapath` rows
 * @returns {string | null}
 */
function shareUrlFromCatalogForMeta(catalogDoc, currentMetaUrl, catalogBaseUrl) {
  if (!catalogDoc || !currentMetaUrl) return null;
  const rows = moviesFromCatalog(catalogDoc);
  for (const m of rows) {
    const mp =
      catalogBaseUrl && catalogBaseUrl.trim() !== ""
        ? resolveCatalogMetapath(m.metapath, catalogBaseUrl)
        : m.metapath;
    if (sameMetaUrl(mp, currentMetaUrl) && m.share) {
      return m.share;
    }
  }
  return null;
}

/**
 * @param {string | null} sharePageUrl Open Graph landing page from catalog `share`, or null to hide Share
 */
function renderShareEmbedButtons(sharePageUrl) {
  if (!viewerActionsEl || embedMode) return;

  viewerActionsEl.hidden = false;
  viewerActionsEl.innerHTML = "";

  if (sharePageUrl) {
    const shareLink = document.createElement("a");
    shareLink.className = "viewer-action-btn viewer-action-btn--round";
    shareLink.href = sharePageUrl;
    shareLink.target = "_blank";
    shareLink.rel = "noopener noreferrer";
    shareLink.title = "Share this page, Social Media enabled with OpenGraph";
    shareLink.setAttribute("aria-label", "Share page");
    shareLink.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.41" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>`;
    viewerActionsEl.appendChild(shareLink);
  }

  const embedSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  embedSvg.setAttribute("width", "18");
  embedSvg.setAttribute("height", "18");
  embedSvg.setAttribute("viewBox", "0 0 24 24");
  embedSvg.setAttribute("fill", "none");
  embedSvg.setAttribute("stroke", "currentColor");
  embedSvg.setAttribute("stroke-width", "2");
  embedSvg.setAttribute("aria-hidden", "true");
  const p1 = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  p1.setAttribute("points", "16 18 22 12 16 6");
  const p2 = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  p2.setAttribute("points", "8 6 2 12 8 18");
  embedSvg.append(p1, p2);

  const embedBtn = document.createElement("button");
  embedBtn.type = "button";
  embedBtn.className = "viewer-action-btn viewer-action-btn--round";
  embedBtn.title = "Copy embed code";
  embedBtn.setAttribute("aria-label", "Copy iframe embed code");
  embedBtn.appendChild(embedSvg);
  embedBtn.addEventListener("click", () => {
    void copyToClipboard(buildEmbedIframeSnippet());
  });

  viewerActionsEl.appendChild(embedBtn);
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
 * @param {string} catalogUrlStr
 * @param {number | null} dataSetId
 */
function replaceViewerCatalogInBrowser(catalogUrlStr, dataSetId) {
  const u = new URL(window.location.href);
  u.searchParams.set("catalog", catalogUrlStr);
  if (dataSetId != null && Number.isFinite(dataSetId) && dataSetId >= 0) {
    u.searchParams.set("dataset", String(dataSetId));
  }
  history.replaceState({}, "", u);
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
    bylineCatalogEl.innerHTML = "";
    donateRootEl.innerHTML = "";
    bylineEl.hidden = false;
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

  const copy = broadcastCopyFromMeta(meta);
  const title = copy.title.trim() || "Untitled";
  const desc = copy.description.trim();

  if (embedMode) {
    document.title = `${title} · FilStream`;
    if (metaSection) metaSection.hidden = true;
    if (viewerActionsEl) viewerActionsEl.hidden = true;
    return;
  }

  if (!metaSection || !titleEl || !descriptionEl || !donateRootEl) return;

  const ctx = catalogCtx ?? { catalogUrl: null, catalogDoc: null, datasetId: null };

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
  const sharePageUrl =
    ctx.catalogDoc && metaUrl
      ? shareUrlFromCatalogForMeta(ctx.catalogDoc, metaUrl, ctx.catalogUrl)
      : null;
  renderShareEmbedButtons(sharePageUrl);
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
      if (catalogUrl && !embedMode) {
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

      let resolvedDatasetId = resolveDatasetIdForCatalog(
        catalogFetchOk ? catalogDocPreload : null,
        datasetQueryRaw,
      );

      /** @type {string | null} */
      let displayCatalogUrl = catalogUrl;

      if (!embedMode && resolvedDatasetId != null) {
        const hasShare =
          catalogFetchOk &&
          catalogDocPreload &&
          shareUrlFromCatalogForMeta(catalogDocPreload, metaUrl, displayCatalogUrl);
        if (!hasShare) {
          const cfg = getFilstreamStoreConfig();
          const doc =
            catalogDocPreload && typeof catalogDocPreload === "object" && catalogDocPreload !== null
              ? /** @type {Record<string, unknown>} */ (catalogDocPreload)
              : {};
          const chainId =
            typeof doc.chainId === "number" && Number.isFinite(doc.chainId)
              ? doc.chainId
              : cfg.storeChainId;
          const providerId =
            typeof doc.providerId === "number" && Number.isFinite(doc.providerId)
              ? doc.providerId
              : null;
          try {
            const recovered = await fetchLatestCatalogJsonForDataSet({
              chainId,
              dataSetId: resolvedDatasetId,
              providerId,
            });
            if (recovered?.doc && typeof recovered.doc === "object") {
              catalogDocPreload = recovered.doc;
              catalogFetchOk = true;
              displayCatalogUrl = recovered.retrievalUrl.trim();
              replaceViewerCatalogInBrowser(displayCatalogUrl, resolvedDatasetId);
              resolvedDatasetId = resolveDatasetIdForCatalog(catalogDocPreload, datasetQueryRaw);
            }
          } catch (e) {
            console.warn("[filstream viewer] catalog chain refresh failed", e);
          }
        }
      }

      renderViewerMeta(meta, {
        catalogUrl: displayCatalogUrl,
        catalogDoc: catalogFetchOk ? catalogDocPreload : null,
        datasetId: resolvedDatasetId,
      });
      setStatus("");
      shaka.polyfill.installAll();
      if (!shakaContainerEl || !videoEl) {
        throw new Error("viewer-shaka-container or viewer-video missing");
      }
      const player = new shaka.Player();
      const shakaUi = new shaka.ui.Overlay(
        player,
        shakaContainerEl,
        /** @type {HTMLVideoElement} */ (videoEl),
      );
      await player.attach(/** @type {HTMLVideoElement} */ (videoEl));
      const apple = isApplePlaybackPlatform();
      const reloadStrategy =
        shaka.config?.CodecSwitchingStrategy?.RELOAD ?? "reload";
      player.configure({
        abr: {
          enabled: true,
          useNetworkInformation: false,
        },
        ...(apple
          ? {
              streaming: {
                preferNativeHls: true,
                useNativeHlsOnSafari: true,
              },
              mediaSource: {
                codecSwitchingStrategy: reloadStrategy,
              },
              preferredVideoCodecs: ["avc1", "avc3", "hvc1", "hev1"],
              preferredAudioCodecs: ["mp4a.40.2", "mp4a.40.5"],
            }
          : {}),
      });
      shakaUi.configure({
        controlPanelElements: [
          "play_pause",
          "time_and_duration",
          "spacer",
          "mute",
          "volume",
          "spacer",
          "fullscreen",
          "overflow_menu",
        ],
        overflowMenuButtons: ["playback_rate", "quality", "filstream"],
        playbackRates: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2],
        enableTooltips: true,
      });
      await loadMasterWithAppleMseFallback(player, master);

      if (displayCatalogUrl && !embedMode) {
        void renderCatalogSidebar(
          displayCatalogUrl,
          metaUrl,
          displayCatalogUrl,
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
