#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const p = path.join(__dirname, "../docs/components/creator-impl.mjs");
let s = fs.readFileSync(p, "utf8");

const block = `import "./movie-link-showcase.mjs";

const G_REF = /** @type {{ host: import("lit").LitElement | null }} */ ({ host: null });

/** @type {HTMLElement | null} */
let brandMount = null;
/** @type {HTMLElement | null} */
let statusEl = null;
/** @type {HTMLElement | null} */
let pageSpinnerMount = null;
/** @type {HTMLElement | null} */
let saveSpinnerMount = null;
/** @type {HTMLElement | null} */
let heroEl = null;
/** @type {HTMLImageElement | null} */
let posterImg = null;
/** @type {HTMLElement | null} */
let titleEl = null;
/** @type {HTMLElement | null} */
let roleLabel = null;
/** @type {HTMLElement | null} */
let datasetLabel = null;
/** @type {HTMLElement | null} */
let heroActionsEl = null;
/** @type {HTMLElement | null} */
let editSection = null;
/** @type {HTMLElement | null} */
let editHint = null;
/** @type {HTMLButtonElement | null} */
let enableEditBtn = null;
/** @type {HTMLButtonElement | null} */
let disconnectBtn = null;
/** @type {HTMLElement | null} */
let sessionKeyNoteEl = null;
/** @type {HTMLElement | null} */
let editForm = null;
/** @type {HTMLInputElement | null} */
let nameInput = null;
/** @type {HTMLInputElement | null} */
let posterFileInput = null;
/** @type {HTMLButtonElement | null} */
let posterBrowseBtn = null;
/** @type {HTMLElement | null} */
let posterStatusEl = null;
/** @type {HTMLButtonElement | null} */
let saveBtn = null;
/** @type {HTMLElement | null} */
let saveStatus = null;
/** @type {HTMLElement | null} */
let movieEditList = null;
/** @type {HTMLElement | null} */
let catalogSection = null;
/** @type {HTMLElement | null} */
let movieListEl = null;
/** @type {HTMLElement | null} */
let emptyStateSection = null;
/** @type {HTMLButtonElement | null} */
let emptyStateConnectBtn = null;
/** @type {HTMLElement | null} */
let browseSection = null;
/** @type {HTMLElement | null} */
let browseListEl = null;

function cacheCreatorRefs() {
  const h = G_REF.host;
  if (!h) return;
  brandMount = h.querySelector("#creator-brand-mount");
  statusEl = h.querySelector("#creator-status");
  pageSpinnerMount = h.querySelector("#creator-page-spinner");
  saveSpinnerMount = h.querySelector("#creator-save-spinner-mount");
  heroEl = h.querySelector("#creator-hero");
  posterImg = /** @type {HTMLImageElement | null} */ (h.querySelector("#creator-poster"));
  titleEl = h.querySelector("#creator-title");
  roleLabel = h.querySelector("#creator-title-role");
  datasetLabel = h.querySelector("#creator-dataset-label");
  heroActionsEl = h.querySelector("#creator-hero-actions");
  editSection = h.querySelector("#creator-edit-section");
  editHint = h.querySelector("#creator-edit-hint");
  enableEditBtn = /** @type {HTMLButtonElement | null} */ (h.querySelector("#creator-enable-edit"));
  disconnectBtn = /** @type {HTMLButtonElement | null} */ (h.querySelector("#creator-disconnect"));
  sessionKeyNoteEl = h.querySelector("#creator-sessionkey-note");
  editForm = h.querySelector("#creator-edit-form");
  nameInput = /** @type {HTMLInputElement | null} */ (h.querySelector("#creator-name-input"));
  posterFileInput = /** @type {HTMLInputElement | null} */ (h.querySelector("#creator-poster-file"));
  posterBrowseBtn = /** @type {HTMLButtonElement | null} */ (h.querySelector("#creator-poster-browse"));
  posterStatusEl = h.querySelector("#creator-poster-status");
  saveBtn = /** @type {HTMLButtonElement | null} */ (h.querySelector("#creator-save-btn"));
  saveStatus = h.querySelector("#creator-save-status");
  movieEditList = h.querySelector("#creator-movie-edit-list");
  catalogSection = h.querySelector("#creator-catalog-section");
  movieListEl = h.querySelector("#creator-movie-list");
  emptyStateSection = h.querySelector("#creator-empty-state");
  emptyStateConnectBtn = /** @type {HTMLButtonElement | null} */ (
    h.querySelector("#creator-empty-connect")
  );
  browseSection = h.querySelector("#creator-browse-section");
  browseListEl = h.querySelector("#creator-browse-list");
  h.querySelector("#creator-dev-paste-box")?.setAttribute("hidden", "");
}

`;

