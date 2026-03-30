/**
 * Owner video delete list — light DOM so `creator.css` applies.
 * Dispatches `filstream-delete-entry` with `detail.entryId` (number).
 */
import { LitElement, html } from "./lit-base.mjs";

export class CreatorMovieEditList extends LitElement {
  static properties = {
    /** @type {import("../filstream-catalog-chain.mjs").CatalogEntry[]} */
    entries: { type: Array },
    /** @type {Record<number, boolean>} */
    deleteBusy: { type: Object },
  };

  constructor() {
    super();
    this.entries = [];
    this.deleteBusy = {};
  }

  createRenderRoot() {
    return this;
  }

  render() {
    return html`
      <ul class="creator-movie-edit-list">
        ${this.entries.map(
          (entry) => html`
            <li class="creator-movie-edit-row">
              <span class="creator-movie-edit-title"
                >${entry.active ? entry.title : `${entry.title} (removed)`}</span
              >
              <div class="creator-movie-edit-actions">
                ${entry.active
                  ? html`
                      <button
                        type="button"
                        class="creator-row-btn creator-row-btn--danger"
                        ?disabled=${Boolean(this.deleteBusy[entry.entryId])}
                        @click=${() =>
                          this.dispatchEvent(
                            new CustomEvent("filstream-delete-entry", {
                              detail: { entryId: entry.entryId },
                              bubbles: true,
                              composed: true,
                            }),
                          )}
                      >
                        ${this.deleteBusy[entry.entryId] ? "Removing…" : "Remove"}
                      </button>
                    `
                  : null}
              </div>
            </li>
          `,
        )}
      </ul>
    `;
  }
}

customElements.define("creator-movie-edit-list", CreatorMovieEditList);
