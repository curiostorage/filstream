/**
 * On-chain FilStream catalog client helpers (read + session-key writes).
 */
import {
  CATALOG_REGISTRY_ABI,
  FILSTREAM_CATALOG_ADD_PERMISSION as SHARED_FILSTREAM_CATALOG_ADD_PERMISSION,
  FILSTREAM_CATALOG_DELETE_PERMISSION as SHARED_FILSTREAM_CATALOG_DELETE_PERMISSION,
} from "./filstream-constants.mjs";
import {
  Synapse,
  createWalletClient,
  custom,
  getAddress,
  getChain,
  http,
  numberToHex,
  privateKeyToAccount,
} from "../vendor/synapse-browser.mjs";
import { getFilstreamStoreConfig } from "./filstream-config.mjs";

export const FILSTREAM_CATALOG_ADD_PERMISSION = SHARED_FILSTREAM_CATALOG_ADD_PERMISSION;
export const FILSTREAM_CATALOG_DELETE_PERMISSION = SHARED_FILSTREAM_CATALOG_DELETE_PERMISSION;

/** @type {Synapse | null} */
let catalogReadSynapseCache = null;
/** @type {Map<number, string>} */
const providerServiceUrlCache = new Map();
const CATALOG_READ_ACCOUNT = "0x0000000000000000000000000000000000000001";

/**
 * @typedef {{
 *   entryId: number,
 *   createdAt: number,
 *   updatedAt: number,
 *   creator: string,
 *   assetId: string,
 *   providerId: number,
 *   manifestCid: string,
 *   title: string,
 *   active: boolean,
 * }} CatalogEntry
 */

function toSafeUint(value, label) {
  if (typeof value === "bigint") {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new Error(`Invalid ${label}: out of range`);
    }
    return n;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  throw new Error(`Invalid ${label}`);
}

function normalizeSessionPrivateKey(sessionPrivateKey) {
  const raw = String(sessionPrivateKey || "").trim();
  if (!raw) throw new Error("Missing session private key");
  if (raw.startsWith("0x") || raw.startsWith("0X")) return raw;
  return `0x${raw}`;
}

/** JSON.stringify replacer so bigint params encode as hex (viem RPC shape). */
function rpcJsonReplacer(_key, value) {
  if (typeof value === "bigint") {
    return `0x${value.toString(16)}`;
  }
  return value;
}

/**
 * Synapse SDK read client must use:
 * - an account (SDK currently assumes `client.account` exists)
 * - custom transport for json-rpc account type
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
 * @param {unknown} raw
 * @returns {CatalogEntry | null}
 */
function normalizeCatalogEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const o = /** @type {Record<string, unknown>} */ (raw);
  const entryIdRaw = "entryId" in o ? o.entryId : o[0];
  const createdAtRaw = "createdAt" in o ? o.createdAt : o[1];
  const updatedAtRaw = "updatedAt" in o ? o.updatedAt : o[2];
  const creatorRaw = "creator" in o ? o.creator : o[3];
  const assetIdRaw = "assetId" in o ? o.assetId : o[4];
  const providerIdRaw = "providerId" in o ? o.providerId : o[5];
  const manifestCidRaw = "manifestCid" in o ? o.manifestCid : o[6];
  const titleRaw = "title" in o ? o.title : o[7];
  const activeRaw = "active" in o ? o.active : o[8];

  const creator = typeof creatorRaw === "string" ? creatorRaw.trim() : "";
  const assetId = typeof assetIdRaw === "string" ? assetIdRaw.trim() : "";
  const manifestCid =
    typeof manifestCidRaw === "string" ? manifestCidRaw.trim() : "";
  const title = typeof titleRaw === "string" ? titleRaw.trim() : "";
  if (!creator || !assetId || !manifestCid || !title) {
    return null;
  }

  return {
    entryId: toSafeUint(entryIdRaw, "entryId"),
    createdAt: toSafeUint(createdAtRaw, "createdAt"),
    updatedAt: toSafeUint(updatedAtRaw, "updatedAt"),
    creator,
    assetId,
    providerId: toSafeUint(providerIdRaw, "providerId"),
    manifestCid,
    title,
    active: Boolean(activeRaw),
  };
}

