/**
 * Create and on-chain authorize a Synapse session key for PDP uploads (browser wallet).
 * @see https://docs.filecoin.cloud/developer-guides/session-keys/
 */
import {
  FILSTREAM_SESSION_ORIGIN,
  SESSION_KEY_SWEEP_GAS_LIMIT,
} from "./filstream-constants.mjs";
import {
  createWalletClient,
  custom,
  generatePrivateKey,
  getAddress,
  getChain,
  http,
  numberToHex,
  DefaultFwssPermissions,
  fromSecp256k1,
  privateKeyToAccount,
} from "./vendor/synapse-browser.mjs";
import { getFilstreamStoreConfig } from "./filstream-config.mjs";
import {
  FILSTREAM_CATALOG_ADD_PERMISSION,
  FILSTREAM_CATALOG_DELETE_PERMISSION,
} from "./filstream-catalog-chain.mjs";

/**
 * @param {import("./eip6963.mjs").Eip1193Provider} provider
 * @param {import("viem").Chain} chain
 */
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
 * @param {Record<string, string>} expMap
 * @returns {string | null}
 */
export function minExpirationSummaryLocal(expMap) {
  let minSec = Infinity;
  for (const v of Object.values(expMap)) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) continue;
    minSec = Math.min(minSec, n);
  }
  if (!Number.isFinite(minSec)) return null;
  return new Date(minSec * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });
}

/**
 * @param {import("./eip6963.mjs").Eip1193Provider} provider
 * @param {string} txHash
 * @param {{ timeoutMs?: number, intervalMs?: number, timeoutMessage?: string }} [opts]
 */
