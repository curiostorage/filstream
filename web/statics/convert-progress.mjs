/**
 * Skinny transcoding progress → expanded video preview + quality controls.
 * Edit and refresh.
 */
import { html } from "https://cdn.jsdelivr.net/npm/lit-html@3.2.1/+esm";

/**
 * @param {import("shaka-player").Player | null} player
 * @param {"auto" | number} mode
 * @param {{ width: number; height: number }[]} rungs
 */
export function applyStreamMode(player, mode, rungs) {
  if (!player) return;
  if (mode === "auto") {
    player.configure("abr.enabled", true);
    return;
  }
  player.configure("abr.enabled", false);
  const target = rungs[mode];
  if (!target) return;
  const tracks = player.getVariantTracks();
  const t = tracks.find(
    (tr) => tr.width === target.width && tr.height === target.height,
  );
  if (t) {
    player.selectVariantTrack(t, true);
  }
}

/**
 * @param {{
 *   show: boolean,
 *   phase: "encoding" | "define" | "awaiting" | "playback",
 *   fileName: string,
 *   progress: number,
 *   statusMsg: string,
 *   statusKind: string,
 *   videoEl: HTMLVideoElement,
 *   rungs: { width: number; height: number; bandwidth: number }[],
 *   streamMode: "auto" | number,
 *   onStreamMode: (mode: "auto" | number) => void,
 *   playingLabel: string,
 *   onCancel: () => void,
 *   onStartOver: () => void,
 *   showDebugSave?: boolean,
 *   debugSaveBusy?: boolean,
 *   onDebugSave?: () => void,
 *   awaitListingLayout?: boolean,
 *   awaitListingTitle?: string,
 *   awaitListingDescription?: string,
 *   awaitPosterUrl?: string | null,
 *   awaitUploadBannerText?: string,
 *   awaitPipelineBars?: {
 *     transcodePct: number,
 *     transcodeDetail: string,
 *     uploadPct: number,
 *     uploadDetail: string,
 *     uploadPhaseNote?: string,
 *   } | null,
 *   storageUpload?: { pct: number, label: string } | null,
 * }} props
 */
