/**
 * FilStream name, tagline, and logo — shared by the wizard (`ui.mjs`) and `viewer/viewer.mjs`.
 * Header markup lives in `components/filstream-header.mjs` (`FilstreamHeader` / `filstreamHeaderLit`).
 */
import { html, render } from "https://cdn.jsdelivr.net/npm/lit-html@3.2.1/+esm";
import { buildCreatorUrlForAddress, getFilstreamStoreConfig } from "./filstream-config.mjs";
import {
  readCatalogProfilePicturePieceCid,
  resolveManifestUrl,
} from "./filstream-catalog-chain.mjs";
import { FILSTREAM_BRAND as SHARED_FILSTREAM_BRAND } from "./filstream-constants.mjs";
import { loadWalletFromStorage } from "./session-key-storage.mjs";

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
  link.setAttribute("aria-label", "My Profile");
  render(
    html`
      <img
        class="site-header-profile-img"
        src=${picUrl}
        alt=""
        width="32"
        height="32"
        decoding="async"
      />
    `,
    link,
  );
}

export {
  FilstreamHeader,
  mountFilstreamHeader,
  filstreamHeaderLit,
  filstreamBrandLit,
} from "./components/filstream-header.mjs";
