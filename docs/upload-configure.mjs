/**
 * Injected wallet UI via EIP-6963 discovery + `window.ethereum` fallback.
 */
import { html } from "https://cdn.jsdelivr.net/npm/lit-html@3.2.1/+esm";
import { spinnerLit } from "./spinner.mjs";

function shortAddress(addr) {
  if (!addr || addr.length < 12) return addr || "";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/**
 * @param {{
 *   show: boolean,
 *   fundGateComplete?: boolean,
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
 *   fundingReady?: boolean,
 *   fundingBusy?: boolean,
 *   fundingError?: string | null,
 *   fundingSummary?: string,
 *   fundingTxHash?: string,
 *   canAuthorizeSession?: boolean,
 *   onAuthorizeSession?: () => void | Promise<void>,
 *   onRefreshSessionKey?: () => void | Promise<void>,
 *   onRetryFundingCheck?: () => void | Promise<void>,
 * }} props
 */
export function uploadConfigurePanel(props) {
  if (!props.show) return null;

  const {
    fundGateComplete = false,
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
    fundingReady = false,
    fundingBusy = false,
    fundingError = null,
    fundingSummary = "",
    fundingTxHash = "",
    canAuthorizeSession = false,
    onAuthorizeSession,
    onRefreshSessionKey,
    onRetryFundingCheck,
  } = props;

  const connected = Boolean(walletAddress);
  const sessionBusy = Boolean(
    sessionAuthBusy || fundingBusy || walletBusy,
  );

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
        detail:
          "Approve the session-key transaction when your wallet prompts you.",
      };
    }
  }

  if (fundGateComplete && connected) {
    return html`
      <section
        class="upload-configure upload-configure--wallet-only"
        aria-label="Wallet connected"
      >
        <div class="wallet-injected-block">
          <div class="wallet-connected-row wallet-connected-row--fund">
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
          ${sessionExpiresSummary
            ? html`<p class="wallet-session-expiry">
                Session ends ${sessionExpiresSummary}
              </p>`
            : null}
        </div>
      </section>
    `;
  }

  return html`
    <section class="upload-configure" aria-label="Wallet and upload settings">
      <div class="wallet-injected-block">
        ${!connected
          ? html`
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
              <p
                class="configure-section-lead"
                title="EIP-6963 wallets are listed automatically; legacy window.ethereum when present."
              >
                Pick a wallet (EIP-6963 or legacy).
              </p>
            `
          : null}

        ${connected
          ? html`
              <div class="wallet-connected-row wallet-connected-row--fund">
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
              ${sessionAuthReady && sessionExpiresSummary
                ? html`<p class="wallet-session-expiry">
                    Session ends ${sessionExpiresSummary}
                  </p>`
                : null}
              ${!sessionAuthReady || sessionAuthBusy
                ? html`
                    <div class="session-key-block" aria-label="Filecoin session key">
                      ${!sessionAuthReady
                        ? html`
                            <h4 class="configure-section-title">Session key</h4>
                            <p class="configure-section-lead">
                              <a
                                href="https://docs.filecoin.cloud/developer-guides/session-keys/"
                                target="_blank"
                                rel="noopener noreferrer"
                                >What is this?</a
                              >
                              Registers who may sign uploads — it does not move money.
                            </p>
                          `
                        : null}
                      ${sessionAuthBusy
                        ? html`
                            <div class="session-auth-progress" role="status" aria-live="polite">
                              ${spinnerLit({ size: "sm" })}
                              <div class="session-auth-progress-copy">
                                <strong class="session-auth-progress-title">${waitUi.title}</strong>
                                <p class="session-auth-progress-detail">${waitUi.detail}</p>
                              </div>
                            </div>
                          `
                        : null}
                      ${!sessionAuthBusy && !sessionAuthReady
                        ? html`
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
                                  </div>
                                `
                              : null}
                          `
                        : null}
                      ${sessionAuthError
                        ? html`<p class="wallet-error" role="alert">${sessionAuthError}</p>`
                        : null}
                      ${!sessionAuthReady
                        ? html`
                            <p
                              class="configure-section-lead configure-hint-subtle"
                              title="Wallet network must match the FilStream store chain (storeChainId in config)."
                            >
                              Use the same network as FilStream in your wallet.
                            </p>
                          `
                        : null}
                    </div>
                  `
                : null}
              ${sessionAuthReady && typeof onRefreshSessionKey === "function" && fundingReady
                ? html`
                    <button
                      type="button"
                      class="btn btn-secondary btn-session-refresh-inline"
                      title="New on-chain authorization (~1h). Use after reload if uploads fail."
                      ?disabled=${sessionBusy || !canAuthorizeSession}
                      @click=${onRefreshSessionKey}
                    >
                      Refresh session key
                    </button>
                  `
                : null}
              ${sessionAuthReady
                ? html`
                    <div class="session-key-block" aria-label="Warm storage funding">
                      <h4 class="configure-section-title">Storage funds (FilecoinPay)</h4>
                      <p
                        class="configure-section-lead configure-hint-subtle"
                        title="Session key = signing. FilecoinPay = tUSDFC deposit and operator approval for warm storage."
                      >
                        One-time operator approval and tUSDFC deposit or top-up if your balance is short.
                      </p>
                      ${fundingBusy
                        ? html`
                            <div class="session-auth-progress" role="status" aria-live="polite">
                              ${spinnerLit({ size: "sm" })}
                              <div class="session-auth-progress-copy">
                                <strong class="session-auth-progress-title">Balance setup</strong>
                                <p class="session-auth-progress-detail">
                                  ${fundingSummary || "Checking account funds, lockup, and approvals…"}
                                </p>
                              </div>
                            </div>
                          `
                        : null}
                      ${fundingReady && !fundingBusy
                        ? html`
                            <p class="session-auth-ok">
                              Balance OK.
                              ${fundingSummary
                                ? html`<span class="session-expiry"
                                    ><strong>${fundingSummary}</strong></span
                                  >`
                                : null}
                              ${fundingTxHash
                                ? html`<span class="session-expiry"
                                    >Tx: <code>${fundingTxHash}</code></span
                                  >`
                                : null}
                            </p>
                          `
                        : null}
                      ${!fundingReady && !fundingBusy
                        ? html`
                            <p
                              class="configure-section-lead"
                              title="FilStream may request one upfront top-up: max(5 tUSDFC, 120% of estimated deposit)."
                            >
                              Checked automatically before you define the listing.
                            </p>
                          `
                        : null}
                      ${fundingError
                        ? html`<p class="wallet-error" role="alert">${fundingError}</p>`
                        : null}
                      ${typeof onRetryFundingCheck === "function" && !fundingBusy
                        ? html`
                            <button
                              type="button"
                              class="btn btn-secondary session-refresh-btn"
                              ?disabled=${sessionBusy || !connected}
                              @click=${onRetryFundingCheck}
                            >
                              Retry funding check
                            </button>
                          `
                        : null}
                    </div>
                  `
                : null}
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
