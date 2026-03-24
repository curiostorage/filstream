/**
 * Pipeline dependencies via esm.sh (browser bundles — no `node:` built-ins in the graph).
 * Raw Mediabunny files on jsDelivr import `node:fs/promises` and break in the browser.
 * Requires network + CSP allowing `esm.sh`.
 */
import {
  Input,
  Output,
  Conversion,
  ALL_FORMATS,
  BlobSource,
  Mp4OutputFormat,
  NullTarget,
  canEncodeVideo,
  canEncodeAudio,
} from "https://esm.sh/mediabunny";
import shaka from "https://esm.sh/shaka-player";

const FAKE_ORIGIN = "https://filstream.invalid";
const FRAGMENT_SECONDS = 2;

/** @see runFilstreamPipeline `segmentReadyTarget` */
export const SEGMENT_READY_EVENT = "segmentready";
/** Fired before a VP9 re-encode attempt after a recoverable hardware failure — drop buffered partials for that variant. */
export const SEGMENT_FLUSH_EVENT = "segmentflush";

/** Max(width,height) must be at least this to include a 1080p-height rung. */
const MIN_MAJOR_DIM_FOR_1080_RUNG = 1200;

/** Video bitrate ladder (bits per second); used for both VP9 and H.264 rungs. */
function vp9BitrateForHeight(h) {
  if (h >= 1080) return 2_500_000;
  if (h >= 720) return 1_500_000;
  if (h >= 360) return 500_000;
  if (h >= 144) return 200_000;
  return Math.max(80_000, Math.round((h / 144) * 200_000));
}

/** @see mediabunny `AVC_LEVEL_TABLE` / `buildVideoCodecString('avc', …)` */
const AVC_LEVEL_TABLE = [
  { maxMacroblocks: 99, maxBitrate: 64000, level: 0x0a },
  { maxMacroblocks: 396, maxBitrate: 192000, level: 0x0b },
  { maxMacroblocks: 396, maxBitrate: 384000, level: 0x0c },
  { maxMacroblocks: 396, maxBitrate: 768000, level: 0x0d },
  { maxMacroblocks: 396, maxBitrate: 2000000, level: 0x14 },
  { maxMacroblocks: 792, maxBitrate: 4000000, level: 0x15 },
  { maxMacroblocks: 1620, maxBitrate: 4000000, level: 0x16 },
  { maxMacroblocks: 1620, maxBitrate: 10000000, level: 0x1e },
  { maxMacroblocks: 3600, maxBitrate: 14000000, level: 0x1f },
  { maxMacroblocks: 5120, maxBitrate: 20000000, level: 0x20 },
  { maxMacroblocks: 8192, maxBitrate: 20000000, level: 0x28 },
  { maxMacroblocks: 8192, maxBitrate: 50000000, level: 0x29 },
  { maxMacroblocks: 8704, maxBitrate: 50000000, level: 0x2a },
  { maxMacroblocks: 22080, maxBitrate: 135000000, level: 0x32 },
  { maxMacroblocks: 36864, maxBitrate: 240000000, level: 0x33 },
  { maxMacroblocks: 36864, maxBitrate: 240000000, level: 0x34 },
  { maxMacroblocks: 139264, maxBitrate: 240000000, level: 0x3c },
  { maxMacroblocks: 139264, maxBitrate: 480000000, level: 0x3d },
  { maxMacroblocks: 139264, maxBitrate: 800000000, level: 0x3e },
];

function last(arr) {
  return arr[arr.length - 1];
}

function buildAvcCodecString(width, height, bitrate) {
  const profileIndication = 0x64;
  const totalMacroblocks = Math.ceil(width / 16) * Math.ceil(height / 16);
  const levelInfo =
    AVC_LEVEL_TABLE.find(
      (level) => totalMacroblocks <= level.maxMacroblocks && bitrate <= level.maxBitrate,
    ) ?? last(AVC_LEVEL_TABLE);
  const hexProfile = profileIndication.toString(16).padStart(2, "0");
  const hexLevel = levelInfo.level.toString(16).padStart(2, "0");
  return `avc1.${hexProfile}00${hexLevel}`;
}