export async function waitForProviderReceipt(provider, txHash, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const intervalMs = opts.intervalMs ?? 1_500;
  const timeoutMessage =
    opts.timeoutMessage ?? "Timed out waiting for transaction receipt";
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
      throw new Error(timeoutMessage);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * @param {Record<string, unknown>} receipt
 * @returns {boolean}
 */
export function receiptSucceeded(receipt) {
  const status = receipt?.status;
  return status === "0x1" || status === 1 || status === 1n;
}

/**
 * @param {{ syncExpirations: (permissions: string[]) => Promise<void>, expirations: Record<string, bigint | undefined> }} sessionKey
 * @param {string[]} permissions
 * @param {{ afterLoginSync?: () => void }} [hooks]
 * @returns {Promise<Record<string, string>>}
 */
export async function finalizeSessionKeyAfterLoginMined(
  sessionKey,
  permissions,
  hooks,
) {
  hooks?.afterLoginSync?.();
  await sessionKey.syncExpirations(permissions);
  /** @type {Record<string, string>} */
  const sessionExpirations = {};
  const raw = sessionKey.expirations;
  for (const perm of permissions) {
    const exp = raw[perm];
    if (exp != null) {
      sessionExpirations[perm] = exp.toString();
    }
  }
  return sessionExpirations;
}

/**
 * Submit `loginAndFund` only (no receipt wait). Pair with {@link waitForProviderReceipt}
 * and {@link finalizeSessionKeyAfterLoginMined} for chained funding in the same block.
 *
 * @param {import("./eip6963.mjs").Eip1193Provider} provider
 * @param {string} rootAddress
 * @param {{ onTransactionSubmitted?: (txHash: string) => void }} [hooks]
 * @returns {Promise<{
 *   txHash: string,
 *   sessionPrivateKey: string,
 *   sessionKey: object,
 *   permissions: string[],
 * }>}
 */
export async function submitSessionLoginAndFundTransaction(
  provider,
  rootAddress,
  hooks,
) {
  const cfg = getFilstreamStoreConfig();
  const chain = getChain(cfg.storeChainId);
  await ensureWalletChain(provider, chain);

  const normalizedRoot = getAddress(/** @type {`0x${string}`} */ (rootAddress));

  const walletClient = createWalletClient({
    account: normalizedRoot,
    chain,
    transport: custom(provider),
  });

  const sessionPrivateKey = generatePrivateKey();
  const sessionKey = fromSecp256k1({
    privateKey: sessionPrivateKey,
    root: normalizedRoot,
    chain,
    transport: http(cfg.storeRpcUrl),
  });

  const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const sessionFundValue = BigInt(cfg.sessionKeyFundAttoFil);
  const permissions = filstreamSessionPermissions();

  const txHash = await walletClient.writeContract({
    address: chain.contracts.sessionKeyRegistry.address,
    abi: chain.contracts.sessionKeyRegistry.abi,
    functionName: "loginAndFund",
    args: [sessionKey.address, expiresAt, permissions, FILSTREAM_SESSION_ORIGIN],
    value: sessionFundValue,
  });
  hooks?.onTransactionSubmitted?.(txHash);
  return { txHash, sessionPrivateKey, sessionKey, permissions };
}

/**
 * @param {string} sessionPrivateKey
 * @returns {`0x${string}`}
 */
function normalizeSessionPrivateKey(sessionPrivateKey) {
  const raw = String(sessionPrivateKey || "").trim();
  if (!raw) throw new Error("Missing session private key");
  return /** @type {`0x${string}`} */ (
    raw.startsWith("0x") || raw.startsWith("0X") ? raw : `0x${raw}`
  );
}

/**
 * @param {string} rpcUrl
 * @param {string} method
 * @param {unknown[]} params
 */
async function rpcCall(rpcUrl, method, params) {
  const body = { jsonrpc: "2.0", id: Date.now(), method, params };
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
async function waitForRpcReceipt(rpcUrl, txHash, opts = {}) {
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

/**
 * @param {unknown} value
 * @returns {bigint}
 */
function asBigInt(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.floor(value));
  if (typeof value === "string" && value.trim() !== "") return BigInt(value);
  throw new Error("Invalid bigint value");
}

/**
 * @returns {string[]}
 */
export function filstreamSessionPermissions() {
  return Array.from(
    new Set([
      ...DefaultFwssPermissions,
      FILSTREAM_CATALOG_ADD_PERMISSION,
      FILSTREAM_CATALOG_DELETE_PERMISSION,
    ]),
  );
}

/**
 * @param {string} sessionPrivateKey
 * @returns {`0x${string}`}
 */
export function sessionSignerAddressFromPrivateKey(sessionPrivateKey) {
  const account = privateKeyToAccount(normalizeSessionPrivateKey(sessionPrivateKey));
  return getAddress(account.address);
}

/**
 * Sweep remaining FIL from a retired session key back to root wallet.
 * Returns without transaction when balance is too low to cover transfer gas.
 *
 * @param {{
 *   sessionPrivateKey: string,
 *   rootAddress: string,
 *   reserveWei?: bigint | number | string,
 *   onTransactionSubmitted?: (txHash: string) => void,
 * }} input
 * @returns {Promise<{ swept: boolean, txHash: string | null, sentWei: string, balanceWei: string }>}
 */
export async function sweepSessionKeyBalanceToRoot(input) {
  const cfg = getFilstreamStoreConfig();
  const chain = getChain(cfg.storeChainId);
  const account = privateKeyToAccount(normalizeSessionPrivateKey(input.sessionPrivateKey));
  const signer = getAddress(account.address);
  const root = getAddress(/** @type {`0x${string}`} */ (input.rootAddress));
  if (signer.toLowerCase() === root.toLowerCase()) {
    return { swept: false, txHash: null, sentWei: "0", balanceWei: "0" };
  }

  const balanceRaw = await rpcCall(cfg.storeRpcUrl, "eth_getBalance", [signer, "latest"]);
  const balanceWei = asBigInt(balanceRaw);
  if (balanceWei <= 0n) {
    return { swept: false, txHash: null, sentWei: "0", balanceWei: "0" };
  }

  const gasPriceRaw = await rpcCall(cfg.storeRpcUrl, "eth_gasPrice", []);
  const gasPrice = asBigInt(gasPriceRaw);
  const reserveWei = asBigInt(input.reserveWei ?? 0n);
  const fee = gasPrice * SESSION_KEY_SWEEP_GAS_LIMIT;
  if (balanceWei <= fee + reserveWei) {
    return {
      swept: false,
      txHash: null,
      sentWei: "0",
      balanceWei: balanceWei.toString(),
    };
  }
  const sendValue = balanceWei - fee - reserveWei;
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(cfg.storeRpcUrl),
  });
  const txHash = await walletClient.sendTransaction({
    to: root,
    value: sendValue,
    gas: SESSION_KEY_SWEEP_GAS_LIMIT,
    gasPrice,
  });
  input.onTransactionSubmitted?.(txHash);
  const receipt = await waitForRpcReceipt(cfg.storeRpcUrl, txHash);
  const status = receipt?.status;
  if (!(status === "0x1" || status === 1 || status === 1n)) {
    throw new Error(`Session-key sweep reverted: ${txHash}`);
  }
  return {
    swept: true,
    txHash,
    sentWei: sendValue.toString(),
    balanceWei: balanceWei.toString(),
  };
}

