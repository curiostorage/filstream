/**
 * In-browser Synapse upload session: IndexedDB-segmented media pieces + Synapse store/commit.
 * Media bytes are not held as a chunk list in JS heap; each segment is written to IDB and
 * streamed to Synapse via ReadableStream, deleting each IDB record after it is read.
 */
import {
  Synapse,
  getChain,
  DefaultFwssPermissions,
  fromSecp256k1,
  getAddress,
  custom,
  privateKeyToAccount,
} from "./vendor/synapse-browser.mjs";
import { ensureFilstreamId, getFilstreamStoreConfig } from "./filstream-config.mjs";

/**
 * @typedef {object} DataSetCandidate
 * @property {unknown} [providerId]
 * @property {unknown} [dataSetId]
 * @property {unknown} [metadata]
 * @property {unknown} [createdAt]
 */

/**
 * @typedef {object} FileMapping
 * @property {string} path
 * @property {string} mimeType
 * @property {string} pieceCid
 * @property {string | null} retrievalUrl
 * @property {number} offset
 * @property {number} length
 * @property {string} variant
 * @property {number | null} sequence
 * @property {number | null} segmentIndex
 */

/**
 * @typedef {object} PieceRecord
 * @property {unknown} pieceRef
 * @property {string} pieceCid
 * @property {string | null} retrievalUrl
 * @property {number} byteLength
 * @property {Record<string, string>} pieceMetadata
 * @property {boolean} committed
 * @property {boolean} abandoned
 * @property {string} variant
 * @property {number | null} sequence
 * @property {string} storedAt
 */

/**
 * @typedef {import("@filoz/synapse-sdk").PieceCID} PieceCID
 */

const SYNAPSE_MIN_PIECE_BYTES = 127;
const SYNAPSE_MAX_PIECE_BYTES = 200 * 1024 * 1024;
const MAX_COMMIT_BATCH_PIECES = 32;
const MAX_PARALLEL_PDP_UPLOADS = 4;
const VARIANT_PLAYLIST_APP_RE = /^v\d+\/playlist-app\.m3u8$/;
const FAKE_ORIGIN = "https://filstream.invalid";
const SEGMENTS_STORE = "segments";
const DB_VERSION = 1;

export class StoreError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   * @param {string} [hint]
   */
  constructor(status, message, hint) {
    super(hint ? `${message} (${hint})` : message);
    this.status = status;
    this.hint = hint;
    this.name = "StoreError";
  }
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function parseSafeNonNegativeInt(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return n;
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isExtraDataTooLargeError(error) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    msg.includes("extraData size") &&
    msg.includes("exceeds the maximum allowed limit")
  );
}

/**
 * @param {unknown} value
 * @param {string} fieldName
 * @returns {bigint}
 */
function parseExpirationBigInt(value, fieldName) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) {
    return BigInt(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    try {
      return BigInt(value.trim());
    } catch {
      throw new StoreError(400, `Invalid ${fieldName}`);
    }
  }
  throw new StoreError(400, `Missing ${fieldName}`);
}

/**
 * @param {unknown} raw
 * @returns {Record<string, bigint>}
 */
function parseSessionExpirations(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new StoreError(400, "Missing sessionExpirations");
  }
  const src = /** @type {Record<string, unknown>} */ (raw);
  /** @type {Record<string, bigint>} */
  const out = {};
  for (const permission of DefaultFwssPermissions) {
    out[permission] = parseExpirationBigInt(
      src[permission],
      `sessionExpirations[${permission}]`,
    );
  }
  return out;
}

/** JSON.stringify `replacer` so bigint params encode as hex (viem RPC shape). */
function rpcJsonReplacer(_key, value) {
  if (typeof value === "bigint") {
    return `0x${value.toString(16)}`;
  }
  return value;
}

/**
 * Synapse.create() rejects `http()` when `account` is a plain address (`json-rpc` type); use `custom`.
 *
 * @param {string} rpcUrl
 */
function jsonRpcUrlCustomTransport(rpcUrl) {
  let reqId = 0;
  return custom({
    request: async (/** @type {{ method: string, params?: unknown }} */ { method, params }) => {
      const body = JSON.stringify(
        {
          jsonrpc: "2.0",
          id: ++reqId,
          method,
          params: params ?? [],
        },
        rpcJsonReplacer,
      );
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      const json = await res.json();
      if (json.error) {
        const err = json.error;
        const msg =
          typeof err === "object" && err && "message" in err && typeof err.message === "string"
            ? err.message
            : JSON.stringify(err);
        throw new Error(msg);
      }
      return json.result;
    },
  });
}

/**
 * @param {{
 *   rpcUrl: string,
 *   chainId: number,
 *   source: string,
 * }} cfg
 * @param {string} rootAddress
 * @param {string} sessionPrivateKey
 * @param {Record<string, bigint>} sessionExpirations
 */
function buildSynapseInitOptions(cfg, rootAddress, sessionPrivateKey, sessionExpirations) {
  const chain = getChain(cfg.chainId);
  const transport = jsonRpcUrlCustomTransport(cfg.rpcUrl);
  const sessionKey = fromSecp256k1({
    privateKey: sessionPrivateKey,
    root: rootAddress,
    chain,
    transport,
    expirations: sessionExpirations,
  });
  return {
    account: rootAddress,
    transport,
    chain,
    source: cfg.source,
    sessionKey,
  };
}

/**
 * @param {{
 *   rpcUrl: string,
 *   chainId: number,
 *   source: string,
 * }} cfg
 * @param {string} clientAddress
 * @param {string} sessionPrivateKey
 * @param {unknown} sessionExpirationsInput
 */
export async function createSynapseForSession(
  cfg,
  clientAddress,
  sessionPrivateKey,
  sessionExpirationsInput,
) {
  if (typeof clientAddress !== "string" || clientAddress.trim() === "") {
    throw new StoreError(400, "Missing clientAddress");
  }
  if (typeof sessionPrivateKey !== "string" || sessionPrivateKey.trim() === "") {
    throw new StoreError(400, "Missing sessionPrivateKey");
  }
  const normalized =
    sessionPrivateKey.startsWith("0x") || sessionPrivateKey.startsWith("0X")
      ? sessionPrivateKey
      : `0x${sessionPrivateKey}`;
  const sessionExpirations = parseSessionExpirations(sessionExpirationsInput);
  try {
    privateKeyToAccount(/** @type {`0x${string}`} */ (normalized));
  } catch {
    throw new StoreError(400, "Invalid sessionPrivateKey");
  }
  if (!cfg || typeof cfg !== "object") {
    throw new StoreError(500, "Invalid store configuration");
  }
  let rootAddress = "";
  try {
    rootAddress = getAddress(clientAddress);
  } catch {
    throw new StoreError(400, "Invalid clientAddress");
  }
  try {
    const options = buildSynapseInitOptions(cfg, rootAddress, normalized, sessionExpirations);
    return Synapse.create(options);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("Session key does not have the required permissions")
    ) {
      throw new StoreError(
        403,
        "Session key missing required permissions",
        "Run session-key login/authorization before upload",
      );
    }
    throw new StoreError(
      500,
      "Failed to initialize Synapse client with provided session key",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * @param {unknown} raw
 * @returns {DataSetCandidate[]}
 */
function normalizeDataSetList(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {DataSetCandidate[]} */
  const out = [];
  for (const item of raw) {
    if (item && typeof item === "object") {
      out.push(/** @type {DataSetCandidate} */ (item));
    }
  }
  return out;
}

/**
 * @param {unknown} raw
 * @returns {Record<string, string>}
 */
function normalizeMetadata(raw) {
  if (!raw || typeof raw !== "object") return {};
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(/** @type {Record<string, unknown>} */ (raw))) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * @param {DataSetCandidate} raw
 * @returns {number | null}
 */
function extractProviderId(raw) {
  return parseSafeNonNegativeInt(raw.providerId);
}

/**
 * @param {DataSetCandidate} raw
 * @returns {number | null}
 */
function extractDataSetId(raw) {
  return parseSafeNonNegativeInt(raw.dataSetId);
}

/**
 * @param {DataSetCandidate} raw
 * @returns {number | null}
 */
function extractCreatedAtMs(raw) {
  const candidates = [raw.createdAt];
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const ms = Date.parse(candidate);
      if (Number.isFinite(ms)) return ms;
    }
    const asNum = Number(candidate);
    if (Number.isFinite(asNum) && asNum > 0) {
      return asNum < 10_000_000_000 ? asNum * 1000 : asNum;
    }
  }
  return null;
}

/**
 * @param {import("@filoz/synapse-sdk/storage").StorageManager} storage
 * @param {string} clientAddress
 */
async function findDataSetsByAddress(storage, clientAddress) {
  if (!storage || typeof storage.findDataSets !== "function") {
    throw new StoreError(500, "Synapse storage.findDataSets is unavailable");
  }
  const raw = await storage.findDataSets({ address: clientAddress });
  return normalizeDataSetList(raw);
}

/**
 * @param {DataSetCandidate[]} datasets
 * @param {number} providerId
 * @param {string} filstreamId
 */
function pickMatchingDataSet(datasets, providerId, filstreamId) {
  /** @type {Array<{ dataSetId: number, createdAtMs: number | null, raw: DataSetCandidate }>} */
  const matches = [];
  for (const item of datasets) {
    const id = extractDataSetId(item);
    if (id == null) continue;
    const pid = extractProviderId(item);
    if (pid == null || pid !== providerId) continue;
    const metadata = normalizeMetadata(item?.metadata);
    if (metadata["FILSTREAM-ID"] !== filstreamId) continue;
    matches.push({
      dataSetId: id,
      createdAtMs: extractCreatedAtMs(item),
      raw: item,
    });
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => {
    if (a.createdAtMs != null && b.createdAtMs != null && a.createdAtMs !== b.createdAtMs) {
      return a.createdAtMs - b.createdAtMs;
    }
    return a.dataSetId - b.dataSetId;
  });
  return {
    dataSetId: matches[0].dataSetId,
    raw: matches[0].raw,
  };
}

/**
 * @param {import("@filoz/synapse-sdk/storage").StorageManager} storage
 * @param {number} providerId
 * @param {number} dataSetId
 */
async function createExistingDataSetContext(storage, providerId, dataSetId) {
  return storage.createContext({
    providerId: BigInt(providerId),
    dataSetId: BigInt(dataSetId),
  });
}

/**
 * @param {import("@filoz/synapse-sdk/storage").StorageManager} storage
 * @param {number} providerId
 * @param {string} filstreamId
 */
async function createNewDataSetContext(storage, providerId, filstreamId) {
  return storage.createContext({
    providerId: BigInt(providerId),
    metadata: {
      "FILSTREAM-ID": filstreamId,
    },
  });
}

/**
 * @param {{
 *   synapse: import("@filoz/synapse-sdk").Synapse,
 *   providerId: number,
 *   clientAddress: string,
 *   filstreamId: string,
 * }} input
 */
