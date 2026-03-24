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
 *   phase: "encoding" | "playback",
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
  } = props;

  return html`
    <section
      class="convert-progress ${phase === "encoding"
        ? "convert-progress--encoding"
        : "convert-progress--playback"}"
      aria-label=${phase === "encoding" ? "Transcoding progress" : "Playback preview"}
    >
      <header class="convert-head">
        <h2 class="convert-title">${phase === "encoding" ? "Transcode" : "Preview"}</h2>
        <p class="convert-file">${fileName}</p>
      </header>

      <div
        class="convert-media ${phase === "encoding"
          ? "convert-media--encoding"
          : "convert-media--playback"}"
      >
        <div class="convert-player-wrap">${videoEl}</div>
        ${phase === "encoding"
          ? html`
              <div class="convert-encode-skinny" aria-hidden="false">
                <span class="convert-encode-label">Encoding</span>
                <progress class="progress convert-progress-bar" max="100" .value=${progress}></progress>
                <span class="convert-encode-pct">${progress}%</span>
              </div>
            `
          : null}
      </div>

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

      <p class="status ${statusKind} convert-status" aria-live="polite">${statusMsg}</p>

      <div class="convert-actions">
        ${phase === "encoding"
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
