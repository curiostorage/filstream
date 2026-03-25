import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { HttpError } from "./errors.mjs";
import {
  createSynapseForSession,
  deletePiece,
  extractPieceCid,
  getPieceRetrievalUrl,
  resolveOrCreateDataSet,
  terminateDataSet,
} from "./synapse.mjs";

/**
 * @typedef {import("@filoz/synapse-sdk").Synapse} SynapseClient
 * @typedef {import("@filoz/synapse-sdk/storage").StorageContext} StorageContext
 */

/**
 * @typedef {object} FileMapping
 * @property {string} path
 * @property {string} mimeType
 * @property {string} pieceCid
 * @property {string | null} retrievalUrl
 * @property {number} offset
 * @property {number} length
 * @property {string} variant
 * @property {number | null} sequence
 * @property {number | null} segmentIndex
 */

/**
 * @typedef {object} PieceRecord
 * @property {string} pieceCid
 * @property {string | null} retrievalUrl
 * @property {number} byteLength
 * @property {Record<string, string>} pieceMetadata
 * @property {boolean} committed
 * @property {boolean} abandoned
 * @property {string} variant
 * @property {number | null} sequence
 * @property {string} storedAt
 */

/**
 * @typedef {object} VariantBuffer
 * @property {string} variant
 * @property {number} sequence
 * @property {Uint8Array[]} chunks
 * @property {number} size
 * @property {number | null} segmentStart
 * @property {number | null} segmentEnd
 * @property {Array<{
 *   path: string,
 *   mimeType: string,
 *   offset: number,
 *   length: number,
 *   segmentIndex: number | null,
 * }>} entries
 */

/**
 * @typedef {object} UploadSession
 * @property {string} uploadId
 * @property {string} assetId
 * @property {string} clientAddress
 * @property {string} filstreamId
 * @property {number} providerId
 * @property {number} dataSetId
 * @property {SynapseClient} synapse
 * @property {StorageContext} context
 * @property {EventEmitter} events
 * @property {Map<string, VariantBuffer>} variantBuffers
 * @property {Map<string, { path: string, mimeType: string, data: Uint8Array }>} textFiles
 * @property {Map<string, PieceRecord>} piecesByCid
 * @property {FileMapping[]} fileMappings
 * @property {{
 *   segmentready: number,
 *   segmentflush: number,
 *   fileEvent: number,
 *   transcodeComplete: number,
 *   listingDetails: number,
 * }} eventCounts
 * @property {boolean} transcodeCompleteReceived
 * @property {boolean} listingDetailsReceived
 * @property {boolean} finalized
 * @property {string} createdAt
 * @property {string} lastEventAt
 */

/**
 * Build a valid piece metadata object and enforce on-chain limits.
 *
 * @param {Record<string, string>} values
 * @returns {Record<string, string>}
 */
function validatePieceMetadata(values) {
  const entries = Object.entries(values).filter(([, v]) => v.trim() !== "");
  if (entries.length > 5) {
    throw new HttpError(400, "piece metadata supports at most 5 key-value pairs");
  }
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of entries) {
    if (k.length > 32) {
      throw new HttpError(400, `piece metadata key exceeds 32 chars: ${k}`);
    }
    if (v.length > 128) {
      throw new HttpError(400, `piece metadata value exceeds 128 chars: ${k}`);
    }
    out[k] = v;
  }
  return out;
}

/**
 * Return `v{index}` from event detail.
 *
 * @param {unknown} detail
 * @returns {string}
 */
function variantKeyFromDetail(detail) {
  if (!detail || typeof detail !== "object") {
    throw new HttpError(400, "Event detail must be an object");
  }
  const d = /** @type {Record<string, unknown>} */ (detail);
  if (typeof d.variant === "string" && d.variant.trim() !== "") {
    return d.variant.trim();
  }
  if (Number.isFinite(Number(d.variantIndex))) {
    return `v${Number(d.variantIndex)}`;
  }
  throw new HttpError(400, "Event detail is missing variant/variantIndex");
}

/**
 * Parse a positive integer segment index from detail.
 *
 * @param {unknown} detail
 * @returns {number}
 */
function parseSegmentIndex(detail) {
  const d = /** @type {Record<string, unknown>} */ (detail);
  const n = Number(d.segmentIndex);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new HttpError(400, "segmentIndex must be a positive integer");
  }
  return n;
}

/**
 * Parse bytes from event detail (`dataBase64`).
 *
 * @param {unknown} detail
 * @returns {Uint8Array}
 */
