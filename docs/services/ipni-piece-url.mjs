/**
 * Resolve a Filecoin piece to an HTTP retrieval URL advertised on IPNI.
 *
 * Upload-time playlist and manifest URLs point at the provider that first stored
 * the bytes. Those hosts can go away (InfraFolio Calibration). Playback asks IPNI
 * which providers currently advertise the piece and uses one of those URLs.
 */
import {
  IPNI_FIND_ORIGIN,
  RETIRED_PIECE_RETRIEVAL_HOSTS,
} from "./filstream-constants.mjs";

const PROTO_BITSWAP = 0x900;
const PROTO_IPFS_GATEWAY_HTTP = 0x920;
const PROTO_FILECOIN_PIECE_HTTP = 0x930;
const EMPTY_PAYLOAD_PROTOCOLS = new Set([
  PROTO_BITSWAP,
  PROTO_IPFS_GATEWAY_HTTP,
  PROTO_FILECOIN_PIECE_HTTP,
]);

const NEGATIVE_TTL_MS = 2 * 60 * 1000;
const MAX_CANDIDATES = 8;

/**
 * Piece id whose bytes have already been downloaded. Later reads, including
 * player retries and byte-range segment requests, use this instead of the network.
 * @type {Map<string, Uint8Array>}
 */
const pieceBytes = new Map();
/** @type {Map<string, Promise<Uint8Array>>} */
const pieceLoads = new Map();
/** @type {Map<string, string>} */
const pieceSourceUrl = new Map();
/** @type {Map<string, string>} */
const pieceObjectUrls = new Map();
/**
 * MIME type for player responses. Piece URLs have no file extension, so Shaka
 * uses this Content-Type as the SourceBuffer type. `application/octet-stream`
 * makes `addSourceBuffer` throw.
 * @type {Map<string, string>}
 */
const pieceContentType = new Map();

/**
 * @typedef {"piece" | "ipfs"} RetrievalKind
 * @typedef {{ base: string, kind: RetrievalKind }} StickyProvider
 */

/** @type {StickyProvider[]} */
let stickyProviders = [];
/** @type {Map<string, Promise<string>>} */
const inflight = new Map();
/** @type {Map<string, { url: string, expires: number }>} */
const positiveCache = new Map();
/** @type {Map<string, number>} */
const negativeUntil = new Map();

/**
 * @param {string} hostname
 * @returns {boolean}
 */
function hostIsRetired(hostname) {
  const host = String(hostname || "")
    .toLowerCase()
    .replace(/\.+$/, "");
  if (!host) return false;
  return RETIRED_PIECE_RETRIEVAL_HOSTS.some((suffix) => {
    const s = String(suffix || "").toLowerCase();
    return s !== "" && (host === s || host.endsWith(`.${s}`));
  });
}

/**
 * @param {string} url
 * @returns {boolean}
 */
