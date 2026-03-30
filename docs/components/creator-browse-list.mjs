/**
 * Browse creators strip — light DOM so `creator.css` applies.
 */
import { LitElement, html } from "./lit-base.mjs";
import { buildCreatorUrlForAddress } from "../filstream-config.mjs";

function shortAddress(addr) {
  if (!addr) return "";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export class CreatorBrowseList extends LitElement {
  static properties = {
    connected: { type: Boolean },
    creators: { type: Array },
  };

  constructor() {
    super();
    this.connected = false;
    /** @type {{ creator: string, activeCount: number, latestCreatedAt: number, username: string }[]} */
    this.creators = [];
  }

  createRenderRoot() {
    return this;
  }

  render() {
    if (this.connected) {
      return html``;
    }
    if (!this.creators.length) {
      return html`<p class="creator-status">No creators found yet.</p>`;
    }
    return html`
      ${this.creators.map(
        (row) => html`
          <a class="creator-browse-card" href=${buildCreatorUrlForAddress(row.creator)}>
            <span class="creator-browse-card-name"
              >${row.username || shortAddress(row.creator)}</span
            >
            <span class="creator-browse-card-meta"
              >${row.activeCount} video${row.activeCount === 1 ? "" : "s"} ·
              ${shortAddress(row.creator)}</span
            >
          </a>
        `,
      )}
    `;
  }
}

customElements.define("creator-browse-list", CreatorBrowseList);