function parseEventBytes(detail) {
  if (!detail || typeof detail !== "object") {
    throw new HttpError(400, "Event detail must be an object");
  }
  const d = /** @type {Record<string, unknown>} */ (detail);
  const raw = typeof d.dataBase64 === "string" ? d.dataBase64 : "";
  if (raw.trim() === "") {
    throw new HttpError(400, "Event detail is missing dataBase64");
  }
  const bytes = Buffer.from(raw, "base64");
  if (!bytes.length) {
    throw new HttpError(400, "Event dataBase64 decodes to empty bytes");
  }
  return new Uint8Array(bytes);
}

/**
 * Create an empty per-variant piece buffer.
 *
 * @param {string} variant
 * @returns {VariantBuffer}
 */
function newVariantBuffer(variant) {
  return {
    variant,
    sequence: 1,
    chunks: [],
    size: 0,
    segmentStart: null,
    segmentEnd: null,
    entries: [],
  };
}

/**
 * Build piece metadata for a packed variant piece.
 *
 * @param {string} assetId
 * @param {string} variant
 * @param {number} sequence
 * @param {number | null} segmentStart
 * @param {number | null} segmentEnd
 * @returns {Record<string, string>}
 */
function variantPieceMetadata(assetId, variant, sequence, segmentStart, segmentEnd) {
  const segRange =
    segmentStart != null && segmentEnd != null ? `${segmentStart}-${segmentEnd}` : "";
  return validatePieceMetadata({
    FS_ASSET: assetId,
    FS_VAR: variant,
    FS_SEQ: String(sequence),
    FS_SEGS: segRange,
    FS_FILE: "",
  });
}

/**
 * Build piece metadata for a single-file piece (playlist/master/manifest/meta).
 *
 * @param {string} assetId
 * @param {string} path
 * @returns {Record<string, string>}
 */
