import { LitElement, html } from "https://cdn.jsdelivr.net/npm/lit@3.2.1/+esm";

/**
 * Upload page shell (light DOM). Wizard UI is rendered into `#wizard-root` by `ui.mjs`.
 */
export class FilstreamUploadApp extends LitElement {
  createRenderRoot() {
    return this;
  }

  render() {
    return html`<div id="wizard-root"></div>`;
  }
}

customElements.define("filstream-upload-app", FilstreamUploadApp);
