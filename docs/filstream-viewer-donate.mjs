/**
 * Viewer-side donate control (not the uploader). Reads `donate` from published meta.json;
 * connects a wallet and proposes an ERC-20 `transfer` to the creator’s Fund-step wallet (`meta.listing.fundWalletAddress` / `meta.donate.recipient`).
 */
import { html } from "https://cdn.jsdelivr.net/npm/lit-html@3.2.1/+esm";
import { connectInjectedProvider } from "./eip6963.mjs";
import { USDFC_DONATE_TOKEN } from "./filstream-chain-config.mjs";

/**
 * @param {string} human e.g. "1" or "0.5"
 * @param {number} decimals
 * @returns {bigint}
 */
export function humanToTokenWei(human, decimals) {
  const s = String(human).trim();
  if (!s || !Number.isFinite(Number(s))) throw new Error("Invalid amount");
  const [ip, fp = ""] = s.split(".");
  const frac = (fp + "0".repeat(decimals)).slice(0, decimals);
  const combined = ip + frac;
  if (!/^\d+$/.test(combined)) throw new Error("Invalid amount");
  return BigInt(combined);
}

/**
 * @param {string} toAddress `0x` + 40 hex (recipient of tokens)
 * @param {bigint} amountWei
 */
export function encodeErc20Transfer(toAddress, amountWei) {
  const addr = toAddress.replace(/^0x/i, "").toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(addr)) throw new Error("Invalid recipient");

  let amtHex = amountWei.toString(16);
  if (amtHex.length % 2) amtHex = "0" + amtHex;
  const amtPadded = amtHex.padStart(64, "0");
  const addrPadded = addr.padStart(64, "0");
  return `0xa9059cbb${addrPadded}${amtPadded}`;
}

/**
 * @param {unknown} meta parsed meta.json
 * @returns {{ enabled: true, recipient: string, amountHuman: string, token: { symbol: string, address: string, decimals: number }, chainId: number } | { enabled: false }}
 */
export function donateConfigFromMeta(meta) {
  if (meta && typeof meta === "object" && meta.donate && meta.donate.enabled === true) {
    const d = meta.donate;
    const tok = d.token || {};
    return {
      enabled: true,
      recipient: String(d.recipient || ""),
      amountHuman: String(d.amountHuman ?? "1"),
      token: {
        symbol: String(tok.symbol ?? USDFC_DONATE_TOKEN.symbol),
        address: String(tok.address ?? USDFC_DONATE_TOKEN.address),
        decimals: Number(tok.decimals ?? USDFC_DONATE_TOKEN.decimals),
      },
      chainId: Number(d.chainId ?? USDFC_DONATE_TOKEN.chainId),
    };
  }
  const listing = meta && typeof meta === "object" ? meta.listing : null;
  const fundAddr =
    listing &&
    typeof listing.fundWalletAddress === "string" &&
    /^0x[a-fA-F0-9]{40}$/.test(listing.fundWalletAddress)
      ? listing.fundWalletAddress
      : listing &&
          typeof listing.uploaderWalletAddress === "string" &&
          /^0x[a-fA-F0-9]{40}$/.test(listing.uploaderWalletAddress)
        ? listing.uploaderWalletAddress
        : null;
  if (listing && listing.showDonateButton && fundAddr) {
    const amt = listing.donateAmountUsdfc ?? 1;
    return {
      enabled: true,
      recipient: fundAddr,
      amountHuman: String(amt),
      token: {
        symbol: USDFC_DONATE_TOKEN.symbol,
        address: USDFC_DONATE_TOKEN.address,
        decimals: USDFC_DONATE_TOKEN.decimals,
      },
      chainId: USDFC_DONATE_TOKEN.chainId,
    };
  }
  return { enabled: false };
}

/** @param {import("./eip6963.mjs").Eip1193Provider} provider */
async function ensureChain(provider, chainId, chainName) {
  const idHex = "0x" + BigInt(chainId).toString(16);
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: idHex }],
    });
  } catch (e) {
    if (/** @type {{ code?: number }} */ (e).code === 4902) {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: idHex,
            chainName: chainName || `chain ${chainId}`,
            nativeCurrency: { name: "FIL", symbol: "FIL", decimals: 18 },
            rpcUrls: ["https://api.calibration.node.glif.io/rpc/v0"],
            blockExplorerUrls: ["https://calibration.filfox.info/en"],
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
 * @param {Exclude<ReturnType<typeof donateConfigFromMeta>, { enabled: false }>} cfg
 */
export async function proposeDonateTransfer(provider, cfg) {
  if (!cfg || cfg.enabled !== true) {
    throw new Error("Donations are not enabled for this listing.");
  }

  const from = await connectInjectedProvider(provider);
  if (!from) throw new Error("No account from wallet");

  const tokenAddress = cfg.token.address;
  if (!tokenAddress || !/^0x[a-fA-F0-9]{40}$/i.test(tokenAddress)) {
    throw new Error("meta.json is missing a valid token contract address");
  }

  await ensureChain(provider, cfg.chainId, USDFC_DONATE_TOKEN.chainName);

  const amountWei = humanToTokenWei(cfg.amountHuman, cfg.token.decimals);
  const data = encodeErc20Transfer(cfg.recipient, amountWei);

  const txHash = await provider.request({
    method: "eth_sendTransaction",
    params: [
      {
        from,
        to: tokenAddress,
        data,
      },
    ],
  });
  return { txHash: /** @type {string} */ (txHash) };
}

/**
 * Pick a browser wallet (EIP-6963 legacy or `window.ethereum`).
 * @param {{ request: (a: { method: string, params?: unknown[] }) => Promise<unknown> } | null} preferred
 */
export function resolveViewerProvider(preferred) {
  if (preferred && typeof preferred.request === "function") return preferred;
  if (typeof window !== "undefined" && window.ethereum?.request) {
    return window.ethereum;
  }
  return null;
}

/**
 * Lit template: donate primary CTA for broadcast / publish previews.
 * @param {{
 *   meta: unknown,
 *   getWalletList?: () => import("./eip6963.mjs").Eip6963AnnouncedWallet[],
 *   viewerBusy: boolean,
 *   viewerError: string,
 *   viewerTxHash: string,
 *   onDonateClick: () => void,
 * }} props
 */
export function viewerDonateBlock(props) {
  const {
    meta,
    viewerBusy,
    viewerError,
    viewerTxHash,
    onDonateClick,
    getWalletList,
  } = props;
  const cfg = donateConfigFromMeta(meta);
  if (!cfg.enabled) return null;

  const label = `Donate ${cfg.amountHuman} ${cfg.token.symbol}`;
  const wallets = getWalletList?.() ?? [];
  const showWalletHint = !resolveViewerProvider(null) && wallets.length === 0;

  return html`
    <div class="viewer-donate" aria-label="Donate to creator">
      <button
        type="button"
        class="btn btn-primary viewer-donate-btn"
        ?disabled=${viewerBusy}
        @click=${onDonateClick}
      >
        ${viewerBusy ? "Connecting…" : label}
      </button>
      ${showWalletHint
        ? html`<p class="viewer-donate-hint">Install a browser wallet to donate.</p>`
        : null}
      ${viewerError
        ? html`<p class="viewer-donate-err" role="alert">${viewerError}</p>`
        : null}
      ${viewerTxHash
        ? html`<p class="viewer-donate-tx" aria-live="polite">
            Transaction sent: <code>${viewerTxHash}</code>
          </p>`
        : null}
      <p class="viewer-donate-recipient subtle">
        Fund wallet (creator, step 2) <span class="mono">${cfg.recipient}</span>
      </p>
    </div>
  `;
}