function filePieceMetadata(assetId, path) {
  const m = path.match(/^(v\d+)\//);
  const variant = m ? m[1] : "root";
  return validatePieceMetadata({
    FS_ASSET: assetId,
    FS_VAR: variant,
    FS_SEQ: "",
    FS_SEGS: "",
    FS_FILE: path,
  });
}

/**
 * Derive mime type for text files by path.
 *
 * @param {string} filePath
 * @returns {string}
 */
function defaultMimeForPath(filePath) {
  if (filePath.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
  if (filePath.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

/**
 * Parse potential JSON text safely.
 *
 * @param {string} raw
 * @returns {Record<string, unknown> | null}
 */
function parseOptionalJsonObject(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return /** @type {Record<string, unknown>} */ (parsed);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Extract master/manifest URLs from mapped files.
 *
 * @param {FileMapping[]} files
 * @returns {{ masterAppUrl: string | null, manifestUrl: string | null }}
 */
function extractPlaybackUrls(files) {
  const master = files.find((f) => f.path === "master-app.m3u8");
  const manifest = files.find((f) => f.path === "manifest.json");
  return {
    masterAppUrl: master?.retrievalUrl || null,
    manifestUrl: manifest?.retrievalUrl || null,
  };
}

const VARIANT_PLAYLIST_APP_RE = /^v\d+\/playlist-app\.m3u8$/;
const FAKE_ORIGIN = "https://filstream.invalid";

/**
 * Parse `v{n}` from a file path like `v0/playlist-app.m3u8`.
 *
 * @param {string} filePath
 * @returns {string | null}
 */
function parseVariantFromPath(filePath) {
  const m = filePath.match(/^(v\d+)\//);
  return m ? m[1] : null;
}

/**
 * Build a path -> live file mapping index from non-abandoned pieces.
 * If duplicate paths exist, newest mapping wins by insertion order.
 *
 * @param {UploadSession} session
 * @returns {Map<string, FileMapping>}
 */
function buildLiveMappingByPath(session) {
  /** @type {Map<string, FileMapping>} */
  const out = new Map();
  for (const mapping of session.fileMappings) {
    const piece = session.piecesByCid.get(mapping.pieceCid);
    if (!piece || piece.abandoned) continue;
    out.set(mapping.path, mapping);
  }
  return out;
}

/**
 * Resolve one required file mapping from a live mapping index.
 *
 * @param {Map<string, FileMapping>} mappingsByPath
 * @param {string} filePath
 * @returns {FileMapping}
 */
function requireMapping(mappingsByPath, filePath) {
  const found = mappingsByPath.get(filePath);
  if (!found) {
    throw new HttpError(400, `Missing file mapping for ${filePath}`);
  }
  return found;
}

/**
 * Resolve retrieval URL for one mapped file.
 *
 * @param {FileMapping} mapping
 * @param {string} filePath
 * @returns {string}
 */
function requireRetrievalUrl(mapping, filePath) {
  const url = typeof mapping.retrievalUrl === "string" ? mapping.retrievalUrl.trim() : "";
  if (url === "") {
    throw new HttpError(500, `Missing retrievalUrl for ${filePath}`);
  }
  return url;
}

/**
 * Rewrite one variant playlist (for example `v0/playlist-app.m3u8`) to retrieval URLs + byte ranges.
 *
 * @param {string} variant
 * @param {string} playlistText
 * @param {Map<string, FileMapping>} mappingsByPath
 * @returns {string}
 */
function rewriteVariantPlaylist(variant, playlistText, mappingsByPath) {
  const initPath = `${variant}/init.mp4`;
  const initMapping = requireMapping(mappingsByPath, initPath);
  const initUrl = requireRetrievalUrl(initMapping, initPath);
  const normalized = playlistText.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  /** @type {string[]} */
  const out = [];
  let mapWritten = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith("#EXT-X-BYTERANGE:")) {
      continue;
    }
    if (line.startsWith("#EXT-X-MAP:")) {
      out.push(
        `#EXT-X-MAP:URI="${initUrl}",BYTERANGE="${initMapping.length}@${initMapping.offset}"`,
      );
      mapWritten = true;
      continue;
    }
    if (line === `${FAKE_ORIGIN}/${variant}/init.mp4`) {
      continue;
    }
    const segMatch = line.match(/(?:^|\/)seg-(\d+)\.m4s(?:$|\?)/);
    if (segMatch) {
      const segIndex = Number(segMatch[1]);
      const segPath = `${variant}/seg-${segIndex}.m4s`;
      const segMapping = requireMapping(mappingsByPath, segPath);
      const segUrl = requireRetrievalUrl(segMapping, segPath);
      out.push(`#EXT-X-BYTERANGE:${segMapping.length}@${segMapping.offset}`);
      out.push(segUrl);
      continue;
    }
    out.push(rawLine);
  }

  if (!mapWritten) {
    const mapLine = `#EXT-X-MAP:URI="${initUrl}",BYTERANGE="${initMapping.length}@${initMapping.offset}"`;
    const insertAfter = out.findIndex(
      (value) => value.trim() === "#EXT-X-INDEPENDENT-SEGMENTS",
    );
    if (insertAfter >= 0) {
      out.splice(insertAfter + 1, 0, mapLine);
    } else {
      out.splice(Math.min(2, out.length), 0, mapLine);
    }
  }

  return out.join("\n");
}

/**
 * Rewrite master-app playlist variant URIs to stored variant playlist retrieval URLs.
 *
 * @param {string} masterText
 * @param {Map<string, FileMapping>} mappingsByPath
 * @returns {string}
 */
function rewriteMasterPlaylistText(masterText, mappingsByPath) {
  const normalized = masterText.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  /** @type {string[]} */
  const out = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const match = line.match(/(?:^|\/)v(\d+)\/playlist(?:-app)?\.m3u8(?:$|\?)/);
    if (!match) {
      out.push(rawLine);
      continue;
    }
    const variant = `v${match[1]}`;
    const playlistPath = `${variant}/playlist-app.m3u8`;
    const playlistMapping = requireMapping(mappingsByPath, playlistPath);
    out.push(requireRetrievalUrl(playlistMapping, playlistPath));
  }
  return out.join("\n");
}

/**
 * Hold upload sessions in memory and process encoder events through an EventEmitter.
 */
export class StoreService {
  /**
  * @param {{
   *   rpcUrl: string,
   *   chainId: number,
   *   source: string,
   *   providerId: number,
   *   filstreamId: string,
   *   maxPieceBytes: number,
   * }} cfg
   */
  constructor(cfg) {
    this.cfg = cfg;
    /** @type {Map<string, UploadSession>} */
    this.sessions = new Map();
  }

  /**
   * Startup hook.
   *
   * @returns {Promise<void>}
   */
  async init() {
    // Dataset lookup/sync is done on every upload init via resolveOrCreateDataSet().
  }

  /**
   * Resolve one upload session by id.
   *
   * @param {string} uploadId
   * @returns {UploadSession}
   */
  getUploadSession(uploadId) {
    const found = this.sessions.get(uploadId);
    if (!found) {
      throw new HttpError(404, `Upload session not found: ${uploadId}`);
    }
    return found;
  }

  /**
   * Create and register one upload session.
   *
   * @param {{
   *   assetId: string,
   *   clientAddress: string,
   *   sessionPrivateKey: string,
   *   sessionExpirations: Record<string, string | number | bigint>,
   * }} input
   * @returns {Promise<{
   *   uploadId: string,
   *   dataSetId: number,
   *   providerId: number,
   *   filstreamId: string,
   *   createdDataSet: boolean,
   * }>}
   */
  async createUploadSession(input) {
    const { assetId, clientAddress, sessionPrivateKey, sessionExpirations } = input;
    if (!assetId || !clientAddress || !sessionPrivateKey || !sessionExpirations) {
      throw new HttpError(
        400,
        "assetId, clientAddress, sessionPrivateKey, sessionExpirations are required",
      );
    }
    const synapse = await createSynapseForSession(
      this.cfg,
      clientAddress,
      sessionPrivateKey,
      sessionExpirations,
    );
    const resolved = await resolveOrCreateDataSet({
      synapse,
      providerId: this.cfg.providerId,
      clientAddress,
      filstreamId: this.cfg.filstreamId,
    });
    const uploadId = crypto.randomUUID();
    /** @type {UploadSession} */
    const session = {
      uploadId,
      assetId,
      clientAddress,
      filstreamId: this.cfg.filstreamId,
      providerId: this.cfg.providerId,
      dataSetId: resolved.dataSetId,
      synapse,
      context: resolved.context,
      events: new EventEmitter(),
      variantBuffers: new Map(),
      textFiles: new Map(),
      piecesByCid: new Map(),
      fileMappings: [],
      eventCounts: {
        segmentready: 0,
        segmentflush: 0,
        fileEvent: 0,
        transcodeComplete: 0,
        listingDetails: 0,
      },
      transcodeCompleteReceived: false,
      listingDetailsReceived: false,
      finalized: false,
      createdAt: new Date().toISOString(),
      lastEventAt: new Date().toISOString(),
    };
    this.bindSessionEventHandlers(session);
    this.sessions.set(uploadId, session);
    return {
      uploadId,
      dataSetId: resolved.dataSetId,
      providerId: this.cfg.providerId,
      filstreamId: this.cfg.filstreamId,
      createdDataSet: resolved.created,
    };
  }

  /**
   * Attach async event listeners for one upload session.
   *
   * @param {UploadSession} session
   * @returns {void}
   */
  bindSessionEventHandlers(session) {
    session.events.on("segmentready", async (detail) => {
      await this.handleSegmentReady(session, detail);
    });
    session.events.on("segmentflush", async (detail) => {
      await this.handleSegmentFlush(session, detail);
    });
    session.events.on("fileEvent", async (detail) => {
      await this.handleFileEvent(session, detail);
    });
    session.events.on("transcodeComplete", async (detail) => {
      await this.handleTranscodeComplete(session, detail);
    });
    session.events.on("listingDetails", async (detail) => {
      await this.handleListingDetails(session, detail);
    });
  }

  /**
   * Emit one session event and await all listeners sequentially.
   *
   * @param {UploadSession} session
   * @param {string} type
   * @param {unknown} detail
   * @returns {Promise<void>}
   */
  async emitSessionEvent(session, type, detail) {
    const listeners = session.events.listeners(type);
    if (!listeners.length) {
      throw new HttpError(400, `Unsupported event type: ${type}`);
    }
    for (const listener of listeners) {
      // Listener functions are attached by this service and can be async.
      await listener(detail);
    }
  }

  /**
   * Record one encoder event in session state.
   *
   * @param {string} uploadId
   * @param {{ type: string, detail: unknown }} input
   * @returns {Promise<{ accepted: boolean, type: string }>}
   */
  async ingestEvent(uploadId, input) {
    const session = this.getUploadSession(uploadId);
    if (session.finalized) {
      throw new HttpError(409, "Upload is already finalized");
    }
    const type = (input.type || "").trim();
    if (type === "") {
      throw new HttpError(400, "Event type is required");
    }
    await this.emitSessionEvent(session, type, input.detail ?? {});
    if (type in session.eventCounts) {
      const key = /** @type {keyof UploadSession["eventCounts"]} */ (type);
      session.eventCounts[key] += 1;
    }
    session.lastEventAt = new Date().toISOString();
    return { accepted: true, type };
  }

  /**
   * Get or create a variant buffer state.
   *
   * @param {UploadSession} session
   * @param {string} variant
   * @returns {VariantBuffer}
   */
  getVariantBuffer(session, variant) {
    let found = session.variantBuffers.get(variant);
    if (!found) {
      found = newVariantBuffer(variant);
      session.variantBuffers.set(variant, found);
    }
    return found;
  }

  /**
   * Append one logical file into a variant piece buffer.
   *
   * @param {VariantBuffer} buffer
   * @param {{
   *   path: string,
   *   mimeType: string,
   *   bytes: Uint8Array,
   *   segmentIndex: number | null,
   * }} input
   * @returns {void}
   */
  appendVariantEntry(buffer, input) {
    const offset = buffer.size;
    buffer.chunks.push(input.bytes);
    buffer.entries.push({
      path: input.path,
      mimeType: input.mimeType,
      offset,
      length: input.bytes.byteLength,
      segmentIndex: input.segmentIndex,
    });
    buffer.size += input.bytes.byteLength;
  }

  /**
   * Store one byte buffer as a parked piece and register it in session memory.
   *
   * @param {UploadSession} session
   * @param {{
   *   bytes: Uint8Array,
   *   pieceMetadata: Record<string, string>,
   *   variant: string,
   *   sequence: number | null,
   *   abandoned?: boolean,
   * }} input
   * @returns {Promise<PieceRecord>}
   */
  async storePieceBytes(session, input) {
    if (!session.context || typeof session.context.store !== "function") {
      throw new HttpError(500, "Storage context.store is unavailable");
    }
    const storeResult = await session.context.store(input.bytes);
    const pieceCid = extractPieceCid(storeResult);
    if (!pieceCid) {
      throw new HttpError(500, "store() response is missing pieceCid");
    }
    const retrievalUrl =
      (typeof storeResult?.retrievalUrl === "string" &&
      storeResult.retrievalUrl.trim() !== ""
        ? storeResult.retrievalUrl
        : null) || (await getPieceRetrievalUrl(session.context, pieceCid));

    /** @type {PieceRecord} */
    const record = {
      pieceCid,
      retrievalUrl,
      byteLength: input.bytes.byteLength,
      pieceMetadata: input.pieceMetadata,
      committed: false,
      abandoned: input.abandoned === true,
      variant: input.variant,
      sequence: input.sequence,
      storedAt: new Date().toISOString(),
    };
    session.piecesByCid.set(record.pieceCid, record);
    return record;
  }

  /**
   * Flush one variant buffer into a parked piece.
   *
   * @param {UploadSession} session
   * @param {VariantBuffer} buffer
   * @returns {Promise<void>}
   */
  async flushVariantBuffer(session, buffer) {
    if (buffer.size === 0) return;
    const bytes = Buffer.concat(buffer.chunks.map((c) => Buffer.from(c)));
    const metadata = variantPieceMetadata(
      session.assetId,
      buffer.variant,
      buffer.sequence,
      buffer.segmentStart,
      buffer.segmentEnd,
    );
    const piece = await this.storePieceBytes(session, {
      bytes: new Uint8Array(bytes),
      pieceMetadata: metadata,
      variant: buffer.variant,
      sequence: buffer.sequence,
    });
    for (const entry of buffer.entries) {
      session.fileMappings.push({
        path: entry.path,
        mimeType: entry.mimeType,
        pieceCid: piece.pieceCid,
        retrievalUrl: piece.retrievalUrl,
        offset: entry.offset,
        length: entry.length,
        variant: buffer.variant,
        sequence: buffer.sequence,
        segmentIndex: entry.segmentIndex,
      });
    }
    buffer.sequence += 1;
    buffer.chunks = [];
    buffer.entries = [];
    buffer.size = 0;
    buffer.segmentStart = null;
    buffer.segmentEnd = null;
  }

  /**
   * Handle one `segmentready` event by appending bytes into a packed variant buffer.
   *
   * @param {UploadSession} session
   * @param {unknown} detail
   * @returns {Promise<void>}
   */
  async handleSegmentReady(session, detail) {
    const variant = variantKeyFromDetail(detail);
    const d = /** @type {Record<string, unknown>} */ (detail);
    const kind =
      typeof d.kind === "string" && d.kind.trim() !== "" ? d.kind.trim() : "";
    if (kind !== "init" && kind !== "media") {
      throw new HttpError(400, "segmentready.kind must be 'init' or 'media'");
    }
    const segmentIndex = kind === "media" ? parseSegmentIndex(detail) : null;
    const bytes = parseEventBytes(detail);
    const path =
      kind === "init" ? `${variant}/init.mp4` : `${variant}/seg-${segmentIndex}.m4s`;
    const buffer = this.getVariantBuffer(session, variant);
    this.appendVariantEntry(buffer, {
      path,
      mimeType: "video/mp4",
      bytes,
      segmentIndex,
    });
    if (segmentIndex != null) {
      if (buffer.segmentStart == null || segmentIndex < buffer.segmentStart) {
        buffer.segmentStart = segmentIndex;
      }
      if (buffer.segmentEnd == null || segmentIndex > buffer.segmentEnd) {
        buffer.segmentEnd = segmentIndex;
      }
    }
    if (buffer.size >= this.cfg.maxPieceBytes) {
      await this.flushVariantBuffer(session, buffer);
    }
  }

  /**
   * Handle one `segmentflush` event by discarding in-memory variant bytes and marking
   * already parked variant pieces as abandoned (uncommitted).
   *
   * @param {UploadSession} session
   * @param {unknown} detail
   * @returns {Promise<void>}
   */
  async handleSegmentFlush(session, detail) {
    const variant = variantKeyFromDetail(detail);
    const buffer = this.getVariantBuffer(session, variant);
    buffer.chunks = [];
    buffer.entries = [];
    buffer.size = 0;
    buffer.segmentStart = null;
    buffer.segmentEnd = null;
    for (const piece of session.piecesByCid.values()) {
      if (!piece.committed && piece.variant === variant) {
        piece.abandoned = true;
      }
    }
  }

  /**
   * Handle one `fileEvent` event by staging text artifacts in memory until finalize.
   *
   * @param {UploadSession} session
   * @param {unknown} detail
   * @returns {Promise<void>}
   */
  async handleFileEvent(session, detail) {
    if (!detail || typeof detail !== "object") {
      throw new HttpError(400, "fileEvent detail must be an object");
    }
    const d = /** @type {Record<string, unknown>} */ (detail);
    const filePath =
      typeof d.path === "string" && d.path.trim() !== "" ? d.path.trim() : "";
    if (!filePath) {
      throw new HttpError(400, "fileEvent.path is required");
    }
    const mimeType =
      typeof d.mimeType === "string" && d.mimeType.trim() !== ""
        ? d.mimeType.trim()
        : defaultMimeForPath(filePath);
    const bytes = parseEventBytes(detail);
    session.textFiles.set(filePath, {
      path: filePath,
      mimeType,
      data: bytes,
    });
  }

  /**
   * Handle one `transcodeComplete` event and stage master playlists from payload.
   *
   * @param {UploadSession} session
   * @param {unknown} detail
   * @returns {Promise<void>}
   */
  async handleTranscodeComplete(session, detail) {
    session.transcodeCompleteReceived = true;
    if (!detail || typeof detail !== "object") return;
    const d = /** @type {Record<string, unknown>} */ (detail);
    const textEncoder = new TextEncoder();
    if (typeof d.masterAppM3U8Text === "string" && d.masterAppM3U8Text.trim() !== "") {
      session.textFiles.set("master-app.m3u8", {
        path: "master-app.m3u8",
        mimeType: "application/vnd.apple.mpegurl",
        data: textEncoder.encode(d.masterAppM3U8Text),
      });
    }
    if (typeof d.rootM3U8Text === "string" && d.rootM3U8Text.trim() !== "") {
      session.textFiles.set("master-local.m3u8", {
        path: "master-local.m3u8",
        mimeType: "application/vnd.apple.mpegurl",
        data: textEncoder.encode(d.rootM3U8Text),
      });
    }
  }

  /**
   * Handle one `listingDetails` event and stage `meta.json`.
   *
   * @param {UploadSession} session
   * @param {unknown} detail
   * @returns {Promise<void>}
   */
  async handleListingDetails(session, detail) {
    session.listingDetailsReceived = true;
    if (!detail || typeof detail !== "object") return;
    const d = /** @type {Record<string, unknown>} */ (detail);
    const metaPath =
      typeof d.metaPath === "string" && d.metaPath.trim() !== ""
        ? d.metaPath.trim()
        : "meta.json";
    if (typeof d.metaJsonText === "string" && d.metaJsonText.trim() !== "") {
      session.textFiles.set(metaPath, {
        path: metaPath,
        mimeType: "application/json",
        data: new TextEncoder().encode(d.metaJsonText),
      });
    }
  }

  /**
   * Build the canonical manifest document from in-memory piece and file mapping state.
   *
   * @param {UploadSession} session
   * @returns {Record<string, unknown>}
   */
  buildManifest(session) {
    const livePieces = [...session.piecesByCid.values()].filter((p) => !p.abandoned);
    const livePieceSet = new Set(livePieces.map((p) => p.pieceCid));
    const files = session.fileMappings.filter((f) => livePieceSet.has(f.pieceCid));
    const metaFile = session.textFiles.get("meta.json");
    const metaDoc =
      metaFile != null
        ? parseOptionalJsonObject(Buffer.from(metaFile.data).toString("utf8"))
        : null;
    const playback = extractPlaybackUrls(files);
    return {
      version: 1,
      createdAt: new Date().toISOString(),
      assetId: session.assetId,
      filstreamId: session.filstreamId,
      clientAddress: session.clientAddress,
      providerId: session.providerId,
      dataSetId: session.dataSetId,
      playback: {
        masterAppUrl: playback.masterAppUrl,
      },
      eventCounts: { ...session.eventCounts },
      transcodeCompleteReceived: session.transcodeCompleteReceived,
      listingDetailsReceived: session.listingDetailsReceived,
      pieces: livePieces.map((p) => ({
        pieceCid: p.pieceCid,
        retrievalUrl: p.retrievalUrl,
        byteLength: p.byteLength,
        pieceMetadata: p.pieceMetadata,
        committed: p.committed,
        variant: p.variant,
        sequence: p.sequence,
      })),
      files: files.map((f) => ({
        path: f.path,
        mimeType: f.mimeType,
        pieceCid: f.pieceCid,
        retrievalUrl: f.retrievalUrl,
        offset: f.offset,
        length: f.length,
        variant: f.variant,
        sequence: f.sequence,
        segmentIndex: f.segmentIndex,
      })),
      meta: metaDoc,
    };
  }

  /**
   * Store one staged text file as its own piece and register file mapping.
   *
   * @param {UploadSession} session
   * @param {{ path: string, mimeType: string, data: Uint8Array }} file
   * @returns {Promise<void>}
   */
  async storeStagedFile(session, file) {
    const metadata = filePieceMetadata(session.assetId, file.path);
    const piece = await this.storePieceBytes(session, {
      bytes: file.data,
      pieceMetadata: metadata,
      variant: metadata.FS_VAR || "root",
      sequence: null,
    });
    session.fileMappings.push({
      path: file.path,
      mimeType: file.mimeType,
      pieceCid: piece.pieceCid,
      retrievalUrl: piece.retrievalUrl,
      offset: 0,
      length: file.data.byteLength,
      variant: metadata.FS_VAR || "root",
      sequence: null,
      segmentIndex: null,
    });
  }

  /**
   * Rewrite and stage all variant `playlist-app` files with retrieval URL byte-ranges.
   *
   * @param {UploadSession} session
   * @returns {void}
   */
  rewriteVariantPlaylists(session) {
    const encoder = new TextEncoder();
    const mappingsByPath = buildLiveMappingByPath(session);
    for (const [path, file] of session.textFiles.entries()) {
      if (!VARIANT_PLAYLIST_APP_RE.test(path)) continue;
      const variant = parseVariantFromPath(path);
      if (!variant) {
        throw new HttpError(400, `Invalid variant playlist path: ${path}`);
      }
      const current = Buffer.from(file.data).toString("utf8");
      const rewritten = rewriteVariantPlaylist(variant, current, mappingsByPath);
      session.textFiles.set(path, {
        path: file.path,
        mimeType: file.mimeType,
        data: encoder.encode(rewritten),
      });
    }
  }

  /**
   * Rewrite and stage `master-app.m3u8` with direct variant playlist retrieval URLs.
   *
   * @param {UploadSession} session
   * @returns {void}
   */
  rewriteMasterPlaylistFile(session) {
    const master = session.textFiles.get("master-app.m3u8");
    if (!master) return;
    const mappingsByPath = buildLiveMappingByPath(session);
    const current = Buffer.from(master.data).toString("utf8");
    const rewritten = rewriteMasterPlaylistText(current, mappingsByPath);
    session.textFiles.set(master.path, {
      path: master.path,
      mimeType: master.mimeType,
      data: new TextEncoder().encode(rewritten),
    });
  }

  /**
   * Commit all non-abandoned parked pieces.
   *
   * @param {UploadSession} session
   * @returns {Promise<{ committedCount: number, transactionHash: string | null }>}
   */
  async commitPendingPieces(session) {
    if (!session.context || typeof session.context.commit !== "function") {
      throw new HttpError(500, "Storage context.commit is unavailable");
    }
    const pending = [...session.piecesByCid.values()].filter(
      (p) => !p.committed && !p.abandoned,
    );
    if (pending.length === 0) {
      return { committedCount: 0, transactionHash: null };
    }
    const result = await session.context.commit({
      pieces: pending.map((p) => ({
        pieceCid: p.pieceCid,
        pieceMetadata: p.pieceMetadata,
      })),
    });
    for (const p of pending) {
      p.committed = true;
    }
    const txHash = typeof result?.txHash === "string" ? result.txHash : null;
    return { committedCount: pending.length, transactionHash: txHash };
  }

  /**
   * Finalize upload by flushing packed variant pieces, uploading staged files,
   * generating/storing manifest.json, then committing all live pieces.
   *
   * @param {string} uploadId
   * @returns {Promise<{
   *   finalized: boolean,
   *   committedCount: number,
   *   transactionHash: string | null,
   *   masterAppUrl: string | null,
   *   manifestUrl: string | null,
   *   dataSetId: number,
   * }>}
   */
  async finalizeUpload(uploadId) {
    const session = this.getUploadSession(uploadId);
    if (session.finalized) {
      throw new HttpError(409, "Upload is already finalized");
    }

    for (const buffer of session.variantBuffers.values()) {
      await this.flushVariantBuffer(session, buffer);
    }

    this.rewriteVariantPlaylists(session);
    const variantPlaylists = [...session.textFiles.values()].filter((f) =>
      VARIANT_PLAYLIST_APP_RE.test(f.path),
    );
    for (const file of variantPlaylists) {
      await this.storeStagedFile(session, file);
    }

    this.rewriteMasterPlaylistFile(session);
    const master = session.textFiles.get("master-app.m3u8");
    if (master) {
      await this.storeStagedFile(session, master);
    }

    const manifestDoc = this.buildManifest(session);
    const manifestText = JSON.stringify(manifestDoc, null, 2);
    await this.storeStagedFile(session, {
      path: "manifest.json",
      mimeType: "application/json",
      data: new TextEncoder().encode(manifestText),
    });

    const commit = await this.commitPendingPieces(session);
    session.finalized = true;

    const liveFiles = session.fileMappings.filter((f) => {
      const p = session.piecesByCid.get(f.pieceCid);
      return p != null && !p.abandoned;
    });
    const playback = extractPlaybackUrls(liveFiles);
    return {
      finalized: true,
      committedCount: commit.committedCount,
      transactionHash: commit.transactionHash,
      masterAppUrl: playback.masterAppUrl,
      manifestUrl: playback.manifestUrl,
      dataSetId: session.dataSetId,
    };
  }

  /**
   * Delete all committed pieces tracked in this upload session.
   *
   * @param {string} uploadId
   * @returns {Promise<{ deletedPieceCount: number }>}
   */
  async deleteAsset(uploadId) {
    const session = this.getUploadSession(uploadId);
    const committed = [...session.piecesByCid.values()].filter((p) => p.committed);
    let deleted = 0;
    for (const piece of committed) {
      await deletePiece(session.context, piece.pieceCid);
      session.piecesByCid.delete(piece.pieceCid);
      deleted += 1;
    }
    session.fileMappings = session.fileMappings.filter(
      (f) => session.piecesByCid.has(f.pieceCid),
    );
    return { deletedPieceCount: deleted };
  }

  /**
   * Abort one upload session (parked pieces are left uncommitted/abandoned).
   *
   * @param {string} uploadId
   * @returns {{ aborted: boolean }}
   */
  abortUpload(uploadId) {
    this.getUploadSession(uploadId);
    this.sessions.delete(uploadId);
    return { aborted: true };
  }

  /**
   * Terminate/delete the whole dataset for this session.
   *
   * @param {string} uploadId
   * @returns {Promise<{ terminated: boolean }>}
   */
  async deleteAccountData(uploadId) {
    const session = this.getUploadSession(uploadId);
    await terminateDataSet(session.context);
    this.sessions.delete(uploadId);
    return { terminated: true };
  }

  /**
   * Return status summary for one upload session.
   *
   * @param {string} uploadId
   * @returns {{
   *   uploadId: string,
   *   assetId: string,
   *   clientAddress: string,
   *   filstreamId: string,
   *   providerId: number,
   *   dataSetId: number,
   *   finalized: boolean,
   *   eventCounts: UploadSession["eventCounts"],
   *   pieces: {
   *     total: number,
   *     committed: number,
   *     abandoned: number,
   *     pending: number,
   *   },
   *   textFilesStaged: number,
   *   fileMappings: number,
   *   createdAt: string,
   *   lastEventAt: string,
   * }}
   */
  getStatus(uploadId) {
    const session = this.getUploadSession(uploadId);
    const records = [...session.piecesByCid.values()];
    const committed = records.filter((p) => p.committed).length;
    const abandoned = records.filter((p) => p.abandoned).length;
    const pending = records.filter((p) => !p.committed && !p.abandoned).length;
    return {
      uploadId: session.uploadId,
      assetId: session.assetId,
      clientAddress: session.clientAddress,
      filstreamId: session.filstreamId,
      providerId: session.providerId,
      dataSetId: session.dataSetId,
      finalized: session.finalized,
      eventCounts: { ...session.eventCounts },
      pieces: {
        total: records.length,
        committed,
        abandoned,
        pending,
      },
      textFilesStaged: session.textFiles.size,
      fileMappings: session.fileMappings.length,
      createdAt: session.createdAt,
      lastEventAt: session.lastEventAt,
    };
  }
}
