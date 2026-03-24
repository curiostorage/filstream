/**
 * Injected wallet UI via EIP-6963 discovery + `window.ethereum` fallback.
 */
import { html } from "https://cdn.jsdelivr.net/npm/lit-html@3.2.1/+esm";

function shortAddress(addr) {
  if (!addr || addr.length < 12) return addr || "";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/**
 * @param {{
 *   show: boolean,
 *   fileName: string,
 *   injectedWallets: { info: { uuid: string, name: string, icon: string, rdns: string }, provider: import("./eip6963.mjs").Eip1193Provider }[],
 *   walletAddress: string | null,
 *   connectedWalletName: string | null,
 *   walletBusy: boolean,
 *   walletError: string | null,
 *   connectingUuid: string | null,
 *   onConnectInjected: (provider: import("./eip6963.mjs").Eip1193Provider, info: { uuid: string, name: string }) => void | Promise<void>,
 *   onDisconnectWallet: () => void,
 *   onRefreshWallets: () => void,
 * }} props
 */
export function uploadConfigurePanel(props) {
  if (!props.show) return null;

  const {
    fileName,
    injectedWallets,
    walletAddress,
    connectedWalletName,
    walletBusy,
    walletError,
    connectingUuid,
    onConnectInjected,
    onDisconnectWallet,
    onRefreshWallets,
  } = props;

  const connected = Boolean(walletAddress);

  return html`
    <section class="upload-configure" aria-label="Wallet and upload settings">
      ${fileName
          ? html`<p class="configure-file">Selected: ${fileName}</p>`
          : null}

      <div class="wallet-injected-block">
        <div class="wallet-injected-head">
          <h3 class="configure-section-title">Select your wallet.</h3>
          <button
            type="button"
            class="btn btn-text btn-refresh-wallets"
            ?disabled=${walletBusy}
            @click=${onRefreshWallets}
          >
            Refresh list
          </button>
        </div>
        <p class="configure-section-lead">
          Choose a browser extension or injected provider. Wallets that support
          <a href="https://eips.ethereum.org/EIPS/eip-6963">EIP-6963</a> appear automatically;
          otherwise use the legacy <code>window.ethereum</code> entry if present.
        </p>

        ${connected
          ? html`
              <div class="wallet-connected-row">
                <p class="wallet-address" title=${walletAddress ?? ""}>
                  ${connectedWalletName
                    ? html`<span class="wallet-via">${connectedWalletName}</span> · `
                    : null}
                  <span class="wallet-address-mono">${shortAddress(walletAddress)}</span>
                </p>
                <button
                  type="button"
                  class="btn btn-wallet-disconnect"
                  ?disabled=${walletBusy}
                  @click=${onDisconnectWallet}
                >
                  Disconnect
                </button>
              </div>
            `
          : null}

        ${!connected && injectedWallets.length === 0
          ? html`<p class="wallet-empty">No injected wallets detected. Install an extension and click Refresh.</p>`
          : null}

        ${!connected && injectedWallets.length
          ? html`
              <ul class="wallet-picker-list" role="list">
                ${injectedWallets.map(
                  (w) => html`
                    <li class="wallet-picker-item">
                      <button
                        type="button"
                        class="btn btn-wallet-pick"
                        ?disabled=${walletBusy}
                        @click=${() => onConnectInjected(w.provider, w.info)}
                      >
                        ${w.info.icon
                          ? html`<img
                              class="wallet-picker-icon"
                              src=${w.info.icon}
                              alt=""
                              width="28"
                              height="28"
                              loading="lazy"
                            />`
                          : html`<span class="wallet-picker-icon-fallback" aria-hidden="true"
                              >◆</span
                            >`}
                        <span class="wallet-picker-name">${w.info.name}</span>
                        ${connectingUuid === w.info.uuid
                          ? html`<span class="wallet-picker-busy">Connecting…</span>`
                          : null}
                      </button>
                    </li>
                  `,
                )}
              </ul>
            `
          : null}

        ${walletError
          ? html`<p class="wallet-error" role="alert">${walletError}</p>`
          : null}
      </div>

      <div class="later-steps-block">
        <h3 class="configure-section-title">Next steps</h3>
        <p class="configure-section-lead">
          Pricing, destination, and signing will live here after the wallet is connected.
        </p>
        <ul class="later-steps-list">
          <li>Confirm network &amp; token</li>
          <li>Authorize upload / session</li>
          <li>Optional: pin or attest output</li>
        </ul>
      </div>
    </section>
  `;
}
