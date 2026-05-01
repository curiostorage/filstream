import "./filstream-upload-app.mjs";
import { startUploadWizard } from "./ui.mjs";

await customElements.whenDefined("filstream-upload-app");
const host = document.querySelector("filstream-upload-app");
if (!(host instanceof HTMLElement)) {
  throw new TypeError("Expected <filstream-upload-app> in the document.");
}
await host.updateComplete;
const mount = host.querySelector("#wizard-root");
if (!(mount instanceof HTMLElement)) {
  throw new TypeError("Expected #wizard-root inside <filstream-upload-app>.");
}
startUploadWizard(mount);
