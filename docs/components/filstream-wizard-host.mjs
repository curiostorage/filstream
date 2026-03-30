/**
 * Upload wizard mount — light DOM so `style.css` applies.
 * The main template is registered from `ui.mjs` via `setFilstreamWizardTemplate`.
 */
import { LitElement, html } from "./lit-base.mjs";

/** @type {() => import("lit").TemplateResult} */
let wizardTemplate = () => html``;

/**
 * @param {() => import("lit").TemplateResult} fn
 */
export function setFilstreamWizardTemplate(fn) {
  wizardTemplate = fn;
}

export class FilstreamWizardHost extends LitElement {
  createRenderRoot() {
    return this;
  }

  render() {
    return wizardTemplate();
  }
}

customElements.define("filstream-wizard-host", FilstreamWizardHost);