async function canUseAvcHardwareForLadder(srcW, srcH, heights) {
  if (typeof VideoEncoder === "undefined" || typeof VideoEncoder.isConfigSupported !== "function") {
    return false;
  }
  if (!canEncodeVideo("avc")) return false;
  const framerate = 30;
  for (const h of heights) {
    const w = scaledWidth(srcW, srcH, h);
    const bitrate = vp9BitrateForHeight(h);
    const codec = buildAvcCodecString(w, h, bitrate);
    const r = await VideoEncoder.isConfigSupported({
      codec,
      width: w,
      height: h,
      bitrate,
      framerate,
      hardwareAcceleration: "prefer-hardware",
    });
    if (!r.supported || r.config?.hardwareAcceleration !== "prefer-hardware") {
      return false;
    }
  }
  return true;
}

/**
 * Rungs: 1080, 720, 360, 144. Drop 1080 if max(w,h) < 1200.
 * Drop any rung taller than the source display height.
 */
function ladderHeights(sourceW, sourceH) {
  let sh = Math.max(2, sourceH);
  sh -= sh % 2;
  const sw = Math.max(1, sourceW);
  const major = Math.max(sw, sh);

  let candidates = [1080, 720, 360, 144];
  if (major < MIN_MAJOR_DIM_FOR_1080_RUNG) {
    candidates = candidates.filter((h) => h !== 1080);
  }

  const out = [];
  for (const h of candidates) {
    if (h <= sh) out.push(h);
  }
  return out.length ? out : [sh];
}

function scaledWidth(srcW, srcH, targetH) {
  if (srcH < 1) {
    let w = Math.floor((targetH * 16) / 9);
    w -= w % 2;
    return Math.max(2, w);
  }
  let w = Math.floor((srcW * targetH) / srcH);
  w -= w % 2;
  return Math.max(2, w);
}

function bandwidthBits(videoBps, includeAudio) {
  let b = videoBps;
  if (includeAudio) b += 128_000;
  return Math.max(1, Math.round(b));
}

function copyU8(data) {
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function segmentDurationsSec(fragmentStartsSec, totalSec) {
  const durs = [];
  for (let i = 0; i < fragmentStartsSec.length; i++) {
    const end = i + 1 < fragmentStartsSec.length ? fragmentStartsSec[i + 1] : totalSec;
    durs.push(Math.max(0.001, end - fragmentStartsSec[i]));
  }
  return durs;
}

function buildMediaPlaylist(variantIndex, durationsSec) {
  const base = `${FAKE_ORIGIN}/v${variantIndex}`;
  const target = Math.ceil(Math.max(2, ...durationsSec.map((d) => d)));
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:6",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    `#EXT-X-TARGETDURATION:${target}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    `#EXT-X-MAP:URI="${base}/init.mp4"`,
  ];
  for (let i = 0; i < durationsSec.length; i++) {
    lines.push(`#EXTINF:${durationsSec[i].toFixed(3)},`);
    lines.push(`${base}/seg-${i + 1}.m4s`);
  }
  lines.push("#EXT-X-ENDLIST");
  return lines.join("\n");
}

/** Same as `buildMediaPlaylist` but paths relative to `v{n}/` on disk (debug export). */
function buildMediaPlaylistLocal(durationsSec) {
  const target = Math.ceil(Math.max(2, ...durationsSec.map((d) => d)));
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:6",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    `#EXT-X-TARGETDURATION:${target}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    '#EXT-X-MAP:URI="init.mp4"',
  ];
  for (let i = 0; i < durationsSec.length; i++) {
    lines.push(`#EXTINF:${durationsSec[i].toFixed(3)},`);
    lines.push(`seg-${i + 1}.m4s`);
  }
  lines.push("#EXT-X-ENDLIST");
  return lines.join("\n");
}

