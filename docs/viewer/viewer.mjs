/**
 * GitHub Pages entry:
 * `viewer.html?meta=<absolute-https-url-to-meta.json>[&catalog=<absolute-url-to-filstream_catalog.json>]`
 *
 * Playback: fetch `meta.json`, then load `playback.masterAppUrl` with Shaka.
 * Optional `catalog` points at the dataset’s `filstream_catalog.json` (multi-title index); reserved for tools / future UI.
 */
import shaka from "https://esm.sh/shaka-player";

const statusEl = document.getElementById("viewer-status");
const videoEl = document.getElementById("viewer-video");

function setStatus(msg, kind) {
  if (!statusEl) return;
  statusEl.textContent = msg;
  statusEl.className = `viewer-status${kind === "err" ? " err" : ""}`;
}

const params = new URLSearchParams(window.location.search);
const metaUrl = params.get("meta");
const catalogUrl = params.get("catalog");
if (catalogUrl && !/^https?:\/\//i.test(catalogUrl)) {
  console.warn("[filstream viewer] Ignoring invalid catalog query param (expected absolute http(s) URL).");
}

if (!metaUrl || !/^https?:\/\//i.test(metaUrl)) {
  setStatus("Missing or invalid ?meta= URL (must be absolute https).", "err");
} else {
  void (async () => {
    try {
      const res = await fetch(metaUrl);
      if (!res.ok) {
        throw new Error(`meta.json HTTP ${res.status}`);
      }
      const meta = await res.json();
      const master =
        meta &&
        typeof meta.playback === "object" &&
        meta.playback !== null &&
        typeof meta.playback.masterAppUrl === "string"
          ? meta.playback.masterAppUrl.trim()
          : "";
      if (!master) {
        throw new Error("meta.json has no playback.masterAppUrl");
      }
      const poster =
        meta &&
        typeof meta.poster === "object" &&
        meta.poster !== null &&
        typeof meta.poster.url === "string"
          ? meta.poster.url.trim()
          : meta &&
              typeof meta.playback === "object" &&
              meta.playback !== null &&
              typeof meta.playback.posterUrl === "string"
            ? meta.playback.posterUrl.trim()
            : "";
      if (poster && videoEl) {
        videoEl.setAttribute("poster", poster);
      }
      setStatus("");
      shaka.polyfill.installAll();
      const player = new shaka.Player();
      await player.attach(/** @type {HTMLVideoElement} */ (videoEl));
      try {
        await player.load(master, undefined, "application/x-mpegurl");
      } catch (firstErr) {
        try {
          await player.load(master, undefined, "application/vnd.apple.mpegurl");
        } catch {
          throw firstErr;
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus(`Playback failed: ${msg}`, "err");
    }
  })();
}