export function isRetiredPieceRetrievalUrl(url) {
  try {
    return hostIsRetired(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Piece CID embedded in a `/piece/{cid}` retrieval URL.
 *
 * @param {string} value
 * @returns {string}
 */
export function pieceCidFromRetrievalUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let url;
  try {
    url = new URL(raw);
  } catch {
    return "";
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return "";
  const kind = parts[parts.length - 2];
  if (kind !== "piece") return "";
  const cid = parts[parts.length - 1];
  if (!/^[A-Za-z0-9]+$/.test(cid) || cid.length < 10) return "";
  return cid;
}

/**
 * Prefer a provider IPNI currently advertises. If the indexer has no usable
 * URL, keep the original retrieval URL so playback still works while pieces
 * are moving.
 *
 * @param {string} url
 * @returns {Promise<string>}
 */
export async function relocatePieceRetrievalUrl(url) {
  const raw = String(url || "");
  const cid = pieceCidFromRetrievalUrl(raw);
  if (!cid) return raw;
  try {
    return await resolvePieceRetrievalUrl(cid);
  } catch {
    return raw;
  }
}

/**
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {{ value: number, next: number } | null}
 */
function readUvarint(bytes, offset) {
  let value = 0;
  let shift = 0;
  for (let i = offset; i < bytes.length && shift <= 28; i++) {
    const b = bytes[i];
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value, next: i + 1 };
    shift += 7;
  }
  return null;
}

/**
 * @param {string} metadata
 * @returns {Uint8Array}
 */
function decodeMetadata(metadata) {
  if (typeof metadata !== "string" || metadata.trim() === "") return new Uint8Array();
  const normalized = metadata.trim().replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  const bin = atob(normalized + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * @param {Uint8Array} bytes
 * @returns {number[]}
 */
function protocolsInMetadata(bytes) {
  /** @type {number[]} */
  const found = [];
  let i = 0;
  while (i < bytes.length) {
    const decoded = readUvarint(bytes, i);
    if (!decoded || !EMPTY_PAYLOAD_PROTOCOLS.has(decoded.value)) break;
    found.push(decoded.value);
    i = decoded.next;
  }
  return found;
}

/**
 * @param {string} multiaddr
 * @returns {string}
 */
function httpBaseFromMultiaddr(multiaddr) {
  const parts = String(multiaddr || "")
    .split("/")
    .filter(Boolean);
  let host = "";
  let port = "";
  let scheme = "";
  let sawTls = false;
  let path = "";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === "dns" || part === "dns4" || part === "dns6") {
      host = parts[++i] || "";
    } else if (part === "ip4" || part === "ip6") {
      const addr = parts[++i] || "";
      host = part === "ip6" && addr.includes(":") ? `[${addr}]` : addr;
    } else if (part === "tcp") {
      port = parts[++i] || "";
    } else if (part === "tls") {
      sawTls = true;
    } else if (part === "https") {
      scheme = "https";
    } else if (part === "http") {
      scheme = sawTls ? "https" : "http";
    } else if (part === "http-path") {
      try {
        path = decodeURIComponent(parts[++i] || "");
      } catch {
        path = parts[i] || "";
      }
    }
  }
  if (!host || (scheme !== "http" && scheme !== "https")) return "";
  let hostname = host;
  try {
    hostname = new URL(`${scheme}://${host}`).hostname;
  } catch {
    return "";
  }
  if (hostIsRetired(hostname)) return "";
  const defaultPort = scheme === "https" ? "443" : "80";
  const portPart = port && port !== defaultPort ? `:${port}` : "";
  let base = `${scheme}://${host}${portPart}/`;
  const rel = path.replace(/^\/+/, "").replace(/\/+$/, "");
  if (rel) base = new URL(`${rel}/`, base).href;
  return base;
}

/**
 * @param {string} base
 * @param {RetrievalKind} kind
 * @param {string} pieceCid
 * @returns {string}
 */
function retrievalUrl(base, kind, pieceCid) {
  const root = base.endsWith("/") ? base : `${base}/`;
  return new URL(`${kind}/${pieceCid}`, root).href;
}

/**
 * Ordered retrieval URLs from an IPNI find response. Filecoin piece HTTP is
 * listed before IPFS gateway HTTP. Retired hosts are omitted.
 *
 * @param {string} pieceCid
 * @param {unknown} findResponse
 * @returns {string[]}
 */
export function pieceRetrievalUrlsFromIpniFind(pieceCid, findResponse) {
  const cid = String(pieceCid || "").trim();
  if (!cid || !findResponse || typeof findResponse !== "object") return [];
  const results = /** @type {{ MultihashResults?: unknown }} */ (findResponse).MultihashResults;
  if (!Array.isArray(results)) return [];
  /** @type {string[]} */
  const pieceUrls = [];
  /** @type {string[]} */
  const ipfsUrls = [];
  const seen = new Set();
  for (const row of results) {
    const providers = row && typeof row === "object" ? /** @type {{ ProviderResults?: unknown }} */ (row).ProviderResults : null;
    if (!Array.isArray(providers)) continue;
    for (const providerResult of providers) {
      if (!providerResult || typeof providerResult !== "object") continue;
      const record = /** @type {{ Metadata?: unknown, Provider?: { Addrs?: unknown } }} */ (
        providerResult
      );
      let protos = [];
      try {
        protos = protocolsInMetadata(
          decodeMetadata(typeof record.Metadata === "string" ? record.Metadata : ""),
        );
      } catch {
        continue;
      }
      const wantsPiece = protos.includes(PROTO_FILECOIN_PIECE_HTTP);
      const wantsIpfs = protos.includes(PROTO_IPFS_GATEWAY_HTTP);
      if (!wantsPiece && !wantsIpfs) continue;
      const addrs = record.Provider?.Addrs;
      if (!Array.isArray(addrs)) continue;
      for (const addr of addrs) {
        if (typeof addr !== "string") continue;
        const base = httpBaseFromMultiaddr(addr);
        if (!base) continue;
        const url = retrievalUrl(base, wantsPiece ? "piece" : "ipfs", cid);
        if (seen.has(url) || isRetiredPieceRetrievalUrl(url)) continue;
        seen.add(url);
        if (wantsPiece) pieceUrls.push(url);
        else ipfsUrls.push(url);
      }
    }
  }
  const ranked = [...pieceUrls, ...ipfsUrls];
  ranked.sort((a, b) => {
    const kindDelta = Number(b.includes("/piece/")) - Number(a.includes("/piece/"));
    if (kindDelta !== 0) return kindDelta;
    return Number(b.startsWith("https:")) - Number(a.startsWith("https:"));
  });
  return ranked.slice(0, MAX_CANDIDATES);
}

/**
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function probePieceUrl(url, timeoutMs) {
  const known = pieceCidFromRetrievalUrl(url);
  if (known && pieceBytes.has(known)) return true;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Range: "bytes=0-0" },
      redirect: "follow",
      signal: ctrl.signal,
    });
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    return res.ok || res.status === 206;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string[]} urls
 * @returns {Promise<string>}
 */
async function firstRespondingPieceUrl(urls) {
  return Promise.any(
    urls.map(async (url) => {
      const ok = await probePieceUrl(url, 8000);
      if (!ok) throw new Error("piece URL did not respond");
      return url;
    }),
  );
}

/**
 * @param {string} url
 * @param {string} pieceCid
 */
function rememberSticky(url, pieceCid) {
  for (const kind of /** @type {const} */ (["piece", "ipfs"])) {
    const marker = `/${kind}/${pieceCid}`;
    const at = url.indexOf(marker);
    if (at < 0) continue;
    const base = url.slice(0, at + 1);
    stickyProviders = [
      { base, kind },
      ...stickyProviders.filter((row) => row.base !== base || row.kind !== kind),
    ].slice(0, 3);
    return;
  }
}

/**
 * @param {string} pieceCid
 * @returns {Promise<string>}
 */
async function lookupUncached(pieceCid) {
  if (pieceBytes.has(pieceCid)) {
    const known = pieceSourceUrl.get(pieceCid);
    if (known) return known;
  }
  for (const sticky of stickyProviders) {
    const url = retrievalUrl(sticky.base, sticky.kind, pieceCid);
    if (isRetiredPieceRetrievalUrl(url)) continue;
    if (await probePieceUrl(url, 4000)) return url;
  }

  const findUrl = `${IPNI_FIND_ORIGIN.replace(/\/$/, "")}/cid/${encodeURIComponent(pieceCid)}`;
  let body = null;
  try {
    const res = await fetch(findUrl, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 404) body = null;
    else if (!res.ok) throw new Error(`IPNI HTTP ${res.status}`);
    else body = await res.json();
  } catch (err) {
    throw new Error(`No IPNI retrieval URL for piece ${pieceCid}`, { cause: err });
  }
  const urls = body ? pieceRetrievalUrlsFromIpniFind(pieceCid, body) : [];
  if (!urls.length) throw new Error(`No IPNI retrieval URL for piece ${pieceCid}`);
  try {
    const url = await firstRespondingPieceUrl(urls);
    rememberSticky(url, pieceCid);
    return url;
  } catch (err) {
    throw new Error(`No IPNI retrieval URL for piece ${pieceCid}`, { cause: err });
  }
}

/**
 * @param {string} pieceCid
 * @returns {Promise<string>}
 */
export function resolvePieceRetrievalUrl(pieceCid) {
  const cid = String(pieceCid || "").trim();
  if (!cid) return Promise.reject(new Error("Missing piece CID"));
  const now = Date.now();
  const cached = positiveCache.get(cid);
  if (cached && cached.expires > now) return Promise.resolve(cached.url);
  if ((negativeUntil.get(cid) ?? 0) > now) {
    return Promise.reject(new Error(`No IPNI retrieval URL for piece ${cid}`));
  }
  const pending = inflight.get(cid);
  if (pending) return pending;
  const lookup = lookupUncached(cid).then(
    (url) => {
      positiveCache.set(cid, { url, expires: Number.POSITIVE_INFINITY });
      pieceSourceUrl.set(cid, url);
      return url;
    },
    (err) => {
      negativeUntil.set(cid, Date.now() + NEGATIVE_TTL_MS);
      throw err;
    },
  );
  const shared = lookup.finally(() => {
    inflight.delete(cid);
  });
  inflight.set(cid, shared);
  return shared;
}

/**
 * @param {string} cid
 * @returns {string}
 */
function filpieceUri(cid) {
  return `filpiece:${encodeURIComponent(cid)}`;
}

/**
 * ISO-BMFF box type at the start of an fMP4 init segment or media fragment.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function isoBmffBox(bytes) {
  if (!bytes || bytes.byteLength < 8) return "";
  return String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
}

/**
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
function looksLikeM3u8(bytes) {
  const n = Math.min(bytes.byteLength, 24);
  let prefix = "";
  for (let i = 0; i < n; i++) prefix += String.fromCharCode(bytes[i]);
  return prefix.trimStart().startsWith("#EXTM3U");
}

/**
 * Content-Type to give Shaka. Prefer a sniffed media type over a generic
 * provider header, and never report octet-stream for bytes we recognize.
 *
 * @param {Uint8Array} bytes
 * @param {string} headerType
 * @returns {string}
 */
function contentTypeForPiece(bytes, headerType) {
  const raw = String(headerType || "").split(";")[0].trim().toLowerCase();
  const box = isoBmffBox(bytes);
  if (box === "ftyp" || box === "styp" || box === "moof" || box === "moov" || box === "mdat") {
    if (raw === "audio/mp4" || raw === "video/mp4" || raw === "application/mp4" || raw === "video/iso.segment") {
      return raw;
    }
    return "video/mp4";
  }
  if (looksLikeM3u8(bytes)) {
    if (
      raw === "application/vnd.apple.mpegurl" ||
      raw === "application/x-mpegurl" ||
      raw === "audio/mpegurl"
    ) {
      return raw;
    }
    return "application/vnd.apple.mpegurl";
  }
  if (raw && raw !== "application/octet-stream" && raw !== "binary/octet-stream") return raw;
  return "";
}

/**
 * @param {string} url
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ bytes: Uint8Array, contentType: string }>}
 */
async function fetchFullPiece(url, signal) {
  const res = await fetch(url, { redirect: "follow", signal });
  if (res.status !== 200) {
    throw new Error(`Piece HTTP ${res.status}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  return {
    bytes,
    contentType: contentTypeForPiece(bytes, res.headers.get("content-type") || ""),
  };
}

/**
 * Download a piece once per page session. A confirmed body is reused for every
 * later player retry and byte-range read.
 *
 * @param {string} cid
 * @param {AbortSignal} [signal]
 * @returns {Promise<Uint8Array>}
 */
export async function loadFullPieceBytes(cid, signal) {
  const pieceCid = String(cid || "").trim();
  if (!pieceCid) throw new Error("Missing piece CID");
  const hit = pieceBytes.get(pieceCid);
  if (hit) return hit;
  const pending = pieceLoads.get(pieceCid);
  if (pending) return pending;

  const job = (async () => {
    /** @type {string[]} */
    const urls = [];
    const push = (url) => {
      if (typeof url === "string" && url && !urls.includes(url)) urls.push(url);
    };
    const known = pieceSourceUrl.get(pieceCid);
    if (known && !isRetiredPieceRetrievalUrl(known)) push(known);
    /** @type {unknown} */
    let lastErr = null;
    const take = async (url) => {
      if (signal?.aborted) throw new Error("Piece download aborted");
      const fetched = await fetchFullPiece(url, signal);
      pieceBytes.set(pieceCid, fetched.bytes);
      pieceContentType.set(pieceCid, fetched.contentType);
      pieceSourceUrl.set(pieceCid, url);
      positiveCache.set(pieceCid, { url, expires: Number.POSITIVE_INFINITY });
      return fetched.bytes;
    };
    for (const url of urls) {
      try {
        return await take(url);
      } catch (err) {
        lastErr = err;
      }
    }
    try {
      const found = await resolvePieceRetrievalUrl(pieceCid);
      if (!urls.includes(found)) return await take(found);
    } catch (err) {
      lastErr = err;
    }
    if (known && isRetiredPieceRetrievalUrl(known)) {
      try {
        return await take(known);
      } catch (err) {
        lastErr = err;
      }
    }
    throw new Error(`Piece ${pieceCid} unavailable`, { cause: lastErr ?? undefined });
  })();

  pieceLoads.set(pieceCid, job);
  try {
    return await job;
  } finally {
    if (pieceLoads.get(pieceCid) === job) pieceLoads.delete(pieceCid);
  }
}

/**
 * Player request URL. A piece that is already in memory is not looked up again.
 * Others are served through the `filpiece:` scheme, which downloads the body once.
 *
 * @param {string} original
 * @returns {Promise<string>}
 */
export async function playbackRequestUrl(original) {
  const raw = String(original || "");
  if (raw.startsWith("filpiece:")) return raw;
  const cid = pieceCidFromRetrievalUrl(raw);
  if (!cid) return raw;
  if (!pieceSourceUrl.has(cid) && !isRetiredPieceRetrievalUrl(raw)) {
    pieceSourceUrl.set(cid, raw);
  }
  if (!pieceBytes.has(cid) && isRetiredPieceRetrievalUrl(raw)) {
    try {
      const found = await resolvePieceRetrievalUrl(cid);
      pieceSourceUrl.set(cid, found);
    } catch {
      if (!pieceSourceUrl.has(cid)) pieceSourceUrl.set(cid, raw);
    }
  }
  return filpieceUri(cid);
}

/**
 * @param {Uint8Array} body
 * @param {string} contentType
 * @param {Record<string, string>} [extra]
 * @returns {Record<string, string>}
 */
function playerResponseHeaders(body, contentType, extra) {
  /** @type {Record<string, string>} */
  const headers = {
    "content-length": String(body.byteLength),
    "accept-ranges": "bytes",
  };
  if (contentType) headers["content-type"] = contentType;
  if (extra) Object.assign(headers, extra);
  return headers;
}

/**
 * @param {string} rangeHeader
 * @param {Uint8Array} bytes
 * @param {string} contentType
 * @returns {{ data: ArrayBuffer, status: number, headers: Record<string, string> }}
 */
function slicePieceBytes(bytes, rangeHeader, contentType) {
  const total = bytes.byteLength;
  const range = String(rangeHeader || "").trim();
  const match = /^bytes=(\d+)-(\d*)$/i.exec(range);
  const whole = () => {
    const copy = new Uint8Array(bytes);
    return {
      data: copy.buffer,
      status: 200,
      headers: playerResponseHeaders(copy, contentType),
    };
  };
  if (!match) return whole();
  const start = Number(match[1]);
  const end = match[2] === "" ? total - 1 : Math.min(Number(match[2]), total - 1);
  if (!Number.isFinite(start) || start < 0 || start >= total || end < start) return whole();
  const copy = bytes.slice(start, end + 1);
  return {
    data: copy.buffer,
    status: 206,
    headers: playerResponseHeaders(copy, contentType, {
      "content-range": `bytes ${start}-${end}/${total}`,
    }),
  };
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function latin1(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

/**
 * Some masters list AAC even when every init segment is video-only. Chrome then
 * refuses the init with "misses expected aac track". Drop mp4a from CODECS when
 * the first rendition's init has no audio handler.
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
async function masterPlaylistForPlayer(bytes) {
  if (!looksLikeM3u8(bytes)) return bytes;
  const text = new TextDecoder().decode(bytes);
  if (!text.includes("#EXT-X-STREAM-INF") || !/CODECS="[^"]*mp4a/i.test(text)) return bytes;
  const variantUrl = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("https://") || line.startsWith("http://"));
  if (!variantUrl) return bytes;
  let hasAudio = true;
  try {
    hasAudio = await variantInitHasAudio(variantUrl);
  } catch {
    return bytes;
  }
  if (hasAudio) return bytes;
  const rewritten = text.replace(/CODECS="([^"]*)"/gi, (_match, codecs) => {
    const next = String(codecs)
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part && !part.toLowerCase().startsWith("mp4a"))
      .join(",");
    return `CODECS="${next}"`;
  });
  return new TextEncoder().encode(rewritten);
}

/**
 * @param {string} variantUrl
 * @returns {Promise<boolean>}
 */
async function variantInitHasAudio(variantUrl) {
  const playlistRes = await fetch(variantUrl, { redirect: "follow" });
  if (!playlistRes.ok) throw new Error(`Variant playlist HTTP ${playlistRes.status}`);
  const playlist = await playlistRes.text();
  const mapLine = playlist
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("#EXT-X-MAP:"));
  if (!mapLine) return true;
  const uri = /URI="([^"]+)"/.exec(mapLine)?.[1] || "";
  if (!uri) return true;
  const range = /BYTERANGE="(\d+)@(\d+)"/.exec(mapLine);
  /** @type {Record<string, string>} */
  const headers = {};
  if (range) {
    const length = Number(range[1]);
    const offset = Number(range[2]);
    if (length > 0) headers.Range = `bytes=${offset}-${offset + length - 1}`;
  }
  const initRes = await fetch(uri, { redirect: "follow", headers });
  if (!(initRes.ok || initRes.status === 206)) throw new Error(`Init HTTP ${initRes.status}`);
  const initBytes = new Uint8Array(await initRes.arrayBuffer());
  const packed = latin1(initBytes);
  return packed.includes("soun") || packed.includes("mp4a");
}

/**
 * @param {string} cid
 * @param {string} [rangeHeader]
 * @param {AbortSignal} [signal]
 */
export async function readPieceForPlayer(cid, rangeHeader, signal) {
  const bytes = await loadFullPieceBytes(cid, signal);
  const pieceCid = String(cid || "").trim();
  const contentType = pieceContentType.get(pieceCid) || contentTypeForPiece(bytes, "");
  const sliced = slicePieceBytes(bytes, rangeHeader || "", contentType);
  if (sliced.status !== 200 || rangeHeader) return sliced;
  const original = new Uint8Array(sliced.data);
  const playlist = await masterPlaylistForPlayer(original);
  if (playlist === original) return sliced;
  const copy = new Uint8Array(playlist);
  return {
    data: copy.buffer,
    status: 200,
    headers: playerResponseHeaders(copy, sliced.headers["content-type"] || contentType),
  };
}

/**
 * HTTPS piece URL turned into a same-session object URL after one download.
 * Repeated image tags on the waiting page must not hit the provider again.
 *
 * @param {string} url
 * @returns {Promise<string>}
 */
export async function objectUrlForPieceRetrievalUrl(url) {
  const raw = String(url || "").trim();
  const cid = pieceCidFromRetrievalUrl(raw);
  if (!cid) return raw;
  const existing = pieceObjectUrls.get(cid);
  if (existing) return existing;
  if (!pieceSourceUrl.has(cid)) pieceSourceUrl.set(cid, raw);
  const bytes = await loadFullPieceBytes(cid);
  const contentType = pieceContentType.get(cid) || "";
  const created = URL.createObjectURL(
    contentType ? new Blob([bytes], { type: contentType }) : new Blob([bytes]),
  );
  pieceObjectUrls.set(cid, created);
  return created;
}