function buildMasterPlaylist(variants, includeAudio, videoCodecParam) {
  const codecs = includeAudio ? `${videoCodecParam},opus` : videoCodecParam;
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:6",
    "#EXT-X-INDEPENDENT-SEGMENTS",
  ];
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i];
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${v.bandwidth},RESOLUTION=${v.width}x${v.height},CODECS="${codecs}"`,
    );
    lines.push(`${FAKE_ORIGIN}/v${i}/playlist.m3u8`);
  }
  return lines.join("\n");
}

/** Master playlist with `v0/playlist.m3u8`-style lines for local inspection. */
function buildMasterPlaylistLocal(variants, includeAudio, videoCodecParam) {
  const codecs = includeAudio ? `${videoCodecParam},opus` : videoCodecParam;
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:6",
    "#EXT-X-INDEPENDENT-SEGMENTS",
  ];
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i];
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${v.bandwidth},RESOLUTION=${v.width}x${v.height},CODECS="${codecs}"`,
    );
    lines.push(`v${i}/playlist.m3u8`);
  }
  return lines.join("\n");
}

export async function probeVideoEncoderHardwareAcceleration() {
  if (typeof VideoEncoder === "undefined" || typeof VideoEncoder.isConfigSupported !== "function") {
    console.info(
      "[FilStream] VideoEncoder.isConfigSupported is not available; skipping encoder HW probe.",
    );
    return null;
  }

  const modes = [
    { key: "prefer-hardware", hardwareAcceleration: "prefer-hardware" },
    { key: "no-preference", hardwareAcceleration: undefined },
    { key: "prefer-software", hardwareAcceleration: "prefer-software" },
  ];

  const probes = [
    {
      id: "vp9-1080",
      codec: "vp09.00.41.08",
      width: 1920,
      height: 1080,
      bitrate: 2_500_000,
    },
    {
      id: "vp9-720",
      codec: "vp09.00.31.08",
      width: 1280,
      height: 720,
      bitrate: 1_500_000,
    },
    {
      id: "vp9-360",
      codec: "vp09.00.21.08",
      width: 640,
      height: 360,
      bitrate: 500_000,
    },
    {
      id: "vp9-144",
      codec: "vp09.00.10.08",
      width: 256,
      height: 144,
      bitrate: 200_000,
    },
    { id: "avc-1080", codec: "avc1.640028", width: 1920, height: 1080, bitrate: 5_000_000 },
    { id: "av1-1080", codec: "av01.0.08M.08", width: 1920, height: 1080, bitrate: 5_000_000 },
  ];

  const framerate = 30;
  const rows = [];

  for (const p of probes) {
    for (const { key, hardwareAcceleration } of modes) {
      const cfg = {
        codec: p.codec,
        width: p.width,
        height: p.height,
        bitrate: p.bitrate,
        framerate,
      };
      if (hardwareAcceleration !== undefined) {
        cfg.hardwareAcceleration = hardwareAcceleration;
      }
      try {
        const r = await VideoEncoder.isConfigSupported(cfg);
        rows.push({
          format: p.id,
          requested: key,
          supported: r.supported,
          resolvedHA: r.config?.hardwareAcceleration ?? "",
          resolvedCodec: r.config?.codec ?? "",
        });
      } catch (e) {
        rows.push({
          format: p.id,
          requested: key,
          supported: false,
          resolvedHA: "",
          resolvedCodec: "",
          error: e?.message ?? String(e),
        });
      }
    }
  }

  console.info("[FilStream] VideoEncoder support / hardwareAcceleration probe (browser-reported):");
  console.table(rows);

  const vp9Hw = rows.find(
    (r) => r.format === "vp9-1080" && r.requested === "prefer-hardware" && r.supported,
  );
  if (vp9Hw?.resolvedHA) {
    console.info(
      `[FilStream] VP9 1080p + prefer-hardware: supported; browser reports hardwareAcceleration="${vp9Hw.resolvedHA}".`,
    );
  }

  return rows;
}

function isRecoverableVideoHwError(message) {
  if (!message) return false;
  const m = String(message).toLowerCase();
  return (
    m.includes("encoder configuration") ||
    m.includes("not supported") ||
    m.includes("hardware acceleration") ||
    m.includes("videoconfiguration") ||
    m.includes("encoding configuration")
  );
}

/**
 * @typedef {{
 *   onFragmentReady?: (ev: {
 *     kind: "init" | "media",
 *     segmentIndex?: number,
 *     data: Uint8Array,
 *   }) => void,
 *   onEncodeAttemptReset?: () => void,
 * }} FragmentReadyHooks
 */

/**
 * @param {FragmentReadyHooks | null | undefined} hooks
 */