function catalogContractAddress() {
  const cfg = getFilstreamStoreConfig();
  const raw =
    typeof cfg.catalogContractAddress === "string"
      ? cfg.catalogContractAddress.trim()
      : "";
  if (!raw) {
    throw new Error(
      "Missing catalog contract address: set window.__FILSTREAM_CONFIG__.catalogContractAddress",
    );
  }
  return getAddress(/** @type {`0x${string}`} */ (raw));
}

/**
 * @returns {`0x${string}`}
 */
export function getCatalogContractAddress() {
  return /** @type {`0x${string}`} */ (catalogContractAddress());
}

/**
 * @returns {boolean}
 */
export function isCatalogConfigured() {
  try {
    void catalogContractAddress();
    return true;
  } catch {
    return false;
  }
}

function catalogReadSynapse() {
  if (catalogReadSynapseCache) return catalogReadSynapseCache;
  const cfg = getFilstreamStoreConfig();
  catalogReadSynapseCache = Synapse.create({
    account: getAddress(/** @type {`0x${string}`} */ (CATALOG_READ_ACCOUNT)),
    chain: getChain(cfg.storeChainId),
    transport: jsonRpcUrlCustomTransport(cfg.storeRpcUrl),
    source: cfg.storeSource,
  });
  return catalogReadSynapseCache;
}

/**
 * @param {number} providerId
 * @returns {Promise<string>}
 */
export async function resolveProviderServiceUrl(providerId) {
  if (!Number.isFinite(providerId) || providerId <= 0) {
    throw new Error("Invalid providerId");
  }
  const pid = Math.floor(providerId);
  const hit = providerServiceUrlCache.get(pid);
  if (hit) return hit;
  const synapse = catalogReadSynapse();
  const providerInfo = await synapse.providers.getProvider({ providerId: BigInt(pid) });
  const serviceURL = providerInfo?.pdp?.serviceURL;
  if (typeof serviceURL !== "string" || serviceURL.trim() === "") {
    throw new Error(`Provider ${pid} has no PDP serviceURL`);
  }
  const normalized = serviceURL.trim();
  providerServiceUrlCache.set(pid, normalized);
  return normalized;
}

/**
 * @param {string} serviceUrl
 * @param {string} pieceCid
 * @returns {string}
 */
export function buildPieceRetrievalUrl(serviceUrl, pieceCid) {
  const cid = String(pieceCid || "").trim();
  if (!cid) throw new Error("Missing piece CID");
  return new URL(`piece/${cid}`, serviceUrl).href;
}

/**
 * @param {number} providerId
 * @param {string} manifestCid
 * @returns {Promise<string>}
 */
export async function resolveManifestUrl(providerId, manifestCid) {
  const serviceUrl = await resolveProviderServiceUrl(providerId);
  return buildPieceRetrievalUrl(serviceUrl, manifestCid);
}

/**
 * @param {unknown[]} raw
 * @returns {CatalogEntry[]}
 */
function normalizeCatalogEntryList(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {CatalogEntry[]} */
  const out = [];
  for (const row of raw) {
    const item = normalizeCatalogEntry(row);
    if (item) out.push(item);
  }
  return out;
}

/**
 * @param {{
 *   offset?: number,
 *   limit?: number,
 *   activeOnly?: boolean,
 * }} [input]
 * @returns {Promise<CatalogEntry[]>}
 */