/**
 * @param {{
 *   provider: import("./eip6963.mjs").Eip1193Provider,
 *   walletAddress: string,
 *   sessionPrivateKey?: string,
 *   sessionSignerAddress?: string,
 *   permissions?: string[],
 *   origin?: string,
 *   onTransactionSubmitted?: (txHash: string) => void,
 * }} input
 */
export async function revokeSessionKeyWithWallet(input) {
  const cfg = getFilstreamStoreConfig();
  const chain = getChain(cfg.storeChainId);
  await ensureWalletChain(input.provider, chain);
  const walletAddress = getAddress(/** @type {`0x${string}`} */ (input.walletAddress));
  const signer =
    input.sessionSignerAddress && input.sessionSignerAddress.trim() !== ""
      ? getAddress(/** @type {`0x${string}`} */ (input.sessionSignerAddress))
      : sessionSignerAddressFromPrivateKey(String(input.sessionPrivateKey || ""));
  const permissions = Array.from(new Set(input.permissions ?? filstreamSessionPermissions()));
  const walletClient = createWalletClient({
    account: walletAddress,
    chain,
    transport: custom(input.provider),
  });
  const txHash = await walletClient.writeContract({
    address: chain.contracts.sessionKeyRegistry.address,
    abi: chain.contracts.sessionKeyRegistry.abi,
    functionName: "revoke",
    args: [signer, permissions, input.origin ?? FILSTREAM_SESSION_ORIGIN],
  });
  input.onTransactionSubmitted?.(txHash);
  const receipt = await waitForProviderReceipt(input.provider, txHash);
  const status = receipt?.status;
  if (!(status === "0x1" || status === 1 || status === 1n)) {
    throw new Error(`Session-key revoke reverted: ${txHash}`);
  }
  return { txHash };
}

/**
 * Root wallet signs `login` on SessionKeyRegistry; session key is then used by Synapse for storage ops.
 *
 * @param {import("./eip6963.mjs").Eip1193Provider} provider
 * @param {string} rootAddress
 * @param {{
 *   onTransactionSubmitted?: (txHash: string) => void,
 *   afterLoginSync?: () => void,
 * }} [hooks]
 * @returns {Promise<{ sessionPrivateKey: string, sessionExpirations: Record<string, string> }>}
 */
export async function authorizeSessionKeyForUpload(provider, rootAddress, hooks) {
  const { txHash, sessionPrivateKey, sessionKey, permissions } =
    await submitSessionLoginAndFundTransaction(provider, rootAddress, hooks);
  const receipt = await waitForProviderReceipt(provider, txHash, {
    timeoutMessage: "Timed out waiting for session-key authorization tx receipt",
  });
  if (!receiptSucceeded(receipt)) {
    throw new Error(`Session-key authorization reverted: ${txHash}`);
  }
  const sessionExpirations = await finalizeSessionKeyAfterLoginMined(
    sessionKey,
    permissions,
    hooks,
  );
  return {
    sessionPrivateKey,
    sessionExpirations,
  };
}