export async function resolveOrCreateDataSet(input) {
  const { synapse, providerId, clientAddress, filstreamId } = input;
  if (!synapse?.storage) {
    throw new StoreError(500, "Synapse storage manager is unavailable");
  }
  const existing = pickMatchingDataSet(
    await findDataSetsByAddress(synapse.storage, clientAddress),
    providerId,
    filstreamId,
  );
  if (existing) {
    return {
      context: await createExistingDataSetContext(
        synapse.storage,
        providerId,
        existing.dataSetId,
      ),
      dataSetId: existing.dataSetId,
      created: false,
    };
  }
  const context = await createNewDataSetContext(synapse.storage, providerId, filstreamId);
  const dataSetIdRaw = context.dataSetId;
  const dataSetId =
    dataSetIdRaw != null ? parseSafeNonNegativeInt(dataSetIdRaw) : null;
  if (dataSetIdRaw != null && dataSetId == null) {
    throw new StoreError(500, "Received invalid dataSetId from Synapse context");
  }
  return {
    context,
    dataSetId,
    created: dataSetId != null,
  };
}

/**
 * @param {import("@filoz/synapse-sdk/storage").StorageContext} context
 * @param {PieceCID | string} pieceCid
 * @returns {Promise<string | null>}
 */
export async function getPieceRetrievalUrl(context, pieceCid) {
  if (!context || typeof context.getPieceUrl !== "function") {
    return null;
  }
  try {
    const value = context.getPieceUrl(pieceCid);
    return typeof value === "string" && value.trim() !== "" ? value : null;
  } catch {
    return null;
  }
}

/**
 * @param {import("@filoz/synapse-sdk/storage").StorageContext} context
 * @param {PieceCID | string} pieceCid
 */
export async function deletePiece(context, pieceCid) {
  if (!context || typeof context.deletePiece !== "function") {
    throw new StoreError(500, "Storage context.deletePiece is unavailable");
  }
  await context.deletePiece({ piece: pieceCid });
}

/**
 * @param {import("@filoz/synapse-sdk/storage").StorageContext} context
 */
export async function terminateDataSet(context) {
  if (!context || typeof context.terminate !== "function") {
    throw new StoreError(500, "Storage context.terminate is unavailable");
  }
  await context.terminate();
}

/**
 * Open an existing PDP data set for the catalog `providerId` / `dataSetId`.
 * `catalogChainId` must match `getFilstreamStoreConfig().storeChainId` (or omit when absent).
 *
 * @param {{
 *   synapse: import("@filoz/synapse-sdk").Synapse,
 *   providerId: number,
 *   dataSetId: number,
 *   catalogChainId?: number | null,
 * }} input
 * @returns {Promise<import("@filoz/synapse-sdk/storage").StorageContext>}
 */
export async function openDataSetContextForCatalog(input) {
  const { synapse, providerId, dataSetId, catalogChainId } = input;
  if (!synapse?.storage) {
    throw new StoreError(500, "Synapse storage manager is unavailable");
  }
  const cfg = getFilstreamStoreConfig();
  if (
    catalogChainId != null &&
    Number.isFinite(catalogChainId) &&
    catalogChainId !== cfg.storeChainId
  ) {
    throw new StoreError(
      400,
      "Catalog chainId does not match FilStream store config (set window.__FILSTREAM_CONFIG__.storeChainId)",
    );
  }
  return createExistingDataSetContext(synapse.storage, providerId, dataSetId);
}

/**
 * Highest `FS_VER` among `filstream_catalog.json` pieces on the data set, and the version to use for the next catalog piece.
 *
 * @param {{
 *   context: import("@filoz/synapse-sdk/storage").StorageContext,
 *   synapse: import("@filoz/synapse-sdk").Synapse,
 *   chainId: number,
 *   dataSetId: number,
 * }} input
 * @returns {Promise<{ latestVersion: number, nextVersion: number }>}
 */
export async function findLatestCatalogVersion(input) {
  const { context, synapse, chainId, dataSetId } = input;
  if (!context || typeof context.getPieces !== "function") {
    throw new StoreError(500, "Storage context.getPieces is unavailable");
  }
  let bestVer = -1;
  try {
    for await (const row of context.getPieces()) {
      const kv = await readPieceMetadataKvPublic({
        synapse,
        chainId,
        dataSetId,
        pieceId: row.pieceId,
      });
      if (kv.FS_NAME === "filstream_catalog.json") {
        const v = Number.parseInt(kv.FS_VER ?? "0", 10);
        if (Number.isFinite(v) && v > bestVer) {
          bestVer = v;
        }
      }
    }
  } catch (e) {
    console.warn("[filstream] findLatestCatalogVersion scan failed", e);
  }
  const nextVersion = bestVer < 0 ? 0 : bestVer + 1;
  return { latestVersion: bestVer < 0 ? -1 : bestVer, nextVersion };
}

/**
 * Store and commit a new `filstream_catalog.json` piece (next `FS_VER`).
 *
 * @param {{
 *   context: import("@filoz/synapse-sdk/storage").StorageContext,
 *   synapse: import("@filoz/synapse-sdk").Synapse,
 *   assetId: string,
 *   catalogDoc: Record<string, unknown>,
 * }} input
 * @returns {Promise<{ pieceCid: string, catalogVersion: number }>}
 */
export async function publishFilstreamCatalogJson(input) {
  const { context, synapse, assetId, catalogDoc } = input;
  if (!context || typeof context.store !== "function") {
    throw new StoreError(500, "Storage context.store is unavailable");
  }
  if (!synapse?.client) {
    throw new StoreError(500, "Synapse client is unavailable");
  }
  if (!assetId || typeof assetId !== "string") {
    throw new StoreError(400, "assetId is required for catalog piece metadata");
  }
  const dataSetIdRaw = context.dataSetId;
  const dataSetId =
    dataSetIdRaw != null
      ? parseSafeNonNegativeInt(
          typeof dataSetIdRaw === "bigint" ? Number(dataSetIdRaw) : dataSetIdRaw,
        )
      : null;
  if (dataSetId == null) {
    throw new StoreError(500, "Storage context has no dataSetId");
  }
  const cfg = getFilstreamStoreConfig();
  const chainId = cfg.storeChainId;
  if (!chainId || !Number.isFinite(chainId)) {
    throw new StoreError(500, "Invalid storeChainId in config");
  }
  const { nextVersion } = await findLatestCatalogVersion({
    context,
    synapse,
    chainId,
    dataSetId,
  });
  let text = JSON.stringify(catalogDoc, null, 2);
  const enc = new TextEncoder();
  let bytes = enc.encode(text);
  while (bytes.byteLength < SYNAPSE_MIN_PIECE_BYTES) {
    text += "\n";
    bytes = enc.encode(text);
  }
  const storeResult = await context.store(bytes);
  const pieceRef = storeResult?.pieceCid;
  if (!pieceRef) {
    throw new StoreError(500, "store() response is missing pieceCid");
  }
  const pieceCid = String(pieceRef);
  const metadata = catalogPieceMetadata(assetId, nextVersion);
  if (typeof context.commit !== "function") {
    throw new StoreError(500, "Storage context.commit is unavailable");
  }
  await context.commit({
    pieces: [{ pieceCid: pieceRef, pieceMetadata: metadata }],
  });
  return { pieceCid, catalogVersion: nextVersion };
}

/**
 * Schedule PDP deletion for every piece with `FS_ASSET === assetId`, except `filstream_catalog.json` catalog pieces.
 *
 * @param {{
 *   context: import("@filoz/synapse-sdk/storage").StorageContext,
 *   synapse: import("@filoz/synapse-sdk").Synapse,
 *   chainId: number,
 *   dataSetId: number,
 *   assetId: string,
 * }} input
 * @returns {Promise<{ deleted: number, errors: string[] }>}
 */
export async function deleteAllPiecesForAssetId(input) {
  const { context, synapse, chainId, dataSetId, assetId } = input;
  if (!context || typeof context.getPieces !== "function") {
    throw new StoreError(500, "Storage context.getPieces is unavailable");
  }
  let deleted = 0;
  /** @type {string[]} */
  const errors = [];
  try {
    for await (const row of context.getPieces()) {
      const kv = await readPieceMetadataKvPublic({
        synapse,
        chainId,
        dataSetId,
        pieceId: row.pieceId,
      });
      if (kv.FS_NAME === "filstream_catalog.json") {
        continue;
      }
      if (kv.FS_ASSET !== assetId) {
        continue;
      }
      try {
        await deletePiece(context, row.pieceCid);
        deleted += 1;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(msg);
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(msg);
  }
  return { deleted, errors };
}

// --- Pure helpers (from Node service.mjs) ---

/**
 * @param {Record<string, string>} values
 * @returns {Record<string, string>}
 */
function validatePieceMetadata(values) {
  const entries = Object.entries(values).filter(([, v]) => v.trim() !== "");
  if (entries.length > 5) {
    throw new StoreError(400, "piece metadata supports at most 5 key-value pairs");
  }
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of entries) {
    if (k.length > 32) {
      throw new StoreError(400, `piece metadata key exceeds 32 chars: ${k}`);
    }
    if (v.length > 128) {
      throw new StoreError(400, `piece metadata value exceeds 128 chars: ${k}`);
    }
    out[k] = v;
  }
  return out;
}

/**
 * @param {unknown} detail
 * @returns {string}
 */
function variantKeyFromDetail(detail) {
  if (!detail || typeof detail !== "object") {
    throw new StoreError(400, "Event detail must be an object");
  }
  const d = /** @type {Record<string, unknown>} */ (detail);
  if (typeof d.variant === "string" && d.variant.trim() !== "") {
    return d.variant.trim();
  }
  if (Number.isFinite(Number(d.variantIndex))) {
    return `v${Number(d.variantIndex)}`;
  }
  throw new StoreError(400, "Event detail is missing variant/variantIndex");
}

/**
 * @param {unknown} detail
 * @returns {number}
 */
function parseSegmentIndex(detail) {
  const d = /** @type {Record<string, unknown>} */ (detail);
  const n = Number(d.segmentIndex);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new StoreError(400, "segmentIndex must be a positive integer");
  }
  return n;
}

/**
 * @param {unknown} detail
 * @returns {Uint8Array}
 */
