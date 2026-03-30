/**
 * Viewer playback page donate CTA (metadata-driven).
 */
import { LitElement, html } from "./lit-base.mjs";
import { donateConfigFromMeta } from "../filstream-viewer-donate.mjs";

export class ViewerPageDonate extends LitElement {
  static properties = {
    meta: { type: Object, attribute: false },
    donateBusy: { type: Boolean },
    donateError: { type: String },
    donateTxHash: { type: String },
  };

  constructor() {
    super();
    this.meta = null;
    this.donateBusy = false;
    this.donateError = "";
    this.donateTxHash = "";
  }

  createRenderRoot() {
    return this;
  }

  render() {
    const cfgLocal = donateConfigFromMeta(this.meta);
    if (!cfgLocal.enabled) {
      return html``;
    }
    return html`
      <div class="viewer-donate">
        <button
          type="button"
          class="btn btn-primary viewer-donate-btn"
          ?disabled=${this.donateBusy}
          @click=${this._onClick}
        >
          ${this.donateBusy
            ? "Connecting…"
            : `Donate ${cfgLocal.amountHuman} ${cfgLocal.token.symbol}`}
        </button>
        ${this.donateError
          ? html`<p class="viewer-donate-err" role="alert">${this.donateError}</p>`
          : null}
        ${this.donateTxHash
          ? html`<p class="viewer-donate-tx" aria-live="polite">
              Transaction sent: ${this.donateTxHash}
            </p>`
          : null}
      </div>
    `;
  }

  _onClick = () => {
    this.dispatchEvent(
      new CustomEvent("filstream-viewer-donate-click", {
        bubbles: true,
        composed: true,
      }),
    );
  };
}

customElements.define("viewer-page-donate", ViewerPageDonate);
