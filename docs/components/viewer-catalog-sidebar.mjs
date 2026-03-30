/**
 * Discover / “more from creator” catalog rail (light DOM).
 */
import { LitElement, html } from "./lit-base.mjs";
import {
  buildCreatorUrlForAddress,
  buildViewerUrlForVideoId,
} from "../filstream-config.mjs";

/**
 * @param {string} addr
 */
function normalizeCreatorKey(addr) {
  return String(addr || "").trim().toLowerCase();
}

/**
 * @param {string} addr
 */
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
function bylineNameForCreator(profiles, addr) {
  const hit = profileStateForCreator(profiles, addr)?.username ?? "";
  if (hit && hit.trim() !== "") return hit.trim();
  return normalizeAddressLabel(addr);
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
function creatorInitialForAddress(profiles, addr) {
  const name = bylineNameForCreator(profiles, addr);
  const t = String(name || "").trim();
  if (!t) return "?";
  if (/^0x[a-fA-F0-9]{4,}$/.test(t)) {
    return t.slice(2, 3).toUpperCase();
  }
  return t.slice(0, 1).toUpperCase();
}

/**
 * @param {import("../filstream-catalog-chain.mjs").CatalogEntry[]} rows
 */
function sortEntriesNewestFirst(rows) {
  return [...rows].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
    return b.entryId - a.entryId;
  });
}

/**
 * @param {string} creator
 * @param {string} query
 * @param {Record<string, { username?: string, profileUrl?: string }>} profiles
 */
function matchesCreatorSearch(creator, query, profiles) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  const addr = String(creator || "").toLowerCase();
  const name = bylineNameForCreator(profiles, creator).toLowerCase();
  return addr.includes(q) || name.includes(q);
}

export class ViewerCatalogSidebar extends LitElement {
  static properties = {
    mode: { type: String },
    /** @type {import("../filstream-catalog-chain.mjs").CatalogEntry[]} */
    entries: { type: Array, attribute: false },
    currentVideoId: { type: String },
    searchQuery: { type: String },
    /** Keys: `normalizeCreatorKey` */
    creatorProfiles: { type: Object, attribute: false },
  };

  constructor() {
    super();
    this.mode = "discover";
    this.entries = [];
    this.currentVideoId = "";
    this.searchQuery = "";
    this.creatorProfiles = {};
    /** @type {import("../filstream-catalog-chain.mjs").CatalogEntry[]} */
    this._rowsForHydrate = [];
  }

  createRenderRoot() {
    return this;
  }

  updated(changed) {
    if (
      changed.has("mode") ||
      changed.has("entries") ||
      changed.has("currentVideoId") ||
      changed.has("searchQuery") ||
      changed.has("creatorProfiles")
    ) {
      this.dispatchEvent(
        new CustomEvent("filstream-catalog-rendered", {
          detail: { rows: this._rowsForHydrate },
          bubbles: true,
          composed: true,
        }),
      );
    }
  }

  /**
   * @param {string} creator
   * @param {string} className
   */
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