export async function readCatalogLatest(input = {}) {
  const offset =
    Number.isFinite(input.offset) && input.offset >= 0
      ? Math.floor(input.offset)
      : 0;
  const limit =
    Number.isFinite(input.limit) && input.limit > 0
      ? Math.min(250, Math.floor(input.limit))
      : 50;
  const activeOnly = input.activeOnly !== false;
  const synapse = catalogReadSynapse();
  const rows = await synapse.client.readContract({
    address: catalogContractAddress(),
    abi: CATALOG_REGISTRY_ABI,
    functionName: "getLatest",
    args: [BigInt(offset), BigInt(limit), activeOnly],
  });
  return normalizeCatalogEntryList(/** @type {unknown[]} */ (rows));
}

/**
 * @param {{
 *   cursorCreatedAt: number,
 *   cursorEntryId: number,
 *   limit?: number,
 *   activeOnly?: boolean,
 * }} input
 * @returns {Promise<CatalogEntry[]>}
 */
export async function readCatalogNewerThan(input) {
  const createdAt =
    Number.isFinite(input.cursorCreatedAt) && input.cursorCreatedAt >= 0
      ? Math.floor(input.cursorCreatedAt)
      : 0;
  const entryId =
    Number.isFinite(input.cursorEntryId) && input.cursorEntryId >= 0
      ? Math.floor(input.cursorEntryId)
      : 0;
  const limit =
    Number.isFinite(input.limit) && input.limit > 0
      ? Math.min(250, Math.floor(input.limit))
      : 100;
  const activeOnly = input.activeOnly === true;
  const synapse = catalogReadSynapse();
  const rows = await synapse.client.readContract({
    address: catalogContractAddress(),
    abi: CATALOG_REGISTRY_ABI,
    functionName: "getNewerThan",
    args: [BigInt(createdAt), BigInt(entryId), BigInt(limit), activeOnly],
  });
  return normalizeCatalogEntryList(/** @type {unknown[]} */ (rows));
}

/**
 * @param {string} creatorAddress
 * @returns {Promise<string>}
 */
export async function readCatalogUsername(creatorAddress) {
  const creator = getAddress(/** @type {`0x${string}`} */ (creatorAddress));
  const synapse = catalogReadSynapse();
  const out = await synapse.client.readContract({
    address: catalogContractAddress(),
    abi: CATALOG_REGISTRY_ABI,
    functionName: "usernameOf",
    args: [creator],
  });
  return typeof out === "string" ? out.trim() : "";
}

/**
 * @param {string} creatorAddress
 * @returns {Promise<string>}
 */
export async function readCatalogProfilePicturePieceCid(creatorAddress) {
  const creator = getAddress(/** @type {`0x${string}`} */ (creatorAddress));
  const synapse = catalogReadSynapse();
  const out = await synapse.client.readContract({
    address: catalogContractAddress(),
    abi: CATALOG_REGISTRY_ABI,
    functionName: "profilePicturePieceCidOf",
    args: [creator],
  });
  return typeof out === "string" ? out.trim() : "";
}

/**
 * @param {{
 *   creatorAddress: string,
 *   offset?: number,
 *   limit?: number,
 *   activeOnly?: boolean,
 * }} input
 * @returns {Promise<CatalogEntry[]>}
 */
export async function readCatalogByCreator(input) {
  const creator = getAddress(/** @type {`0x${string}`} */ (input.creatorAddress));
  const offset =
    Number.isFinite(input.offset) && input.offset >= 0
      ? Math.floor(input.offset)
      : 0;
  const limit =
    Number.isFinite(input.limit) && input.limit > 0
      ? Math.min(250, Math.floor(input.limit))
      : 100;
  const activeOnly = input.activeOnly !== false;
  const synapse = catalogReadSynapse();
  const rows = await synapse.client.readContract({
    address: catalogContractAddress(),
    abi: CATALOG_REGISTRY_ABI,
    functionName: "getByCreator",
    args: [creator, BigInt(offset), BigInt(limit), activeOnly],
  });
  return normalizeCatalogEntryList(/** @type {unknown[]} */ (rows));
}

