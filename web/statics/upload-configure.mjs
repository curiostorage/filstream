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
 *   sessionAuthReady?: boolean,
 *   sessionAuthBusy?: boolean,
 *   sessionAuthWaitPhase?: "idle" | "wallet" | "chain" | "session_sync",
 *   sessionAuthError?: string | null,
 *   sessionExpiresSummary?: string | null,
 *   canAuthorizeSession?: boolean,
 *   onAuthorizeSession?: () => void | Promise<void>,
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
    sessionAuthReady = false,
    sessionAuthBusy = false,
    sessionAuthWaitPhase = "idle",
    sessionAuthError = null,
    sessionExpiresSummary = null,
    canAuthorizeSession = false,
    onAuthorizeSession,
  } = props;

  const connected = Boolean(walletAddress);
  const sessionBusy = Boolean(sessionAuthBusy || walletBusy);

  /** @type {{ title: string, detail: string }} */
  let waitUi = { title: "", detail: "" };
  if (sessionAuthBusy) {
    if (sessionAuthWaitPhase === "chain") {
      waitUi = {
        title: "Waiting for the network",
        detail:
          "Your transaction was sent. Confirming it on-chain can take a minute on Filecoin. You can leave this tab open.",
      };
    } else if (sessionAuthWaitPhase === "session_sync") {
      waitUi = {
        title: "Finalizing session",
        detail: "Reading authorization data from the chain…",
      };
    } else {
      waitUi = {
        title: "Confirm in wallet",
        detail: "Approve the session-key transaction when your wallet prompts you.",
      };
    }
  }

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
              <div class="session-key-block" aria-label="Filecoin session key">
                <h4 class="configure-section-title">Authorize upload (session key)</h4>
                <p class="configure-section-lead">
                  <a
                    href="https://docs.filecoin.cloud/developer-guides/session-keys/"
                    target="_blank"
                    rel="noopener noreferrer"
                    >Session keys</a
                  >
                  let FilStream sign PDP storage actions after you approve once in your wallet.
                </p>
                ${sessionAuthBusy
                  ? html`
                      <div class="session-auth-progress" role="status" aria-live="polite">
                        <span class="session-auth-spinner" aria-hidden="true"></span>
                        <div class="session-auth-progress-copy">
                          <strong class="session-auth-progress-title">${waitUi.title}</strong>
                          <p class="session-auth-progress-detail">${waitUi.detail}</p>
                        </div>
                      </div>
                    `
                  : null}
                ${sessionAuthReady
                  ? html`
                      <p class="session-auth-ok">
                        Session key is ready for upload.
                        ${sessionExpiresSummary
                          ? html`<span class="session-expiry"
                              >Earliest permission ends (UTC):
                              <strong>${sessionExpiresSummary}</strong></span
                            >`
                          : null}
                      </p>
                      ${typeof onAuthorizeSession === "function"
                        ? html`
                            <button
                              type="button"
                              class="btn btn-secondary session-refresh-btn"
                              ?disabled=${sessionBusy}
                              @click=${onAuthorizeSession}
                            >
                              Refresh session key
                            </button>
                            <p class="session-refresh-hint">
                              Signs a new on-chain authorization (about 1 hour). Use refresh after
                              reload if uploads fail with an expired session.
                            </p>
                          `
                        : null}
                    `
                  : html`
                      ${typeof onAuthorizeSession === "function"
                        ? html`
                            <div class="session-key-actions">
                              <button
                                type="button"
                                class="btn btn-primary session-authorize-btn"
                                ?disabled=${sessionBusy || !canAuthorizeSession}
                                @click=${onAuthorizeSession}
                              >
                                Authorize upload session
                              </button>
                              <button
                                type="button"
                                class="btn btn-secondary session-refresh-btn"
                                ?disabled=${sessionBusy || !canAuthorizeSession}
                                @click=${onAuthorizeSession}
                              >
                                Refresh session key
                              </button>
                            </div>
                            <p class="session-refresh-hint">
                              Signs a new on-chain authorization (about 1 hour). Use refresh after
                              reload if uploads fail with an expired session.
                            </p>
                          `
                        : null}
                    `}
                ${sessionAuthError
                  ? html`<p class="wallet-error" role="alert">${sessionAuthError}</p>`
                  : null}
                <p class="configure-section-lead configure-hint-subtle">
                  Ensure this wallet is on the same chain as FilStream config (see
                  <code>storeChainId</code>). You also need adequate Filecoin Pay / warm-storage
                  balance; deposit if an upload reports insufficient funds.
                </p>
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
          <li>Switch wallet to FilStream chain if prompted</li>
          <li>Session key login (one wallet confirmation)</li>
          <li>Fund warm storage if uploads require it</li>
        </ul>
      </div>
    </section>
  `;
}