function parseEventBytes(detail) {
  if (!detail || typeof detail !== "object") {
    throw new StoreError(400, "Event detail must be an object");
  }
  const d = /** @type {Record<string, unknown>} */ (detail);
  if (d.data instanceof Uint8Array && d.data.byteLength > 0) {
    return d.data;
  }
  const raw = typeof d.dataBase64 === "string" ? d.dataBase64 : "";
  if (raw.trim() === "") {
    throw new StoreError(400, "Event detail is missing binary data (data or dataBase64)");
  }
  const bin = atob(raw);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * @typedef {object} VariantIdbBuffer
 * @property {string} variant
 * @property {number} sequence
 * @property {number} size
 * @property {number | null} segmentStart
 * @property {number | null} segmentEnd
 * @property {number} pendingOrd
 * @property {Array<{
 *   path: string,
 *   mimeType: string,
 *   offset: number,
 *   length: number,
 *   segmentIndex: number | null,
 * }>} entries
 */

/**
 * @typedef {object} VariantPieceUploadJob
 * @property {string} variant
 * @property {number} sequence
 * @property {number} segmentCount
 * @property {number} byteLength
 * @property {Record<string, string>} pieceMetadata
 * @property {Array<{
 *   path: string,
 *   mimeType: string,
 *   offset: number,
 *   length: number,
 *   segmentIndex: number | null,
 * }>} entries
 */

/**
 * @typedef {object} UploadIdleWaiter
 * @property {() => void} resolve
 * @property {(error: unknown) => void} reject
 */

/**
 * @param {string} variant
 * @returns {VariantIdbBuffer}
 */
function newVariantBuffer(variant) {
  return {
    variant,
    sequence: 0,
    size: 0,
    segmentStart: null,
    segmentEnd: null,
    pendingOrd: 0,
    entries: [],
  };
}

/**
 * @param {string} assetId
 * @param {string} variant
 * @param {number} sequence
 * @param {number | null} segmentStart
 * @param {number | null} segmentEnd
 */
function variantPieceMetadata(assetId, variant, sequence, segmentStart, segmentEnd) {
  const segRange =
    segmentStart != null && segmentEnd != null ? `${segmentStart}-${segmentEnd}` : "";
  return validatePieceMetadata({
    FS_ASSET: assetId,
    FS_VAR: variant,
    FS_SEQ: String(sequence),
    FS_SEGS: segRange,
    FS_FILE: "",
  });
}

/**
 * @param {string} assetId
 * @param {string} path
 */
function filePieceMetadata(assetId, path) {
  const m = path.match(/^(v\d+)\//);
  const variant = m ? m[1] : "root";
  return validatePieceMetadata({
    FS_ASSET: assetId,
    FS_VAR: variant,
    FS_SEQ: "",
    FS_SEGS: "",
    FS_FILE: path,
  });
}

/**
 * @param {string} filePath
 * @returns {string}
 */
function defaultMimeForPath(filePath) {
  if (filePath.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
  if (filePath.endsWith(".json")) return "application/json";
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "application/octet-stream";
}

/**
 * Safe single-segment path for a listing poster (basename only).
 *
 * @param {string} raw
 * @returns {string}
 */
function sanitizePosterPath(raw) {
  const base = raw.split(/[/\\]/).pop() || "poster.png";
  const cleaned = base.replace(/[^\w.\-]+/g, "_").replace(/^\.+/, "") || "poster.png";
  return cleaned.slice(0, 200);
}

/**
 * @param {string} raw
 * @returns {Record<string, unknown> | null}
 */
function parseOptionalJsonObject(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return /** @type {Record<string, unknown>} */ (parsed);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * @param {FileMapping[]} files
 * @param {string | null | undefined} posterPath Staged poster file path (e.g. `poster-seek.png`), if any
 */
function extractPlaybackUrls(files, posterPath) {
  const master = files.find((f) => f.path === "master-app.m3u8");
  const manifest = files.find((f) => f.path === "manifest.json");
  const meta = files.find((f) => f.path === "meta.json");
  const pNorm =
    typeof posterPath === "string" && posterPath.trim() !== ""
      ? posterPath.trim()
      : "";
  const poster =
    pNorm !== "" ? files.find((f) => f.path === pNorm) : undefined;
  const catalog = files.find((f) => f.path === "filstream_catalog.json");
  return {
    masterAppUrl: master?.retrievalUrl || null,
    manifestUrl: manifest?.retrievalUrl || null,
    metaJsonUrl: meta?.retrievalUrl || null,
    posterUrl: poster?.retrievalUrl ?? null,
    catalogJsonUrl: catalog?.retrievalUrl ?? null,
  };
}

/**
 * @param {Record<string, unknown>} obj
 * @returns {Uint8Array}
 */
function encodeJsonWithMinPiecePadding(obj) {
  let text = JSON.stringify(obj, null, 2);
  const enc = new TextEncoder();
  let bytes = enc.encode(text);
  while (bytes.byteLength < SYNAPSE_MIN_PIECE_BYTES) {
    text += "\n";
    bytes = enc.encode(text);
  }
  return bytes;
}

/**
 * Drop uncommitted staged pieces for `path` (e.g. replace draft manifest with final).
 *
 * @param {BrowserFilstreamUploadSession} session
 * @param {string} path
 */
function abandonUncommittedStagingByPath(session, path) {
  for (let i = session.fileMappings.length - 1; i >= 0; i--) {
    if (session.fileMappings[i].path !== path) continue;
    const cid = session.fileMappings[i].pieceCid;
    const p = session.piecesByCid.get(cid);
    if (p && !p.committed) {
      p.abandoned = true;
    }
    session.fileMappings.splice(i, 1);
  }
}

/**
 * Listing + playback URLs + stable filstream ids for viewers and tools.
 *
 * @param {BrowserFilstreamUploadSession} session
 * @param {{
 *   masterAppUrl: string | null,
 *   manifestUrl: string | null,
 *   metaJsonUrl: string | null,
 *   posterUrl: string | null,
 * }} urls
 * @returns {Record<string, unknown>}
 */
function buildPublishedMetaDocument(session, urls) {
  const stagingPath =
    typeof session.listingMetaPath === "string" && session.listingMetaPath.trim() !== ""
      ? session.listingMetaPath.trim()
      : "meta.json";
  const metaFile = session.textFiles.get(stagingPath);
  if (!metaFile) {
    throw new StoreError(
      400,
      "Listing meta is missing — complete Listing Details before finalize.",
    );
  }
  const base = parseOptionalJsonObject(new TextDecoder().decode(metaFile.data));
  if (!base) {
    throw new StoreError(400, "Listing meta (meta.json) is not valid JSON.");
  }
  const master = typeof urls.masterAppUrl === "string" ? urls.masterAppUrl.trim() : "";
  const manifest = typeof urls.manifestUrl === "string" ? urls.manifestUrl.trim() : "";
  const posterUrl =
    typeof urls.posterUrl === "string" && urls.posterUrl.trim() !== ""
      ? urls.posterUrl.trim()
      : null;
  if (!master) {
    throw new StoreError(500, "Cannot publish meta.json: missing master-app.m3u8 retrieval URL.");
  }
  if (!manifest) {
    throw new StoreError(500, "Cannot publish meta.json: missing manifest.json retrieval URL.");
  }
  /** @type {Record<string, unknown>} */
  const prevPb =
    typeof base.playback === "object" && base.playback !== null && !Array.isArray(base.playback)
      ? /** @type {Record<string, unknown>} */ (base.playback)
      : {};
  /** @type {Record<string, unknown>} */
  const prevPoster =
    typeof base.poster === "object" && base.poster !== null && !Array.isArray(base.poster)
      ? /** @type {Record<string, unknown>} */ ({ ...base.poster })
      : {};
  const posterOut =
    posterUrl != null ? { ...prevPoster, url: posterUrl } : base.poster;
  return {
    ...base,
    poster: posterOut,
    playback: {
      ...prevPb,
      masterAppUrl: master,
      manifestUrl: manifest,
      ...(posterUrl != null ? { posterUrl } : {}),
    },
    filstream: {
      assetId: session.assetId,
      filstreamId: session.filstreamId,
      dataSetId: session.dataSetId,
      providerId: session.providerId,
      clientAddress: session.clientAddress,
    },
  };
}

/**
 * PDP piece metadata key-values from chain (FWSS view).
 *
 * @param {{
 *   synapse: import("@filoz/synapse-sdk").Synapse,
 *   chainId: number,
 *   dataSetId: number,
 *   pieceId: bigint,
 * }} input
 * @returns {Promise<Record<string, string>>}
 */
export async function readPieceMetadataKvPublic(input) {
  const { synapse, chainId, dataSetId, pieceId } = input;
  if (!synapse?.client) {
    throw new StoreError(500, "Synapse client is unavailable");
  }
  const chain = getChain(chainId);
  const client = synapse.client;
  const [keys, values] = await client.readContract({
    address: chain.contracts.fwssView.address,
    abi: chain.contracts.fwssView.abi,
    functionName: "getAllPieceMetadata",
    args: [BigInt(dataSetId), pieceId],
  });
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < keys.length; i++) {
    out[keys[i]] = values[i];
  }
  return out;
}

/**
 * Read-only Synapse client for public PDP / FWSS view calls (no session key).
 *
 * @param {{ rpcUrl: string, chainId: number, source: string }} cfg
 */
function createSynapseForPublicRead(cfg) {
  const chain = getChain(cfg.chainId);
  const transport = jsonRpcUrlCustomTransport(cfg.rpcUrl);
  return Synapse.create({
    chain,
    transport,
    account: "0x0000000000000000000000000000000000000001",
    source: cfg.source,
  });
}

/**
 * @param {string} hex
 * @returns {Uint8Array}
 */
function hexToBytes(hex) {
  const h = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * @param {unknown} data
 * @returns {{ pieces: unknown[], pieceIds: unknown[], hasMore: boolean }}
 */
function parseGetActivePiecesResult(data) {
  if (Array.isArray(data)) {
    const a = /** @type {unknown[]} */ (data);
    return {
      pieces: Array.isArray(a[0]) ? a[0] : [],
      pieceIds: Array.isArray(a[1]) ? a[1] : [],
      hasMore: Boolean(a[2]),
    };
  }
  if (data && typeof data === "object" && data !== null) {
    const d = /** @type {Record<string, unknown>} */ (data);
    if (Array.isArray(d.pieces) && Array.isArray(d.pieceIds)) {
      return {
        pieces: d.pieces,
        pieceIds: d.pieceIds,
        hasMore: Boolean(d.hasMore),
      };
    }
  }
  return { pieces: [], pieceIds: [], hasMore: false };
}

/**
 * @param {unknown} cidStruct
 * @param {string} serviceURL
 * @returns {Promise<string | null>}
 */
async function pieceCidStructToRetrievalUrl(cidStruct, serviceURL) {
  if (!cidStruct || typeof cidStruct !== "object") return null;
  const data = /** @type {{ data?: unknown }} */ (cidStruct).data;
  if (data == null) return null;
  let bytes;
  if (data instanceof Uint8Array) {
    bytes = data;
  } else if (typeof data === "string") {
    bytes = hexToBytes(data);
  } else {
    return null;
  }
  const { CID } = await import("https://esm.sh/multiformats@13.0.1/cid");
  const cid = CID.decode(bytes);
  return new URL(`piece/${cid.toString()}`, serviceURL).href;
}

/**
 * @param {unknown} data Return value of FWSS `getDataSet(uint256)`.
 * @returns {{ providerId: number } | null}
 */
function providerIdFromGetDataSetView(data) {
  if (data == null || typeof data !== "object") {
    return null;
  }
  const d = /** @type {Record<string, unknown>} */ (data);
  const info =
    "info" in d && d.info != null && typeof d.info === "object"
      ? /** @type {Record<string, unknown>} */ (d.info)
      : d;
  const rail = info.pdpRailId;
  const railZero =
    rail === 0n ||
    rail === 0 ||
    rail === "0" ||
    (typeof rail === "string" && /^0x0*$/i.test(rail.trim()));
  if (railZero) {
    return null;
  }
  const pid = info.providerId;
  let n;
  if (typeof pid === "bigint") {
    n = Number(pid);
  } else if (typeof pid === "number") {
    n = pid;
  } else {
    return null;
  }
  if (!Number.isFinite(n) || n < 0) {
    return null;
  }
  return { providerId: n };
}

/**
 * Resolve the PDP provider id for a data set via `fwssView.getDataSet` (no catalog JSON needed).
 *
 * @param {import("@filoz/synapse-sdk").Synapse} synapse
 * @param {number} chainId
 * @param {number} dataSetId
 * @returns {Promise<number | null>}
 */
async function resolveProviderIdFromDataSetId(synapse, chainId, dataSetId) {
  const client = synapse.client;
  const chain = getChain(chainId);
  try {
    const data = await client.readContract({
      address: chain.contracts.fwssView.address,
      abi: chain.contracts.fwssView.abi,
      functionName: "getDataSet",
      args: [BigInt(dataSetId)],
    });
    const out = providerIdFromGetDataSetView(data);
    return out?.providerId ?? null;
  } catch (e) {
    console.warn("[filstream] resolveProviderIdFromDataSetId failed", e);
    return null;
  }
}

/**
 * Find the highest-`FS_VER` `filstream_catalog.json` piece on a PDP data set and fetch its JSON
 * from the provider retrieval URL. Uses public chain reads only (no storage session / ownership).
 *
 * When `providerId` is omitted, it is resolved from `fwssView.getDataSet(dataSetId)` so callers
 * only need `chainId` + `dataSetId` (e.g. creator recovery when the catalog URL is dead).
 *
 * @param {{
 *   chainId: number,
 *   dataSetId: number,
 *   providerId?: number | null,
 *   rpcUrl?: string,
 *   source?: string,
 * }} input
 * @returns {Promise<{ retrievalUrl: string, doc: unknown, catalogVersion: number } | null>}
 */
export async function fetchLatestCatalogJsonForDataSet(input) {
  const { chainId, dataSetId } = input;
  let providerId =
    typeof input.providerId === "number" && Number.isFinite(input.providerId)
      ? input.providerId
      : null;
  if (!Number.isFinite(chainId) || !Number.isFinite(dataSetId)) {
    return null;
  }
  const cfg = getFilstreamStoreConfig();
  const rpcUrl =
    typeof input.rpcUrl === "string" && input.rpcUrl.trim() !== ""
      ? input.rpcUrl.trim()
      : cfg.storeRpcUrl;
  const source =
    typeof input.source === "string" && input.source.trim() !== ""
      ? input.source.trim()
      : cfg.storeSource;

  let synapse;
  try {
    synapse = createSynapseForPublicRead({ rpcUrl, chainId, source });
  } catch (e) {
    console.warn("[filstream] fetchLatestCatalogJsonForDataSet: synapse init failed", e);
    return null;
  }

  const client = synapse.client;
  const chain = getChain(chainId);

  if (providerId == null) {
    const resolved = await resolveProviderIdFromDataSetId(synapse, chainId, dataSetId);
    if (resolved == null) {
      console.warn(
        "[filstream] fetchLatestCatalogJsonForDataSet: could not resolve providerId for data set",
      );
      return null;
    }
    providerId = resolved;
  }

  let providerInfo;
  try {
    providerInfo = await synapse.providers.getProvider({
      providerId: BigInt(providerId),
    });
  } catch (e) {
    console.warn("[filstream] fetchLatestCatalogJsonForDataSet: provider lookup failed", e);
    return null;
  }
  const serviceURL = providerInfo?.pdp?.serviceURL;
  if (typeof serviceURL !== "string" || serviceURL.trim() === "") {
    return null;
  }

  let bestVer = -1;
  /** @type {bigint | null} */
  let bestPieceId = null;

  try {
    let offset = 0n;
    const limit = 100n;
    let hasMore = true;
    while (hasMore) {
      const raw = await client.readContract({
        address: chain.contracts.pdp.address,
        abi: chain.contracts.pdp.abi,
        functionName: "getActivePieces",
        args: [BigInt(dataSetId), offset, limit],
      });
      const { pieces, pieceIds, hasMore: more } = parseGetActivePiecesResult(raw);
      hasMore = more;
      offset += limit;
      const n = Math.min(pieces.length, pieceIds.length);
      for (let i = 0; i < n; i++) {
        const pieceIdRaw = pieceIds[i];
        const pieceId =
          typeof pieceIdRaw === "bigint"
            ? pieceIdRaw
            : pieceIdRaw != null
              ? BigInt(pieceIdRaw)
              : null;
        if (pieceId == null) continue;
        const kv = await readPieceMetadataKvPublic({
          synapse,
          chainId,
          dataSetId,
          pieceId,
        });
        if (kv.FS_NAME !== "filstream_catalog.json") continue;
        const v = Number.parseInt(kv.FS_VER ?? "0", 10);
        if (Number.isFinite(v) && v > bestVer) {
          bestVer = v;
          bestPieceId = pieceId;
        }
      }
      if (!hasMore) break;
    }
  } catch (e) {
    console.warn("[filstream] fetchLatestCatalogJsonForDataSet: chain scan failed", e);
    return null;
  }

  if (bestPieceId == null || bestVer < 0) {
    return null;
  }

  let cidStruct;
  try {
    cidStruct = await client.readContract({
      address: chain.contracts.pdp.address,
      abi: chain.contracts.pdp.abi,
      functionName: "getPieceCid",
      args: [BigInt(dataSetId), bestPieceId],
    });
  } catch (e) {
    console.warn("[filstream] fetchLatestCatalogJsonForDataSet: getPieceCid failed", e);
    return null;
  }

  let retrievalUrl;
  try {
    retrievalUrl = await pieceCidStructToRetrievalUrl(cidStruct, serviceURL);
  } catch (e) {
    console.warn("[filstream] fetchLatestCatalogJsonForDataSet: CID decode failed", e);
    return null;
  }
  if (!retrievalUrl) {
    return null;
  }

  try {
    const res = await fetch(retrievalUrl);
    if (!res.ok) {
      console.warn(
        "[filstream] fetchLatestCatalogJsonForDataSet: HTTP",
        res.status,
        retrievalUrl,
      );
      return null;
    }
    const doc = await res.json();
    return { retrievalUrl, doc, catalogVersion: bestVer };
  } catch (e) {
    console.warn("[filstream] fetchLatestCatalogJsonForDataSet: fetch failed", e);
    return null;
  }
}

/**
 * @param {BrowserFilstreamUploadSession} session
 * @param {number} dataSetId
 * @param {bigint} pieceId
 * @returns {Promise<Record<string, string>>}
 */
async function readPieceMetadataKv(session, dataSetId, pieceId) {
  return readPieceMetadataKvPublic({
    synapse: session.synapse,
    chainId: session.cfg.chainId,
    dataSetId,
    pieceId,
  });
}

/**
 * @param {string} assetId
 * @param {number} version
 */
function catalogPieceMetadata(assetId, version) {
  return validatePieceMetadata({
    FS_ASSET: assetId,
    FS_VAR: "root",
    FS_NAME: "filstream_catalog.json",
    FS_VER: String(version),
  });
}

/**
 * @param {Record<string, unknown> | null} doc Published `meta.json` object
 * @returns {string}
 */
function posterUrlFromPublishedMetaDoc(doc) {
  if (!doc) return "";
  const poster = doc.poster;
  if (poster && typeof poster === "object" && poster !== null) {
    const u = /** @type {{ url?: string }} */ (poster).url;
    if (typeof u === "string" && u.trim() !== "") return u.trim();
  }
  const pb = doc.playback;
  if (pb && typeof pb === "object" && pb !== null) {
    const u = /** @type {{ posterUrl?: string }} */ (pb).posterUrl;
    if (typeof u === "string" && u.trim() !== "") return u.trim();
  }
  return "";
}

/**
 * @param {string} addr
 * @returns {string}
 */
function normalizeEditorAddress(addr) {
  if (typeof addr !== "string" || addr.trim() === "") return "";
  try {
    return getAddress(/** @type {`0x${string}`} */ (addr.trim()));
  } catch {
    return addr.trim().toLowerCase();
  }
}

/**
 * Published `filstream_catalog.json` top-level fields so viewers can match dataset + editor wallet.
 * Optional `creatorName` / `creatorPosterUrl` (https URL) are merged from `prevCatalog` when present.
 *
 * @param {BrowserFilstreamUploadSession} session
 * @param {{ title: string, metapath: string, posterUrl?: string }[]} movies
 * @param {Record<string, unknown> | null} prevCatalog Prior catalog (chain), for merging `dataSetId` if session has not committed yet
 * @returns {Record<string, unknown>}
 */
function buildFilstreamCatalogDoc(session, movies, prevCatalog) {
  const editorAddress = normalizeEditorAddress(session.clientAddress);
  let dataSetId = session.dataSetId != null ? session.dataSetId : null;
  if (dataSetId == null && prevCatalog) {
    const p = prevCatalog.dataSetId;
    if (typeof p === "number" && Number.isFinite(p)) {
      dataSetId = p;
    }
  }

  /** @type {Record<string, unknown>} */
  const doc = {
    kind: "filstream v1",
    editorAddress,
    movies,
  };
  if (dataSetId != null) {
    doc.dataSetId = dataSetId;
  }
  if (session.providerId != null && Number.isFinite(session.providerId)) {
    doc.providerId = session.providerId;
  }
  if (session.cfg?.chainId != null && Number.isFinite(session.cfg.chainId)) {
    doc.chainId = session.cfg.chainId;
  }
  if (prevCatalog) {
    const cn = prevCatalog.creatorName;
    if (typeof cn === "string" && cn.trim() !== "") {
      doc.creatorName = cn.trim();
    }
    const cpu = prevCatalog.creatorPosterUrl;
    if (typeof cpu === "string" && cpu.trim() !== "") {
      doc.creatorPosterUrl = cpu.trim();
    }
  }
  return doc;
}

/**
 * @param {BrowserFilstreamUploadSession} session
 * @returns {Promise<{ catalogVersion: number | null, catalogPieceCid: string | null }>}
 */
async function appendFilstreamCatalogPiece(session) {
  const metaMapping = session.fileMappings.find((f) => f.path === "meta.json");
  const metaUrl = metaMapping?.retrievalUrl ?? null;
  if (!metaUrl || typeof metaUrl !== "string") {
    return { catalogVersion: null, catalogPieceCid: null };
  }

  let title = "Untitled";
  /** @type {string} */
  let posterUrl = "";
  try {
    const metaFile = session.textFiles.get("meta.json");
    if (metaFile) {
      const doc = parseOptionalJsonObject(new TextDecoder().decode(metaFile.data));
      const t =
        doc && typeof doc.listing === "object" && doc.listing !== null
          ? /** @type {{ title?: string }} */ (doc.listing).title
          : undefined;
      if (typeof t === "string" && t.trim()) title = t.trim();
      posterUrl = posterUrlFromPublishedMetaDoc(doc);
    }
  } catch {
    /* ignore */
  }

  let nextVer = 0;
  /** @type {{ title: string, metapath: string, posterUrl?: string }[]} */
  let movies = [];
  /** @type {Record<string, unknown> | null} */
  let prevCatalog = null;
  let bestVer = -1;
  /** @type {unknown} */
  let bestCid = null;

  const dsId = session.dataSetId;
  if (dsId != null && session.context) {
    try {
      for await (const row of session.context.getPieces()) {
        const kv = await readPieceMetadataKv(session, dsId, row.pieceId);
        if (kv.FS_NAME === "filstream_catalog.json") {
          const v = Number.parseInt(kv.FS_VER ?? "0", 10);
          if (Number.isFinite(v) && v > bestVer) {
            bestVer = v;
            bestCid = row.pieceCid;
          }
        }
      }
    } catch (e) {
      console.warn("[filstream] catalog scan failed", e);
    }

    if (bestCid != null && bestVer >= 0) {
      try {
        const url = session.context.getPieceUrl(bestCid);
        const res = await fetch(url);
        if (res.ok) {
          const prev = await res.json();
          if (prev && typeof prev === "object" && prev !== null) {
            prevCatalog = /** @type {Record<string, unknown>} */ (prev);
          }
          if (prev && Array.isArray(prev.movies)) {
            movies = [...prev.movies];
          }
        }
      } catch (e) {
        console.warn("[filstream] catalog fetch failed", e);
      }
      nextVer = bestVer + 1;
    }
  }

  /** @type {{ title: string, metapath: string, posterUrl?: string }} */
  const entry = { title, metapath: metaUrl };
  if (posterUrl !== "") {
    entry.posterUrl = posterUrl;
  }
  movies.push(entry);
  const doc = buildFilstreamCatalogDoc(session, movies, prevCatalog);
  let text = JSON.stringify(doc, null, 2);
  const enc = new TextEncoder();
  let bytes = enc.encode(text);
  while (bytes.byteLength < SYNAPSE_MIN_PIECE_BYTES) {
    text += "\n";
    bytes = enc.encode(text);
  }

  const metadata = catalogPieceMetadata(session.assetId, nextVer);
  const piece = await session.storePieceBytes({
    bytes,
    pieceMetadata: metadata,
    variant: metadata.FS_VAR || "root",
    sequence: null,
  });
  session.fileMappings.push({
    path: "filstream_catalog.json",
    mimeType: "application/json",
    pieceCid: piece.pieceCid,
    retrievalUrl: piece.retrievalUrl,
    offset: 0,
    length: bytes.byteLength,
    variant: metadata.FS_VAR || "root",
    sequence: null,
    segmentIndex: null,
  });
  return { catalogVersion: nextVer, catalogPieceCid: piece.pieceCid };
}

/**
 * @param {string} filePath
 * @returns {string | null}
 */
function parseVariantFromPath(filePath) {
  const m = filePath.match(/^(v\d+)\//);
  return m ? m[1] : null;
}

/**
 * @param {string} variant
 * @param {number} pieceSeq
 * @param {number} ord
 */
function segmentKey(variant, pieceSeq, ord) {
  return `${variant}\u0000${pieceSeq}\u0000${ord}`;
}

/**
 * @param {string} uploadId
 * @returns {Promise<IDBDatabase>}
 */
function openSegmentsDb(uploadId) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(`filstream-upload-${uploadId}`, DB_VERSION);
    req.onerror = () => reject(req.error ?? new Error("indexedDB.open failed"));
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SEGMENTS_STORE)) {
        db.createObjectStore(SEGMENTS_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
}

/**
 * @param {IDBDatabase} db
 * @param {string} key
 * @param {Uint8Array} bytes
 */
function idbPutSegment(db, key, bytes) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SEGMENTS_STORE, "readwrite");
    tx.onerror = () => reject(tx.error ?? new Error("IDB transaction error"));
    tx.oncomplete = () => resolve();
    const copy = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes
      : new Uint8Array(bytes.slice());
    tx.objectStore(SEGMENTS_STORE).put(copy, key);
  });
}

