/**
 * FilStream name, tagline, and logo — shared by the wizard (`ui.mjs`) and `viewer/viewer.mjs`.
 */
import { html } from "https://cdn.jsdelivr.net/npm/lit-html@3.2.1/+esm";
import { getFilstreamStoreConfig, resolveViewerIndexPageUrl } from "./filstream-config.mjs";
import { FILSTREAM_BRAND as SHARED_FILSTREAM_BRAND } from "./filstream-constants.mjs";

export const FILSTREAM_BRAND = SHARED_FILSTREAM_BRAND;

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
  { id: "home", label: "Home", file: "index.html" },
  { id: "upload", label: "Upload", file: "upload.html" },
  { id: "viewer", label: "Viewer", file: "viewer.html" },
  { id: "creator", label: "Creator", file: "creator.html" },
]);

/**
 * @returns {{ id: string, label: string, href: string }[]}
 */
export function filstreamAppNavLinks() {
  const base = resolveViewerIndexPageUrl();
  return APP_NAV_LINKS.map((link) => ({
    id: link.id,
    label: link.label,
    href: new URL(link.file, base).href,
  }));
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
 * Lit: full app header (brand + top nav links).
 *
 * @param {{ active?: string }} [opts]
 */
export function filstreamHeaderLit(opts = {}) {
  const active = typeof opts.active === "string" ? opts.active : "";
  const links = filstreamAppNavLinks();
  return html`
    <div class="site-header-bar">
      ${filstreamBrandLit()}
      <nav class="site-header-nav" aria-label="FilStream pages">
        ${links.map(
          (link) => html`
            <a
              class=${`site-header-link${active === link.id ? " is-active" : ""}`}
              href=${link.href}
              >${link.label}</a
            >
          `,
        )}
      </nav>
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
 * Vanilla DOM: append one brand block into `container` (e.g. viewer header).
 *
 * @param {HTMLElement} container
 * @param {{ href?: string }} [opts]
 */
export function mountFilstreamBrand(container, opts = {}) {
  const href = opts.href ?? projectSiteHref();
  const title = filstreamBrandFullTitle();
  container.appendChild(createBrandAnchor(href, title));
}

/**
 * Vanilla DOM: append full app header (`site-brand` + nav links) into `container`.
 *
 * @param {HTMLElement} container
 * @param {{ active?: string, href?: string }} [opts]
 */
export function mountFilstreamHeader(container, opts = {}) {
  const active = typeof opts.active === "string" ? opts.active : "";
  const href = opts.href ?? projectSiteHref();
  const title = filstreamBrandFullTitle();
  const wrap = document.createElement("div");
  wrap.className = "site-header-bar";
  wrap.appendChild(createBrandAnchor(href, title));

  const nav = document.createElement("nav");
  nav.className = "site-header-nav";
  nav.setAttribute("aria-label", "FilStream pages");
  for (const link of filstreamAppNavLinks()) {
    const a = document.createElement("a");
    a.className = "site-header-link";
    if (active === link.id) a.classList.add("is-active");
    a.href = link.href;
    a.textContent = link.label;
    nav.appendChild(a);
  }
  wrap.appendChild(nav);
  container.replaceChildren(wrap);
}
