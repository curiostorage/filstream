/**
 * Standalone embed: `?meta=<absolute URL to meta.json>`.
 * Fetches meta, loads `playback.masterAppUrl` with Shaka.
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