/**
 * @param {IDBDatabase} db
 * @param {string} key
 */
function idbTakeSegment(db, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SEGMENTS_STORE, "readwrite");
    const os = tx.objectStore(SEGMENTS_STORE);
    const getReq = os.get(key);
    getReq.onerror = () => reject(getReq.error ?? new Error("IDB get failed"));
    getReq.onsuccess = () => {
      const v = getReq.result;
      if (v == null) {
        reject(new StoreError(500, `Missing IDB segment ${key}`));
        return;
      }
      const bytes = v instanceof Uint8Array ? v : new Uint8Array(v);
      const delReq = os.delete(key);
      delReq.onerror = () => reject(delReq.error ?? new Error("IDB delete failed"));
      delReq.onsuccess = () => resolve(bytes);
    };
    tx.onerror = () => reject(tx.error ?? new Error("IDB tx error"));
  });
}

/**
 * @param {IDBDatabase} db
 * @param {string} variant
 * @param {number} pieceSeq
 * @param {number} ordCount
 */
async function idbDeletePendingPiece(db, variant, pieceSeq, ordCount) {
  for (let o = 0; o < ordCount; o++) {
    const key = segmentKey(variant, pieceSeq, o);
    await new Promise((resolve, reject) => {
      const tx = db.transaction(SEGMENTS_STORE, "readwrite");
      tx.onerror = () => reject(tx.error ?? new Error("IDB tx error"));
      tx.oncomplete = () => resolve();
      tx.objectStore(SEGMENTS_STORE).delete(key);
    });
  }
}