async function ensureWalletChain(provider, chain) {
  const wantHex = numberToHex(chain.id);
  const current = await provider.request({ method: "eth_chainId" });
  if (
    typeof current === "string" &&
    current.toLowerCase() === wantHex.toLowerCase()
  ) {
    return;
  }
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: wantHex }],
    });
  } catch (e) {
    const code = /** @type {{ code?: number }} */ (e)?.code;
    if (code === 4902) {
      const explorers = chain.blockExplorers?.default?.url;
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: wantHex,
            chainName: chain.name,
            nativeCurrency: chain.nativeCurrency,
            rpcUrls: chain.rpcUrls.default.http,
            blockExplorerUrls: explorers ? [explorers] : [],
          },
        ],
      });
      return;
    }
    throw e;
  }
}

/**
 * @param {import("./eip6963.mjs").Eip1193Provider} provider
 * @param {string} txHash
 * @param {{ timeoutMs?: number, intervalMs?: number }} [opts]
 */
async function waitForProviderReceipt(provider, txHash, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const intervalMs = opts.intervalMs ?? 1_500;
  const start = Date.now();
  for (;;) {
    const receipt = await provider.request({
      method: "eth_getTransactionReceipt",
      params: [txHash],
    });
    if (receipt && typeof receipt === "object") {
      return /** @type {Record<string, unknown>} */ (receipt);
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for transaction receipt");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function rpcCall(rpcUrl, method, params) {
  const body = {
    jsonrpc: "2.0",
    id: Date.now(),
    method,
    params,
  };
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`RPC HTTP ${res.status}`);
  }
  const json = await res.json();
  if (json?.error) {
    const msg =
      typeof json.error?.message === "string"
        ? json.error.message
        : JSON.stringify(json.error);
    throw new Error(msg || "RPC error");
  }
  return json?.result;
}

/**
 * @param {string} rpcUrl
 * @param {string} txHash
 * @param {{ timeoutMs?: number, intervalMs?: number }} [opts]
 * @returns {Promise<Record<string, unknown>>}
 */
async function waitForTransactionReceipt(rpcUrl, txHash, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const intervalMs = opts.intervalMs ?? 1_500;
  const start = Date.now();
  for (;;) {
    const receipt = await rpcCall(rpcUrl, "eth_getTransactionReceipt", [txHash]);
    if (receipt && typeof receipt === "object") {
      return /** @type {Record<string, unknown>} */ (receipt);
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for transaction receipt");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function ensureTxSuccess(receipt, txHash) {
  const rawStatus = receipt?.status;
  if (rawStatus === "0x1" || rawStatus === 1 || rawStatus === 1n) {
    return;
  }
  throw new Error(`Transaction reverted: ${txHash}`);
}

/**
 * @param {{
 *   claimedUser: string,
 *   sessionPrivateKey: string,
 *   assetId: string,
 *   providerId: number,
 *   manifestCid: string,
 *   title: string,
 *   onTransactionSubmitted?: (txHash: string) => void,
 * }} input
 * @returns {Promise<{ txHash: string }>}
 */
export async function addCatalogEntryWithSessionKey(input) {
  const cfg = getFilstreamStoreConfig();
  const chain = getChain(cfg.storeChainId);
  const claimedUser = getAddress(/** @type {`0x${string}`} */ (input.claimedUser));
  const account = privateKeyToAccount(
    /** @type {`0x${string}`} */ (normalizeSessionPrivateKey(input.sessionPrivateKey)),
  );
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(cfg.storeRpcUrl),
  });

  const txHash = await walletClient.writeContract({
    address: catalogContractAddress(),
    abi: CATALOG_REGISTRY_ABI,
    functionName: "addEntry",
    args: [
      claimedUser,
      String(input.assetId || "").trim(),
      BigInt(Math.max(0, Math.floor(Number(input.providerId) || 0))),
      String(input.manifestCid || "").trim(),
      String(input.title || "").trim(),
    ],
  });
  input.onTransactionSubmitted?.(txHash);
  const receipt = await waitForTransactionReceipt(cfg.storeRpcUrl, txHash);
  ensureTxSuccess(receipt, txHash);
  return { txHash };
}

