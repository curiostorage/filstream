/**
 * Replace __installFilstreamDocumentCss + string blob with lit-html html`<style>…</style>` + render().
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const LIT_CDN = "https://cdn.jsdelivr.net/npm/lit-html@3.2.1/+esm";

function gitShow(relPath) {
  return execSync(`git show HEAD:${relPath}`, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    cwd: root,
  });
}

/** Escape raw CSS so it is safe inside a JS template literal (backticks / ${ / \). */
function escapeForTemplateLiteral(css) {
  return css.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

function makePrefix({ styleId, constName, css, includeLitImport }) {
  const body = escapeForTemplateLiteral(css);
  const importLine = includeLitImport
    ? `import { html, render } from "${LIT_CDN}";\n\n`
    : "";
  return `${importLine}const ${constName} = html\`
<style id="${styleId}">
${body}
</style>
\`;

{
  const mount = document.createElement("span");
  mount.hidden = true;
  document.head.appendChild(mount);
  if (!document.getElementById(${JSON.stringify(styleId)})) {
    render(${constName}, mount);
  }
}

`;
}

function stripOldPrefix(src) {
  const end = src.indexOf("\n\n/**");
  if (end === -1) throw new Error("expected /** after install block");
  const head = src.slice(0, end);
  if (!head.includes("__installFilstreamDocumentCss")) {
    throw new Error("expected __installFilstreamDocumentCss block");
  }
  return src.slice(end + 2); // keep one \n before /**
}

const catalogAppCss = gitShow("docs/components/filstream-catalog-app.css");
const creatorCss = gitShow("docs/creator/creator.css");
const wizardCss = gitShow("docs/style.css");

const catalogAppPath = path.join(root, "docs", "components", "catalog-app.mjs");
const creatorPath = path.join(root, "docs", "components", "creator.mjs");
const uiPath = path.join(root, "docs", "components", "ui.mjs");

let catalogAppSrc = fs.readFileSync(catalogAppPath, "utf8");
catalogAppSrc =
  makePrefix({
    styleId: "filstream-catalog-app-global-css",
    constName: "filstreamCatalogAppGlobalStyles",
    css: catalogAppCss,
    includeLitImport: true,
  }) + stripOldPrefix(catalogAppSrc);
fs.writeFileSync(catalogAppPath, catalogAppSrc);

let creatorSrc = fs.readFileSync(creatorPath, "utf8");
creatorSrc =
  makePrefix({
    styleId: "filstream-creator-global-css",
    constName: "filstreamCreatorGlobalStyles",
    css: creatorCss,
    includeLitImport: true,
  }) + stripOldPrefix(creatorSrc);
fs.writeFileSync(creatorPath, creatorSrc);

let uiSrc = fs.readFileSync(uiPath, "utf8");
const uiRest = stripOldPrefix(uiSrc);
// ui.mjs already imports html, render — insert style block after first import line block
const firstImportEnd = uiRest.indexOf("\n\n");
if (firstImportEnd === -1) throw new Error("ui.mjs: expected imports");
const uiImports = uiRest.slice(0, firstImportEnd);
const uiBody = uiRest.slice(firstImportEnd + 2);
const styleBlock = makePrefix({
  styleId: "filstream-upload-wizard-css",
  constName: "filstreamUploadWizardStyles",
  css: wizardCss,
  includeLitImport: false,
});
fs.writeFileSync(uiPath, `${uiImports}\n\n${styleBlock}${uiBody}`);

console.log("embed-lit-global-styles: wrote catalog-app.mjs, creator.mjs, ui.mjs");
