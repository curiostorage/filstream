/**
 * Viewer “about this video” block: title, date, byline, description, donate + share slots.
 */
import { LitElement, html } from "./lit-base.mjs";
import { buildCreatorUrlForAddress } from "../filstream-config.mjs";

function normalizeCreatorKey(addr) {
  return String(addr || "").trim().toLowerCase();
}

function normalizeAddressLabel(addr) {
  if (typeof addr !== "string") return "";
  const t = addr.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(t)) return t;
  return `${t.slice(0, 6)}…${t.slice(-4)}`;
}

/**
 * @param {Record<string, { username?: string, profileUrl?: string }>} profiles
 * @param {string} addr
 */
function profileStateForCreator(profiles, addr) {
  if (!profiles || typeof profiles !== "object") return null;
  return profiles[normalizeCreatorKey(addr)] ?? null;
}

/**
 * @param {Record<string, { username?: string, profileUrl?: string }>} profiles
 * @param {string} addr
 */
function profileUrlForCreator(profiles, addr) {
  const url = profileStateForCreator(profiles, addr)?.profileUrl ?? "";
  return typeof url === "string" && url.trim() !== "" ? url.trim() : "";
}

/**
 * @param {Record<string, { username?: string, profileUrl?: string }>} profiles
 * @param {string} addr
 */
function bylineNameForCreator(profiles, addr) {
  const hit = profileStateForCreator(profiles, addr)?.username ?? "";
  if (hit && hit.trim() !== "") return hit.trim();
  return normalizeAddressLabel(addr);
}

/**
 * @param {Record<string, { username?: string, profileUrl?: string }>} profiles
 * @param {string} addr
 */
function creatorInitialForAddress(profiles, addr) {
  const name = bylineNameForCreator(profiles, addr);
  const t = String(name || "").trim();
  if (!t) return "?";
  if (/^0x[a-fA-F0-9]{4,}$/.test(t)) {
    return t.slice(2, 3).toUpperCase();
  }
  return t.slice(0, 1).toUpperCase();
}

export class ViewerMetaBlock extends LitElement {
  static properties = {
    title: { type: String },
    description: { type: String },
    uploadDate: { type: String },
    creatorAddress: { type: String },
    creatorProfiles: { type: Object, attribute: false },
  };

  constructor() {
    super();
    this.title = "";
    this.description = "";
    this.uploadDate = "";
    this.creatorAddress = "";
    this.creatorProfiles = {};
  }

  createRenderRoot() {
    return this;
  }

  _avatar(creator, className) {
    const profiles = this.creatorProfiles;
    const url = profileUrlForCreator(profiles, creator);
    if (url) {
      return html`<img
        class=${className}
        alt=""
        loading="lazy"
        decoding="async"
        src=${url}
      />`;
    }
    return html`<div
      class=${`${className} viewer-creator-avatar--placeholder`}
      aria-hidden="true"
    >
      ${creatorInitialForAddress(profiles, creator)}
    </div>`;
  }

  render() {
    const creator = this.creatorAddress;
    const profiles = this.creatorProfiles;
    const creatorName = creator ? bylineNameForCreator(profiles, creator) : "";
    const desc = typeof this.description === "string" ? this.description.trim() : "";
    const when = this.uploadDate.trim();

    return html`
      <h1 id="viewer-title" class="broadcast-title">${this.title}</h1>
      <p id="viewer-upload-date" class="broadcast-upload-date" ?hidden=${!when}>
        ${when}
      </p>
      <div id="viewer-byline" class="viewer-byline" ?hidden=${!creatorName}>
        <div id="viewer-byline-catalog" class="viewer-byline-catalog">
          ${creatorName
            ? html`
                <div class="viewer-creator-cluster">
                  <a
                    class="viewer-creator-avatar-link"
                    href=${buildCreatorUrlForAddress(creator)}
                    title=${creatorName}
                  >
                    ${this._avatar(creator, "viewer-creator-avatar")}
                  </a>
                  <a class="viewer-creator-name" href=${buildCreatorUrlForAddress(creator)}
                    >${creatorName}</a
                  >
                </div>
              `
            : null}
        </div>
        <div class="viewer-byline-trailing">
          <viewer-page-donate id="viewer-donate-root" class="viewer-byline-donate"></viewer-page-donate>
          <viewer-share-actions
            id="viewer-actions"
            class="viewer-actions"
            aria-label="Share and embed"
          ></viewer-share-actions>
        </div>
      </div>
      <div class="viewer-description-box">
        <div id="viewer-description" class="broadcast-description">
          ${desc
            ? html`<p class="broadcast-desc-body">${desc}</p>`
            : html`<p class="broadcast-desc-empty">No description</p>`}
        </div>
      </div>
    `;
  }
}

customElements.define("viewer-meta-block", ViewerMetaBlock);