/**
 * @param {{
 *   claimedUser: string,
 *   sessionPrivateKey: string,
 *   entryId: number,
 *   onTransactionSubmitted?: (txHash: string) => void,
 * }} input
 * @returns {Promise<{ txHash: string }>}
 */
export async function deleteCatalogEntryWithSessionKey(input) {
  const cfg = getFilstreamStoreConfig();
  const chain = getChain(cfg.storeChainId);
  const claimedUser = getAddress(/** @type {`0x${string}`} */ (input.claimedUser));
  const account = privateKeyToAccount(
    /** @type {`0x${string}`} */ (normalizeSessionPrivateKey(input.sessionPrivateKey)),
  );
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(cfg.storeRpcUrl),
  });
  const txHash = await walletClient.writeContract({
    address: catalogContractAddress(),
    abi: CATALOG_REGISTRY_ABI,
    functionName: "deleteEntry",
    args: [claimedUser, BigInt(Math.max(0, Math.floor(input.entryId || 0)))],
  });
  input.onTransactionSubmitted?.(txHash);
  const receipt = await waitForTransactionReceipt(cfg.storeRpcUrl, txHash);
  ensureTxSuccess(receipt, txHash);
  return { txHash };
}

/**
 * @param {{
 *   provider: import("./eip6963.mjs").Eip1193Provider,
 *   walletAddress: string,
 *   username: string,
 *   onTransactionSubmitted?: (txHash: string) => void,
 * }} input
 * @returns {Promise<{ txHash: string }>}
 */
export async function setCatalogUsernameWithWallet(input) {
  const username = String(input.username || "").trim();
  if (!username) {
    throw new Error("Username cannot be empty.");
  }
  const cfg = getFilstreamStoreConfig();
  const chain = getChain(cfg.storeChainId);
  await ensureWalletChain(input.provider, chain);
  const walletAddress = getAddress(/** @type {`0x${string}`} */ (input.walletAddress));
  const walletClient = createWalletClient({
    account: walletAddress,
    chain,
    transport: custom(input.provider),
  });
  const txHash = await walletClient.writeContract({
    address: catalogContractAddress(),
    abi: CATALOG_REGISTRY_ABI,
    functionName: "setMyUsername",
    args: [username],
  });
  input.onTransactionSubmitted?.(txHash);
  const receipt = await waitForProviderReceipt(input.provider, txHash);
  const status = receipt?.status;
  if (!(status === "0x1" || status === 1 || status === 1n)) {
    throw new Error(`Transaction reverted: ${txHash}`);
  }
  return { txHash };
}

/**
 * @param {{
 *   provider: import("./eip6963.mjs").Eip1193Provider,
 *   walletAddress: string,
 *   pieceCid: string,
 *   onTransactionSubmitted?: (txHash: string) => void,
 * }} input
 * @returns {Promise<{ txHash: string }>}
 */
export async function setCatalogProfilePicturePieceCidWithWallet(input) {
  const cfg = getFilstreamStoreConfig();
  const chain = getChain(cfg.storeChainId);
  await ensureWalletChain(input.provider, chain);
  const walletAddress = getAddress(/** @type {`0x${string}`} */ (input.walletAddress));
  const walletClient = createWalletClient({
    account: walletAddress,
    chain,
    transport: custom(input.provider),
  });
  const txHash = await walletClient.writeContract({
    address: catalogContractAddress(),
    abi: CATALOG_REGISTRY_ABI,
    functionName: "setMyProfilePicturePieceCid",
    args: [String(input.pieceCid || "").trim()],
  });
  input.onTransactionSubmitted?.(txHash);
  const receipt = await waitForProviderReceipt(input.provider, txHash);
  const status = receipt?.status;
  if (!(status === "0x1" || status === 1 || status === 1n)) {
    throw new Error(`Transaction reverted: ${txHash}`);
  }
  return { txHash };
}
