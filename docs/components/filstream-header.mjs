/**
 * App shell header: brand, search, nav — light DOM so `style.css` / page CSS apply.
 */
import { LitElement, html } from "./lit-base.mjs";
import { buildDiscoverHomeUrlWithSearchQuery } from "../filstream-config.mjs";
import {
  hydrateFilstreamHeaderProfile,
  filstreamAppNavLinks,
  filstreamBrandFullTitle,
  projectSiteHref,
} from "../filstream-brand.mjs";
import { FILSTREAM_BRAND } from "../filstream-constants.mjs";

/** @type {string} */
const GLOBAL_SEARCH_ID = "filstream-global-search";

function navigateHomeWithSearchQuery(raw) {
  globalThis.location.href = buildDiscoverHomeUrlWithSearchQuery(raw);
}

export function filstreamBrandLit() {
  const href = projectSiteHref();
  const title = filstreamBrandFullTitle();
  return html`
    <a
      class="site-brand"
      href=${href}
      target="_blank"
      rel="noopener noreferrer"
      title=${title}
      aria-label="${title} (project site)"
    >
      <img
        class="site-brand-mark"
        src=${FILSTREAM_BRAND.logoSrc}
        width="40"
        height="40"
        alt=""
        decoding="async"
      />
      <div class="site-brand-text">
        <span class="site-brand-name">${FILSTREAM_BRAND.name}</span>
        <span class="site-brand-tagline">${FILSTREAM_BRAND.tagline}</span>
      </div>
    </a>
  `;
}

/**
 * @param {{ active?: string, searchManaged?: boolean }} [opts]
 */
export function filstreamHeaderLit(opts = {}) {
  const active = typeof opts.active === "string" ? opts.active : "";
  const searchManaged = opts.searchManaged === true;
  const links = filstreamAppNavLinks();
  return html`
    <div class="site-header-shell" data-filstream-header>
      <div class="site-header-bar site-header-bar--with-search">
        <div class="site-header-bar-start">${filstreamBrandLit()}</div>
        <div class="site-header-search-wrap">
          <input
            type="search"
            id=${GLOBAL_SEARCH_ID}
            class="site-header-search"
            placeholder="Search by creator name or wallet"
            autocomplete="off"
            spellcheck="false"
            aria-label="Search catalog"
            @keydown=${(e) => {
              if (searchManaged) return;
              if (/** @type {KeyboardEvent} */ (e).key !== "Enter") return;
              e.preventDefault();
              const el = /** @type {HTMLInputElement} */ (e.target);
              navigateHomeWithSearchQuery(el.value);
            }}
          />
          <span class="site-header-search-icon" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3-3" stroke-linecap="round" />
            </svg>
          </span>
        </div>
        <nav class="site-header-nav" aria-label="FilStream pages">
          ${links.map(
            (link) => html`
              <a
                class=${`site-header-link${active === link.id ? " is-active" : ""}${
                  link.id === "creator" ? " site-header-profile" : ""
                }`}
                href=${link.href}
                >${link.id === "creator"
                  ? html`<span class="site-header-profile-label">${link.label}</span>`
                  : link.label}</a
              >
            `,
          )}
        </nav>
      </div>
    </div>
  `;
}

export class FilstreamHeader extends LitElement {
  static properties = {
    active: { type: String },
    searchManaged: { type: Boolean },
  };

  constructor() {
    super();
    this.active = "";
    this.searchManaged = false;
  }

  createRenderRoot() {
    return this;
  }

  firstUpdated() {
    void hydrateFilstreamHeaderProfile(this.querySelector("[data-filstream-header]"));
  }

  updated(changed) {
    if (changed.has("active") || changed.has("searchManaged")) {
      void hydrateFilstreamHeaderProfile(this.querySelector("[data-filstream-header]"));
    }
  }

  render() {
    return filstreamHeaderLit({
      active: this.active,
      searchManaged: this.searchManaged,
    });
  }
}

/**
 * @param {HTMLElement} container
 * @param {{ active?: string, searchManaged?: boolean }} [opts]
 */
export function mountFilstreamHeader(container, opts = {}) {
  const el = document.createElement("filstream-header");
  el.active = typeof opts.active === "string" ? opts.active : "";
  el.searchManaged = opts.searchManaged === true;
  container.replaceChildren(el);
  queueMicrotask(() =>
    void hydrateFilstreamHeaderProfile(el.querySelector("[data-filstream-header]")),
  );
}

customElements.define("filstream-header", FilstreamHeader);
