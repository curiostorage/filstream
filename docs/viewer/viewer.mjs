/**
 * GitHub Pages entry:
 * `viewer.html?meta=<absolute-https-url-to-meta.json>[&catalog=<absolute-url-to-filstream_catalog.json>]`
 *
 * Fetches `meta.json` for playback; optional `catalog` loads `filstream_catalog.json` and shows
 * a right column (newest first): poster 168px + title 192px. Catalog rows include `posterUrl` when
 * published by FilStream so the sidebar does not fetch each `meta.json` for posters; legacy
 * catalogs fall back to fetching `meta` per row when `posterUrl` is absent.
 */
import shaka from "https://esm.sh/shaka-player";

const statusEl = document.getElementById("viewer-status");
const videoEl = document.getElementById("viewer-video");
const catalogAside = document.getElementById("viewer-catalog");

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
      catalogAside.hidden = false;
      catalogAside.innerHTML = `<p class="viewer-catalog-note">Catalog unavailable (${res.status})</p>`;
      return;
    }
    const doc = await res.json();
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
