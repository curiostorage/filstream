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
 * @param {{
 *   meta: unknown,
 *   videoEl: HTMLVideoElement,
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
        <div class="broadcast-video-frame">${videoEl}</div>
      </div>
      <div class="broadcast-meta">
        <h1 class="broadcast-title">${title}</h1>
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
