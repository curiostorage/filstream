/**
 * Pipeline dependencies via esm.sh (browser bundles — no `node:` built-ins in the graph).
 * Raw Mediabunny files on jsDelivr import `node:fs/promises` and break in the browser.
 * Requires network + CSP allowing `esm.sh`.
 */
import {
  ALL_FORMATS,
  BlobSource,
  Conversion,
  Input,
  Mp4OutputFormat,
  NullTarget,
  Output,
  canEncodeAudio,
  canEncodeVideo,
} from "https://esm.sh/mediabunny";
import shaka from "https://esm.sh/shaka-player";
import { USDFC_DONATE_TOKEN } from "./filstream-chain-config.mjs";
import {
  AVC_LEVEL_TABLE as SHARED_AVC_LEVEL_TABLE,
  CORE_FRAGMENT_SECONDS,
  FILE_EVENT as SHARED_FILE_EVENT,
  FILSTREAM_FAKE_ORIGIN as SHARED_FILSTREAM_FAKE_ORIGIN,
  LISTING_DETAILS_EVENT as SHARED_LISTING_DETAILS_EVENT,
  MIN_MAJOR_DIM_FOR_1080_RUNG as SHARED_MIN_MAJOR_DIM_FOR_1080_RUNG,
  SEGMENT_FLUSH_EVENT as SHARED_SEGMENT_FLUSH_EVENT,
  SEGMENT_READY_EVENT as SHARED_SEGMENT_READY_EVENT,
  TRANSCODE_COMPLETE_EVENT as SHARED_TRANSCODE_COMPLETE_EVENT,
} from "./filstream-constants.mjs";

const FAKE_ORIGIN = SHARED_FILSTREAM_FAKE_ORIGIN;
const FRAGMENT_SECONDS = CORE_FRAGMENT_SECONDS;

/** @see runFilstreamPipeline event target */
export const SEGMENT_READY_EVENT = SHARED_SEGMENT_READY_EVENT;
/** Fired before another H.264 hardware-acceleration attempt after a recoverable encoder failure — drop buffered partials for that variant. */
export const SEGMENT_FLUSH_EVENT = SHARED_SEGMENT_FLUSH_EVENT;
/** Non-binary artifacts: `init.json`, `*.m3u8`, etc. (listing JSON is emitted with {@link LISTING_DETAILS_EVENT}). */
export const FILE_EVENT = SHARED_FILE_EVENT;
/** Encodes finished; HLS master + variant playlists are ready (before Shaka attach/load). Transcode meta is finalized in {@link LISTING_DETAILS_EVENT}. */
export const TRANSCODE_COMPLETE_EVENT = SHARED_TRANSCODE_COMPLETE_EVENT;
/** After Listing Details **Next**: full listing JSON document (text + poster blob) with transcode fields + listing form. */
export const LISTING_DETAILS_EVENT = SHARED_LISTING_DETAILS_EVENT;

/** Max(width,height) must be at least this to include a 1080p-height rung. */
const MIN_MAJOR_DIM_FOR_1080_RUNG = SHARED_MIN_MAJOR_DIM_FOR_1080_RUNG;

/** Video bitrate ladder (bits per second); used for H.264 ABR rungs. */
function vp9BitrateForHeight(h) {
  if (h >= 1080) return 2_500_000;
  if (h >= 720) return 1_500_000;
  if (h >= 360) return 500_000;
  if (h >= 144) return 200_000;
  return Math.max(80_000, Math.round((h / 144) * 200_000));
}

/** @see mediabunny `AVC_LEVEL_TABLE` / `buildVideoCodecString('avc', …)` */
const AVC_LEVEL_TABLE = SHARED_AVC_LEVEL_TABLE;

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

