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

const POSITIVE_TTL_MS = 10 * 60 * 1000;
const NEGATIVE_TTL_MS = 2 * 60 * 1000;
const MAX_CANDIDATES = 8;

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
 * @param {string} url
 * @returns {Promise<string>}
 */
export async function relocatePieceRetrievalUrl(url) {
  const cid = pieceCidFromRetrievalUrl(url);
  if (!cid) return String(url || "");
  return resolvePieceRetrievalUrl(cid);
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
      positiveCache.set(cid, { url, expires: Date.now() + POSITIVE_TTL_MS });
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
