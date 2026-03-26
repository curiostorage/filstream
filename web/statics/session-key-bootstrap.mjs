/**
 * Create and on-chain authorize a Synapse session key for PDP uploads (browser wallet).
 * @see https://docs.filecoin.cloud/developer-guides/session-keys/
 */
import {
  createWalletClient,
  custom,
  generatePrivateKey,
  getAddress,
  getChain,
  http,
  loginSync,
  numberToHex,
  DefaultFwssPermissions,
  fromSecp256k1,
} from "./vendor/synapse-browser.mjs";
import { getFilstreamStoreConfig } from "./filstream-config.mjs";

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
export function minExpirationSummaryUtc(expMap) {
  let minSec = Infinity;
  for (const v of Object.values(expMap)) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) continue;
    minSec = Math.min(minSec, n);
  }
  if (!Number.isFinite(minSec)) return null;
  return new Date(minSec * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
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

  await loginSync(walletClient, {
    address: sessionKey.address,
    permissions: [...DefaultFwssPermissions],
    expiresAt,
    onHash: (hash) => {
      hooks?.onTransactionSubmitted?.(hash);
    },
  });

  hooks?.afterLoginSync?.();
  await sessionKey.syncExpirations();

  /** @type {Record<string, string>} */
  const sessionExpirations = {};
  const raw = sessionKey.expirations;
  for (const perm of DefaultFwssPermissions) {
    const exp = raw[perm];
    if (exp != null) {
      sessionExpirations[perm] = exp.toString();
    }
  }

  return {
    sessionPrivateKey,
    sessionExpirations,
  };
}
