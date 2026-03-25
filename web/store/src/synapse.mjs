import { Synapse } from "@filoz/synapse-sdk";
import { getChain } from "@filoz/synapse-sdk";
import { DefaultFwssPermissions, fromSecp256k1 } from "@filoz/synapse-core/session-key";
import { getAddress, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { HttpError } from "./errors.mjs";

/**
 * @typedef {import("@filoz/synapse-sdk").Synapse} SynapseClient
 * @typedef {import("@filoz/synapse-sdk/storage").StorageManager} StorageManager
 * @typedef {import("@filoz/synapse-sdk/storage").StorageContext} StorageContext
 * @typedef {import("@filoz/synapse-sdk").EnhancedDataSetInfo} EnhancedDataSetInfo
 * @typedef {import("@filoz/synapse-sdk").StoreResult} StoreResult
 * @typedef {import("@filoz/synapse-core/session-key").Expirations} SessionExpirations
 * @typedef {EnhancedDataSetInfo & { createdAt?: string | number | bigint }} DataSetCandidate
 */

/**
 * Parse an integer-like value into a non-negative safe integer.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
function parseSafeNonNegativeInt(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return n;
}

/**
 * Parse one session permission expiration value into bigint.
 *
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
      throw new HttpError(400, `Invalid ${fieldName}`);
    }
  }
  throw new HttpError(400, `Missing ${fieldName}`);
}

/**
 * Parse frontend-provided session expirations for required FWSS permissions.
 *
 * @param {unknown} raw
 * @returns {SessionExpirations}
 */
function parseSessionExpirations(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HttpError(400, "Missing sessionExpirations");
  }
  const src = /** @type {Record<string, unknown>} */ (raw);
  /** @type {SessionExpirations} */
  const out = {};
  for (const permission of DefaultFwssPermissions) {
    out[permission] = parseExpirationBigInt(
      src[permission],
      `sessionExpirations[${permission}]`,
    );
  }
  return out;
}

/**
 * Build a strict `Synapse.create(...)` options object from validated runtime inputs.
 *
 * @param {{ rpcUrl: string, chainId: number, source: string }} cfg
 * @param {string} rootAddress
 * @param {string} sessionPrivateKey
 * @param {SessionExpirations} sessionExpirations
 * @returns {{
 *   account: string,
 *   transport: ReturnType<typeof http>,
 *   chain: ReturnType<typeof getChain>,
 *   source: string,
 *   sessionKey: ReturnType<typeof fromSecp256k1>,
 * }}
 */