export function convertProgressPanel(props) {
  if (!props.show) return null;

  const {
    phase,
    fileName,
    progress,
    statusMsg,
    statusKind,
    videoEl,
    rungs,
    streamMode,
    onStreamMode,
    playingLabel,
    onCancel,
    onStartOver,
    showDebugSave,
    debugSaveBusy,
    onDebugSave,
    awaitListingLayout = false,
    awaitListingTitle = "",
    awaitListingDescription = "",
    awaitPosterUrl = null,
    awaitUploadBannerText = "Upload in progress",
    awaitPipelineBars = null,
    storageUpload = null,
  } = props;

  const pipelineBarsBlock =
    awaitPipelineBars != null
      ? html`
          <div
            class="await-pipeline-bars"
            role="group"
            aria-label="Transcode and PDP upload"
          >
            <div class="await-pipeline-row-wrap">
              <div class="await-pipeline-row await-pipeline-row--transcode">
                <span class="await-pipeline-label">Transcoding</span>
                <progress
                  class="progress await-pipeline-bar"
                  max="100"
                  .value=${awaitPipelineBars.transcodePct}
                ></progress>
                <span class="await-pipeline-pct"
                  >${awaitPipelineBars.transcodePct}%</span
                >
              </div>
              ${awaitPipelineBars.transcodeDetail
                ? html`<p class="await-pipeline-row-detail">
                    ${awaitPipelineBars.transcodeDetail}
                  </p>`
                : null}
            </div>
            <div class="await-pipeline-row-wrap">
              <div class="await-pipeline-row await-pipeline-row--upload">
                <span class="await-pipeline-label">Uploading</span>
                <progress
                  class="progress await-pipeline-bar"
                  max="100"
                  .value=${awaitPipelineBars.uploadPct}
                ></progress>
                <span class="await-pipeline-pct"
                  >${awaitPipelineBars.uploadPct}%</span
                >
              </div>
              ${awaitPipelineBars.uploadDetail
                ? html`<p class="await-pipeline-row-detail">
                    ${awaitPipelineBars.uploadDetail}
                  </p>`
                : null}
              ${awaitPipelineBars.uploadPhaseNote
                ? html`<p class="await-pipeline-row-detail await-pipeline-row-detail--phase">
                    ${awaitPipelineBars.uploadPhaseNote}
                  </p>`
                : null}
            </div>
          </div>
        `
      : null;

  const storeUploadBlock = storageUpload
    ? html`
        <div class="store-upload-panel" role="status" aria-live="polite">
          <div class="store-upload-row">
            <span class="store-upload-heading">PDP upload</span>
            <progress
              class="progress store-upload-bar"
              max="100"
              .value=${storageUpload.pct}
            ></progress>
            <span class="store-upload-pct">${storageUpload.pct}%</span>
          </div>
          <p class="store-upload-detail">${storageUpload.label}</p>
        </div>
      `
    : null;

  const isPlaybackMedia = phase === "playback";
  const sectionTone =
    phase === "awaiting"
      ? "convert-progress--awaiting"
      : isPlaybackMedia
        ? "convert-progress--playback"
        : "convert-progress--encoding";
  const panelTitle =
    phase === "encoding"
      ? "Transcode"
      : phase === "define"
        ? "Define"
        : "Await";
  const ariaPanel =
    phase === "encoding"
      ? "Transcoding progress"
      : phase === "define"
        ? "Preparing stream"
        : phase === "awaiting"
          ? "Waiting for playback stream"
          : "Playback preview";

  const mediaBlock = html`
    <div
      class="convert-media ${phase === "awaiting"
        ? "convert-media--awaiting"
        : isPlaybackMedia
          ? "convert-media--playback"
          : "convert-media--encoding"} ${awaitListingLayout && phase === "awaiting"
        ? "convert-media--await-yt-wait"
        : ""}"
    >
      ${phase === "awaiting" && awaitListingLayout && awaitPosterUrl
        ? html`
            <img
              class="await-poster-frame-img"
              src=${awaitPosterUrl}
              alt=""
              width="1280"
              height="720"
              decoding="async"
            />
          `
        : null}
      <div class="convert-player-wrap">${videoEl}</div>
      ${phase === "awaiting"
        ? html`
            <div class="convert-awaiting-overlay" aria-live="polite">
              <div class="convert-awaiting-spinner" aria-hidden="true"></div>
              <p class="convert-awaiting-title">Waiting for stream</p>
              <p class="convert-awaiting-sub">
                ${statusMsg ||
                "Playback is still attaching. This step stays here until the player is ready."}
              </p>
            </div>
          `
        : phase === "encoding"
            ? awaitPipelineBars
              ? null
              : html`
                  <div class="convert-encode-skinny" aria-hidden="false">
                    <span class="convert-encode-label">Encoding</span>
                    <progress class="progress convert-progress-bar" max="100" .value=${progress}></progress>
                    <span class="convert-encode-pct">${progress}%</span>
                  </div>
                `
            : phase === "define"
              ? html`
                  <div class="convert-encode-skinny" aria-hidden="false">
                    <span class="convert-encode-label">Preparing</span>
                    <progress class="progress convert-progress-bar" max="100" .value=${100}></progress>
                  </div>
                `
              : null}
    </div>
  `;

  const statusLine = statusMsg
    ? html`<p class="status ${statusKind} convert-status" aria-live="polite">
        ${statusMsg}
      </p>`
    : null;

  return html`
    <section class="convert-progress ${sectionTone}" aria-label=${ariaPanel}>
      ${awaitListingLayout
        ? html`
            <p
              class="await-upload-banner"
              role="status"
              aria-live="polite"
            >
              ${awaitUploadBannerText}
            </p>
          `
        : null}
      ${statusLine}
      ${pipelineBarsBlock}
      ${storeUploadBlock}
      ${awaitListingLayout
        ? html`
            <div class="await-yt-layout">
              <div class="await-yt-primary">${mediaBlock}</div>
              <div class="await-yt-meta">
                <h1 class="await-yt-title">${awaitListingTitle.trim() || "Untitled"}</h1>
                <div class="await-yt-description">
                  ${awaitListingDescription.trim()
                    ? html`<p class="await-yt-desc-copy">${awaitListingDescription}</p>`
                    : html`<p class="await-yt-desc-empty">No description</p>`}
                </div>
              </div>
            </div>
          `
        : html`
            <header class="convert-head">
              <h2 class="convert-title">${panelTitle}</h2>
              <p class="convert-file">${fileName}</p>
            </header>
            ${mediaBlock}
          `}

      ${phase === "playback" && rungs?.length
        ? html`
            <fieldset class="resolution-radios">
              <legend class="resolution-legend">Resolution (manual switching)</legend>
              <label class="radio-row">
                <input
                  type="radio"
                  name="filstream-res"
                  value="auto"
                  .checked=${streamMode === "auto"}
                  @change=${() => onStreamMode("auto")}
                />
                <span>Auto (ABR)</span>
              </label>
              ${rungs.map(
                (r, idx) => html`
                  <label class="radio-row">
                    <input
                      type="radio"
                      name="filstream-res"
                      value=${String(idx)}
                      .checked=${streamMode === idx}
                      @change=${() => onStreamMode(idx)}
                    />
                    <span>${r.width}×${r.height}</span>
                    <span class="radio-meta">${Math.round(r.bandwidth / 1000)} kb/s</span>
                  </label>
                `,
              )}
            </fieldset>
            <p class="playing-now" aria-live="polite">
              Active stream: <strong>${playingLabel || "…"}</strong>
            </p>
          `
        : null}

      <div class="convert-actions">
        ${phase === "encoding" || phase === "define" || phase === "awaiting"
          ? html`<button type="button" class="btn" @click=${onCancel}>Cancel transcode</button>`
          : html`
              <div class="convert-actions-row">
                <button type="button" class="btn btn-primary" @click=${onStartOver}>Start over</button>
                ${showDebugSave && onDebugSave
                  ? html`
                      <button
                        type="button"
                        class="btn btn-debug-save"
                        ?disabled=${debugSaveBusy}
                        title="POST HLS + source video to this dev server (web/debug-hls/…)"
                        @click=${onDebugSave}
                      >
                        ${debugSaveBusy ? "Saving…" : "Debug save locally"}
                      </button>
                    `
                  : null}
              </div>
            `}
      </div>
    </section>
  `;
}
