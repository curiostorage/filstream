/**
 * Single movie tile matching the catalog Discover card.
 */
import { LitElement, html, nothing, css } from "https://cdn.jsdelivr.net/npm/lit@3.2.1/+esm";

function normalizeAddressLabel(addr) {
  if (typeof addr !== "string") return "";
  const t = addr.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(t)) return t;
  return `${t.slice(0, 6)}…${t.slice(-4)}`;
}

function creatorInitialFromLabel(name) {
  const t = String(name || "").trim();
  if (!t) return "?";
  if (/^0x[a-fA-F0-9]{4,}$/.test(t)) {
    return t.slice(2, 3).toUpperCase();
  }
  return t.slice(0, 1).toUpperCase();
}

export class MovieLinkShowcase extends LitElement {
  static styles = css`
    :host {
      display: block;
      min-width: 0;
    }

    .viewer-catalog-card {
      display: flex;
      flex-direction: column;
      min-width: 0;
      text-decoration: none;
      color: inherit;
      border-radius: 12px;
      border: 1px solid rgb(52 56 64 / 0.95);
      background: #171b23;
      overflow: hidden;
      transition: transform 0.12s ease, border-color 0.12s ease, background 0.12s ease;
    }

    .viewer-catalog-card:hover {
      transform: translateY(-1px);
      border-color: rgb(96 156 255 / 0.8);
      background: #1a1f28;
    }

    .viewer-catalog-card:focus-visible {
      outline: 2px solid #18c8ff;
      outline-offset: 2px;
    }

    .viewer-catalog-card--current {
      border-color: rgb(24 200 255 / 0.8);
      box-shadow: inset 0 0 0 1px rgb(24 200 255 / 0.5);
    }

    .viewer-catalog-card-thumb-wrap {
      position: relative;
      aspect-ratio: 16 / 9;
      background: #232935;
    }

    .viewer-catalog-card-watched-bar {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: 2px;
      background: #f03;
      pointer-events: none;
      z-index: 6;
    }

    .viewer-catalog-card-thumb-wrap--anim .viewer-catalog-card-thumb--still,
    .viewer-catalog-card-thumb-wrap--anim .viewer-catalog-card-thumb--motion {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      transition: opacity 0.15s ease;
      z-index: 1;
    }

    .viewer-catalog-card-thumb-wrap--anim .viewer-catalog-card-thumb--motion {
      opacity: 0;
      pointer-events: none;
    }

    .viewer-catalog-card:hover .viewer-catalog-card-thumb-wrap--anim .viewer-catalog-card-thumb--motion {
      opacity: 1;
    }

    .viewer-catalog-card:hover .viewer-catalog-card-thumb-wrap--anim .viewer-catalog-card-thumb--still {
      opacity: 0;
    }

    .viewer-catalog-card-thumb {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    .viewer-catalog-card-body {
      display: flex;
      flex-direction: column;
      gap: 0.45rem;
      padding: 0.58rem 0.65rem 0.7rem;
    }

    .viewer-catalog-card-title {
      font-size: 0.9rem;
      line-height: 1.3;
      color: #e8eaed;
      word-wrap: break-word;
      overflow-wrap: break-word;
    }

    .viewer-catalog-card-creator {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      min-width: 0;
    }

    .viewer-catalog-card-creator-avatar {
      width: 17px;
      height: 17px;
      border-radius: 4px;
      object-fit: cover;
      flex-shrink: 0;
      box-shadow: 0 0 0 1px rgb(60 64 67 / 0.45);
    }

    .viewer-catalog-card-creator-avatar.viewer-creator-avatar--placeholder {
      display: flex;
      align-items: center;
      justify-content: center;
      background: #2d3139;
      color: #bdc1c6;
      font-size: 0.62rem;
      font-weight: 600;
    }

    .viewer-catalog-card-creator-name {
      font-size: 0.78rem;
      line-height: 1.2;
      color: #a8afb9;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    :host-context(.catalog-app--watch) .viewer-catalog-card--watch {
      flex-direction: row;
    }

    :host-context(.catalog-app--watch) .viewer-catalog-card--watch .viewer-catalog-card-thumb-wrap {
      width: 150px;
      flex-shrink: 0;
    }

    :host-context(.catalog-app--watch) .viewer-catalog-card--watch .viewer-catalog-card-body {
      justify-content: center;
    }
  `;

