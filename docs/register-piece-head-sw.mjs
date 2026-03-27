/**
 * Registers the piece HEAD → ranged-GET service worker (see `piece-head-sw.js`).
 * Safe to import from every app shell; registration is idempotent.
 */
const swUrl = new URL("./piece-head-sw.js", import.meta.url);
const scopeUrl = new URL("./", import.meta.url);

if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
  navigator.serviceWorker.register(swUrl, { scope: scopeUrl }).catch(() => {});
}