  /**
   * @param {import("../filstream-catalog-chain.mjs").CatalogEntry} row
   * @param {{ showCreator?: boolean, variant?: "watch" | "discover" }} opts
   */
  _card(row, opts = {}) {
    const showCreator = opts.showCreator !== false;
    const variant = opts.variant === "watch" ? "watch" : "discover";
    const profiles = this.creatorProfiles;
    const safeTitle =
      String(row.title ?? "").trim() || String(row.assetId ?? "").trim() || "Untitled";
    const cardClass = [
      "viewer-catalog-card",
      variant === "watch" ? "viewer-catalog-card--watch" : "",
      this.currentVideoId && row.assetId === this.currentVideoId
        ? "viewer-catalog-card--current"
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    return html`
      <a class=${cardClass} href=${buildViewerUrlForVideoId(row.assetId)} title=${safeTitle}>
        <div class="viewer-catalog-card-thumb-wrap">
          <img
            class="viewer-catalog-card-thumb viewer-catalog-card-thumb--still"
            alt=""
            loading="lazy"
            decoding="async"
            data-video-id=${row.assetId}
          />
        </div>
        <div class="viewer-catalog-card-body">
          <div class="viewer-catalog-card-title">${safeTitle}</div>
          ${showCreator
            ? html`<div class="viewer-catalog-card-creator">
                ${this._avatar(row.creator, "viewer-catalog-card-creator-avatar")}
                <span class="viewer-catalog-card-creator-name"
                  >${bylineNameForCreator(profiles, row.creator)}</span
                >
              </div>`
            : null}
        </div>
      </a>
    `;
  }

  _renderDiscover(active) {
    const profiles = this.creatorProfiles;
    const query = this.searchQuery.trim().toLowerCase();
    /** @type {import("../filstream-catalog-chain.mjs").CatalogEntry[]} */
    const renderedRows = [];

    if (!active.length) {
      this._rowsForHydrate = [];
      return html`
        <div class="viewer-catalog-toolbar">
          <h2 class="viewer-catalog-head">Discover</h2>
        </div>
        <p class="viewer-catalog-note">No videos yet.</p>
      `;
    }

    const latestRows = active
      .filter((row) => matchesCreatorSearch(row.creator, query, profiles))
      .slice(0, 10);

    /** @type {Map<string, { creator: string, rows: import("../filstream-catalog-chain.mjs").CatalogEntry[], count: number, latestCreatedAt: number }>} */
    const creatorBuckets = new Map();
    for (const row of active) {
      const key = normalizeCreatorKey(row.creator);
      if (!creatorBuckets.has(key)) {
        creatorBuckets.set(key, {
          creator: row.creator,
          rows: [],
          count: 0,
          latestCreatedAt: row.createdAt,
        });
      }
      const bucket = creatorBuckets.get(key);
      if (!bucket) continue;
      bucket.rows.push(row);
      bucket.count += 1;
      if (row.createdAt > bucket.latestCreatedAt) {
        bucket.latestCreatedAt = row.createdAt;
      }
    }

    const topCreators = [...creatorBuckets.values()]
      .sort((a, b) => {
        if (a.count !== b.count) return b.count - a.count;
        if (a.latestCreatedAt !== b.latestCreatedAt) {
          return b.latestCreatedAt - a.latestCreatedAt;
        }
        return normalizeCreatorKey(a.creator).localeCompare(normalizeCreatorKey(b.creator));
      })
      .slice(0, 10)
      .filter((bucket) => matchesCreatorSearch(bucket.creator, query, profiles));

    const latestSection = html`
      <section class="viewer-catalog-section">
        <h3 class="viewer-catalog-section-head">Latest uploads</h3>
        ${!latestRows.length
          ? html`<p class="viewer-catalog-note">No videos match this search.</p>`
          : html`
              <div class="viewer-catalog-strip">
                ${latestRows.map((row) => {
                  renderedRows.push(row);
                  return this._card(row, { showCreator: true });
                })}
              </div>
            `}
      </section>
    `;

    const creatorSections = topCreators.map((bucket) => {
      const rows = sortEntriesNewestFirst(bucket.rows);
      return html`
        <section class="viewer-catalog-section">
          <div class="viewer-catalog-creator-head">
            <a class="viewer-catalog-creator-link" href=${buildCreatorUrlForAddress(bucket.creator)}>
              ${this._avatar(bucket.creator, "viewer-catalog-creator-head-avatar")}
              <span class="viewer-catalog-creator-head-title"
                >${bylineNameForCreator(profiles, bucket.creator)}</span
              >
            </a>
            <span class="viewer-catalog-creator-count"
              >${bucket.count} upload${bucket.count === 1 ? "" : "s"}</span
            >
          </div>
          <div class="viewer-catalog-strip">
            ${rows.map((row) => {
              renderedRows.push(row);
              return this._card(row, { showCreator: false });
            })}
          </div>
        </section>
      `;
    });

    this._rowsForHydrate = renderedRows;

    return html`
      <div class="viewer-catalog-toolbar">
        <h2 class="viewer-catalog-head">Discover</h2>
      </div>
      ${latestSection}
      ${creatorSections}
      ${!topCreators.length
        ? html`<p class="viewer-catalog-note">No creators match this search.</p>`
        : null}
    `;
  }

  /**
   * @param {import("../filstream-catalog-chain.mjs").CatalogEntry[]} active
   */
  _renderWatch(active) {
    const profiles = this.creatorProfiles;
    if (!active.length) {
      this._rowsForHydrate = [];
      return html`
        <h2 class="viewer-catalog-head">More from creator</h2>
        <p class="viewer-catalog-note">No videos yet.</p>
      `;
    }

    const current = active.find((row) => row.assetId === this.currentVideoId) ?? null;
    if (!current) {
      this._rowsForHydrate = [];
      return html`
        <h2 class="viewer-catalog-head">More from creator</h2>
        <p class="viewer-catalog-note">Creator list is loading…</p>
      `;
    }

    const sameCreator = sortEntriesNewestFirst(
      active.filter(
        (row) =>
          row.assetId !== this.currentVideoId &&
          normalizeCreatorKey(row.creator) === normalizeCreatorKey(current.creator),
      ),
    );

    const creatorHead = html`
      <a class="viewer-watch-creator-link" href=${buildCreatorUrlForAddress(current.creator)}>
        ${this._avatar(current.creator, "viewer-catalog-creator-head-avatar")}
        <span class="viewer-catalog-creator-head-title"
          >${bylineNameForCreator(profiles, current.creator)}</span
        >
      </a>
    `;

    if (!sameCreator.length) {
      this._rowsForHydrate = [];
      return html`
        <h2 class="viewer-catalog-head">More from creator</h2>
        ${creatorHead}
        <p class="viewer-catalog-note">No other videos from this creator yet.</p>
      `;
    }

    this._rowsForHydrate = sameCreator;
    return html`
      <h2 class="viewer-catalog-head">More from creator</h2>
      ${creatorHead}
      <div class="viewer-watch-list">
        ${sameCreator.map((row) => this._card(row, { showCreator: false, variant: "watch" }))}
      </div>
    `;
  }

  render() {
    const active = this.entries;
    if (this.mode === "watch") {
      return this._renderWatch(active);
    }
    return this._renderDiscover(active);
  }
}

customElements.define("viewer-catalog-sidebar", ViewerCatalogSidebar);
