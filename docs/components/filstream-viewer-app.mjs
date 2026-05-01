import { LitElement, html } from "https://cdn.jsdelivr.net/npm/lit@3.2.1/+esm";
import { initViewerPage } from "./viewer-impl.mjs";

export class FilstreamViewerApp extends LitElement {
  static properties = {
    landingToast: { type: Boolean, reflect: true, attribute: "landing-toast" },
  };

  constructor() {
    super();
    this.landingToast = false;
  }

  createRenderRoot() {
    return this;
  }

  render() {
    return html`
      <div id="root" class="viewer-layout">
        <div class="viewer-main">
          <header id="viewer-brand-mount" class="viewer-brand" role="banner"></header>
          <p class="viewer-status" id="viewer-status">Loading…</p>
          <div class="viewer-player-block">
            <div id="viewer-shaka-container" class="viewer-shaka-container">
              <video id="viewer-video" playsinline></video>
            </div>
          </div>
          <section id="viewer-meta" class="viewer-meta" hidden aria-label="About this video">
            <h1 id="viewer-title" class="broadcast-title"></h1>
            <p id="viewer-upload-date" class="broadcast-upload-date" hidden></p>
            <div id="viewer-byline" class="viewer-byline" hidden>
              <div id="viewer-byline-catalog" class="viewer-byline-catalog"></div>
              <div class="viewer-byline-trailing">
                <div id="viewer-donate-root" class="viewer-byline-donate"></div>
                <div id="viewer-actions" class="viewer-actions" hidden aria-label="Share and embed"></div>
              </div>
            </div>
            <div class="viewer-description-box">
              <div id="viewer-description" class="broadcast-description"></div>
            </div>
          </section>
        </div>
        <aside id="viewer-catalog" class="viewer-catalog" hidden aria-label="Catalog"></aside>
      </div>
      ${this.landingToast
        ? html`
            <aside
              id="filstream-landing-toast"
              class="filstream-landing-toast"
              role="dialog"
              aria-labelledby="filstream-landing-toast-title"
              aria-modal="false"
              hidden
            >
              <button type="button" class="filstream-landing-toast-dismiss" aria-label="Dismiss">
                ×
              </button>
              <h2 id="filstream-landing-toast-title" class="filstream-landing-toast-title">
                Own your movies
              </h2>
              <ul class="filstream-landing-toast-list">
                <li>No Terms of Service</li>
                <li>No gatekeepers</li>
                <li>No central owning company</li>
                <li>Get 100% of ads revenue if you want them (coming soon)</li>
                <li>Just pay for space on Filecoin: about 0.10 USDFC for an hour-long movie per year.</li>
              </ul>
              <p class="filstream-landing-toast-cta">
                <a class="btn btn-primary" href="upload.html">Upload a movie</a>
              </p>
            </aside>
          `
        : null}
    `;
  }

  async firstUpdated() {
    await initViewerPage(this);
  }
}

customElements.define("filstream-viewer-app", FilstreamViewerApp);
