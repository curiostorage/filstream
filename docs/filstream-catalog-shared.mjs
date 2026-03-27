/**
 * Shared catalog helpers for viewer.html and creator.html (URLs + row parsing).
 */

/**
 * @param {string} metapath
 * @param {string | null} catalogParam
 * @param {string} [baseHref] Page whose query will be replaced (default: current page, e.g. viewer.html)
 * @returns {string}
 */
export function viewerHrefForMeta(metapath, catalogParam, baseHref) {
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
  return u.href;
}

/**
 * Static creator page: `creator.html?catalog=` (same origin as viewer).
 *
 * @param {string} catalogUrl Absolute `filstream_catalog.json` URL
 * @param {string} [baseHref] Page used to resolve `creator.html` (default: current location)
 * @returns {string}
 */
export function creatorHrefForCatalog(catalogUrl, baseHref) {
  const u = new URL(
    "creator.html",
    baseHref ??
      (typeof window !== "undefined" ? window.location.href : "https://invalid/viewer.html"),
  );
  u.searchParams.set("catalog", catalogUrl.trim());
  return u.href;
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
 * Catalog row: `title`, `metapath` (meta.json URL), optional `posterUrl`.
 *
 * @param {unknown} doc
 * @returns {{ title: string, metapath: string, posterUrl?: string }[]}
 */
export function moviesFromCatalog(doc) {
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