/**
 * Segments are read in order; each IDB record is removed when enqueued to the stream.
 *
 * @param {IDBDatabase} db
 * @param {string} variant
 * @param {number} pieceSeq
 * @param {number} segmentCount
 * @returns {ReadableStream<Uint8Array>}
 */
function createIdbPieceReadableStream(db, variant, pieceSeq, segmentCount) {
  let ord = 0;
  return new ReadableStream({
    pull(controller) {
      if (ord >= segmentCount) {
        controller.close();
        return;
      }
      const key = segmentKey(variant, pieceSeq, ord);
      ord += 1;
      return idbTakeSegment(db, key).then((chunk) => {
        controller.enqueue(chunk);
      });
    },
  });
}

/**
 * @param {string} variant
 * @param {string} playlistText
 * @param {Map<string, FileMapping>} mappingsByPath
 */
function rewriteVariantPlaylist(variant, playlistText, mappingsByPath) {
  const initPath = `${variant}/init.mp4`;
  const initMapping = mappingsByPath.get(initPath);
  if (!initMapping) {
    throw new StoreError(400, `Missing file mapping for ${initPath}`);
  }
  const initUrl = (initMapping.retrievalUrl || "").trim();
  if (!initUrl) {
    throw new StoreError(500, `Missing retrievalUrl for ${initPath}`);
  }
  const normalized = playlistText.replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");
  /** @type {string[]} */
  const out = [];
  let mapWritten = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith("#EXT-X-BYTERANGE:")) {
      continue;
    }
    if (line.startsWith("#EXT-X-MAP:")) {
      out.push(
        `#EXT-X-MAP:URI="${initUrl}",BYTERANGE="${initMapping.length}@${initMapping.offset}"`,
      );
      mapWritten = true;
      continue;
    }
    if (line === `${FAKE_ORIGIN}/${variant}/init.mp4`) {
      continue;
    }
    const segMatch = line.match(/(?:^|\/)seg-(\d+)\.m4s(?:$|\?)/);
    if (segMatch) {
      const segIndex = Number(segMatch[1]);
      const segPath = `${variant}/seg-${segIndex}.m4s`;
      const segMapping = mappingsByPath.get(segPath);
      if (!segMapping) {
        throw new StoreError(400, `Missing file mapping for ${segPath}`);
      }
      const segUrl = (segMapping.retrievalUrl || "").trim();
      if (!segUrl) {
        throw new StoreError(500, `Missing retrievalUrl for ${segPath}`);
      }
      out.push(`#EXT-X-BYTERANGE:${segMapping.length}@${segMapping.offset}`);
      out.push(segUrl);
      continue;
    }
    out.push(rawLine);
  }

  if (!mapWritten) {
    const mapLine = `#EXT-X-MAP:URI="${initUrl}",BYTERANGE="${initMapping.length}@${initMapping.offset}"`;
    const insertAfter = out.findIndex((value) => value.trim() === "#EXT-X-INDEPENDENT-SEGMENTS");
    if (insertAfter >= 0) {
      out.splice(insertAfter + 1, 0, mapLine);
    } else {
      out.splice(Math.min(2, out.length), 0, mapLine);
    }
  }

  return out.join("\n");
}

/**
 * @param {string} masterText
 * @param {Map<string, FileMapping>} mappingsByPath
 */
function rewriteMasterPlaylistText(masterText, mappingsByPath) {
  const normalized = masterText.replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");
  /** @type {string[]} */
  const out = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const match = line.match(/(?:^|\/)v(\d+)\/playlist(?:-app)?\.m3u8(?:$|\?)/);
    if (!match) {
      out.push(rawLine);
      continue;
    }
    const variant = `v${match[1]}`;
    const playlistPath = `${variant}/playlist-app.m3u8`;
    const playlistMapping = mappingsByPath.get(playlistPath);
    if (!playlistMapping) {
      throw new StoreError(400, `Missing file mapping for ${playlistPath}`);
    }
    const url = (playlistMapping.retrievalUrl || "").trim();
    if (!url) {
      throw new StoreError(500, `Missing retrievalUrl for ${playlistPath}`);
    }
    out.push(url);
  }
  return out.join("\n");
}

/**
 * @param {Map<string, PieceRecord>} piecesByCid
 * @param {FileMapping[]} fileMappings
 * @returns {Map<string, FileMapping>}
 */
function buildLiveMappingByPath(piecesByCid, fileMappings) {
  /** @type {Map<string, FileMapping>} */
  const out = new Map();
  for (const mapping of fileMappings) {
    const piece = piecesByCid.get(mapping.pieceCid);
    if (!piece || piece.abandoned) continue;
    out.set(mapping.path, mapping);
  }
  return out;
}

/**
 * Browser upload session (single active encode).
 */
export class BrowserFilstreamUploadSession {
  /**
   * @param {{
   *   rpcUrl: string,
   *   chainId: number,
   *   source: string,
   *   providerId: number,
   *   filstreamId: string,
   *   maxPieceBytes: number,
   * }} cfg
   * @param {{
   *   uploadId: string,
   *   assetId: string,
   *   clientAddress: string,
   *   synapse: import("@filoz/synapse-sdk").Synapse,
   *   context: import("@filoz/synapse-sdk/storage").StorageContext,
   *   dataSetId: number | null,
   * }} core
   */
  constructor(cfg, core) {
    this.cfg = cfg;
    this.uploadId = core.uploadId;
    this.assetId = core.assetId;
    this.clientAddress = core.clientAddress;
    this.filstreamId = cfg.filstreamId;
    this.providerId = cfg.providerId;
    this.dataSetId = core.dataSetId;
    this.synapse = core.synapse;
    this.context = core.context;
    /** @type {Promise<IDBDatabase>} */
    this._dbReady = openSegmentsDb(core.uploadId);
    /** @type {Map<string, VariantIdbBuffer>} */
    this.variantBuffers = new Map();
    /** @type {Map<string, { path: string, mimeType: string, data: Uint8Array }>} */
    this.textFiles = new Map();
    /** @type {Map<string, PieceRecord>} */
    this.piecesByCid = new Map();
    /** @type {FileMapping[]} */
    this.fileMappings = [];
    this.eventCounts = {
      segmentready: 0,
      segmentflush: 0,
      fileEvent: 0,
      transcodeComplete: 0,
      listingDetails: 0,
    };
    this.transcodeCompleteReceived = false;
    this.listingDetailsReceived = false;
    /** Staging path for listing JSON (`listingDetails`), default `meta.json`. */
    this.listingMetaPath = null;
    /**
     * Listing poster image bytes + path, uploaded as its own piece during finalize.
     *
     * @type {{ path: string, mimeType: string, data: Uint8Array } | null}
     */
    this.posterStagedFile = null;
    this.finalized = false;
    /** Concurrent `context.store()` calls (PDP piece uploads). */
    this._pdpUploadsInFlight = 0;
    /** @type {Map<string, number>} */
    this._variantAbandonBeforeSequence = new Map();
    /** @type {VariantPieceUploadJob[]} */
    this._variantUploadQueue = [];
    this._variantUploadsRunning = 0;
    /** @type {Error | null} */
    this._variantUploadFatalError = null;
    /** @type {UploadIdleWaiter[]} */
    this._variantUploadIdleWaiters = [];
    this.createdAt = new Date().toISOString();
    this.lastEventAt = new Date().toISOString();
    /**
     * Optional: invoked when PDP piece count, unpieced buffers, or upload in-flight count may have changed.
     * Assigned from `ui.mjs` for live pipeline counts during long `store()` calls.
     *
     * @type {(() => void) | null | undefined}
     */
    this.onStagingStateChanged = undefined;
  }

