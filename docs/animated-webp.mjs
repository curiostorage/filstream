/**
 * Build a catalog mini WebP from a source video: normally a 20-frame animation (10s, 12s, …, 4 FPS).
 * If the clip is shorter than ~10s, encodes a single static WebP of the first frame instead.
 * Uses vendored webpxmux (libwebp WASM).
 */
import {
  CATALOG_ANIM_MAX_WIDTH_PX,
  FRAME_COUNT,
  MIN_DURATION_FOR_ANIM_SEC,
  PLAYBACK_FPS,
  START_SEC,
  STEP_SEC,
} from "./filstream-constants.mjs";
export { CATALOG_ANIM_MAX_WIDTH_PX };

/** @type {Promise<(...args: unknown[]) => unknown> | null} */
let muxLoader = null;

/**
 * @returns {Promise<(...args: unknown[]) => unknown>}
 */
function ensureWebPXMux() {
  if (!muxLoader) {
    muxLoader = new Promise((resolve, reject) => {
      const W = globalThis.WebPXMux;
      if (typeof W === "function") {
        resolve(/** @type {(...args: unknown[]) => unknown} */ (W));
        return;
      }
      const s = document.createElement("script");
      s.src = new URL("./vendor/webpxmux/webpxmux.min.js", import.meta.url).href;
      s.async = true;
      s.onload = () => {
        const Ctor = globalThis.WebPXMux;
        if (typeof Ctor !== "function") {
          reject(new Error("WebPXMux global missing after load"));
          return;
        }
        resolve(/** @type {(...args: unknown[]) => unknown} */ (Ctor));
      };
      s.onerror = () => reject(new Error("Failed to load webpxmux"));
      document.head.appendChild(s);
    });
  }
  return muxLoader;
}

/**
 * @param {ImageData} imageData
 * @param {number} durationMs
 * @param {boolean} isKeyframe
 */
function imageDataToRgbaPacked(imageData) {
  const { width, height, data } = imageData;
  const rgba = new Uint32Array(width * height);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    rgba[j] =
      (data[i] << 24) |
      (data[i + 1] << 16) |
      (data[i + 2] << 8) |
      data[i + 3];
  }
  return rgba;
}

/**
 * @param {ImageData} imageData
 * @param {number} durationMs
 * @param {boolean} isKeyframe
 */
function imageDataToFrame(imageData, durationMs, isKeyframe) {
  const { width, height } = imageData;
  return {
    duration: durationMs,
    isKeyframe,
    rgba: imageDataToRgbaPacked(imageData),
  };
}

/**
 * @param {ImageData} imageData
 * @returns {{ width: number, height: number, rgba: Uint32Array }}
 */
function imageDataToBitmap(imageData) {
  const { width, height } = imageData;
  return {
    width,
    height,
    rgba: imageDataToRgbaPacked(imageData),
  };
}

/**
 * @param {HTMLVideoElement} video
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} w
 * @param {number} h
 * @param {number} targetSec
 */
function seekAndDraw(video, ctx, w, h, targetSec) {
  const cap = Math.max(0, video.duration - 0.001);
  const t = Math.min(Math.max(0, targetSec), cap);
  if (Math.abs(video.currentTime - t) < 0.02) {
    ctx.drawImage(video, 0, 0, w, h);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const onSeeked = () => {
      cleanup();
      ctx.drawImage(video, 0, 0, w, h);
      resolve();
    };
    const onErr = () => {
      cleanup();
      reject(video.error || new Error("Video seek failed"));
    };
    function cleanup() {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onErr);
    }
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onErr);
    video.currentTime = t;
  });
}

/**
 * @param {number} w
 * @param {number} h
 */
function miniPosterDimensions(w, h) {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return { tw: 1, th: 1 };
  }
  const tw = Math.min(CATALOG_ANIM_MAX_WIDTH_PX, Math.round(w));
  const th = Math.max(1, Math.round((tw * h) / w));
  return { tw, th };
}

/**
 * @param {HTMLVideoElement} video
 * @param {number} w
 * @param {number} h
 * @returns {Promise<Blob>}
 */
export async function captureListingAnimatedWebp(video, w, h) {
  const canvasFull = document.createElement("canvas");
  canvasFull.width = w;
  canvasFull.height = h;
  const ctxFull = canvasFull.getContext("2d");
  if (!ctxFull) throw new Error("Could not get canvas context.");

  const { tw, th } = miniPosterDimensions(w, h);
  const canvasMini = document.createElement("canvas");
  canvasMini.width = tw;
  canvasMini.height = th;
  const ctxMini = canvasMini.getContext("2d");
  if (!ctxMini) throw new Error("Could not get mini canvas context.");
  ctxMini.imageSmoothingEnabled = true;
  ctxMini.imageSmoothingQuality = "high";

  const dur = video.duration;
  const useFirstFrameOnly =
    !Number.isFinite(dur) || dur <= 0 || dur < MIN_DURATION_FOR_ANIM_SEC;

  const durationMs = Math.round(1000 / PLAYBACK_FPS);
  const savedTime = video.currentTime;

  /** @type {ImageData | null} */
  let shortStillImageData = null;
  /** @type {{ duration: number, isKeyframe: boolean, rgba: Uint32Array }[]} */
  const frameList = [];
  try {
    if (useFirstFrameOnly) {
      await seekAndDraw(video, ctxFull, w, h, 0);
      ctxMini.drawImage(canvasFull, 0, 0, tw, th);
      shortStillImageData = ctxMini.getImageData(0, 0, tw, th);
    } else {
      for (let i = 0; i < FRAME_COUNT; i++) {
        const t = START_SEC + i * STEP_SEC;
        const cap = Math.max(0, video.duration - 0.05);
        const target = Math.min(t, cap);
        await seekAndDraw(video, ctxFull, w, h, target);
        ctxMini.drawImage(canvasFull, 0, 0, tw, th);
        const imageData = ctxMini.getImageData(0, 0, tw, th);
        frameList.push(imageDataToFrame(imageData, durationMs, i === 0));
      }
    }
  } finally {
    try {
      await seekAndDraw(video, ctxFull, w, h, savedTime);
    } catch {
      /* ignore restore failure */
    }
  }

  const WebPXMux = await ensureWebPXMux();
  const wasmHref = new URL("./vendor/webpxmux/webpxmux.wasm", import.meta.url).href;
  const xMux = /** @type {{
    waitRuntime: () => Promise<void>,
    encodeFrames: (f: unknown) => Promise<Uint8Array>,
    encodeWebP: (b: unknown) => Promise<Uint8Array>,
  }} */ (WebPXMux(wasmHref));
  await xMux.waitRuntime();

  if (useFirstFrameOnly) {
    if (!shortStillImageData) {
      throw new Error("Could not capture preview frame.");
    }
    const out = await xMux.encodeWebP(imageDataToBitmap(shortStillImageData));
    return new Blob([out], { type: "image/webp" });
  }

  const payload = {
    frameCount: FRAME_COUNT,
    width: tw,
    height: th,
    loopCount: 0,
    bgColor: 0xff000000,
    frames: frameList,
  };
  const out = await xMux.encodeFrames(payload);
  return new Blob([out], { type: "image/webp" });
}