const oldBlock = `import "./movie-link-showcase.mjs";

const brandMount = document.getElementById("creator-brand-mount");
if (brandMount) {
  mountFilstreamHeader(brandMount, { active: "creator" });
}

const statusEl = document.getElementById("creator-status");
const pageSpinnerMount = document.getElementById("creator-page-spinner");
const saveSpinnerMount = document.getElementById("creator-save-spinner-mount");
const heroEl = document.getElementById("creator-hero");
const posterImg = /** @type {HTMLImageElement | null} */ (document.getElementById("creator-poster"));
const titleEl = document.getElementById("creator-title");
const roleLabel = document.getElementById("creator-title-role");
const datasetLabel = document.getElementById("creator-dataset-label");
const heroActionsEl = document.getElementById("creator-hero-actions");
const editSection = document.getElementById("creator-edit-section");
const editHint = document.getElementById("creator-edit-hint");
const enableEditBtn = /** @type {HTMLButtonElement | null} */ (
  document.getElementById("creator-enable-edit")
);
const disconnectBtn = /** @type {HTMLButtonElement | null} */ (
  document.getElementById("creator-disconnect")
);
const sessionKeyNoteEl = document.getElementById("creator-sessionkey-note");
const editForm = document.getElementById("creator-edit-form");
const nameInput = /** @type {HTMLInputElement | null} */ (document.getElementById("creator-name-input"));
const posterFileInput = /** @type {HTMLInputElement | null} */ (
  document.getElementById("creator-poster-file")
);
const posterBrowseBtn = /** @type {HTMLButtonElement | null} */ (
  document.getElementById("creator-poster-browse")
);
const posterStatusEl = document.getElementById("creator-poster-status");
const saveBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById("creator-save-btn"));
const saveStatus = document.getElementById("creator-save-status");
const movieEditList = document.getElementById("creator-movie-edit-list");
const catalogSection = document.getElementById("creator-catalog-section");
const movieListEl = document.getElementById("creator-movie-list");
const emptyStateSection = document.getElementById("creator-empty-state");
const emptyStateConnectBtn = /** @type {HTMLButtonElement | null} */ (
  document.getElementById("creator-empty-connect")
);
const browseSection = document.getElementById("creator-browse-section");
const browseListEl = document.getElementById("creator-browse-list");

// Legacy dev-only paste box remains hidden in on-chain mode.
document.getElementById("creator-dev-paste-box")?.setAttribute("hidden", "");

`;

if (!s.includes("const brandMount = document.getElementById")) {
  console.error("Expected block not found — already transformed?");
  process.exit(1);
}

s = s.replace(oldBlock, block);

const tail = `bindEvents();
void refreshAll();
`;

const newTail = `export function initCreatorPage(host) {
  G_REF.host = host;
  cacheCreatorRefs();
  if (brandMount) {
    mountFilstreamHeader(brandMount, { active: "creator" });
  }
  bindEvents();
  void refreshAll();
}
`;

if (!s.endsWith(tail)) {
  console.error("Unexpected file ending");
  process.exit(1);
}

s = s.slice(0, -tail.length) + newTail;

fs.writeFileSync(p, s);
console.log("Wrote creator-impl.mjs");
