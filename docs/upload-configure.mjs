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
 *   onRetryFundingCheck?: () => void | Promise<void>,
 *   fundingPrompt?: { headline: string, lines: string[] } | null,
 *   onFundingPromptContinue?: () => void | Promise<void>,
 *   onFundingPromptCancel?: () => void | Promise<void>,
 *   setupConfirmPrompt?: { headline: string, lines: string[], declineReason: string } | null,
 *   onSetupConfirmContinue?: () => void | Promise<void>,
 *   onSetupConfirmCancel?: () => void | Promise<void>,
 * }} props
 */
export function uploadConfigurePanel(props) {
  if (!props.show) return null;

  const {
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
    onRetryFundingCheck,
    fundingPrompt = null,
    onFundingPromptContinue,
    onFundingPromptCancel,
    setupConfirmPrompt = null,
    onSetupConfirmContinue,
    onSetupConfirmCancel,
  } = props;

  const connected = Boolean(walletAddress);
  const fundingAwaitingConfirm = Boolean(fundingPrompt);
  const setupAwaitingConfirm = Boolean(setupConfirmPrompt);
  const sessionBusy = Boolean(
    sessionAuthBusy ||
      fundingBusy ||
      walletBusy ||
      fundingAwaitingConfirm ||
      setupAwaitingConfirm,
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
        detail: "Approve the session-key transaction when your wallet prompts you.",
      };
    }
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
                  — one approval, then PDP signing.
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
                ${!sessionAuthBusy && setupAwaitingConfirm && setupConfirmPrompt
                  ? html`
                      <div
                        class="funding-prompt-inline"
                        role="region"
                        aria-labelledby="setup-confirm-heading"
                      >
                        <h5 id="setup-confirm-heading" class="funding-prompt-head">
                          ${setupConfirmPrompt.headline}
                        </h5>
                        ${setupConfirmPrompt.lines.length
                          ? html`
                              <ul class="funding-prompt-lines">
                                ${setupConfirmPrompt.lines.map(
                                  (line) =>
                                    html`<li class="funding-prompt-line">${line}</li>`,
                                )}
                              </ul>
                            `
                          : null}
                        <p class="funding-prompt-note" title="Cancel returns to file selection.">
                          Cancel stops setup.
                        </p>
                        <div class="funding-prompt-actions">
                          <button
                            type="button"
                            class="btn btn-primary funding-prompt-continue"
                            @click=${onSetupConfirmContinue}
                          >
                            Continue
                          </button>
                          <button
                            type="button"
                            class="btn btn-secondary funding-prompt-cancel"
                            @click=${onSetupConfirmCancel}
                          >
                            Cancel upload setup
                          </button>
                        </div>
                      </div>
                    `
                  : null}
                ${!sessionAuthBusy && !setupAwaitingConfirm
                  ? sessionAuthReady
                    ? html`
                        <p class="session-auth-ok">
                          Session key is ready for upload.
                          ${sessionExpiresSummary
                            ? html`<span class="session-expiry"
                                >Earliest permission ends:
                                <strong>${sessionExpiresSummary}</strong></span
                              >`
                            : null}
                        </p>
                        ${typeof onAuthorizeSession === "function"
                          ? html`
                              <button
                                type="button"
                                class="btn btn-secondary session-refresh-btn"
                                title="New on-chain authorization (~1h). Use after reload if uploads fail."
                                ?disabled=${sessionBusy}
                                @click=${onAuthorizeSession}
                              >
                                Refresh session key
                              </button>
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
                                  title="New on-chain authorization (~1h). Use after reload if uploads fail."
                                  ?disabled=${sessionBusy || !canAuthorizeSession}
                                  @click=${onAuthorizeSession}
                                >
                                  Refresh session key
                                </button>
                              </div>
                            `
                          : null}
                      `
                  : null}
                ${sessionAuthError
                  ? html`<p class="wallet-error" role="alert">${sessionAuthError}</p>`
                  : null}
                <p
                  class="configure-section-lead configure-hint-subtle"
                  title="Wallet chain must match storeChainId. One upfront warm-storage funding tx before encode."
                >
                  Chain must match <code>storeChainId</code>.
                </p>
              </div>
              <div class="session-key-block" aria-label="Warm storage funding">
                <h4 class="configure-section-title">Funding check</h4>
                ${fundingBusy
                  ? html`
                      <div class="session-auth-progress" role="status" aria-live="polite">
                        <span class="session-auth-spinner" aria-hidden="true"></span>
                        <div class="session-auth-progress-copy">
                          <strong class="session-auth-progress-title">Preparing warm storage</strong>
                          <p class="session-auth-progress-detail">
                            ${fundingSummary || "Checking account funds, lockup, and approvals…"}
                          </p>
                        </div>
                      </div>
                    `
                  : null}
                ${fundingReady && !fundingAwaitingConfirm
                  ? html`
                      <p class="session-auth-ok">
                        Funding check passed.
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
                ${fundingAwaitingConfirm && fundingPrompt && !fundingBusy
                  ? html`
                      <div
                        class="funding-prompt-inline"
                        role="region"
                        aria-labelledby="funding-prompt-heading"
                      >
                        <h5 id="funding-prompt-heading" class="funding-prompt-head">
                          ${fundingPrompt.headline}
                        </h5>
                        <ul class="funding-prompt-lines">
                          ${fundingPrompt.lines.map(
                            (line) => html`<li class="funding-prompt-line">${line}</li>`,
                          )}
                        </ul>
                        <p class="funding-prompt-note" title="Cancel returns to file selection.">
                          Copy amounts above if needed. Cancel stops setup.
                        </p>
                        <div class="funding-prompt-actions">
                          <button
                            type="button"
                            class="btn btn-primary funding-prompt-continue"
                            @click=${onFundingPromptContinue}
                          >
                            Continue with funding
                          </button>
                          <button
                            type="button"
                            class="btn btn-secondary funding-prompt-cancel"
                            @click=${onFundingPromptCancel}
                          >
                            Cancel upload setup
                          </button>
                        </div>
                      </div>
                    `
                  : null}
                ${!fundingReady && !fundingBusy && !fundingAwaitingConfirm
                  ? html`
                      <p
                        class="configure-section-lead"
                        title="FilStream may request one upfront top-up: max(5 tUSDFC, 120% of estimated deposit)."
                      >
                        One funding check before Define.
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