async function convertToFmp4Segments(
  file,
  includeAudio,
  videoOpts,
  onProgress,
  videoCodec,
  hooks,
) {
  const hwModes =
    videoCodec === "avc"
      ? ["prefer-hardware"]
      : ["prefer-hardware", "no-preference", "prefer-software"];
  let lastError = null;

  for (let attemptIdx = 0; attemptIdx < hwModes.length; attemptIdx++) {
    const hwAccel = hwModes[attemptIdx];
    if (attemptIdx > 0) {
      hooks?.onEncodeAttemptReset?.();
    }

    let ftyp = null;
    let moov = null;
    let pendingMoof = null;
    const segments = [];
    const fragmentStartsSec = [];
    let initEmitted = false;

    const tryEmitInit = () => {
      if (initEmitted || !ftyp || !moov || !hooks?.onFragmentReady) return;
      const init = new Uint8Array(ftyp.byteLength + moov.byteLength);
      init.set(ftyp, 0);
      init.set(moov, ftyp.byteLength);
      initEmitted = true;
      hooks.onFragmentReady({
        kind: "init",
        data: new Uint8Array(init),
      });
    };

    const format = new Mp4OutputFormat({
      fastStart: "fragmented",
      minimumFragmentDuration: FRAGMENT_SECONDS,
      onFtyp: (data) => {
        ftyp = copyU8(data);
        tryEmitInit();
      },
      onMoov: (data) => {
        moov = copyU8(data);
        tryEmitInit();
      },
      onMoof: (data, _start, fragmentStartTimestamp) => {
        pendingMoof = copyU8(data);
        fragmentStartsSec.push(fragmentStartTimestamp);
      },
      onMdat: (data) => {
        if (!pendingMoof) return;
        const mdat = copyU8(data);
        const seg = new Uint8Array(pendingMoof.byteLength + mdat.byteLength);
        seg.set(pendingMoof, 0);
        seg.set(mdat, pendingMoof.byteLength);
        segments.push(seg);
        pendingMoof = null;
        hooks?.onFragmentReady?.({
          kind: "media",
          segmentIndex: segments.length,
          data: new Uint8Array(seg),
        });
      },
    });

    const input = new Input({
      source: new BlobSource(file),
      formats: ALL_FORMATS,
    });

    const output = new Output({
      format,
      target: new NullTarget(),
    });

    const conversion = await Conversion.init({
      input,
      output,
      video: {
        codec: videoCodec,
        height: videoOpts.height,
        width: videoOpts.width,
        fit: "contain",
        keyFrameInterval: FRAGMENT_SECONDS,
        bitrate: videoOpts.bitrate,
        hardwareAcceleration: hwAccel,
      },
      audio: includeAudio
        ? { codec: "opus", bitrate: 128_000 }
        : { discard: true },
      showWarnings: false,
    });

    if (!conversion.isValid) {
      const reasons = conversion.discardedTracks
        .map((t) => t.reason)
        .join("; ");
      lastError = new Error(
        reasons || "Conversion is not valid for this file",
      );
      if (
        videoCodec === "vp9" &&
        hwAccel !== "prefer-software" &&
        isRecoverableVideoHwError(reasons)
      ) {
        continue;
      }
      throw lastError;
    }

    try {
      conversion.onProgress = onProgress;
      await conversion.execute();
    } catch (e) {
      lastError = e;
      const msg = e?.message || String(e);
      if (
        videoCodec === "vp9" &&
        hwAccel !== "prefer-software" &&
        isRecoverableVideoHwError(msg)
      ) {
        continue;
      }
      throw e;
    }

    if (!ftyp || !moov) {
      throw new Error("Missing ftyp/moov from fragmented output");
    }
    if (pendingMoof) {
      throw new Error("Incomplete fragment (moof without mdat)");
    }

    const init = new Uint8Array(ftyp.byteLength + moov.byteLength);
    init.set(ftyp, 0);
    init.set(moov, ftyp.byteLength);

    const durationSec = await input.computeDuration();

    return { init, segments, fragmentStartsSec, durationSec };
  }

  throw (
    lastError ?? new Error(`${videoCodec} encode failed for all acceleration modes`)
  );
}

