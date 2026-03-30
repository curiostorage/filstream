/**
 * Share + embed copy buttons (viewer meta rail).
 */
import { LitElement, html } from "./lit-base.mjs";
import { buildViewerUrlForVideoId } from "../filstream-config.mjs";

export class ViewerShareActions extends LitElement {
  static properties = {
    videoId: { type: String },
    embed: { type: Boolean },
  };

  constructor() {
    super();
    this.videoId = "";
    this.embed = false;
  }

  createRenderRoot() {
    return this;
  }

  render() {
    if (this.embed || !this.videoId) {
      this.hidden = true;
      return html``;
    }
    this.hidden = false;
    return html`
      <button
        type="button"
        class="viewer-action-btn--round"
        title="Copy share URL"
        aria-label="Copy share URL"
        @click=${this._onShare}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M18 16a3 3 0 0 0-2.816 1.98L8.91 14.77a3.02 3.02 0 0 0 0-1.54l6.273-3.21A3 3 0 1 0 14 8a3.02 3.02 0 0 0 .09.77L7.816 12A3 3 0 1 0 8 15a3.02 3.02 0 0 0-.09-.77l6.273 3.21A3 3 0 1 0 18 16Z"
          />
        </svg>
      </button>
      <button
        type="button"
        class="viewer-action-btn--round"
        title="Copy embed URL"
        aria-label="Copy embed URL"
        @click=${this._onEmbed}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="m8.6 16.6 1.4-1.4L6.8 12 10 8.8 8.6 7.4 4 12l4.6 4.6Zm6.8 0L20 12l-4.6-4.6-1.4 1.4L17.2 12 14 15.2l1.4 1.4Z"
          />
        </svg>
      </button>
    `;
  }

  _emitStatus(message, kind) {
    this.dispatchEvent(
      new CustomEvent("filstream-viewer-status", {
        detail: { message, kind },
        bubbles: true,
        composed: true,
      }),
    );
  }

  _onShare = async () => {
    const videoId = this.videoId;
    if (!videoId) return;
    try {
      const url = buildViewerUrlForVideoId(videoId);
      const mode = await copyTextToClipboardBestEffort(url);
      if (mode === "clipboard") {
        this._emitStatus("Share URL copied.", "");
      } else if (mode === "prompt") {
        this._emitStatus("Share URL ready to copy.", "");
      } else {
        this._emitStatus("Share copy cancelled.", "err");
      }
    } catch {
      this._emitStatus("Could not copy share URL.", "err");
    }
  };

  _onEmbed = async () => {
    const videoId = this.videoId;
    if (!videoId) return;
    try {
      const url = buildViewerUrlForVideoId(videoId, { embed: true });
      const mode = await copyTextToClipboardBestEffort(url);
      if (mode === "clipboard") {
        this._emitStatus("Embed URL copied.", "");
      } else if (mode === "prompt") {
        this._emitStatus("Embed URL ready to copy.", "");
      } else {
        this._emitStatus("Embed copy cancelled.", "err");
      }
    } catch {
      this._emitStatus("Could not copy embed URL.", "err");
    }
  };
}

/**
 * @param {string} text
 */
async function copyTextToClipboardBestEffort(text) {
  const t = String(text || "");
  if (!t) throw new Error("Nothing to copy");
  if (
    typeof navigator !== "undefined" &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === "function"
  ) {
    try {
      await navigator.clipboard.writeText(t);
      return "clipboard";
    } catch {
      /* fall through */
    }
  }
  const shown = window.prompt("Copy URL", t);
  return shown === null ? "cancelled" : "prompt";
}

customElements.define("viewer-share-actions", ViewerShareActions);
