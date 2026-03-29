/**
 * FilStream name, tagline, and logo — shared by the wizard (`ui.mjs`) and `viewer/viewer.mjs`.
 */
import { html } from "https://cdn.jsdelivr.net/npm/lit-html@3.2.1/+esm";
import {
  buildCreatorUrlForAddress,
  buildDiscoverHomeUrlWithSearchQuery,
  getFilstreamStoreConfig,
} from "./filstream-config.mjs";
import {
  readCatalogProfilePicturePieceCid,
  resolveManifestUrl,
} from "./filstream-catalog-chain.mjs";
import { FILSTREAM_BRAND as SHARED_FILSTREAM_BRAND } from "./filstream-constants.mjs";
import { loadWalletFromStorage } from "./session-key-storage.mjs";

export const FILSTREAM_BRAND = SHARED_FILSTREAM_BRAND;

/** @type {string} */
const GLOBAL_SEARCH_ID = "filstream-global-search";

/** @returns {string} e.g. `FilStream — CalibrationNet edition` */
export function filstreamBrandFullTitle() {
  return `${FILSTREAM_BRAND.name} — ${FILSTREAM_BRAND.tagline}`;
}

/**
 * Public project / docs site (matches `viewBaseUrl`, default GitHub Pages).
 * @returns {string}
 */
export function projectSiteHref() {
  const u = getFilstreamStoreConfig().viewBaseUrl.trim();
  if (u) return u.endsWith("/") ? u : `${u}/`;
  return "https://curiostorage.github.io/filstream/";
}

const APP_NAV_LINKS = /** @type {const} */ ([
  { id: "upload", label: "Upload", file: "upload.html" },
  { id: "creator", label: "My Profile", file: "creator.html" },
]);

/**
 * @returns {{ id: string, label: string, href: string }[]}
 */
export function filstreamAppNavLinks() {
  return APP_NAV_LINKS.map((link) => ({
    id: link.id,
    label: link.label,
    href: link.file,
  }));
}

/**
 * @param {string} pieceCid
 * @returns {Promise<string>}
 */
async function resolveProfilePictureUrlForPieceCid(pieceCid) {
  const cid = String(pieceCid || "").trim();
  if (!cid) return "";
  try {
    const cfg = getFilstreamStoreConfig();
    return await resolveManifestUrl(cfg.storeProviderId, cid);
  } catch {
    return "";
  }
}

/**
 * Replaces "My Profile" text with a poster thumb when available.
 *
 * @param {HTMLElement | null} root
 */
export async function hydrateFilstreamHeaderProfile(root) {
  if (!root) return;
  const link = root.querySelector(".site-header-profile");
  if (!(link instanceof HTMLAnchorElement)) return;
  if (link.querySelector(".site-header-profile-img")) return;

  const wallet = loadWalletFromStorage();
  const addr = wallet?.address && typeof wallet.address === "string" ? wallet.address.trim() : "";
  if (addr) {
    link.href = buildCreatorUrlForAddress(addr);
  }

  let pieceCid = "";
  if (/^0x[a-fA-F0-9]{40}$/.test(addr)) {
    try {
      pieceCid = await readCatalogProfilePicturePieceCid(addr);
    } catch {
      /* ignore */
    }
  }
  const picUrl = pieceCid ? await resolveProfilePictureUrlForPieceCid(pieceCid) : "";
  if (!picUrl) return;

  link.classList.add("site-header-profile--thumb");
  link.textContent = "";
  link.setAttribute("aria-label", "My Profile");
  const img = document.createElement("img");
  img.className = "site-header-profile-img";
  img.src = picUrl;
  img.alt = "";
  img.width = 32;
  img.height = 32;
  img.decoding = "async";
  link.appendChild(img);
}

function navigateHomeWithSearchQuery(raw) {
  globalThis.location.href = buildDiscoverHomeUrlWithSearchQuery(raw);
}

/**
 * Lit: header link + logo + title stack (classes match `style.css` `.site-brand`).
 */
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
 * Lit: full app header (brand + centered search + nav).
 *
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
                >${link.label}</a
              >
            `,
          )}
        </nav>
      </div>
    </div>
  `;
}

function createBrandAnchor(href, title) {
  const a = document.createElement("a");
  a.className = "site-brand";
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.title = title;
  a.setAttribute("aria-label", `${title} (project site)`);

  const img = document.createElement("img");
  img.className = "site-brand-mark";
  img.src = FILSTREAM_BRAND.logoSrc;
  img.width = 40;
  img.height = 40;
  img.alt = "";
  img.decoding = "async";

  const textWrap = document.createElement("div");
  textWrap.className = "site-brand-text";
  const name = document.createElement("span");
  name.className = "site-brand-name";
  name.textContent = FILSTREAM_BRAND.name;
  const tag = document.createElement("span");
  tag.className = "site-brand-tagline";
  tag.textContent = FILSTREAM_BRAND.tagline;
  textWrap.append(name, tag);

  a.append(img, textWrap);
  return a;
}

/**
 * Vanilla DOM: append full app header into `container`.
 *
 * @param {HTMLElement} container
 * @param {{ active?: string, href?: string, searchManaged?: boolean }} [opts]
 *   When `searchManaged` is true, search is wired by the viewer (no Enter navigation).
 */
export function mountFilstreamHeader(container, opts = {}) {
  const active = typeof opts.active === "string" ? opts.active : "";
  const href = opts.href ?? projectSiteHref();
  const title = filstreamBrandFullTitle();
  const searchManaged = opts.searchManaged === true;

  const shell = document.createElement("div");
  shell.className = "site-header-shell";
  shell.dataset.filstreamHeader = "";

  const bar = document.createElement("div");
  bar.className = "site-header-bar site-header-bar--with-search";

  const start = document.createElement("div");
  start.className = "site-header-bar-start";
  start.appendChild(createBrandAnchor(href, title));

  const searchWrap = document.createElement("div");
  searchWrap.className = "site-header-search-wrap";
  const search = document.createElement("input");
  search.type = "search";
  search.id = GLOBAL_SEARCH_ID;
  search.className = "site-header-search";
  search.placeholder = "Search by creator name or wallet";
  search.autocomplete = "off";
  search.spellcheck = false;
  search.setAttribute("aria-label", "Search catalog");

  const icon = document.createElement("span");
  icon.className = "site-header-search-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" xmlns="http://www.w3.org/2000/svg"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3-3" stroke-linecap="round"/></svg>`;
  searchWrap.append(search, icon);

  if (!searchManaged) {
    search.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      navigateHomeWithSearchQuery(search.value);
    });
  }

  const nav = document.createElement("nav");
  nav.className = "site-header-nav";
  nav.setAttribute("aria-label", "FilStream pages");
  for (const link of filstreamAppNavLinks()) {
    const a = document.createElement("a");
    const isProfile = link.id === "creator";
    a.className = isProfile
      ? `site-header-link site-header-profile${active === link.id ? " is-active" : ""}`
      : `site-header-link${active === link.id ? " is-active" : ""}`;
    a.href = link.href;
    if (isProfile) {
      const span = document.createElement("span");
      span.className = "site-header-profile-label";
      span.textContent = link.label;
      a.appendChild(span);
    } else {
      a.textContent = link.label;
    }
    nav.appendChild(a);
  }

  bar.append(start, searchWrap, nav);
  shell.appendChild(bar);
  container.replaceChildren(shell);
  void hydrateFilstreamHeaderProfile(shell);
}