/**
 * @typedef {object} SegmentReadyDetail
 * @property {number} variantIndex
 * @property {number} width
 * @property {number} height
 * @property {"init"|"media"} kind
 * @property {number} [segmentIndex] 1-based when `kind === "media"` (matches `seg-{n}.m4s`)
 * @property {Uint8Array} data copy of init.mp4 or media segment bytes
 */

/**
 * @typedef {object} SegmentFlushDetail
 * @property {number} variantIndex
 * @property {number} width
 * @property {number} height
 * @property {string} reason e.g. `encode-retry` before another VP9 hardware-acceleration attempt
 */

/**
 * @param {{
 *   onSegmentReady?: (d: SegmentReadyDetail) => void | Promise<void>,
 *   onSegmentFlush?: (d: SegmentFlushDetail) => void | Promise<void>,
 *   segmentReadyTarget?: EventTarget,
 * }} ui
 * @param {number} variantIndex
 * @param {number} width
 * @param {number} height
 * @returns {FragmentReadyHooks | null}
 */
function buildVariantSegmentHooks(ui, variantIndex, width, height) {
  if (!ui.segmentReadyTarget && !ui.onSegmentReady && !ui.onSegmentFlush) {
    return null;
  }
  return {
    onFragmentReady: (frag) => {
      /** @type {SegmentReadyDetail} */
      const detail = {
        variantIndex,
        width,
        height,
        kind: frag.kind,
        segmentIndex: frag.segmentIndex,
        data: frag.data,
      };
      try {
        void ui.onSegmentReady?.(detail);
        ui.segmentReadyTarget?.dispatchEvent(
          new CustomEvent("segmentready", { detail }),
        );
      } catch (e) {
        console.error("[FilStream] onSegmentReady / segmentready handler failed:", e);
      }
    },
    onEncodeAttemptReset: () => {
      /** @type {SegmentFlushDetail} */
      const detail = {
        variantIndex,
        width,
        height,
        reason: "encode-retry",
      };
      try {
        void ui.onSegmentFlush?.(detail);
        ui.segmentReadyTarget?.dispatchEvent(
          new CustomEvent("segmentflush", { detail }),
        );
      } catch (e) {
        console.error("[FilStream] onSegmentFlush / segmentflush handler failed:", e);
      }
    },
  };
}

/** Human-readable segment count for status (avoids "299/299/299/299" when all match). */
function segmentCountSummary(encoded) {
  const counts = encoded.map((v) => v.segmentCount);
  if (!counts.length) return "";
  const n = counts[0];
  if (counts.every((c) => c === n)) {
    return `${n} segment${n === 1 ? "" : "s"} per quality level`;
  }
  return `segments per level: ${counts.join(", ")}`;
}

function installFakeOriginRouting({
  engine,
  masterURL,
  variantPlaylistURLs,
  variants,
}) {
  const masterNeedle = `${FAKE_ORIGIN}/master.m3u8`;
  const variantBase = `${FAKE_ORIGIN}/v`;

  engine.registerRequestFilter((_type, request) => {
    const u = request.uris[0];
    if (u === masterNeedle) {
      request.uris[0] = masterURL;
      return;
    }
    if (!u.startsWith(variantBase)) return;
    const rest = u.slice(variantBase.length);
    const slash = rest.indexOf("/");
    if (slash === -1) return;
    const idx = parseInt(rest.slice(0, slash), 10);
    if (Number.isNaN(idx) || idx < 0) return;
    const path = rest.slice(slash + 1);

    if (path === "playlist.m3u8" && idx < variantPlaylistURLs.length) {
      request.uris[0] = variantPlaylistURLs[idx];
      return;
    }
    if (path === "init.mp4" && idx < variants.length) {
      request.uris[0] = variants[idx].initURL;
      return;
    }
    const segM = path.match(/^seg-(\d+)\.m4s$/);
    if (segM && idx < variants.length) {
      const segIdx = parseInt(segM[1], 10) - 1;
      const segs = variants[idx].segmentURLs;
      if (segIdx >= 0 && segIdx < segs.length) {
        request.uris[0] = segs[segIdx];
      }
    }
  });
}

let player = null;
const revokeList = [];

/** Last successful transcode for optional debug upload (see `uploadDebugHlsToServer`). */
let debugHlsSnapshot = null;
/** @type {File | null} */
let debugSourceFile = null;