/**
 * Nominal ABR ladder (height targets): 1080, 720, 360, 144.
 * - Drops 1080 when max(source width, height) is below `MIN_MAJOR_DIM_FOR_1080_RUNG` (1200).
 * - Drops any rung whose **height** is greater than the source display height (even-rounded).
 *
 * This list is the **only** rung set the pipeline encodes: there are no hidden top rungs.
 * Multivariant master HLS (`buildMasterPlaylist`) is built **solely** from the per-rung encode
 * results (`encoded`), which has exactly one entry per element returned here (same order:
 * largest height first).
 *
 * @returns {number[]} Non-empty, strictly descending when multiple rungs; if no nominal rung
 *   fits, falls back to a single entry at the even-rounded source height (see implementation).
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

/** HLS `CODECS=` AAC-LC fragment (published output is always AAC when audio is present). */
function hlsAudioCodecParam() {
  return "mp4a.40.2";
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

/** Same as `buildMediaPlaylist` but paths relative to `v{n}/` on disk. */
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

/**
 * Multivariant master: one `#EXT-X-STREAM-INF` + `v{i}/playlist.m3u8` line **per** entry.
 * `variants` must be the encoded ladder outputs only (same length and order as `encodeRung` results).
 *
 * @param {Array<{ width: number, height: number, bandwidth: number }>} variants
 */
function buildMasterPlaylist(variants, includeAudio, videoCodecParam, audioCodecParam) {
  const codecs = includeAudio ? `${videoCodecParam},${audioCodecParam}` : videoCodecParam;
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

/**
 * Same as {@link buildMasterPlaylist} with relative variant URLs (for local / disk layout).
 * @param {Array<{ width: number, height: number, bandwidth: number }>} variants
 */
function buildMasterPlaylistLocal(variants, includeAudio, videoCodecParam, audioCodecParam) {
  const codecs = includeAudio ? `${videoCodecParam},${audioCodecParam}` : videoCodecParam;
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
 * Mediabunny surfaces WebCodecs audio failures as `OperationError` / "Encoding error." with
 * `_registerAudioSample` on the stack.
 * @param {unknown} err
 * @returns {boolean}
 */
function isLikelyAudioEncodeFailure(err) {
  if (err == null) return false;
  const msg = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error && typeof err.stack === "string" ? err.stack : "";
  if (!/encoding error/i.test(msg)) return false;
  return stack.includes("registerAudioSample");
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
 * @param {"aac"|null} audioCodec `null` = no audio track
 * @param {FragmentReadyHooks | null | undefined} hooks
 * @param {boolean} [tryAvcPacketCopy] H.264 in / H.264 out without `bitrate` or `keyFrameInterval` so Mediabunny may copy samples
 */
async function convertToFmp4Segments(
  file,
  audioCodec,
  videoOpts,
  onProgress,
  videoCodec,
  hooks,
  tryAvcPacketCopy = false,
) {
  /**
   * @param {Record<string, unknown>} videoBlock
   * @returns {Promise<
   *   | { ok: true, init: Uint8Array, segments: Uint8Array[], fragmentStartsSec: number[], durationSec: number }
   *   | { ok: false, phase: "invalid", reasons: string }
   *   | { ok: false, phase: "execute", error: unknown }
   * >}
   */
  async function runOneFmp4Attempt(videoBlock) {
    async function once() {
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

    /** Mediabunny probes the encoder inside `Conversion.init`; failures must not reject here or H.264 HW retries never run. */
    let conversion;
    try {
      conversion = await Conversion.init({
        input,
        output,
        video: videoBlock,
        audio: audioCodec
          ? {
              codec: audioCodec,
              bitrate: 128_000,
              numberOfChannels: 2,
              sampleRate: 48_000,
              forceTranscode: true,
            }
          : { discard: true },
        showWarnings: false,
      });
    } catch (error) {
      // #region agent log
      fetch("http://127.0.0.1:7633/ingest/7d7c4be0-eed8-4a57-baec-1bad87d28ccf", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Debug-Session-Id": "310c49",
        },
        body: JSON.stringify({
          sessionId: "310c49",
          location: "core.mjs:Conversion.init",
          message: "Conversion.init threw",
          data: {
            audioCodec,
            hw: videoBlock.hardwareAcceleration,
            errName: error instanceof Error ? error.name : typeof error,
            errMsg: error instanceof Error ? error.message : String(error),
          },
          timestamp: Date.now(),
          hypothesisId: "H2",
        }),
      }).catch(() => {});
      // #endregion
      return { ok: false, phase: "execute", error };
    }

    if (!conversion.isValid) {
      const reasons = conversion.discardedTracks
        .map((t) => t.reason)
        .join("; ");
      return {
        ok: false,
        phase: "invalid",
        reasons: reasons || "Conversion is not valid for this file",
      };
    }

    try {
      conversion.onProgress = onProgress;
      await conversion.execute();
    } catch (error) {
      // #region agent log
      fetch("http://127.0.0.1:7633/ingest/7d7c4be0-eed8-4a57-baec-1bad87d28ccf", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Debug-Session-Id": "310c49",
        },
        body: JSON.stringify({
          sessionId: "310c49",
          location: "core.mjs:conversion.execute",
          message: "conversion.execute threw",
          data: {
            audioCodec,
            hw: videoBlock.hardwareAcceleration,
            videoH: videoOpts.height,
            errName: error instanceof Error ? error.name : typeof error,
            errMsg: error instanceof Error ? error.message : String(error),
            stackSnippet:
              error instanceof Error && typeof error.stack === "string"
                ? error.stack.slice(0, 900)
                : "",
          },
          timestamp: Date.now(),
          hypothesisId: "H3",
        }),
      }).catch(() => {});
      // #endregion
      return { ok: false, phase: "execute", error };
    }

    if (!ftyp || !moov) {
      return {
        ok: false,
        phase: "execute",
        error: new Error("Missing ftyp/moov from fragmented output"),
      };
    }
    if (pendingMoof) {
      return {
        ok: false,
        phase: "execute",
        error: new Error("Incomplete fragment (moof without mdat)"),
      };
    }

    const init = new Uint8Array(ftyp.byteLength + moov.byteLength);
    init.set(ftyp, 0);
    init.set(moov, ftyp.byteLength);

    const durationSec = await input.computeDuration();

    return { ok: true, init, segments, fragmentStartsSec, durationSec };
    }

    const maxAudioEncodeAttempts = audioCodec ? 2 : 1;
    for (let i = 0; i < maxAudioEncodeAttempts; i++) {
      if (i > 0) hooks?.onEncodeAttemptReset?.();
      const r = await once();
      if (r.ok) return r;
      if (r.phase === "invalid") return r;
      if (
        r.phase === "execute" &&
        r.error &&
        audioCodec &&
        isLikelyAudioEncodeFailure(r.error) &&
        i < maxAudioEncodeAttempts - 1
      ) {
        // #region agent log
        fetch("http://127.0.0.1:7633/ingest/7d7c4be0-eed8-4a57-baec-1bad87d28ccf", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Debug-Session-Id": "310c49",
          },
          body: JSON.stringify({
            sessionId: "310c49",
            location: "core.mjs:audio-execute-retry",
            message: "retrying after likely audio encode failure",
            data: { attempt: i + 1, max: maxAudioEncodeAttempts },
            timestamp: Date.now(),
            hypothesisId: "H5",
          }),
        }).catch(() => {});
        // #endregion
        continue;
      }
      return r;
    }
  }

  if (tryAvcPacketCopy && videoCodec === "avc") {
    const remux = await runOneFmp4Attempt({
      codec: "avc",
      fit: "contain",
      forceTranscode: false,
      hardwareAcceleration: "no-preference",
    });
    if (remux.ok) {
      return {
        init: remux.init,
        segments: remux.segments,
        fragmentStartsSec: remux.fragmentStartsSec,
        durationSec: remux.durationSec,
      };
    }
    hooks?.onEncodeAttemptReset?.();
  }

  const hwModes = [
    "prefer-hardware",
    "no-preference",
    "prefer-software",
  ];
  let lastError = null;

  for (let attemptIdx = 0; attemptIdx < hwModes.length; attemptIdx++) {
    const hwAccel = hwModes[attemptIdx];
    if (attemptIdx > 0) {
      hooks?.onEncodeAttemptReset?.();
    }

    const r = await runOneFmp4Attempt({
      codec: videoCodec,
      height: videoOpts.height,
      width: videoOpts.width,
      fit: "contain",
      keyFrameInterval: FRAGMENT_SECONDS,
      bitrate: videoOpts.bitrate,
      hardwareAcceleration: hwAccel,
    });

    if (!r.ok && r.phase === "invalid") {
      lastError = new Error(r.reasons);
      if (
        (videoCodec === "vp9" || videoCodec === "avc") &&
        hwAccel !== "prefer-software" &&
        isRecoverableVideoHwError(r.reasons)
      ) {
        continue;
      }
      throw lastError;
    }

    if (!r.ok && r.phase === "execute") {
      lastError = r.error;
      const msg = r.error?.message || String(r.error);
      if (
        (videoCodec === "vp9" || videoCodec === "avc") &&
        hwAccel !== "prefer-software" &&
        isRecoverableVideoHwError(msg)
      ) {
        continue;
      }
      throw r.error;
    }

    return {
      init: r.init,
      segments: r.segments,
      fragmentStartsSec: r.fragmentStartsSec,
      durationSec: r.durationSec,
    };
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
 * @property {string} reason e.g. `encode-retry` before another H.264 hardware-acceleration attempt
 */

/**
 * @typedef {object} FileEventDetail
 * @property {string} path relative path (e.g. `v0/init.json`, `master-local.m3u8`)
 * @property {string} mimeType e.g. `application/json`, `application/vnd.apple.mpegurl`
 * @property {Uint8Array} data UTF-8 for text artifacts
 */

/**
 * @typedef {object} TranscodeCompleteDetail
 * @property {string} rootM3U8Text `master-local.m3u8` contents (relative `v{n}/playlist.m3u8` lines)
 * @property {string} rootM3U8Path always `master-local.m3u8`
 * @property {string} masterAppM3U8Text multivariant master using fake-origin segment URLs (same text Shaka loads)
 * @property {string[]} mediaPlaylistTextsLocal per-variant `v{n}/playlist.m3u8` text (relative `init.mp4` / `seg-*.m4s`)
 * @property {number} nVar number of variants
 * @property {string} segmentCounts human summary from ladder
 * @property {string} stackHint codec / stack blurb
 */

/**
 * Payload for {@link LISTING_DETAILS_EVENT} / {@link emitListingDetailsEvent} (full logical listing JSON).
 * @typedef {object} ListingDetailsDetail
 * @property {object} transcodeMeta shallow copy of transcode fields (assembledAt, sourceName, nVar, …)
 * @property {{ title: string, description: string, showDonateButton: boolean, useSeekPosition: boolean, fundWalletAddress?: string | null, donateAmountUsdfc?: number | null }} listing — `fundWalletAddress` is the wallet connected on Fund (step 2); USDFC donate target
 * @property {{ enabled: boolean, recipient?: string, amountHuman?: string, token?: object, chainId?: number }} [donate] normalized viewer donate block in `metaJsonText`
 * @property {{ fileName: string, mimeType: string, size: number, url?: string }} poster metadata (matches `poster` in `metaJsonText`; `url` is set after PDP upload at finalize)
 * @property {{ fileName: string, mimeType: string, size: number, url?: string } | undefined} [posterAnimInfo] optional animated preview metadata (matches `posterAnim` in `metaJsonText`)
 * @property {File} poster image file (upload or seek capture)
 * @property {File | undefined} [posterAnim] optional 20-frame animated WebP (`listing-preview.webp`) when captured from source
 * @property {string} metaJsonText pretty-printed JSON: transcodeMeta spread + `listing` + `poster` info + `listingCompletedAt` (no raw image-bytes)
 */

/**
 * Prefer `filstreamEventTarget` for every pipeline event; otherwise `segmentReadyTarget`.
 * @param {{ segmentReadyTarget?: EventTarget, filstreamEventTarget?: EventTarget }} ui
 * @returns {EventTarget | null}
 */
function filstreamEventBus(ui) {
  return ui.filstreamEventTarget ?? ui.segmentReadyTarget ?? null;
}

/**
 * @param {{ onFileEvent?: (d: FileEventDetail) => void, filstreamEventTarget?: EventTarget, segmentReadyTarget?: EventTarget }} ui
 * @param {FileEventDetail} detail
 */
function dispatchFileEvent(ui, detail) {
  if (!ui.onFileEvent && !filstreamEventBus(ui)) return;
  try {
    void ui.onFileEvent?.(detail);
    filstreamEventBus(ui)?.dispatchEvent(new CustomEvent(FILE_EVENT, { detail }));
  } catch (e) {
    console.error("[FilStream] onFileEvent / fileEvent failed:", e);
  }
}

/**
 * @param {{ onTranscodeComplete?: (d: TranscodeCompleteDetail) => void, filstreamEventTarget?: EventTarget, segmentReadyTarget?: EventTarget }} ui
 * @param {TranscodeCompleteDetail} detail
 */
function dispatchTranscodeCompleteEvent(ui, detail) {
  if (!ui.onTranscodeComplete && !filstreamEventBus(ui)) return;
  try {
    void ui.onTranscodeComplete?.(detail);
    filstreamEventBus(ui)?.dispatchEvent(
      new CustomEvent(TRANSCODE_COMPLETE_EVENT, { detail }),
    );
  } catch (e) {
    console.error("[FilStream] onTranscodeComplete / transcodeComplete failed:", e);
  }
}

/**
 * @param {{
 *   onListingDetails?: (d: ListingDetailsDetail) => void,
 *   filstreamEventTarget?: EventTarget,
 *   segmentReadyTarget?: EventTarget,
 * }} ui
 * @param {ListingDetailsDetail} detail
 */
function dispatchListingDetailsEvent(ui, detail) {
  try {
    void ui.onListingDetails?.(detail);
    filstreamEventBus(ui)?.dispatchEvent(
      new CustomEvent(LISTING_DETAILS_EVENT, { detail }),
    );
  } catch (e) {
    console.error("[FilStream] onListingDetails / listingDetails failed:", e);
  }
}

/**
 * Emit {@link LISTING_DETAILS_EVENT} after the user submits Listing Details (**Next**).
 * Merges pending transcode meta with the listing form and poster. Clears pending transcode meta on success.
 *
 * @param {{
 *   onListingDetails?: (d: ListingDetailsDetail) => void | Promise<void>,
 *   filstreamEventTarget?: EventTarget,
 *   segmentReadyTarget?: EventTarget,
 * }} ui
 * @param {{
 *   title: string,
 *   description: string,
 *   showDonateButton: boolean,
 *   useSeekPosition: boolean,
 *   fundWalletAddress?: string | null,
 *   donateAmountUsdfc?: number,
 *   poster: File | Blob,
 *   posterAnim?: File | Blob | null,
 * }} listing
 * @returns {ListingDetailsDetail | null} `null` if transcoding has not finished (nothing pending).
 */
export function emitListingDetailsEvent(ui, listing) {
  if (!pendingTranscodeMetaForListing) {
    return null;
  }

  const posterFile =
    listing.poster instanceof File
      ? listing.poster
      : new File([listing.poster], "poster", {
          type: listing.poster.type || "application/octet-stream",
        });

  const donateAmt =
    listing.showDonateButton && Number.isFinite(Number(listing.donateAmountUsdfc))
      ? Number(listing.donateAmountUsdfc)
      : listing.showDonateButton
        ? 1
        : null;

  const rawFund =
    listing.showDonateButton && typeof listing.fundWalletAddress === "string"
      ? listing.fundWalletAddress.trim()
      : null;
  const validRecipient =
    rawFund && /^0x[a-fA-F0-9]{40}$/.test(rawFund) ? rawFund : null;

  const listingBlock = {
    title: listing.title,
    description: listing.description,
    showDonateButton: listing.showDonateButton,
    useSeekPosition: listing.useSeekPosition,
    fundWalletAddress: listing.showDonateButton ? validRecipient : null,
    donateAmountUsdfc: listing.showDonateButton ? donateAmt : null,
  };

  const donateEnabled =
    listing.showDonateButton === true &&
    validRecipient != null &&
    donateAmt != null &&
    donateAmt > 0;

  const donate = donateEnabled
    ? {
        enabled: true,
        recipient: validRecipient,
        amountHuman: String(donateAmt),
        token: {
          symbol: USDFC_DONATE_TOKEN.symbol,
          address: USDFC_DONATE_TOKEN.address,
          decimals: USDFC_DONATE_TOKEN.decimals,
        },
        chainId: USDFC_DONATE_TOKEN.chainId,
      }
    : { enabled: false };

  const posterInfo = {
    fileName: posterFile.name,
    mimeType: posterFile.type || "application/octet-stream",
    size: posterFile.size,
  };

  const posterAnimRaw = listing.posterAnim;
  const posterAnimFile =
    posterAnimRaw instanceof File
      ? posterAnimRaw
      : posterAnimRaw instanceof Blob
        ? new File([posterAnimRaw], "listing-preview.webp", {
            type: posterAnimRaw.type || "image/webp",
          })
        : null;

  const posterAnimInfo = posterAnimFile
    ? {
        fileName: posterAnimFile.name,
        mimeType: posterAnimFile.type || "image/webp",
        size: posterAnimFile.size,
      }
    : undefined;

  const doc = {
    ...pendingTranscodeMetaForListing,
    listing: listingBlock,
    poster: posterInfo,
    ...(posterAnimInfo ? { posterAnim: posterAnimInfo } : {}),
    donate,
    listingCompletedAt: new Date().toISOString(),
  };
  const metaJsonText = JSON.stringify(doc, null, 2);

  /** @type {ListingDetailsDetail} */
  const detail = {
    transcodeMeta: { ...pendingTranscodeMetaForListing },
    listing: listingBlock,
    posterInfo,
    poster: posterFile,
    ...(posterAnimFile ? { posterAnim: posterAnimFile } : {}),
    ...(posterAnimInfo ? { posterAnimInfo } : {}),
    metaJsonText,
  };

  dispatchListingDetailsEvent(ui, detail);
  pendingTranscodeMetaForListing = null;
  return detail;
}

/**
 * @param {{
 *   onSegmentReady?: (d: SegmentReadyDetail) => void | Promise<void>,
 *   onSegmentFlush?: (d: SegmentFlushDetail) => void | Promise<void>,
 *   segmentReadyTarget?: EventTarget,
 *   filstreamEventTarget?: EventTarget,
 * }} ui
 * @param {number} variantIndex
 * @param {number} width
 * @param {number} height
 * @returns {FragmentReadyHooks | null}
 */
function buildVariantSegmentHooks(ui, variantIndex, width, height) {
  if (!filstreamEventBus(ui) && !ui.onSegmentReady && !ui.onSegmentFlush) {
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
        filstreamEventBus(ui)?.dispatchEvent(
          new CustomEvent(SEGMENT_READY_EVENT, { detail }),
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
        filstreamEventBus(ui)?.dispatchEvent(
          new CustomEvent(SEGMENT_FLUSH_EVENT, { detail }),
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

/**
 * Transcode-only listing fields; cleared when listing completes or pipeline resets.
 * @type {{
 *   assembledAt: string,
 *   sourceName: string,
 *   nVar: number,
 *   videoCodec: string,
 *   includeAudio: boolean,
 *   fragmentDurationSec: number,
 * } | null}
 */
let pendingTranscodeMetaForListing = null;

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
  pendingTranscodeMetaForListing = null;
}

/**
 * Destroy only the Shaka Player (does not revoke blob URLs — listing artifacts stay valid).
 * Call when leaving local preview (e.g. Await); Review attaches a new player to the retrieval URL.
 */
export async function destroyActivePipelinePlayer() {
  if (player) {
    try {
      await player.destroy();
    } catch {
      /* ignore */
    }
    player = null;
  }
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
 *   onTranscodeComplete?: (d: TranscodeCompleteDetail) => void | Promise<void>,
 *   onSegmentReady?: (d: SegmentReadyDetail) => void | Promise<void>,
 *   onSegmentFlush?: (d: SegmentFlushDetail) => void | Promise<void>,
 *   onFileEvent?: (d: FileEventDetail) => void | Promise<void>,
 *   segmentReadyTarget?: EventTarget,
 *   filstreamEventTarget?: EventTarget,
 * }} ui
 *
 * **Events** (all `CustomEvent` on `filstreamEventTarget ?? segmentReadyTarget` when set):
 * - `SEGMENT_READY_EVENT` / `onSegmentReady` — binary init + media segments as they encode.
 * - `SEGMENT_FLUSH_EVENT` / `onSegmentFlush` — before an H.264 encoder HW retry; drop partials for that variant.
 * - `FILE_EVENT` / `onFileEvent` — text artifacts: per variant `v{n}/init.json`, `v{n}/playlist.m3u8` (local paths), `v{n}/playlist-app.m3u8` (fake-origin media playlist); then `master-local.m3u8`, `master-app.m3u8`.
 * - `TRANSCODE_COMPLETE_EVENT` / `onTranscodeComplete` — when encodes finish and master + variant M3U8 are assembled (before Shaka); see {@link TranscodeCompleteDetail}. Transcode meta is held until {@link emitListingDetailsEvent}.
 * - `LISTING_DETAILS_EVENT` — fired when the UI calls {@link emitListingDetailsEvent} after Listing Details **Next**; listen on the same `filstreamEventTarget` (or pass `onListingDetails` there). Includes full listing JSON text + poster {@link File}.
 */
export async function runFilstreamPipeline(file, ui) {
  const { setStatus, setProgress, getVideoElement, onPlaybackReady } = ui;
  pendingTranscodeMetaForListing = null;

  const probeInput = new Input({
    source: new BlobSource(file),
    formats: ALL_FORMATS,
  });
  const primaryAudio = await probeInput.getPrimaryAudioTrack();
  // #region agent log
  {
    const sr =
      primaryAudio && typeof primaryAudio.sampleRate === "number"
        ? primaryAudio.sampleRate
        : null;
    const ch =
      primaryAudio && typeof primaryAudio.numberOfChannels === "number"
        ? primaryAudio.numberOfChannels
        : null;
    fetch("http://127.0.0.1:7633/ingest/7d7c4be0-eed8-4a57-baec-1bad87d28ccf", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Debug-Session-Id": "310c49",
      },
      body: JSON.stringify({
        sessionId: "310c49",
        location: "core.mjs:probe-audio",
        message: "primary audio track probe",
        data: {
          fileName: file.name,
          includeAudio: primaryAudio != null,
          sampleRate: sr,
          numberOfChannels: ch,
          ua: typeof navigator !== "undefined" ? navigator.userAgent : "",
        },
        timestamp: Date.now(),
        hypothesisId: "H1",
      }),
    }).catch(() => {});
  }
  // #endregion
  const includeAudio = primaryAudio != null;
  if (includeAudio && !canEncodeAudio("aac")) {
    setStatus(
      "This browser cannot encode AAC (WebCodecs). FilStream publishes H.264 + AAC only. Try a recent Chrome, Edge, or Safari.",
      "err",
    );
    return;
  }
  /** @type {"aac" | null} */
  const audioCodec = includeAudio ? "aac" : null;

  const vt = await probeInput.getPrimaryVideoTrack();
  const srcH = vt?.displayHeight ?? 720;
  const srcW = vt?.displayWidth ?? 1280;
  const heights = ladderHeights(srcW, srcH);
  const nVar = heights.length;

  if (!canEncodeVideo("avc")) {
    setStatus(
      "This browser cannot encode H.264 (WebCodecs). FilStream publishes H.264 + AAC only. Try a recent Chrome, Edge, or Safari.",
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

  /**
   * Invalidates stale mediabunny onProgress callbacks after encode completes or a new fullAttempt
   * runs — otherwise old callbacks regress the UI %.
   */
  let encodeProgressGeneration = 0;

  async function fullAttempt() {
    const gen = ++encodeProgressGeneration;
    if (player) {
      await player.destroy();
      player = null;
    }
    revokeAll();
    video.removeAttribute("src");
    video.load();

    const videoCodec = "avc";
    const videoLabel = "H.264";
    const maxH = heights[0];
    const maxW = scaledWidth(srcW, srcH, maxH);
    const maxBr = vp9BitrateForHeight(maxH);
    const masterVideoCodecParam = buildAvcCodecString(maxW, maxH, maxBr);

    const audioLabel = audioCodec === "aac" ? "AAC" : "";
    setStatus(
      audioCodec
        ? `Transcoding ${nVar} ${videoLabel} + ${audioLabel} rung(s) for HLS ABR…`
        : `Transcoding ${nVar} ${videoLabel} rung(s) for HLS ABR…`,
      "",
    );
    setProgress(0);

    const globalProgress = new Array(nVar).fill(0);
    /** Mediabunny HW retries restart per-rung progress near 0; keep the bar monotonic so it does not flicker backward. */
    let aggregateProgressDisplayed = 0;
    const reportProgress = () => {
      if (gen !== encodeProgressGeneration) return;
      const sum = globalProgress.reduce((a, p) => a + p, 0);
      const next = Math.round(Math.min(100, (sum / nVar) * 100));
      aggregateProgressDisplayed = Math.max(aggregateProgressDisplayed, next);
      setProgress(aggregateProgressDisplayed);
    };
    const textEnc = new TextEncoder();

    async function encodeRung(i) {
      const h = heights[i];
      const w = scaledWidth(srcW, srcH, h);
      const br = vp9BitrateForHeight(h);
      const segmentHooks = buildVariantSegmentHooks(ui, i, w, h);
      const { init, segments, fragmentStartsSec, durationSec } =
        await convertToFmp4Segments(
          file,
          audioCodec,
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

      const dursSec = segmentDurationsSec(fragmentStartsSec, durationSec);
      const initJson = {
        variantIndex: i,
        width: w,
        height: h,
        bandwidth: bandwidthBits(br, audioCodec != null),
        segmentCount: segments.length,
        durationSec,
        videoCodec,
        includeAudio: audioCodec != null,
        audioCodec: audioCodec ?? undefined,
        fragmentDurationSec: FRAGMENT_SECONDS,
      };
      dispatchFileEvent(ui, {
        path: `v${i}/init.json`,
        mimeType: "application/json",
        data: textEnc.encode(JSON.stringify(initJson, null, 2)),
      });
      dispatchFileEvent(ui, {
        path: `v${i}/playlist.m3u8`,
        mimeType: "application/vnd.apple.mpegurl",
        data: textEnc.encode(buildMediaPlaylistLocal(dursSec)),
      });
      dispatchFileEvent(ui, {
        path: `v${i}/playlist-app.m3u8`,
        mimeType: "application/vnd.apple.mpegurl",
        data: textEnc.encode(buildMediaPlaylist(i, dursSec)),
      });

      const initURL = pushBlobURL(new Blob([init], { type: "video/mp4" }));
      const segmentURLs = segments.map((seg) =>
        pushBlobURL(new Blob([seg], { type: "video/mp4" })),
      );

      return {
        i,
        initURL,
        segmentURLs,
        durationSec,
        dursSec,
        width: w,
        height: h,
        bandwidth: bandwidthBits(br, audioCodec != null),
        segmentCount: segments.length,
      };
    }

    const parallelPerBatch = nVar;
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

    if (encoded.length !== nVar) {
      throw new Error(
        `FilStream: master HLS invariant failed — encoded ${encoded.length} variant(s), ladder expected ${nVar}`,
      );
    }

    const audioCodecParam = audioCodec ? hlsAudioCodecParam() : "";
    const masterText = buildMasterPlaylist(
      encoded,
      audioCodec != null,
      masterVideoCodecParam,
      audioCodecParam,
    );
    const masterTextLocal = buildMasterPlaylistLocal(
      encoded,
      audioCodec != null,
      masterVideoCodecParam,
      audioCodecParam,
    );

    const metaPayload = {
      assembledAt: new Date().toISOString(),
      sourceName: file.name,
      nVar: encoded.length,
      videoCodec,
      includeAudio: audioCodec != null,
      audioCodec: audioCodec ?? undefined,
      fragmentDurationSec: FRAGMENT_SECONDS,
    };
    pendingTranscodeMetaForListing = { ...metaPayload };

    const segSummary = segmentCountSummary(encoded);
    const stackHint = includeAudio
      ? `H.264 + ${audioLabel} in fMP4 (hardware encoder when available).`
      : "H.264 in fMP4 (hardware encoder when available).";
    const mediaPlaylistTextsLocal = encoded.map((v) =>
      buildMediaPlaylistLocal(v.dursSec),
    );

    setProgress(100);
    encodeProgressGeneration += 1;

    dispatchTranscodeCompleteEvent(ui, {
      rootM3U8Text: masterTextLocal,
      rootM3U8Path: "master-local.m3u8",
      masterAppM3U8Text: masterText,
      mediaPlaylistTextsLocal,
      nVar: encoded.length,
      segmentCounts: segSummary,
      stackHint,
    });

    const variantPlaylistURLs = encoded.map((v, i) =>
      pushBlobURL(
        new Blob([buildMediaPlaylist(i, v.dursSec)], {
          type: "application/vnd.apple.mpegurl",
        }),
      ),
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
      onPlaybackReady(player, {
        nVar: encoded.length,
        segmentCounts: segSummary,
        stackHint,
        rungs: encoded.map((v, variantIndex) => ({
          variantIndex,
          width: v.width,
          height: v.height,
          bandwidth: v.bandwidth,
        })),
      });
      setStatus("", "");
    } catch (e) {
      await player.destroy();
      player = null;
      throw e;
    }
  }

  try {
    await fullAttempt();
  } catch (e) {
    if (includeAudio && isLikelyAudioEncodeFailure(e)) {
      // #region agent log
      fetch("http://127.0.0.1:7633/ingest/7d7c4be0-eed8-4a57-baec-1bad87d28ccf", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Debug-Session-Id": "310c49",
        },
        body: JSON.stringify({
          sessionId: "310c49",
          location: "core.mjs:runFilstreamPipeline-catch",
          message: "likely audio encode failure (outer catch)",
          data: {
            errName: e instanceof Error ? e.name : typeof e,
            errMsg: e instanceof Error ? e.message : String(e),
            stackSnippet:
              e instanceof Error && typeof e.stack === "string"
                ? e.stack.slice(0, 1200)
                : "",
          },
          timestamp: Date.now(),
          hypothesisId: "H4",
        }),
      }).catch(() => {});
      // #endregion
      setStatus(
        "Audio encoding failed (AAC). FilStream publishes video with sound only — we do not fall back to silent video. Try re-encoding the file with AAC/LC stereo, or try Chrome or Edge. " +
          (e instanceof Error ? e.message : String(e)),
        "err",
      );
      if (player) {
        await player.destroy();
        player = null;
      }
      return;
    }
    setStatus(e instanceof Error ? e.message : String(e), "err");
    if (player) {
      await player.destroy();
      player = null;
    }
  }
}
