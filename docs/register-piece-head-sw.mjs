/**
 * Registers the piece HEAD → ranged-GET service worker (see `piece-head-sw.js`).
 * Await {@link whenPieceHeadServiceWorkerReady} before playback or any PDP `piece/*` HEAD
 * traffic so interceptors are active (avoids 405 from hosts that disallow HEAD).
 *
 * Not wired from app entry points (`ui.mjs`, `viewer/viewer.mjs`, `creator/creator.mjs`) right now;
 * import and `await whenPieceHeadServiceWorkerReady()` there to re-enable.
 */
const swUrl = new URL("./piece-head-sw.js", import.meta.url);
const scopeUrl = new URL("./", import.meta.url);

/**
 * Resolves when registration finished and `navigator.serviceWorker.ready` (active worker).
 * No-ops when Service Workers are unavailable; swallows registration failures.
 *
 * @returns {Promise<void>}
 */
export async function whenPieceHeadServiceWorkerReady() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return;
  }
  try {
    await navigator.serviceWorker.register(swUrl, { scope: scopeUrl });
    await navigator.serviceWorker.ready;
  } catch {
    /* ignore */
  }
}
