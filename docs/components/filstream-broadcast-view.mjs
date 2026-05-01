/**
 * Final published layout: video + poster + title + description + download + viewer donate.
 * Consumes parsed listing/manifest metadata plus playback/download URLs; intended for local preview or Review.
 * When `reviewIframeSrc` is set (Review embed), only the iframe is rendered — title/description/donate
 * live in `view/` (catalog app).
 */
import { html } from "https://cdn.jsdelivr.net/npm/lit-html@3.2.1/+esm";
import { catalogDonateBlock } from "./filstream-catalog-donate.mjs";

/**
 * @param {string} jsonText
 * @returns {unknown}
 */
export function parseMetaJson(jsonText) {
  return JSON.parse(jsonText);
}

/**
 * @param {unknown} meta
 * @returns {{ title: string, description: string, posterUrl: string | null }}
 */
export function broadcastCopyFromMeta(meta) {
  const m = meta && typeof meta === "object" ? meta : {};
  const listing = /** @type {{ title?: string, description?: string }} */ (
    "listing" in m && m.listing && typeof m.listing === "object" ? m.listing : {}
  );
  const pb =
    "playback" in m && m.playback && typeof m.playback === "object"
      ? /** @type {{ posterUrl?: string }} */ (m.playback)
      : {};
  const posterBlock =
    "poster" in m && m.poster && typeof m.poster === "object"
      ? /** @type {{ url?: string }} */ (m.poster)
      : {};
  const posterUrl =
    typeof posterBlock.url === "string" && posterBlock.url.trim() !== ""
      ? posterBlock.url.trim()
      : typeof pb.posterUrl === "string" && pb.posterUrl.trim() !== ""
        ? pb.posterUrl.trim()
        : null;
  return {
    title: typeof listing.title === "string" ? listing.title : "",
    description:
      typeof listing.description === "string" ? listing.description : "",
    posterUrl,
  };
}

/**
 * @param {unknown} meta
 * @returns {string | null}
 */
export function formatUploadDateLabel(meta) {
  if (!meta || typeof meta !== "object") return null;
  const m = /** @type {Record<string, unknown>} */ (meta);
  const completed =
    typeof m.listingCompletedAt === "string" ? m.listingCompletedAt : null;
  const tm = m.transcodeMeta;
  const assembledFromTranscode =
    tm && typeof tm === "object" && tm !== null && "assembledAt" in tm
      ? String(/** @type {Record<string, unknown>} */ (tm).assembledAt)
      : null;
  const assembledTop =
    typeof m.assembledAt === "string" ? m.assembledAt : null;
  const raw = completed || assembledTop || assembledFromTranscode;
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * @param {{
 *   meta: unknown,
 *   videoEl: HTMLVideoElement,
 *   reviewIframeSrc?: string | null,
 *   uploadDateLabel?: string | null,
 *   downloadSourceFile?: File | null,
 *   downloadLabel?: string,
 *   variant?: string,
 *   getWalletList?: () => { info: { uuid: string, name: string }, provider: { request: (a: { method: string, params?: unknown[] }) => Promise<unknown> } }[],
 *   viewerDonate?: {
 *     busy: boolean,
 *     error: string,
 *     txHash: string,
 *     onClick: () => void,
 *   },
 * }} props
 */
export function broadcastViewTemplate(props) {
  const {
    meta,
    videoEl,
    reviewIframeSrc = null,
    uploadDateLabel = null,
    downloadSourceFile = null,
    downloadLabel = "Download source video",
    variant,
    getWalletList,
    viewerDonate,
  } = props;

  const copy = broadcastCopyFromMeta(meta);
  const title = copy.title.trim() || "Untitled";
  const desc = copy.description.trim();

  if (videoEl && !reviewIframeSrc) {
    if (copy.posterUrl) {
      videoEl.setAttribute("poster", copy.posterUrl);
    } else {
      videoEl.removeAttribute("poster");
    }
  }

  /* Standalone catalog app (`view/`) shows title, description, donate; embed is iframe-only. */
  if (reviewIframeSrc) {
    return html`
      <section
        class="broadcast-view ${variant ? `broadcast-view--${variant}` : ""}"
        aria-label="Review stream playback"
      >
        <div class="broadcast-video-shell">
          <div class="broadcast-video-frame">
            <iframe
              class="broadcast-review-iframe"
              src=${reviewIframeSrc}
              title="Stream playback"
              allow="autoplay; fullscreen; encrypted-media"
            ></iframe>
          </div>
        </div>
      </section>
    `;
  }

  return html`
    <section
      class="broadcast-view ${variant ? `broadcast-view--${variant}` : ""}"
      aria-label="Review stream playback"
    >
      <div class="broadcast-video-shell">
        <div class="broadcast-video-frame">
          ${videoEl}
        </div>
      </div>
      <div class="broadcast-meta">
        <h1 class="broadcast-title">${title}</h1>
        ${uploadDateLabel
          ? html`<p class="broadcast-upload-date" title="Listing completed">${uploadDateLabel}</p>`
          : null}
        <div class="broadcast-description">
          ${desc
            ? html`<p class="broadcast-desc-body">${desc}</p>`
            : html`<p class="broadcast-desc-empty">No description</p>`}
        </div>
        <div class="broadcast-actions">
          ${downloadSourceFile
            ? html`<button
                type="button"
                class="btn broadcast-download"
                @click=${() => {
                  const u = URL.createObjectURL(downloadSourceFile);
                  const a = document.createElement("a");
                  a.href = u;
                  a.download = downloadSourceFile.name;
                  a.click();
                  URL.revokeObjectURL(u);
                }}
              >
                ${downloadLabel}
              </button>`
            : null}
          ${viewerDonate
            ? catalogDonateBlock({
                meta,
                getWalletList,
                viewerBusy: viewerDonate.busy,
                viewerError: viewerDonate.error,
                viewerTxHash: viewerDonate.txHash,
                onDonateClick: viewerDonate.onClick,
              })
            : null}
        </div>
      </div>
    </section>
  `;
}
