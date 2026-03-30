/**
 * Public catalog movie grid rows — light DOM so `creator.css` applies.
 */
import { LitElement, html } from "./lit-base.mjs";
import { buildViewerUrlForVideoId } from "../filstream-config.mjs";

export class CreatorMovieList extends LitElement {
  static properties = {
    /** @type {import("../filstream-catalog-chain.mjs").CatalogEntry[]} */
    entries: { type: Array },
  };

  constructor() {
    super();
    this.entries = [];
  }

  createRenderRoot() {
    return this;
  }

  render() {
    if (!this.entries.length) {
      return html`<p class="creator-status">No active videos.</p>`;
    }
    return html`
      ${this.entries.map(
        (entry) => html`
          <a
            class="creator-catalog-row"
            href=${buildViewerUrlForVideoId(entry.assetId)}
            target="_blank"
            rel="noopener noreferrer"
          >
            <div class="creator-catalog-poster-wrap">
              <img
                class="creator-catalog-poster creator-catalog-poster--still"
                alt=""
                loading="lazy"
                decoding="async"
              />
            </div>
            <div class="creator-catalog-title">${entry.title}</div>
          </a>
        `,
      )}
    `;
  }
}

customElements.define("creator-movie-list", CreatorMovieList);
