/**
 * Describe step — listing fields + source preview + Next to Upload.
 */
import { html } from "https://cdn.jsdelivr.net/npm/lit-html@3.2.1/+esm";

/**
 * @param {{
 *   title: string,
 *   description: string,
 *   showDonateButton: boolean,
 *   donateAmountUsdfc: number,
 *   posterPreviewUrl: string | null,
 *   useSeekPosition: boolean,
 *   sourceSeekVideoEl: HTMLVideoElement | null,
 *   seekUsesSource: boolean,
 *   onTitle: (v: string) => void,
 *   onDescription: (v: string) => void,
 *   onShowDonate: (v: boolean) => void,
 *   onDonateAmount: (v: number) => void,
 *   onPosterInput: (e: Event) => void,
 *   onUseSeekPosition: (v: boolean) => void,
 *   onNext: () => void | Promise<void>,
 *   nextBusy: boolean,
 *   nextError: string,
 * }} props
 */
export function publishMetadataForm(props) {
  const {
    title,
    description,
    showDonateButton,
    donateAmountUsdfc,
    posterPreviewUrl,
    useSeekPosition,
    sourceSeekVideoEl,
    seekUsesSource,
    onTitle,
    onDescription,
    onShowDonate,
    onDonateAmount,
    onPosterInput,
    onUseSeekPosition,
    onNext,
    nextBusy,
    nextError,
  } = props;

  return html`
    <section class="publish-metadata" aria-labelledby="publish-metadata-title">
      <h2 id="publish-metadata-title" class="publish-metadata-head">Describe</h2>

      <label class="publish-field">
        <span class="publish-field-label">Title</span>
        <input
          type="text"
          class="publish-input"
          name="publish-title"
          autocomplete="off"
          placeholder="Title"
          .value=${title}
          @input=${(e) => onTitle(/** @type {HTMLInputElement} */ (e.target).value)}
        />
      </label>

      <label class="publish-field">
        <span class="publish-field-label">Description</span>
        <textarea
          class="publish-textarea"
          name="publish-description"
          rows="4"
          placeholder="Description"
          .value=${description}
          @input=${(e) =>
            onDescription(/** @type {HTMLTextAreaElement} */ (e.target).value)}
        ></textarea>
      </label>

      <label class="publish-checkbox">
        <input
          type="checkbox"
          .checked=${showDonateButton}
          @change=${(e) =>
            onShowDonate(/** @type {HTMLInputElement} */ (e.target).checked)}
        />
        <span>Show donate button</span>
      </label>

      ${showDonateButton
        ? html`
            <label class="publish-field">
              <span class="publish-field-label">Donation amount (USDFC)</span>
              <input
                type="number"
                class="publish-input"
                name="publish-donate-amount"
                min="0.000001"
                step="any"
                placeholder="1"
                .value=${String(donateAmountUsdfc)}
                @input=${(e) => {
                  const v = Number(
                    /** @type {HTMLInputElement} */ (e.target).value,
                  );
                  onDonateAmount(Number.isFinite(v) ? v : 1);
                }}
              />
            </label>
            <p
              class="publish-donate-hint"
              title="Fund-step wallet is written into listing metadata as listing.fundWalletAddress."
            >
              Recipient = Fund wallet.
            </p>
          `
        : null}

      <div class="publish-poster">
        <span class="publish-field-label">Poster image</span>
        <div class="publish-poster-row">
          <label class="btn publish-poster-upload">
            <input
              type="file"
              accept="image/*"
              class="sr-only"
              @change=${onPosterInput}
            />
            Upload image
          </label>
          ${posterPreviewUrl
            ? html`
                <img
                  class="publish-poster-preview"
                  src=${posterPreviewUrl}
                  width="160"
                  height="90"
                  alt="Poster preview"
                />
              `
            : html`<span class="publish-poster-empty">No image selected</span>`}
        </div>
      </div>

      <label class="publish-checkbox">
        <input
          type="checkbox"
          .checked=${useSeekPosition}
          @change=${(e) =>
            onUseSeekPosition(/** @type {HTMLInputElement} */ (e.target).checked)}
        />
        <span>Use seek position</span>
      </label>

      ${useSeekPosition && seekUsesSource && sourceSeekVideoEl
        ? html`
            <div class="publish-seek-block">
              <span class="publish-field-label">Poster frame from source video</span>
              <div class="publish-source-seek">${sourceSeekVideoEl}</div>
              <p class="publish-seek-help" title="Next saves a full-resolution JPEG poster plus a mini WebP preview (animated from 10s when the clip is long enough; otherwise the first frame).">
                Scrub, then Next for poster JPEG and preview WebP.
              </p>
            </div>
          `
        : html`
            <p
              class="publish-seek-hint"
              title="Or upload a poster image when seek is off (required if no seek)."
            >
              Turn on seek to grab a frame, or upload a poster.
            </p>
          `}

      ${nextError
        ? html`<p class="publish-define-next-err" role="alert">${nextError}</p>`
        : null}

      <div class="publish-define-next-wrap">
        <button
          type="button"
          class="btn btn-primary publish-define-next-btn"
          ?disabled=${nextBusy}
          @click=${onNext}
        >
          ${nextBusy ? "Saving…" : "Next"}
        </button>
        <p class="publish-define-next-hint" title="Poster required; then pipeline upload continues.">
          Saves poster → Upload.
        </p>
      </div>
    </section>
  `;
}
