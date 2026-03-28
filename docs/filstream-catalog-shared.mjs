/**
 * Shared catalog helpers for viewer.html and creator.html (URLs + row parsing).
 */

/** Top-level field in `filstream_catalog.json`: matches PDP piece `FS_VER` for that document. */
export const CATALOG_JSON_VERSION_KEY = "catalogVersion";

/**
 * Monotonic revision for comparison (same number as metadata `FS_VER` when published by FilStream).
 *
 * @param {unknown} doc Parsed `filstream_catalog.json`
 * @returns {number | null}
 */
export function catalogRevisionFromDoc(doc) {
  if (!doc || typeof doc !== "object" || doc === null) return null;
  const v = /** @type {Record<string, unknown>} */ (doc)[CATALOG_JSON_VERSION_KEY];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

/**
 * @param {string} metapath
 * @param {string | null} catalogParam
 * @param {string} [baseHref] Page whose query will be replaced (default: current page, e.g. viewer.html)
 * @param {number | string | null} [datasetId] PDP data set id (stable handle; catalog URL may be stale)
 * @returns {string}
 */
export function viewerHrefForMeta(metapath, catalogParam, baseHref, datasetId) {
  const u = new URL(
    baseHref ??
      (typeof window !== "undefined" ? window.location.href : "https://invalid/viewer.html"),
  );
  u.searchParams.set("meta", metapath);
  if (catalogParam && catalogParam.trim() !== "") {
    u.searchParams.set("catalog", catalogParam.trim());
  } else {
    u.searchParams.delete("catalog");
  }
  if (datasetId != null && datasetId !== "") {
    const n = typeof datasetId === "number" ? datasetId : Number.parseInt(String(datasetId), 10);
    if (Number.isFinite(n) && n >= 0) {
      u.searchParams.set("dataset", String(n));
    } else {
      u.searchParams.delete("dataset");
    }
  } else {
    u.searchParams.delete("dataset");
  }
  return u.href;
}

/**
 * Static creator page: `creator.html?catalog=` (same origin as viewer).
 *
 * @param {string} catalogUrl Absolute `filstream_catalog.json` URL
 * @param {string} [baseHref] Page used to resolve `creator.html` (default: current location)
 * @param {number | string | null} [datasetId] PDP data set id (stable handle; catalog URL may be stale)
 * @returns {string}
 */
export function creatorHrefForCatalog(catalogUrl, baseHref, datasetId) {
  const u = new URL(
    "creator.html",
    baseHref ??
      (typeof window !== "undefined" ? window.location.href : "https://invalid/viewer.html"),
  );
  u.searchParams.set("catalog", catalogUrl.trim());
  if (datasetId != null && datasetId !== "") {
    const n = typeof datasetId === "number" ? datasetId : Number.parseInt(String(datasetId), 10);
    if (Number.isFinite(n) && n >= 0) {
      u.searchParams.set("dataset", String(n));
    } else {
      u.searchParams.delete("dataset");
    }
  } else {
    u.searchParams.delete("dataset");
  }
  return u.href;
}

/**
 * @param {unknown} meta Parsed `meta.json`
 * @returns {string | null}
 */
export function posterAnimUrlFromMetaJson(meta) {
  if (
    meta &&
    typeof meta === "object" &&
    meta !== null &&
    typeof /** @type {{ posterAnim?: { url?: string } }} */ (meta).posterAnim === "object" &&
    /** @type {{ posterAnim?: { url?: string } | null }} */ (meta).posterAnim !== null
  ) {
    const pa = /** @type {{ posterAnim?: { url?: string } }} */ (meta).posterAnim;
    if (pa && typeof pa.url === "string") {
      const u = pa.url.trim();
      if (u) return u;
    }
  }
  const m = meta && typeof meta === "object" && meta !== null ? meta : null;
  const pb =
    m &&
    typeof /** @type {{ playback?: { posterAnimUrl?: string } }} */ (m).playback === "object" &&
    /** @type {{ playback?: { posterAnimUrl?: string } | null }} */ (m).playback !== null
      ? /** @type {{ playback?: { posterAnimUrl?: string } }} */ (m).playback
      : null;
  const s =
    pb && typeof pb.posterAnimUrl === "string" ? pb.posterAnimUrl.trim() : "";
  return s || null;
}

/**
 * @param {unknown} doc Parsed `filstream_catalog.json`
 * @returns {{ creatorName: string | null, creatorPosterUrl: string | null }}
 */
export function creatorInfoFromCatalog(doc) {
  if (!doc || typeof doc !== "object" || doc === null) {
    return { creatorName: null, creatorPosterUrl: null };
  }
  const d = /** @type {Record<string, unknown>} */ (doc);
  const cn = typeof d.creatorName === "string" ? d.creatorName.trim() : "";
  const cpu = typeof d.creatorPosterUrl === "string" ? d.creatorPosterUrl.trim() : "";
  return {
    creatorName: cn || null,
    creatorPosterUrl: cpu || null,
  };
}

/**
 * One catalog `movies[]` entry: same shape as rows produced by {@link moviesFromCatalog}.
 *
 * @param {unknown} m
 * @returns {{ title: string, metapath: string, posterUrl?: string, posterAnimUrl?: string, share?: string } | null}
 */
export function parseCatalogMovieRow(m) {
  if (!m || typeof m !== "object") return null;
  const row = /** @type {{ title?: unknown, metapath?: unknown, posterUrl?: unknown, posterAnimUrl?: unknown, share?: unknown }} */ (
    m
  );
  const title = typeof row.title === "string" ? row.title.trim() : "";
  const metapath = typeof row.metapath === "string" ? row.metapath.trim() : "";
  if (!metapath) return null;
  const pu =
    typeof row.posterUrl === "string" && row.posterUrl.trim() !== ""
      ? row.posterUrl.trim()
      : undefined;
  const pau =
    typeof row.posterAnimUrl === "string" && row.posterAnimUrl.trim() !== ""
      ? row.posterAnimUrl.trim()
      : undefined;
  const sh =
    typeof row.share === "string" && row.share.trim() !== "" && /^https?:\/\//i.test(row.share.trim())
      ? row.share.trim()
      : undefined;
  /** @type {{ title: string, metapath: string, posterUrl?: string, posterAnimUrl?: string, share?: string }} */
  const item = { title: title || "Untitled", metapath };
  if (pu) item.posterUrl = pu;
  if (pau) item.posterAnimUrl = pau;
  if (sh) item.share = sh;
  return item;
}

/**
 * Catalog row: `title`, `metapath` (meta.json URL), optional `posterUrl`, optional `posterAnimUrl` (animated mini-poster), optional `share` (Open Graph landing page URL).
 *
 * @param {unknown} doc
 * @returns {{ title: string, metapath: string, posterUrl?: string, posterAnimUrl?: string, share?: string }[]}
 */
export function moviesFromCatalog(doc) {
  if (!doc || typeof doc !== "object" || doc === null) return [];
  const movies = /** @type {{ movies?: unknown }} */ (doc).movies;
  if (!Array.isArray(movies)) return [];
  /** @type {{ title: string, metapath: string, posterUrl?: string, posterAnimUrl?: string, share?: string }[]} */
  const out = [];
  for (const m of movies) {
    const item = parseCatalogMovieRow(m);
    if (item) out.push(item);
  }
  return out;
}