function buildSynapseInitOptions(cfg, rootAddress, sessionPrivateKey, sessionExpirations) {
  const chain = getChain(cfg.chainId);
  const transport = http(cfg.rpcUrl);
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
 * Create a signer-bound Synapse client for one upload session.
 *
 * @param {{ rpcUrl: string, chainId: number, source: string }} cfg
 * @param {string} clientAddress
 * @param {string} sessionPrivateKey
 * @param {unknown} sessionExpirationsInput
 * @returns {Promise<SynapseClient>}
 */
export async function createSynapseForSession(
  cfg,
  clientAddress,
  sessionPrivateKey,
  sessionExpirationsInput,
) {
  if (typeof clientAddress !== "string" || clientAddress.trim() === "") {
    throw new HttpError(400, "Missing clientAddress");
  }
  if (typeof sessionPrivateKey !== "string" || sessionPrivateKey.trim() === "") {
    throw new HttpError(400, "Missing sessionPrivateKey");
  }
  const normalized =
    sessionPrivateKey.startsWith("0x") || sessionPrivateKey.startsWith("0X")
      ? sessionPrivateKey
      : `0x${sessionPrivateKey}`;
  const sessionExpirations = parseSessionExpirations(sessionExpirationsInput);
  try {
    // Validate private key format early to return a clear 400-style failure.
    privateKeyToAccount(normalized);
  } catch {
    throw new HttpError(400, "Invalid sessionPrivateKey");
  }
  if (!cfg || typeof cfg !== "object") {
    throw new HttpError(500, "Invalid store configuration");
  }
  if (typeof cfg.rpcUrl !== "string" || cfg.rpcUrl.trim() === "") {
    throw new HttpError(500, "Missing cfg.rpcUrl");
  }
  if (typeof cfg.source !== "string" || cfg.source.trim() === "") {
    throw new HttpError(500, "Missing cfg.source");
  }
  if (
    !Number.isFinite(cfg.chainId) ||
    !Number.isInteger(cfg.chainId) ||
    cfg.chainId <= 0
  ) {
    throw new HttpError(500, "Missing or invalid cfg.chainId");
  }
  let rootAddress = "";
  try {
    rootAddress = getAddress(clientAddress);
  } catch {
    throw new HttpError(400, "Invalid clientAddress");
  }
  try {
    const options = buildSynapseInitOptions(
      cfg,
      rootAddress,
      normalized,
      sessionExpirations,
    );
    return Synapse.create(options);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("Session key does not have the required permissions")
    ) {
      throw new HttpError(
        403,
        "Session key missing required permissions",
        "Run session-key login/authorization before calling init",
      );
    }
    throw new HttpError(
      500,
      "Failed to initialize Synapse client with provided session key",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Convert unknown dataset list response into a flat list.
 *
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
 * Normalize a potential dataset metadata object into string pairs.
 *
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
 * Extract provider id from a dataset-ish object.
 *
 * @param {DataSetCandidate} raw
 * @returns {number | null}
 */
function extractProviderId(raw) {
  return parseSafeNonNegativeInt(raw.providerId);
}

/**
 * Extract dataset id from a dataset-ish object.
 *
 * @param {DataSetCandidate} raw
 * @returns {number | null}
 */
function extractDataSetId(raw) {
  return parseSafeNonNegativeInt(raw.dataSetId);
}

/**
 * Extract creation timestamp from dataset-ish object.
 *
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
      // Accept both seconds and milliseconds.
      return asNum < 10_000_000_000 ? asNum * 1000 : asNum;
    }
  }
  return null;
}

/**
 * Ask the storage manager for all datasets owned by one client address.
 *
 * @param {StorageManager} storage
 * @param {string} clientAddress
 * @returns {Promise<DataSetCandidate[]>}
 */
async function findDataSetsByAddress(storage, clientAddress) {
  if (!storage || typeof storage.findDataSets !== "function") {
    throw new HttpError(500, "Synapse storage.findDataSets is unavailable");
  }
  const raw = await storage.findDataSets({ address: clientAddress });
  return normalizeDataSetList(raw);
}

/**
 * Pick the canonical dataset for one client/provider/FILSTREAM-ID tuple.
 * Selection policy: oldest dataset wins.
 *
 * @param {DataSetCandidate[]} datasets
 * @param {number} providerId
 * @param {string} filstreamId
 * @returns {{ dataSetId: number, raw: DataSetCandidate } | null}
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
 * Create a storage context for an existing dataset id.
 *
 * @param {StorageManager} storage
 * @param {number} providerId
 * @param {number} dataSetId
 * @returns {Promise<StorageContext>}
 */
async function createExistingDataSetContext(storage, providerId, dataSetId) {
  return storage.createContext({
    providerId: BigInt(providerId),
    dataSetId: BigInt(dataSetId),
  });
}

/**
 * Create a context that can create a new dataset with FILSTREAM-ID metadata.
 *
 * @param {StorageManager} storage
 * @param {number} providerId
 * @param {string} filstreamId
 * @returns {Promise<StorageContext>}
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
 * Resolve existing dataset (oldest match) or create one if missing.
 *
 * @param {{
 *   synapse: SynapseClient,
 *   providerId: number,
 *   clientAddress: string,
 *   filstreamId: string,
 * }} input
 * @returns {Promise<{ context: StorageContext, dataSetId: number, created: boolean }>}
 */
export async function resolveOrCreateDataSet(input) {
  const { synapse, providerId, clientAddress, filstreamId } = input;
  if (!synapse?.storage) {
    throw new HttpError(500, "Synapse storage manager is unavailable");
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

  await createNewDataSetContext(synapse.storage, providerId, filstreamId);

  const postCreate = pickMatchingDataSet(
    await findDataSetsByAddress(synapse.storage, clientAddress),
    providerId,
    filstreamId,
  );
  if (!postCreate) {
    throw new HttpError(
      500,
      "Dataset creation succeeded but dataset lookup failed",
    );
  }
  return {
    context: await createExistingDataSetContext(
      synapse.storage,
      providerId,
      postCreate.dataSetId,
    ),
    dataSetId: postCreate.dataSetId,
    created: true,
  };
}

/**
 * Extract normalized piece CID from a store/commit result.
 *
 * @param {StoreResult} value
 * @returns {string}
 */
export function extractPieceCid(value) {
  return String(value.pieceCid);
}

/**
 * Ask the context for a retrieval URL for a piece CID.
 *
 * @param {StorageContext} context
 * @param {string} pieceCid
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
 * Delete one committed piece from the current dataset.
 *
 * @param {StorageContext} context
 * @param {string} pieceCid
 * @returns {Promise<void>}
 */
export async function deletePiece(context, pieceCid) {
  if (!context || typeof context.deletePiece !== "function") {
    throw new HttpError(500, "Storage context.deletePiece is unavailable");
  }
  await context.deletePiece({ piece: pieceCid });
}

/**
 * Terminate/delete the current dataset.
 *
 * @param {StorageContext} context
 * @returns {Promise<void>}
 */
export async function terminateDataSet(context) {
  if (!context || typeof context.terminate !== "function") {
    throw new HttpError(500, "Storage context.terminate is unavailable");
  }
  await context.terminate();
}