  _notifyStagingStateChanged() {
    const fn = this.onStagingStateChanged;
    if (typeof fn !== "function") return;
    try {
      fn();
    } catch {
      /* ignore */
    }
  }

  /**
   * @param {unknown} error
   * @returns {Error}
   */
  _toError(error) {
    if (error instanceof Error) return error;
    return new Error(String(error));
  }

  /**
   * @param {unknown} error
   */
  _setVariantUploadFatalError(error) {
    if (this._variantUploadFatalError) return;
    this._variantUploadFatalError = this._toError(error);
    this._variantUploadQueue = [];
    const waiters = this._variantUploadIdleWaiters.splice(0);
    for (const waiter of waiters) {
      try {
        waiter.reject(this._variantUploadFatalError);
      } catch {
        /* ignore */
      }
    }
    this._notifyStagingStateChanged();
  }

  /** Throws if any background variant upload failed. */
  _throwIfVariantUploadFailed() {
    if (this._variantUploadFatalError) {
      throw this._variantUploadFatalError;
    }
  }

  /** Resolves finalize waiters when the background variant-upload queue is fully drained. */
  _resolveVariantUploadIdleWaiters() {
    if (this._variantUploadQueue.length > 0) return;
    if (this._variantUploadsRunning > 0) return;
    const waiters = this._variantUploadIdleWaiters.splice(0);
    for (const waiter of waiters) {
      try {
        waiter.resolve();
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * @param {string} variant
   * @param {number} sequenceCutoff
   */
  _markVariantAbandonBefore(variant, sequenceCutoff) {
    const prev = this._variantAbandonBeforeSequence.get(variant) ?? 0;
    if (sequenceCutoff > prev) {
      this._variantAbandonBeforeSequence.set(variant, sequenceCutoff);
    }
  }

  /**
   * @param {string} variant
   * @param {number} sequence
   * @returns {boolean}
   */
  _isVariantSequenceAbandoned(variant, sequence) {
    const cutoff = this._variantAbandonBeforeSequence.get(variant);
    return typeof cutoff === "number" && sequence < cutoff;
  }

  /**
   * @param {VariantPieceUploadJob} job
   */
  _queueVariantPieceUpload(job) {
    this._throwIfVariantUploadFailed();
    this._variantUploadQueue.push(job);
    this._notifyStagingStateChanged();
    this._pumpVariantUploadQueue();
  }

  /** Starts queued variant uploads up to `MAX_PARALLEL_PDP_UPLOADS` concurrent workers. */
  _pumpVariantUploadQueue() {
    while (
      this._variantUploadsRunning < MAX_PARALLEL_PDP_UPLOADS &&
      this._variantUploadQueue.length > 0 &&
      !this._variantUploadFatalError
    ) {
      const job = this._variantUploadQueue.shift();
      if (!job) break;
      this._variantUploadsRunning += 1;
      this._notifyStagingStateChanged();
      void this
        ._runVariantPieceUploadJob(job)
        .catch((error) => {
          this._setVariantUploadFatalError(error);
        })
        .finally(() => {
          this._variantUploadsRunning -= 1;
          this._resolveVariantUploadIdleWaiters();
          this._notifyStagingStateChanged();
          this._pumpVariantUploadQueue();
        });
    }
  }

  /** Waits until no queued or in-flight background variant uploads remain. */
  async _waitForVariantUploadsIdle() {
    this._throwIfVariantUploadFailed();
    if (this._variantUploadQueue.length === 0 && this._variantUploadsRunning === 0) {
      return;
    }
    await new Promise((resolve, reject) => {
      this._variantUploadIdleWaiters.push({
        resolve,
        reject,
      });
    });
    this._throwIfVariantUploadFailed();
  }

  /**
   * @param {VariantPieceUploadJob} job
   */
  async _runVariantPieceUploadJob(job) {
    if (!this.context || typeof this.context.store !== "function") {
      throw new StoreError(500, "Storage context.store is unavailable");
    }
    const db = await this._dbReady;
    if (this._isVariantSequenceAbandoned(job.variant, job.sequence)) {
      await idbDeletePendingPiece(db, job.variant, job.sequence, job.segmentCount);
      this._notifyStagingStateChanged();
      return;
    }
    const stream = createIdbPieceReadableStream(db, job.variant, job.sequence, job.segmentCount);

    this._pdpUploadsInFlight += 1;
    this._notifyStagingStateChanged();
    let storeResult;
    try {
      storeResult = await this.context.store(stream);
    } finally {
      this._pdpUploadsInFlight -= 1;
      this._notifyStagingStateChanged();
    }
    const pieceRef = storeResult?.pieceCid;
    if (!pieceRef) {
      throw new StoreError(500, "store() response is missing pieceCid");
    }
    const pieceCid = String(pieceRef);
    const retrievalUrl = await getPieceRetrievalUrl(this.context, pieceRef);
    const byteLength =
      typeof storeResult?.size === "number" ? storeResult.size : job.byteLength;
    const abandoned = this._isVariantSequenceAbandoned(job.variant, job.sequence);
    /** @type {PieceRecord} */
    const piece = {
      pieceRef,
      pieceCid,
      retrievalUrl,
      byteLength,
      pieceMetadata: job.pieceMetadata,
      committed: false,
      abandoned,
      variant: job.variant,
      sequence: job.sequence,
      storedAt: new Date().toISOString(),
    };
    this.piecesByCid.set(piece.pieceCid, piece);
    for (const entry of job.entries) {
      this.fileMappings.push({
        path: entry.path,
        mimeType: entry.mimeType,
        pieceCid: piece.pieceCid,
        retrievalUrl: piece.retrievalUrl,
        offset: entry.offset,
        length: entry.length,
        variant: job.variant,
        sequence: job.sequence,
        segmentIndex: entry.segmentIndex,
      });
    }
    this._notifyStagingStateChanged();
  }

  /**
   * @param {string} variant
   * @returns {VariantIdbBuffer}
   */
  getVariantBuffer(variant) {
    let found = this.variantBuffers.get(variant);
    if (!found) {
      found = newVariantBuffer(variant);
      this.variantBuffers.set(variant, found);
    }
    return found;
  }

  /**
   * Live stats for upload UI. `pathCount` grows when a PDP piece is flushed (one path per init/segment
   * file inside that piece—not the same as piece count). `pendingSegments` updates every segmentready.
   *
   * @returns {{
   *   pieceCount: number,
   *   pathCount: number,
   *   pendingSegments: number,
   *   bufferingBytes: number,
   *   bufferingBytesMax: number,
   *   flushGoalForLargestBytes: number,
   *   pendingRungFlushes: number,
   *   pdpUploadsInFlight: number,
   *   pdpUploadsQueued: number,
   *   unpiecedBlobCount: number,
   * }}
   */
  getStagingSummary() {
    let pendingSegments = 0;
    let bufferingBytesTotal = 0;
    let bufferingBytesMax = 0;
    let flushGoalForLargest = this.cfg.maxPieceBytes;
    let pendingRungFlushes = 0;
    let unpiecedBlobCount = 0;
    for (const b of this.variantBuffers.values()) {
      pendingSegments += b.pendingOrd;
      bufferingBytesTotal += b.size;
      if (b.size > 0 || b.pendingOrd > 0) {
        unpiecedBlobCount += 1;
      }
      if (b.size > bufferingBytesMax) {
        bufferingBytesMax = b.size;
        flushGoalForLargest = this.cfg.maxPieceBytes;
      }
      if (b.size >= SYNAPSE_MIN_PIECE_BYTES) {
        pendingRungFlushes += 1;
      }
    }
    let pieceCount = 0;
    for (const p of this.piecesByCid.values()) {
      if (!p.abandoned) {
        pieceCount += 1;
      }
    }
    return {
      pieceCount,
      pathCount: this.fileMappings.length,
      pendingSegments,
      bufferingBytes: bufferingBytesTotal,
      bufferingBytesMax,
      flushGoalForLargestBytes: flushGoalForLargest,
      pendingRungFlushes,
      pdpUploadsInFlight: this._pdpUploadsInFlight,
      pdpUploadsQueued: this._variantUploadQueue.length,
      unpiecedBlobCount,
    };
  }

  /**
   * Flush every rung buffer that has enough bytes for one PDP piece (used when encode ends so
   * partial batches are not stuck below per-rung max size).
   */
  async flushAllVariantBuffersMinSize() {
    for (const buffer of this.variantBuffers.values()) {
      if (buffer.size >= SYNAPSE_MIN_PIECE_BYTES) {
        await this.flushVariantBuffer(buffer);
      }
    }
  }

  /**
   * After encode, flush partial per-rung batches (&lt; maxPieceBytes) so work is not stranded.
   * Also used when `transcodeComplete` was processed before the last `segmentready` reached the store.
   */
  async flushTailBuffersAfterTranscode() {
    if (!this.transcodeCompleteReceived) return;
    for (const buffer of [...this.variantBuffers.values()]) {
      if (buffer.size < SYNAPSE_MIN_PIECE_BYTES) continue;
      const maxBatch = this.cfg.maxPieceBytes;
      if (buffer.size < maxBatch) {
        await this.flushVariantBuffer(buffer);
      }
    }
  }

  /**
   * @param {{
   *   bytes: Uint8Array,
   *   pieceMetadata: Record<string, string>,
   *   variant: string,
   *   sequence: number | null,
   *   abandoned?: boolean,
   * }} input
   * @returns {Promise<PieceRecord>}
   */
  async storePieceBytes(input) {
    const session = this;
    if (!session.context || typeof session.context.store !== "function") {
      throw new StoreError(500, "Storage context.store is unavailable");
    }
    if (input.bytes.byteLength < SYNAPSE_MIN_PIECE_BYTES) {
      throw new StoreError(
        400,
        `Piece payload too small for Synapse store() (${input.bytes.byteLength} bytes, min ${SYNAPSE_MIN_PIECE_BYTES})`,
      );
    }
    if (input.bytes.byteLength > SYNAPSE_MAX_PIECE_BYTES) {
      throw new StoreError(
        400,
        `Piece payload too large for Synapse store() (${input.bytes.byteLength} bytes, max ${SYNAPSE_MAX_PIECE_BYTES})`,
      );
    }
    session._pdpUploadsInFlight += 1;
    session._notifyStagingStateChanged();
    let storeResult;
    try {
      storeResult = await session.context.store(input.bytes);
    } finally {
      session._pdpUploadsInFlight -= 1;
      session._notifyStagingStateChanged();
    }
    const pieceRef = storeResult?.pieceCid;
    if (!pieceRef) {
      throw new StoreError(500, "store() response is missing pieceCid");
    }
    const pieceCid = String(pieceRef);
    const retrievalUrl = await getPieceRetrievalUrl(session.context, pieceRef);
    const byteLength =
      typeof storeResult?.size === "number" ? storeResult.size : input.bytes.byteLength;
    /** @type {PieceRecord} */
    const record = {
      pieceRef,
      pieceCid,
      retrievalUrl,
      byteLength,
      pieceMetadata: input.pieceMetadata,
      committed: false,
      abandoned: input.abandoned === true,
      variant: input.variant,
      sequence: input.sequence,
      storedAt: new Date().toISOString(),
    };
    session.piecesByCid.set(record.pieceCid, record);
    session._notifyStagingStateChanged();
    return record;
  }

  /**
   * @param {VariantIdbBuffer} buffer
   */
  async flushVariantBuffer(buffer) {
    this._throwIfVariantUploadFailed();
    if (buffer.size === 0) return;
    if (buffer.size < SYNAPSE_MIN_PIECE_BYTES) {
      throw new StoreError(
        400,
        `Piece payload too small for Synapse store() (${buffer.size} bytes, min ${SYNAPSE_MIN_PIECE_BYTES})`,
      );
    }
    if (buffer.size > SYNAPSE_MAX_PIECE_BYTES) {
      throw new StoreError(
        400,
        `Piece payload too large for Synapse store() (${buffer.size} bytes, max ${SYNAPSE_MAX_PIECE_BYTES})`,
      );
    }
    if (buffer.pendingOrd <= 0 || buffer.entries.length === 0) {
      throw new StoreError(500, "Variant buffer flush requested with no pending entries");
    }

    const metadata = variantPieceMetadata(
      this.assetId,
      buffer.variant,
      buffer.sequence,
      buffer.segmentStart,
      buffer.segmentEnd,
    );
    /** @type {VariantPieceUploadJob} */
    const job = {
      variant: buffer.variant,
      sequence: buffer.sequence,
      segmentCount: buffer.pendingOrd,
      byteLength: buffer.size,
      pieceMetadata: metadata,
      entries: buffer.entries.map((entry) => ({
        path: entry.path,
        mimeType: entry.mimeType,
        offset: entry.offset,
        length: entry.length,
        segmentIndex: entry.segmentIndex,
      })),
    };
    buffer.sequence += 1;
    buffer.pendingOrd = 0;
    buffer.entries = [];
    buffer.size = 0;
    buffer.segmentStart = null;
    buffer.segmentEnd = null;
    this._notifyStagingStateChanged();
    this._queueVariantPieceUpload(job);
  }

  /**
   * @param {unknown} detail
   */
  async handleSegmentReady(detail) {
    const variant = variantKeyFromDetail(detail);
    const d = /** @type {Record<string, unknown>} */ (detail);
    const kind =
      typeof d.kind === "string" && d.kind.trim() !== "" ? d.kind.trim() : "";
    if (kind !== "init" && kind !== "media") {
      throw new StoreError(400, "segmentready.kind must be 'init' or 'media'");
    }
    const segmentIndex = kind === "media" ? parseSegmentIndex(detail) : null;
    const bytes = parseEventBytes(detail);
    const path =
      kind === "init" ? `${variant}/init.mp4` : `${variant}/seg-${segmentIndex}.m4s`;
    const buffer = this.getVariantBuffer(variant);
    if (
      buffer.size >= SYNAPSE_MIN_PIECE_BYTES &&
      buffer.size + bytes.byteLength > this.cfg.maxPieceBytes
    ) {
      await this.flushVariantBuffer(buffer);
    }
    const offset = buffer.size;
    const ord = buffer.pendingOrd;
    buffer.pendingOrd += 1;
    buffer.size += bytes.byteLength;
    buffer.entries.push({
      path,
      mimeType: "video/mp4",
      offset,
      length: bytes.byteLength,
      segmentIndex,
    });
    if (segmentIndex != null) {
      if (buffer.segmentStart == null || segmentIndex < buffer.segmentStart) {
        buffer.segmentStart = segmentIndex;
      }
      if (buffer.segmentEnd == null || segmentIndex > buffer.segmentEnd) {
        buffer.segmentEnd = segmentIndex;
      }
    }
    const db = await this._dbReady;
    const key = segmentKey(variant, buffer.sequence, ord);
    try {
      await idbPutSegment(db, key, bytes);
    } catch (e) {
      buffer.pendingOrd -= 1;
      buffer.size -= bytes.byteLength;
      buffer.entries.pop();
      throw new StoreError(
        507,
        "IndexedDB write failed (quota or storage unavailable)",
        e instanceof Error ? e.message : String(e),
      );
    }
    this._notifyStagingStateChanged();
    if (buffer.size >= this.cfg.maxPieceBytes) {
      await this.flushVariantBuffer(buffer);
    }
    if (this.transcodeCompleteReceived) {
      await this.flushTailBuffersAfterTranscode();
    }
  }

  /**
   * @param {unknown} detail
   */
  async handleSegmentFlush(detail) {
    const variant = variantKeyFromDetail(detail);
    const buffer = this.getVariantBuffer(variant);
    const db = await this._dbReady;
    this._markVariantAbandonBefore(variant, buffer.sequence);
    if (buffer.pendingOrd > 0) {
      await idbDeletePendingPiece(db, buffer.variant, buffer.sequence, buffer.pendingOrd);
    }
    buffer.pendingOrd = 0;
    buffer.entries = [];
    buffer.size = 0;
    buffer.segmentStart = null;
    buffer.segmentEnd = null;
    for (const piece of this.piecesByCid.values()) {
      if (!piece.committed && piece.variant === variant) {
        piece.abandoned = true;
      }
    }
    this._notifyStagingStateChanged();
  }

  /**
   * @param {unknown} detail
   */
  async handleFileEvent(detail) {
    if (!detail || typeof detail !== "object") {
      throw new StoreError(400, "fileEvent detail must be an object");
    }
    const d = /** @type {Record<string, unknown>} */ (detail);
    const filePath =
      typeof d.path === "string" && d.path.trim() !== "" ? d.path.trim() : "";
    if (!filePath) {
      throw new StoreError(400, "fileEvent.path is required");
    }
    const mimeType =
      typeof d.mimeType === "string" && d.mimeType.trim() !== ""
        ? d.mimeType.trim()
        : defaultMimeForPath(filePath);
    const bytes = parseEventBytes(detail);
    this.textFiles.set(filePath, {
      path: filePath,
      mimeType,
      data: bytes,
    });
  }

  /**
   * @param {unknown} detail
   */
  async handleTranscodeComplete(detail) {
    this.transcodeCompleteReceived = true;
    if (detail && typeof detail === "object") {
      const d = /** @type {Record<string, unknown>} */ (detail);
      const enc = new TextEncoder();
      if (typeof d.masterAppM3U8Text === "string" && d.masterAppM3U8Text.trim() !== "") {
        this.textFiles.set("master-app.m3u8", {
          path: "master-app.m3u8",
          mimeType: "application/vnd.apple.mpegurl",
          data: enc.encode(d.masterAppM3U8Text),
        });
      }
      if (typeof d.rootM3U8Text === "string" && d.rootM3U8Text.trim() !== "") {
        this.textFiles.set("master-local.m3u8", {
          path: "master-local.m3u8",
          mimeType: "application/vnd.apple.mpegurl",
          data: enc.encode(d.rootM3U8Text),
        });
      }
    }
    await this.flushAllVariantBuffersMinSize();
  }

  /**
   * @param {unknown} detail
   */
  async handleListingDetails(detail) {
    this.listingDetailsReceived = true;
    this.posterStagedFile = null;
    if (!detail || typeof detail !== "object") return;
    const d = /** @type {Record<string, unknown>} */ (detail);
    const metaPath =
      typeof d.metaPath === "string" && d.metaPath.trim() !== ""
        ? d.metaPath.trim()
        : "meta.json";
    this.listingMetaPath = metaPath;
    if (typeof d.metaJsonText === "string" && d.metaJsonText.trim() !== "") {
      this.textFiles.set(metaPath, {
        path: metaPath,
        mimeType: "application/json",
        data: new TextEncoder().encode(d.metaJsonText),
      });
    }
    const pb = d.posterBytes;
    if (pb instanceof Uint8Array && pb.byteLength > 0) {
      const rawName =
        typeof d.posterFileName === "string" && d.posterFileName.trim() !== ""
          ? d.posterFileName.trim()
          : "poster.png";
      const path = sanitizePosterPath(rawName);
      const mime =
        typeof d.posterMimeType === "string" && d.posterMimeType.trim() !== ""
          ? d.posterMimeType.trim()
          : defaultMimeForPath(path);
      this.posterStagedFile = {
        path,
        mimeType: mime,
        data: pb,
      };
    }
  }

  /**
   * @param {string} type
   * @param {unknown} detail
   */
  async ingestEvent(type, detail) {
    if (this.finalized) {
      throw new StoreError(409, "Upload is already finalized");
    }
    this._throwIfVariantUploadFailed();
    const t = (type || "").trim();
    if (t === "segmentready") {
      await this.handleSegmentReady(detail);
    } else if (t === "segmentflush") {
      await this.handleSegmentFlush(detail);
    } else if (t === "fileEvent") {
      await this.handleFileEvent(detail);
    } else if (t === "transcodeComplete") {
      await this.handleTranscodeComplete(detail);
    } else if (t === "listingDetails") {
      await this.handleListingDetails(detail);
    } else {
      throw new StoreError(400, `Unsupported event type: ${t}`);
    }
    if (t in this.eventCounts) {
      const key = /** @type {keyof typeof this.eventCounts} */ (t);
      this.eventCounts[key] += 1;
    }
    this.lastEventAt = new Date().toISOString();
  }

  /**
   * @param {{ path: string, mimeType: string, data: Uint8Array }} file
   */
  async storeStagedFile(file) {
    const metadata = filePieceMetadata(this.assetId, file.path);
    const piece = await this.storePieceBytes({
      bytes: file.data,
      pieceMetadata: metadata,
      variant: metadata.FS_VAR || "root",
      sequence: null,
    });
    this.fileMappings.push({
      path: file.path,
      mimeType: file.mimeType,
      pieceCid: piece.pieceCid,
      retrievalUrl: piece.retrievalUrl,
      offset: 0,
      length: file.data.byteLength,
      variant: metadata.FS_VAR || "root",
      sequence: null,
      segmentIndex: null,
    });
  }

  rewriteVariantPlaylists() {
    const encoder = new TextEncoder();
    const mappingsByPath = buildLiveMappingByPath(this.piecesByCid, this.fileMappings);
    for (const [path, file] of this.textFiles.entries()) {
      if (!VARIANT_PLAYLIST_APP_RE.test(path)) continue;
      const variant = parseVariantFromPath(path);
      if (!variant) {
        throw new StoreError(400, `Invalid variant playlist path: ${path}`);
      }
      const current = new TextDecoder().decode(file.data);
      const rewritten = rewriteVariantPlaylist(variant, current, mappingsByPath);
      this.textFiles.set(path, {
        path: file.path,
        mimeType: file.mimeType,
        data: encoder.encode(rewritten),
      });
    }
  }

  rewriteMasterPlaylistFile() {
    const master = this.textFiles.get("master-app.m3u8");
    if (!master) return;
    const mappingsByPath = buildLiveMappingByPath(this.piecesByCid, this.fileMappings);
    const current = new TextDecoder().decode(master.data);
    const rewritten = rewriteMasterPlaylistText(current, mappingsByPath);
    this.textFiles.set(master.path, {
      path: master.path,
      mimeType: master.mimeType,
      data: new TextEncoder().encode(rewritten),
    });
  }

  buildManifest() {
    const livePieces = [...this.piecesByCid.values()].filter((p) => !p.abandoned);
    const livePieceSet = new Set(livePieces.map((p) => p.pieceCid));
    const files = this.fileMappings.filter((f) => livePieceSet.has(f.pieceCid));
    const playback = extractPlaybackUrls(files, this.posterStagedFile?.path ?? null);
    /** @type {Record<string, string>} */
    const playbackOut = {};
    if (playback.masterAppUrl) playbackOut.masterAppUrl = playback.masterAppUrl;
    if (playback.manifestUrl) playbackOut.manifestUrl = playback.manifestUrl;
    if (playback.metaJsonUrl) playbackOut.metaJsonUrl = playback.metaJsonUrl;
    if (playback.posterUrl) playbackOut.posterUrl = playback.posterUrl;
    if (playback.catalogJsonUrl) playbackOut.catalogJsonUrl = playback.catalogJsonUrl;
    return {
      version: 1,
      createdAt: new Date().toISOString(),
      assetId: this.assetId,
      filstreamId: this.filstreamId,
      clientAddress: this.clientAddress,
      providerId: this.providerId,
      dataSetId: this.dataSetId,
      playback: playbackOut,
      eventCounts: { ...this.eventCounts },
      transcodeCompleteReceived: this.transcodeCompleteReceived,
      listingDetailsReceived: this.listingDetailsReceived,
      pieces: livePieces.map((p) => ({
        pieceCid: p.pieceCid,
        retrievalUrl: p.retrievalUrl,
        byteLength: p.byteLength,
        pieceMetadata: p.pieceMetadata,
        committed: p.committed,
        variant: p.variant,
        sequence: p.sequence,
      })),
      files: files.map((f) => ({
        path: f.path,
        mimeType: f.mimeType,
        pieceCid: f.pieceCid,
        retrievalUrl: f.retrievalUrl,
        offset: f.offset,
        length: f.length,
        variant: f.variant,
        sequence: f.sequence,
        segmentIndex: f.segmentIndex,
      })),
    };
  }

  async commitPendingPieces() {
    this._throwIfVariantUploadFailed();
    if (!this.context || typeof this.context.commit !== "function") {
      throw new StoreError(500, "Storage context.commit is unavailable");
    }
    const pending = [...this.piecesByCid.values()].filter(
      (p) => !p.committed && !p.abandoned,
    );
    if (pending.length === 0) {
      return {
        committedCount: 0,
        transactionHash: null,
        dataSetId: this.dataSetId,
      };
    }
    let idx = 0;
    let committedCount = 0;
    /** @type {string | null} */
    let transactionHash = null;
    let targetBatchSize =
      this.dataSetId == null ? 1 : Math.min(MAX_COMMIT_BATCH_PIECES, pending.length);

    while (idx < pending.length) {
      let currentBatchSize = Math.min(targetBatchSize, pending.length - idx);
      for (;;) {
        const batch = pending.slice(idx, idx + currentBatchSize);
        try {
          const result = await this.context.commit({
            pieces: batch.map((p) => ({
              pieceCid: p.pieceRef,
              pieceMetadata: p.pieceMetadata,
            })),
          });
          for (const p of batch) {
            p.committed = true;
          }
          committedCount += batch.length;
          idx += batch.length;

          const txHash = typeof result?.txHash === "string" ? result.txHash : null;
          if (txHash) {
            transactionHash = txHash;
          }
          const committedDataSetId = parseSafeNonNegativeInt(result?.dataSetId);
          if (result?.dataSetId != null && committedDataSetId == null) {
            throw new StoreError(500, "commit() returned invalid dataSetId");
          }
          if (committedDataSetId != null) {
            this.dataSetId = committedDataSetId;
          }
          break;
        } catch (error) {
          if (isExtraDataTooLargeError(error) && currentBatchSize > 1) {
            currentBatchSize = Math.max(1, Math.floor(currentBatchSize / 2));
            continue;
          }
          throw error;
        }
      }

      targetBatchSize =
        this.dataSetId == null
          ? 1
          : Math.min(MAX_COMMIT_BATCH_PIECES, pending.length - idx);
    }

    return {
      committedCount,
      transactionHash,
      dataSetId: this.dataSetId,
    };
  }

  /**
   * @returns {Promise<{
   *   finalized: boolean,
   *   committedCount: number,
   *   transactionHash: string | null,
   *   masterAppUrl: string | null,
   *   manifestUrl: string | null,
   *   metaJsonUrl: string | null,
   *   posterUrl: string | null,
   *   catalogJsonUrl: string | null,
   *   dataSetId: number | null,
   *   catalogVersion: number | null,
   *   catalogPieceCid: string | null,
   * }>}
   */
  async finalizeUpload() {
    this._throwIfVariantUploadFailed();
    if (this.finalized) {
      throw new StoreError(409, "Upload is already finalized");
    }
    for (const buffer of this.variantBuffers.values()) {
      await this.flushVariantBuffer(buffer);
    }
    await this._waitForVariantUploadsIdle();
    this._throwIfVariantUploadFailed();
    this.rewriteVariantPlaylists();
    const variantPlaylists = [...this.textFiles.values()].filter((f) =>
      VARIANT_PLAYLIST_APP_RE.test(f.path),
    );
    await Promise.all(variantPlaylists.map((file) => this.storeStagedFile(file)));
    this.rewriteMasterPlaylistFile();
    const master = this.textFiles.get("master-app.m3u8");
    if (master) {
      await this.storeStagedFile(master);
    }
    if (this.posterStagedFile) {
      await this.storeStagedFile(this.posterStagedFile);
    }
    const manifestDraft = this.buildManifest();
    const manifestDraftText = JSON.stringify(manifestDraft, null, 2);
    await this.storeStagedFile({
      path: "manifest.json",
      mimeType: "application/json",
      data: new TextEncoder().encode(manifestDraftText),
    });

    const liveForMetaUrls = this.fileMappings.filter((f) => {
      const p = this.piecesByCid.get(f.pieceCid);
      return p != null && !p.abandoned;
    });
    const urlsForMeta = extractPlaybackUrls(
      liveForMetaUrls,
      this.posterStagedFile?.path ?? null,
    );
    const publishedMeta = buildPublishedMetaDocument(this, urlsForMeta);
    const metaBytes = encodeJsonWithMinPiecePadding(publishedMeta);
    this.textFiles.set("meta.json", {
      path: "meta.json",
      mimeType: "application/json",
      data: metaBytes,
    });
    await this.storeStagedFile({
      path: "meta.json",
      mimeType: "application/json",
      data: metaBytes,
    });

    abandonUncommittedStagingByPath(this, "manifest.json");

    const manifestFinal = this.buildManifest();
    const manifestFinalText = JSON.stringify(manifestFinal, null, 2);
    await this.storeStagedFile({
      path: "manifest.json",
      mimeType: "application/json",
      data: new TextEncoder().encode(manifestFinalText),
    });

    /** @type {{ catalogVersion: number | null, catalogPieceCid: string | null }} */
    let catalogOut = { catalogVersion: null, catalogPieceCid: null };
    try {
      catalogOut = await appendFilstreamCatalogPiece(this);
    } catch (e) {
      console.warn("[filstream] catalog append failed", e);
    }
    const commit = await this.commitPendingPieces();
    this.finalized = true;
    const liveFiles = this.fileMappings.filter((f) => {
      const p = this.piecesByCid.get(f.pieceCid);
      return p != null && !p.abandoned;
    });
    const playback = extractPlaybackUrls(liveFiles, this.posterStagedFile?.path ?? null);
    return {
      finalized: true,
      committedCount: commit.committedCount,
      transactionHash: commit.transactionHash,
      masterAppUrl: playback.masterAppUrl,
      manifestUrl: playback.manifestUrl,
      metaJsonUrl: playback.metaJsonUrl,
      posterUrl: playback.posterUrl,
      catalogJsonUrl: playback.catalogJsonUrl,
      dataSetId: this.dataSetId,
      catalogVersion: catalogOut.catalogVersion,
      catalogPieceCid: catalogOut.catalogPieceCid,
    };
  }

  async deleteUploadDatabase() {
    const name = `filstream-upload-${this.uploadId}`;
    await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(name);
      req.onerror = () => reject(req.error ?? new Error("deleteDatabase failed"));
      req.onsuccess = () => resolve();
      req.onblocked = () => resolve();
    });
  }
}

/**
 * @param {{ assetId: string, clientAddress: string, sessionPrivateKey: string, sessionExpirations: Record<string, string | number | bigint> }} input
 * @returns {Promise<BrowserFilstreamUploadSession>}
 */
export async function createBrowserUploadSession(input) {
  const cfgFlat = getFilstreamStoreConfig();
  const filstreamId = ensureFilstreamId(cfgFlat);
  if (
    !cfgFlat.storeRpcUrl ||
    !cfgFlat.storeChainId ||
    cfgFlat.storeChainId <= 0 ||
    !cfgFlat.storeProviderId ||
    cfgFlat.storeProviderId <= 0
  ) {
    throw new StoreError(
      500,
      "Invalid FilStream upload config (storeRpcUrl, storeChainId, storeProviderId)",
      "Override window.__FILSTREAM_CONFIG__ or edit defaults in filstream-config.mjs",
    );
  }
  const synCfg = {
    rpcUrl: cfgFlat.storeRpcUrl,
    chainId: cfgFlat.storeChainId,
    source: cfgFlat.storeSource,
  };
  const { assetId, clientAddress, sessionPrivateKey, sessionExpirations } = input;
  if (!assetId || !clientAddress || !sessionPrivateKey || !sessionExpirations) {
    throw new StoreError(
      400,
      "assetId, clientAddress, sessionPrivateKey, sessionExpirations are required",
    );
  }
  const synapse = await createSynapseForSession(
    synCfg,
    clientAddress,
    sessionPrivateKey,
    sessionExpirations,
  );
  const resolved = await resolveOrCreateDataSet({
    synapse,
    providerId: cfgFlat.storeProviderId,
    clientAddress,
    filstreamId,
  });
  const uploadId =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `u_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const session = new BrowserFilstreamUploadSession(
    {
      rpcUrl: synCfg.rpcUrl,
      chainId: synCfg.chainId,
      source: synCfg.source,
      providerId: cfgFlat.storeProviderId,
      filstreamId,
      maxPieceBytes: Math.min(cfgFlat.storeMaxPieceBytes, SYNAPSE_MAX_PIECE_BYTES),
    },
    {
      uploadId,
      assetId,
      clientAddress,
      synapse,
      context: resolved.context,
      dataSetId: resolved.dataSetId,
    },
  );
  return {
    session,
    uploadId: session.uploadId,
    dataSetId: resolved.dataSetId,
    providerId: cfgFlat.storeProviderId,
    filstreamId,
    createdDataSet: resolved.created,
  };
}
