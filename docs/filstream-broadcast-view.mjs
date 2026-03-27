/**
 * Final published layout: video + poster + title + description + download + viewer donate.
 * Consumes parsed `meta.json` plus playback/download URLs; intended for embed or Review demo.
 */
import { html } from "https://cdn.jsdelivr.net/npm/lit-html@3.2.1/+esm";
import { viewerDonateBlock } from "./filstream-viewer-donate.mjs";

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
  return {
    title: typeof listing.title === "string" ? listing.title : "",
    description:
      typeof listing.description === "string" ? listing.description : "",
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
 *   reviewViewerPageUrl?: string | null, // same URL as iframe; “Open this video” link
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
    reviewViewerPageUrl = null,
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

  return html`
    <section
      class="broadcast-view ${variant ? `broadcast-view--${variant}` : ""}"
      aria-label="Review stream playback"
    >
      <div class="broadcast-video-shell">
        <div class="broadcast-video-frame">
          ${reviewIframeSrc
            ? html`<iframe
                class="broadcast-review-iframe"
                src=${reviewIframeSrc}
                title="Stream playback"
                allow="autoplay; fullscreen; encrypted-media"
              ></iframe>`
            : videoEl}
        </div>
        ${reviewViewerPageUrl
          ? html`<p class="broadcast-viewer-link">
              <a
                href=${reviewViewerPageUrl}
                target="_blank"
                rel="noopener noreferrer"
                >Open this video</a
              >
              <span class="subtle"> — same player as the preview above</span>
            </p>`
          : null}
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
            ? viewerDonateBlock({
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
