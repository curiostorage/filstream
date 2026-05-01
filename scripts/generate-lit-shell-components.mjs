#!/usr/bin/env node
/**
 * Legacy entry point. Page chrome is plain HTML plus linked stylesheets:
 * - `docs/style.css` — upload wizard (`upload.html`)
 * - `docs/viewer/viewer.css` — discover / viewer (`index.html`, `viewer.html`)
 * - `docs/creator/creator.css` — creator dashboard (`creator.html`)
 *
 * LitElement components keep `static styles` in their module; lit-html panels rely
 * on the stylesheet for the page that hosts them.
 */
console.error(
  "generate-lit-shell-components.mjs is retired. Edit the CSS files under docs/ listed in this script's header comment.",
);
process.exit(1);
