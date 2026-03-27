/**
 * FilStream name, tagline, and logo — shared by the wizard (`ui.mjs`) and `viewer/viewer.mjs`.
 */
import { html } from "https://cdn.jsdelivr.net/npm/lit-html@3.2.1/+esm";
import { getFilstreamStoreConfig } from "./filstream-config.mjs";

export const FILSTREAM_BRAND = {
  name: "FilStream",
  tagline: "CalibrationNet edition",
  /** Relative to `docs/` pages (`index.html`, `viewer.html`). */
  logoSrc: "favicon.svg",
};

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
 * Vanilla DOM: append one brand block into `container` (e.g. viewer header).
 *
 * @param {HTMLElement} container
 * @param {{ href?: string }} [opts]
 */
export function mountFilstreamBrand(container, opts = {}) {
  const href = opts.href ?? projectSiteHref();
  const title = filstreamBrandFullTitle();
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
  container.appendChild(a);
}