function revokeAll() {
  for (const r of revokeList) {
    try {
      URL.revokeObjectURL(r);
    } catch {
      /* ignore */
    }
  }
  revokeList.length = 0;
}

function pushBlobURL(blob) {
  const url = URL.createObjectURL(blob);
  revokeList.push(url);
  return url;
}

/**
 * Tear down Shaka and revoke blob URLs. Call from UI when canceling or starting over.
 */
export async function resetFilstreamPlayback() {
  if (player) {
    await player.destroy();
    player = null;
  }
  revokeAll();
  debugHlsSnapshot = null;
  debugSourceFile = null;
}

/**
 * Whether the last run left HLS blobs in memory (before reset / new encode).
 * @returns {boolean}
 */
export function hasDebugHlsSnapshot() {
  return debugHlsSnapshot != null;
}

/**
 * POST one ZIP to the dev server (multipart hits Go's 1000-part limit on large ladders).
 * Playlists use on-disk-relative URIs (`master-local.m3u8`, `v{n}/playlist.m3u8`).
 * @param {string} [baseUrl] e.g. "" for same origin
 * @returns {Promise<{ savedTo: string }>}
 */
export async function uploadDebugHlsToServer(baseUrl = "") {
  if (!debugHlsSnapshot) {
    throw new Error("No HLS in memory — finish transcoding first.");
  }
  const snap = debugHlsSnapshot;
  const { zipSync } = await import("https://cdn.jsdelivr.net/npm/fflate@0.8.2/+esm");
  const te = new TextEncoder();

  const meta = {
    exportedAt: new Date().toISOString(),
    sourceName: debugSourceFile?.name ?? null,
    variantCount: snap.variants.length,
    note: "Playlists: master-local.m3u8 and v*/playlist.m3u8 use relative paths for local tools.",
    archive: "application/zip via fflate (avoids multipart part-count limits).",
  };

  /** @type {Record<string, Uint8Array>} */
  const zipEntries = {
    "meta.json": te.encode(JSON.stringify(meta, null, 2)),
    "master-local.m3u8": te.encode(snap.masterTextLocal),
    "master-app.m3u8": te.encode(snap.masterTextApp),
  };

  for (let i = 0; i < snap.variants.length; i++) {
    const v = snap.variants[i];
    zipEntries[`v${i}/playlist.m3u8`] = te.encode(v.playlistTextLocal);
    const initBuf = await fetch(v.initURL).then((r) => r.arrayBuffer());
    zipEntries[`v${i}/init.mp4`] = new Uint8Array(initBuf);
    for (let j = 0; j < v.segmentURLs.length; j++) {
      const segBuf = await fetch(v.segmentURLs[j]).then((r) => r.arrayBuffer());
      zipEntries[`v${i}/seg-${j + 1}.m4s`] = new Uint8Array(segBuf);
    }
  }

  if (debugSourceFile) {
    const safe = debugSourceFile.name.replace(/[^a-zA-Z0-9._-]+/g, "_");
    const srcBuf = await debugSourceFile.arrayBuffer();
    zipEntries[`source/${safe}`] = new Uint8Array(srcBuf);
  }

  const zipped = zipSync(zipEntries, { level: 0 });

  const res = await fetch(`${baseUrl}/api/debug-hls`, {
    method: "POST",
    headers: { "Content-Type": "application/zip" },
    body: zipped,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(t || res.statusText || String(res.status));
  }
  return res.json();
}

/**
 * @param {File} file
 * @param {{
 *   setStatus: (msg: string, kind?: string) => void,
 *   setProgress: (pct: number) => void,
 *   getVideoElement: () => HTMLVideoElement,
 *   onPlaybackReady: (player: import("shaka-player").Player, info: {
 *     nVar: number,
 *     segmentCounts: string,
 *     stackHint: string,
 *     rungs: { variantIndex: number, width: number, height: number, bandwidth: number }[],
 *   }) => void,
 *   onSegmentReady?: (d: SegmentReadyDetail) => void | Promise<void>,
 *   onSegmentFlush?: (d: SegmentFlushDetail) => void | Promise<void>,
 *   segmentReadyTarget?: EventTarget,
 * }} ui
 *
 * Incremental output: set `segmentReadyTarget` (e.g. `new EventTarget()`) and/or `onSegmentReady`.
 * Listen with `segmentReadyTarget.addEventListener(SEGMENT_READY_EVENT, (e) => { e.detail … })` (`CustomEvent`).
 * On VP9 hardware fallback, `SEGMENT_FLUSH_EVENT` / `onSegmentFlush` runs first so you can discard partial uploads for that variant.
 */
export async function runFilstreamPipeline(file, ui) {
  const { setStatus, setProgress, getVideoElement, onPlaybackReady } = ui;
  debugSourceFile = file;
  debugHlsSnapshot = null;

  const probeInput = new Input({
    source: new BlobSource(file),
    formats: ALL_FORMATS,
  });
  const primaryAudio = await probeInput.getPrimaryAudioTrack();
  const includeAudio = primaryAudio != null;
  if (includeAudio && !canEncodeAudio("opus")) {
    setStatus(
      "This browser cannot encode Opus (WebCodecs). Try recent Chrome or Edge.",
      "err",
    );
    return;
  }

  const vt = await probeInput.getPrimaryVideoTrack();
  const srcH = vt?.displayHeight ?? 720;
  const srcW = vt?.displayWidth ?? 1280;
  const heights = ladderHeights(srcW, srcH);
  const nVar = heights.length;

  let preferAvc = await canUseAvcHardwareForLadder(srcW, srcH, heights);
  if (preferAvc && !canEncodeVideo("avc")) preferAvc = false;
  if (!preferAvc && !canEncodeVideo("vp9")) {
    setStatus(
      "This browser cannot encode VP9 or H.264 (WebCodecs). Try recent Chrome or Edge.",
      "err",
    );
    return;
  }

  shaka.polyfill.installAll();
  if (!shaka.Player.isBrowserSupported()) {
    setStatus("Shaka Player is not supported in this browser.", "err");
    return;
  }

  const video = getVideoElement();

  async function fullAttempt(useAvc) {
    if (player) {
      await player.destroy();
      player = null;
    }
    revokeAll();
    video.removeAttribute("src");
    video.load();

    const videoCodec = useAvc ? "avc" : "vp9";
    const videoLabel = useAvc ? "H.264 (hardware)" : "VP9";
    const maxH = heights[0];
    const maxW = scaledWidth(srcW, srcH, maxH);
    const maxBr = vp9BitrateForHeight(maxH);
    const masterVideoCodecParam = useAvc
      ? buildAvcCodecString(maxW, maxH, maxBr)
      : "vp09.00.41.08";

    setStatus(
      includeAudio
        ? `Transcoding ${nVar} ${videoLabel} + Opus rung(s) for HLS ABR…`
        : `Transcoding ${nVar} ${videoLabel} rung(s) for HLS ABR…`,
      "",
    );
    setProgress(0);

    const globalProgress = new Array(nVar).fill(0);
    const reportProgress = () => {
      const sum = globalProgress.reduce((a, p) => a + p, 0);
      setProgress(Math.round(Math.min(100, (sum / nVar) * 100)));
    };

    async function encodeRung(i) {
      const h = heights[i];
      const w = scaledWidth(srcW, srcH, h);
      const br = vp9BitrateForHeight(h);
      const segmentHooks = buildVariantSegmentHooks(ui, i, w, h);
      const { init, segments, fragmentStartsSec, durationSec } =
        await convertToFmp4Segments(
          file,
          includeAudio,
          { height: h, width: w, bitrate: br },
          (localP) => {
            globalProgress[i] = localP;
            reportProgress();
          },
          videoCodec,
          segmentHooks,
        );
      globalProgress[i] = 1;
      reportProgress();

      const initURL = pushBlobURL(new Blob([init], { type: "video/mp4" }));
      const segmentURLs = segments.map((seg) =>
        pushBlobURL(new Blob([seg], { type: "video/mp4" })),
      );

      return {
        i,
        initURL,
        segmentURLs,
        durationSec,
        dursSec: segmentDurationsSec(fragmentStartsSec, durationSec),
        width: w,
        height: h,
        bandwidth: bandwidthBits(br, includeAudio),
        segmentCount: segments.length,
      };
    }

    // H.264 path is hardware-only — run all rungs at once. VP9 may use software WebCodecs; cap concurrency at 2.
    const parallelPerBatch = useAvc ? nVar : Math.min(2, nVar);
    const batches = [];
    for (let start = 0; start < nVar; start += parallelPerBatch) {
      const idxs = [];
      for (let k = 0; k < parallelPerBatch && start + k < nVar; k++) {
        idxs.push(start + k);
      }
      batches.push(idxs);
    }

    const encodedChunks = [];
    for (let b = 0; b < batches.length; b++) {
      const idxs = batches[b];
      const labels = idxs
        .map((i) => {
          const h = heights[i];
          const w = scaledWidth(srcW, srcH, h);
          return `${w}×${h}`;
        })
        .join(" + ");
      setStatus(
        `Encoding batch ${b + 1}/${batches.length} (${labels}) — ${idxs.length} parallel ${videoLabel}…`,
        "",
      );
      const batchResults = await Promise.all(idxs.map((i) => encodeRung(i)));
      encodedChunks.push(...batchResults);
    }

    encodedChunks.sort((a, b) => a.i - b.i);
    const encoded = encodedChunks.map(
      ({
        i: _i,
        initURL,
        segmentURLs,
        durationSec,
        dursSec,
        width,
        height,
        bandwidth,
        segmentCount,
      }) => ({
        initURL,
        segmentURLs,
        durationSec,
        dursSec,
        width,
        height,
        bandwidth,
        segmentCount,
      }),
    );

    setProgress(100);

    const variantPlaylistURLs = encoded.map((v, i) =>
      pushBlobURL(
        new Blob([buildMediaPlaylist(i, v.dursSec)], {
          type: "application/vnd.apple.mpegurl",
        }),
      ),
    );

    const masterText = buildMasterPlaylist(
      encoded,
      includeAudio,
      masterVideoCodecParam,
    );
    const masterURL = pushBlobURL(
      new Blob([masterText], { type: "application/vnd.apple.mpegurl" }),
    );

    player = new shaka.Player();
    await player.attach(video, true);
    // Blob/object URLs complete instantly; Shaka's default throughput guess + Network
    // Information API can read as "slow" and lock ABR on the lowest rung.
    player.configure({
      abr: {
        enabled: true,
        useNetworkInformation: false,
        defaultBandwidthEstimate: 1e9,
      },
    });
    const net = player.getNetworkingEngine();
    installFakeOriginRouting({
      engine: net,
      masterURL,
      variantPlaylistURLs,
      variants: encoded,
    });

    try {
      await player.load(`${FAKE_ORIGIN}/master.m3u8`);
      const segSummary = segmentCountSummary(encoded);
      const stackHint = useAvc
        ? "H.264 + Opus in fMP4 (hardware encoder when available)."
        : "VP9 + Opus in fMP4.";
      onPlaybackReady(player, {
        nVar,
        segmentCounts: segSummary,
        stackHint,
        rungs: encoded.map((v, variantIndex) => ({
          variantIndex,
          width: v.width,
          height: v.height,
          bandwidth: v.bandwidth,
        })),
      });
      debugHlsSnapshot = {
        masterTextApp: masterText,
        masterTextLocal: buildMasterPlaylistLocal(
          encoded,
          includeAudio,
          masterVideoCodecParam,
        ),
        variants: encoded.map((v, i) => ({
          playlistTextLocal: buildMediaPlaylistLocal(v.dursSec),
          initURL: v.initURL,
          segmentURLs: v.segmentURLs.slice(),
        })),
      };
      setStatus(
        `Ready — ${nVar} HLS levels (${segSummary}). Local ABR favors high quality. ${stackHint}`,
        "ok",
      );
    } catch (e) {
      await player.destroy();
      player = null;
      throw e;
    }
  }

  try {
    await fullAttempt(preferAvc);
  } catch (e) {
    if (preferAvc) {
      setStatus("Hardware H.264 encode failed; retrying with VP9…", "");
      try {
        await fullAttempt(false);
      } catch (e2) {
        setStatus(e2.message || String(e2), "err");
        if (player) {
          await player.destroy();
          player = null;
        }
      }
    } else {
      setStatus(e.message || String(e), "err");
      if (player) {
        await player.destroy();
        player = null;
      }
    }
  }
}