  static properties = {
    assetId: { type: String, attribute: "asset-id" },
    href: { type: String },
    /** Video title (not the HTML `title` attribute). */
    videoTitle: { type: String, attribute: "video-title" },
    showCreator: { type: Boolean, attribute: "show-creator" },
    creatorAddress: { type: String, attribute: "creator-address" },
    /** Display name or short address; shown when `showCreator` is true. */
    creatorDisplayName: { type: String, attribute: "creator-display-name" },
    /** Optional resolved profile image URL for the creator avatar. */
    creatorAvatarUrl: { type: String, attribute: "creator-avatar-url" },
    /** `"discover"` (default) or `"watch"`. */
    variant: { type: String },
    /** Highlight when this row is the active video (watch UI). */
    current: { type: Boolean, reflect: true },
    /** User has reached ≥95% playback (local watch history). */
    watched95: { type: Boolean, attribute: "watched-95" },
    /** Open the viewer in a new tab (e.g. creator channel list). */
    openInNewTab: { type: Boolean, attribute: "open-in-new-tab" },
  };

  constructor() {
    super();
    this.assetId = "";
    this.href = "";
    this.videoTitle = "";
    this.showCreator = false;
    this.creatorAddress = "";
    this.creatorDisplayName = "";
    this.creatorAvatarUrl = "";
    this.variant = "discover";
    this.current = false;
    this.watched95 = false;
    this.openInNewTab = false;
  }

  render() {
    const safeTitle =
      String(this.videoTitle ?? "").trim() ||
      String(this.assetId ?? "").trim() ||
      "Untitled";
    const creatorLabel =
      String(this.creatorDisplayName ?? "").trim() ||
      normalizeAddressLabel(this.creatorAddress);
    const showCreator = this.showCreator && Boolean(String(this.creatorAddress ?? "").trim());

    const cardClass = [
      "viewer-catalog-card",
      this.variant === "watch" ? "viewer-catalog-card--watch" : "",
      this.current ? "viewer-catalog-card--current" : "",
    ]
      .filter(Boolean)
      .join(" ");

    return html`
      <a
        class=${cardClass}
        href=${this.href}
        title=${safeTitle}
        target=${this.openInNewTab ? "_blank" : nothing}
        rel=${this.openInNewTab ? "noopener noreferrer" : nothing}
      >
        <div class="viewer-catalog-card-thumb-wrap">
          <img
            class="viewer-catalog-card-thumb viewer-catalog-card-thumb--still"
            alt=""
            loading="lazy"
            decoding="async"
            data-video-id=${this.assetId || nothing}
          />
          ${this.watched95
            ? html`<div class="viewer-catalog-card-watched-bar" aria-hidden="true"></div>`
            : nothing}
        </div>
        <div class="viewer-catalog-card-body">
          <div class="viewer-catalog-card-title">${safeTitle}</div>
          ${showCreator
            ? html`
                <div class="viewer-catalog-card-creator">
                  ${this.creatorAvatarUrl
                    ? html`<img
                        class="viewer-catalog-card-creator-avatar"
                        src=${this.creatorAvatarUrl}
                        alt=""
                        loading="lazy"
                        decoding="async"
                      />`
                    : html`<div
                        class="viewer-catalog-card-creator-avatar viewer-creator-avatar--placeholder"
                        aria-hidden="true"
                      >
                        ${creatorInitialFromLabel(creatorLabel)}
                      </div>`}
                  <span class="viewer-catalog-card-creator-name">${creatorLabel}</span>
                </div>
              `
            : nothing}
        </div>
      </a>
    `;
  }
}

customElements.define("movie-link-showcase", MovieLinkShowcase);

/**
 * Wait for `movie-link-showcase` elements under `root` to finish Lit's pending update so
 * shadow DOM (poster `<img>`, etc.) exists before imperative hydration runs.
 *
 * @param {ParentNode | null | undefined} root
 * @returns {Promise<void>}
 */
export async function awaitMovieLinkShowcaseUpdates(root) {
  if (!root) return;
  const hosts = root.querySelectorAll("movie-link-showcase");
  await Promise.all(
    [...hosts].map((node) => {
      const el = /** @type {{ updateComplete?: Promise<unknown> }} */ (node);
      const p = el.updateComplete;
      return typeof p?.then === "function" ? p.catch(() => {}) : Promise.resolve();
    }),
  );
}
