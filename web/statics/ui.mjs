/**
 * Wizard shell — edit and refresh; no `npm run build`.
 * Wallet/configure: `upload-configure.mjs`. Transcode + preview: `convert-progress.mjs`. Pipeline: `core.mjs`.
 */
import { html, render } from "https://cdn.jsdelivr.net/npm/lit-html@3.2.1/+esm";
import { applyStreamMode, convertProgressPanel } from "./convert-progress.mjs";
import {
  emitListingDetailsEvent,
  FILE_EVENT,
  hasDebugHlsSnapshot,
  LISTING_DETAILS_EVENT,
  probeVideoEncoderHardwareAcceleration,
  resetFilstreamPlayback,
  runFilstreamPipeline,
  SEGMENT_FLUSH_EVENT,
  SEGMENT_READY_EVENT,
  TRANSCODE_COMPLETE_EVENT,
  uploadDebugHlsToServer,
} from "./core.mjs";
import {
  connectInjectedProvider,
  requestInjectedProviders,
  subscribeInjectedWallets,
} from "./eip6963.mjs";
import { broadcastViewTemplate } from "./filstream-broadcast-view.mjs";
import {
  donateConfigFromMeta,
  proposeDonateTransfer,
  resolveViewerProvider,
} from "./filstream-viewer-donate.mjs";
import { uploadConfigurePanel } from "./upload-configure.mjs";
import { publishMetadataForm } from "./publish-metadata.mjs";

const WIZARD_MAX_STEP = 5;
const STORE_API_BASE = "/api/store";

/**
 * @typedef {{ [permissionHash: string]: string | number | bigint }} StoreSessionExpirations
 * @typedef {{
 *   sessionPrivateKey: string,
 *   sessionExpirations: StoreSessionExpirations,
 * }} StoreSessionAuth
 * @typedef {{
 *   assetId: string,
 *   clientAddress: string,
 *   sessionPrivateKey: string,
 *   sessionExpirations: StoreSessionExpirations,
 * }} StoreInitRequest
 * @typedef {{
 *   uploadId: string,
 *   dataSetId: number | null,
 *   providerId: number,
 *   filstreamId: string,
 *   createdDataSet: boolean,
 * }} StoreInitResponse
 * @typedef {{
 *   finalized: boolean,
 *   committedCount: number,
 *   transactionHash: string | null,
 *   masterAppUrl: string | null,
 *   manifestUrl: string | null,
 *   dataSetId: number | null,
 * }} StoreFinalizeResponse
 */

/** Shared with {@link runFilstreamPipeline} and {@link emitListingDetailsEvent} for FilStream custom events. */
const filstreamEvents = { filstreamEventTarget: new EventTarget() };

const storeRuntime = {
  uploadId: "",
  assetId: "",
  initPromise: null,
  queue: Promise.resolve(),
  disabled: false,
  finalized: false,
  finalizeResult: null,
};

// TODO(asset-id-policy): Replace random fallback with the canonical app-level asset id strategy.
function randomAssetId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `asset_${crypto.randomUUID()}`;
  }
  return `asset_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

/**
 * @param {unknown} value
 * @returns {value is StoreSessionExpirations}
 */
function isStoreSessionExpirations(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  for (const expiration of Object.values(/** @type {Record<string, unknown>} */ (value))) {
    if (
      typeof expiration !== "string" &&
      typeof expiration !== "number" &&
      typeof expiration !== "bigint"
    ) {
      return false;
    }
  }
  return true;
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function bytesToBase64(bytes) {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    bin += String.fromCharCode(...slice);
  }
  return btoa(bin);
}

/**
 * @param {string} eventType
 * @param {unknown} detail
 * @returns {Record<string, unknown>}
 */
function toStoreEventDetail(eventType, detail) {
  if (!detail || typeof detail !== "object") return {};
  const src = /** @type {Record<string, unknown>} */ (detail);
  if (eventType === SEGMENT_READY_EVENT || eventType === FILE_EVENT) {
    const out = { ...src };
    const data = src.data;
    if (data instanceof Uint8Array) {
      out.dataBase64 = bytesToBase64(data);
    }
    delete out.data;
    return out;
  }
  if (eventType === TRANSCODE_COMPLETE_EVENT) {
    return {
      masterAppM3U8Text:
        typeof src.masterAppM3U8Text === "string" ? src.masterAppM3U8Text : "",
      rootM3U8Text: typeof src.rootM3U8Text === "string" ? src.rootM3U8Text : "",
    };
  }
  if (eventType === LISTING_DETAILS_EVENT) {
    return {
      metaPath: typeof src.metaPath === "string" ? src.metaPath : "meta.json",
      metaJsonText:
        typeof src.metaJsonText === "string" ? src.metaJsonText : "",
    };
  }
  return { ...src };
}

/**
 * POST JSON payload to store API and return parsed JSON response.
 *
 * @template T
 * @param {string} path
 * @param {Record<string, unknown>} payload
 * @returns {Promise<T>}
 */
async function postStoreJson(path, payload) {
  const res = await fetch(`${STORE_API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const bodyText = await res.text();
  let parsed = null;
  try {
    parsed = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    const msg =
      (parsed && typeof parsed.error === "string" && parsed.error) ||
      bodyText ||
      res.statusText ||
      String(res.status);
    throw new Error(msg);
  }
  return /** @type {T} */ (parsed);
}

/**
 * Resolve session auth inputs for store init from frontend session state.
 *
 * TODO(session-bootstrap): Wire this to the real session bootstrap output.
 * Required values:
 * - `sessionPrivateKey` (hex string)
 * - `sessionExpirations` map containing required FWSS permission expirations
 *
 * @returns {StoreSessionAuth | null}
 */
function readStoreSessionAuth() {
  const sessionPrivateKey =
    typeof wizardState.sessionPrivateKey === "string"
      ? wizardState.sessionPrivateKey.trim()
      : "";
  const sessionExpirations = wizardState.sessionExpirations;
  if (!sessionPrivateKey || !isStoreSessionExpirations(sessionExpirations)) {
    return null;
  }
  return {
    sessionPrivateKey,
    sessionExpirations,
  };
}

async function ensureStoreUploadSession() {
  if (storeRuntime.disabled) return;
  if (storeRuntime.uploadId) return;
  if (storeRuntime.initPromise) {
    await storeRuntime.initPromise;
    return;
  }
  storeRuntime.initPromise = (async () => {
    const assetId = storeRuntime.assetId || randomAssetId();
    storeRuntime.assetId = assetId;
    const clientAddress = wizardState.walletAddress;
    if (!clientAddress) {
      throw new Error(
        "Missing client wallet address. Connect wallet before starting upload.",
      );
    }
    const auth = readStoreSessionAuth();
    if (!auth) {
      throw new Error(
        "Session auth is not ready. Complete frontend session bootstrap before upload init.",
      );
    }
    const payload = /** @type {StoreInitRequest} */ ({
      assetId,
      clientAddress,
      sessionPrivateKey: auth.sessionPrivateKey,
      sessionExpirations: auth.sessionExpirations,
    });
    const initRes = /** @type {StoreInitResponse} */ (
      await postStoreJson("/uploads/init", payload)
    );
    storeRuntime.uploadId =
      typeof initRes?.uploadId === "string" ? initRes.uploadId : "";
    if (!storeRuntime.uploadId) {
      throw new Error("store init response missing uploadId");
    }
  })();
  try {
    await storeRuntime.initPromise;
  } finally {
    storeRuntime.initPromise = null;
  }
}

function queueStoreEvent(eventType, detail) {
  const payloadDetail = toStoreEventDetail(eventType, detail);
  storeRuntime.queue = storeRuntime.queue
    .then(async () => {
      if (storeRuntime.disabled || storeRuntime.finalized) return;
      await ensureStoreUploadSession();
      if (!storeRuntime.uploadId) return;
      await postStoreJson(`/uploads/${storeRuntime.uploadId}/events`, {
        type: eventType,
        detail: payloadDetail,
      });
    })
    .catch((error) => {
      storeRuntime.disabled = true;
      setWizardStatus(
        `[Store] ${error instanceof Error ? error.message : String(error)}`,
        "err",
      );
    });
}

async function finalizeStoreUpload() {
  if (storeRuntime.disabled || storeRuntime.finalized) {
    return storeRuntime.finalizeResult;
  }
  await storeRuntime.queue;
  await ensureStoreUploadSession();
  if (!storeRuntime.uploadId) {
    throw new Error("Store upload session not initialized");
  }
  const result = /** @type {StoreFinalizeResponse} */ (
    await postStoreJson(`/uploads/${storeRuntime.uploadId}/finalize`, {})
  );
  storeRuntime.finalized = true;
  storeRuntime.finalizeResult = result;
  return result;
}

async function resetStoreRuntime(abortRemote) {
  const previousUploadId = storeRuntime.uploadId;
  storeRuntime.uploadId = "";
  storeRuntime.assetId = "";
  storeRuntime.initPromise = null;
  storeRuntime.queue = Promise.resolve();
  storeRuntime.disabled = false;
  storeRuntime.finalized = false;
  storeRuntime.finalizeResult = null;
  if (abortRemote && previousUploadId) {
    try {
      await postStoreJson(`/uploads/${previousUploadId}/abort`, {});
    } catch {
      /* ignore abort errors during reset */
    }
  }
}

function installStoreEventBridge() {
  const onEvent = (ev) => {
    const ce = /** @type {CustomEvent<unknown>} */ (ev);
    queueStoreEvent(ev.type, ce.detail ?? {});
  };
  filstreamEvents.filstreamEventTarget.addEventListener(SEGMENT_READY_EVENT, onEvent);
  filstreamEvents.filstreamEventTarget.addEventListener(SEGMENT_FLUSH_EVENT, onEvent);
  filstreamEvents.filstreamEventTarget.addEventListener(FILE_EVENT, onEvent);
  filstreamEvents.filstreamEventTarget.addEventListener(
    TRANSCODE_COMPLETE_EVENT,
    onEvent,
  );
  filstreamEvents.filstreamEventTarget.addEventListener(
    LISTING_DETAILS_EVENT,
    onEvent,
  );
}

const wizardState = {
  step: 1,
  fileName: "",
  /** @type {File | null} original upload — used for “seek position” preview */
  sourceFile: null,
  /** @type {string | null} */
  sourcePreviewObjectUrl: null,
  statusMsg: "",
  statusKind: "",
  progress: 0,
  /** @type {Array<{ info: { uuid: string, name: string, icon: string, rdns: string }, provider: { request: (a: { method: string, params?: unknown[] }) => Promise<unknown> } }>} */
  injectedWallets: [],
  /** @type {string | null} */
  walletAddress: null,
  /** @type {string | null} */
  connectedWalletName: null,
  /**
   * TODO(session-bootstrap): Set from frontend session bootstrap flow.
   * TODO(session-bootstrap): Must be the user-scoped session key private key.
   * Must be provided before calling store init.
   */
  sessionPrivateKey: "",
  /**
   * TODO(session-bootstrap): Set from frontend session bootstrap flow.
   * TODO(session-bootstrap): Must include required FWSS permission hashes -> expiration values.
   * Must include required FWSS permission expirations.
   *
   * @type {StoreSessionExpirations | null}
   */
  sessionExpirations: null,
  walletBusy: false,
  /** @type {string | null} */
  walletError: null,
  /** @type {string | null} */
  connectingUuid: null,
  /** Shaka-reported active variant, e.g. `1280×720` */
  playingResolution: "",
  /** @type {import("shaka-player").Player | null} */
  player: null,
  /** @type {{ width: number; height: number; bandwidth: number }[]} */
  rungs: [],
  /** @type {"auto" | number} */
  streamMode: "auto",
  debugSaveBusy: false,
  /** Step 5 — listing */
  publishTitle: "",
  publishDescription: "",
  showDonateButton: false,
  donateAmountUsdfc: 1,
  /** @type {string | null} */
  posterObjectUrl: null,
  /** @type {File | null} chosen poster file or capture from seek */
  posterImageFile: null,
  useSeekPosition: false,
  defineNextBusy: false,
  defineNextError: "",
  /** @type {unknown | null} parsed listing meta.json after Define → Next */
  publishedMeta: null,
  viewerDonateBusy: false,
  viewerDonateError: "",
  viewerDonateTxHash: "",
};

/** @type {HTMLVideoElement | null} */
let videoEl = null;
/** @type {HTMLVideoElement | null} */
let sourcePreviewVideoEl = null;
/** @type {string | null} */
let sourcePreviewBoundKey = null;
/** @type {null | (() => void)} */
let variantListenerTeardown = null;

function ensureVideoEl() {
  if (!videoEl) {
    videoEl = document.createElement("video");
    videoEl.setAttribute("controls", "");
    videoEl.setAttribute("playsinline", "");
  }
  return videoEl;
}

function ensureSourcePreviewVideoEl() {
  if (!sourcePreviewVideoEl) {
    sourcePreviewVideoEl = document.createElement("video");
    sourcePreviewVideoEl.setAttribute("controls", "");
    sourcePreviewVideoEl.setAttribute("playsinline", "");
    sourcePreviewVideoEl.setAttribute("preload", "metadata");
  }
  return sourcePreviewVideoEl;
}

/**
 * Point the seek-preview player at the original file (object URL). Shaka keeps using `videoEl`.
 */
function syncSourcePreviewSrc() {
  const el = ensureSourcePreviewVideoEl();
  const want =
    wizardState.sourceFile &&
    wizardState.useSeekPosition &&
    wizardState.step === 3;
  const key = want
    ? `${wizardState.sourceFile.name}:${wizardState.sourceFile.size}:${wizardState.sourceFile.lastModified}`
    : null;

  if (key === sourcePreviewBoundKey && el.src) return;

  if (wizardState.sourcePreviewObjectUrl) {
    URL.revokeObjectURL(wizardState.sourcePreviewObjectUrl);
    wizardState.sourcePreviewObjectUrl = null;
  }
  sourcePreviewBoundKey = null;

  if (key && wizardState.sourceFile) {
    wizardState.sourcePreviewObjectUrl = URL.createObjectURL(wizardState.sourceFile);
    el.src = wizardState.sourcePreviewObjectUrl;
    sourcePreviewBoundKey = key;
  } else {
    el.removeAttribute("src");
    el.load();
  }
}

function getVariantResolutionLabel(p) {
  try {
    const tracks = p.getVariantTracks?.() ?? [];
    for (const t of tracks) {
      if (t.active && t.width && t.height) {
        return `${t.width}×${t.height}`;
      }
    }
  } catch {
    /* ignore */
  }
  return "";
}

function attachVariantResolutionListener(p) {
  if (variantListenerTeardown) {
    variantListenerTeardown();
    variantListenerTeardown = null;
  }
  const bump = () => {
    wizardState.playingResolution = getVariantResolutionLabel(p) || "—";
    renderWizard();
  };
  p.addEventListener("variantchanged", bump);
  p.addEventListener("adaptation", bump);
  p.addEventListener("trackschanged", bump);
  variantListenerTeardown = () => {
    p.removeEventListener("variantchanged", bump);
    p.removeEventListener("adaptation", bump);
    p.removeEventListener("trackschanged", bump);
  };
  bump();
}

function setWizardStatus(msg, kind) {
  wizardState.statusMsg = msg;
  wizardState.statusKind = kind || "";
  renderWizard();
}

function setWizardProgress(value) {
  wizardState.progress = Math.round(Math.min(100, Math.max(0, value)));
  renderWizard();
}

function handleStreamMode(mode) {
  wizardState.streamMode = mode;
  applyStreamMode(wizardState.player, mode, wizardState.rungs);
  renderWizard();
}

function debugMarkStepDone() {
  wizardState.step = Math.min(wizardState.step + 1, WIZARD_MAX_STEP);
  renderWizard();
}

function handlePublishTitle(v) {
  wizardState.publishTitle = v;
  renderWizard();
}

function handlePublishDescription(v) {
  wizardState.publishDescription = v;
  renderWizard();
}

function handleShowDonate(v) {
  wizardState.showDonateButton = v;
  renderWizard();
}

/** @param {number} v */
function handleDonateAmount(v) {
  wizardState.donateAmountUsdfc = v > 0 ? v : 1;
  renderWizard();
}

function broadcastPreviewMeta() {
  if (wizardState.publishedMeta) return wizardState.publishedMeta;
  return {
    listing: {
      title: wizardState.publishTitle,
      description: wizardState.publishDescription,
      showDonateButton: wizardState.showDonateButton,
      useSeekPosition: wizardState.useSeekPosition,
      fundWalletAddress: wizardState.walletAddress,
      donateAmountUsdfc: wizardState.donateAmountUsdfc,
    },
    donate: { enabled: false },
  };
}

async function handleViewerDonateClick() {
  const meta = broadcastPreviewMeta();
  const cfg = donateConfigFromMeta(meta);
  if (!cfg.enabled) return;
  const provider = resolveViewerProvider(null);
  if (!provider) {
    wizardState.viewerDonateError = "No browser wallet found.";
    renderWizard();
    return;
  }
  wizardState.viewerDonateBusy = true;
  wizardState.viewerDonateError = "";
  renderWizard();
  try {
    const { txHash } = await proposeDonateTransfer(provider, cfg);
    wizardState.viewerDonateTxHash = txHash;
  } catch (e) {
    wizardState.viewerDonateError = e instanceof Error ? e.message : String(e);
  } finally {
    wizardState.viewerDonateBusy = false;
    renderWizard();
  }
}

function handleUseSeekPosition(v) {
  wizardState.useSeekPosition = v;
  renderWizard();
}

/** @param {Event} e */
function handlePosterInput(e) {
  const input = /** @type {HTMLInputElement} */ (e.target);
  const f = input.files?.[0];
  if (wizardState.posterObjectUrl) {
    URL.revokeObjectURL(wizardState.posterObjectUrl);
    wizardState.posterObjectUrl = null;
  }
  wizardState.posterImageFile = f ?? null;
  wizardState.posterObjectUrl = f ? URL.createObjectURL(f) : null;
  input.value = "";
  renderWizard();
}

function handleContinueFromFund() {
  if (wizardState.step !== 2) return;
  wizardState.step = 3;
  renderWizard();
}

async function handleDefineNext() {
  if (wizardState.defineNextBusy) return;
  wizardState.defineNextError = "";

  /** @type {File | null} */
  let posterFile = null;

  if (wizardState.showDonateButton) {
    if (
      !wizardState.walletAddress ||
      !/^0x[a-fA-F0-9]{40}$/.test(wizardState.walletAddress)
    ) {
      wizardState.defineNextError =
        "Connect a wallet on Fund (step 2) — that address is the USDFC donation target in meta.json.";
      renderWizard();
      return;
    }
    if (
      !Number.isFinite(wizardState.donateAmountUsdfc) ||
      wizardState.donateAmountUsdfc <= 0
    ) {
      wizardState.defineNextError = "Enter a positive USDFC donation amount.";
      renderWizard();
      return;
    }
  }

  if (!wizardState.useSeekPosition) {
    if (!wizardState.posterImageFile) {
      wizardState.defineNextError =
        "Upload a poster image, or enable “Use seek position” to capture a frame.";
      renderWizard();
      return;
    }
    posterFile = wizardState.posterImageFile;
  } else {
    const video = ensureSourcePreviewVideoEl();
    if (!wizardState.sourceFile) {
      wizardState.defineNextError = "No source file available.";
      renderWizard();
      return;
    }
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h || video.readyState < 2) {
      wizardState.defineNextError =
        "Play the source preview briefly so a frame loads at full resolution, then try Next again.";
      renderWizard();
      return;
    }

    wizardState.defineNextBusy = true;
    renderWizard();
    try {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Could not get canvas context.");
      ctx.drawImage(video, 0, 0, w, h);
      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob(
          (b) =>
            b ? resolve(b) : reject(new Error("Could not encode poster image.")),
          "image/png",
        );
      });
      if (wizardState.posterObjectUrl) {
        URL.revokeObjectURL(wizardState.posterObjectUrl);
      }
      wizardState.posterObjectUrl = URL.createObjectURL(blob);
      posterFile = new File([blob], "poster-seek.png", {
        type: "image/png",
      });
      wizardState.posterImageFile = posterFile;
    } catch (e) {
      wizardState.defineNextError = e instanceof Error ? e.message : String(e);
    } finally {
      wizardState.defineNextBusy = false;
    }

    if (!posterFile) {
      renderWizard();
      return;
    }
  }

  const detail = emitListingDetailsEvent(filstreamEvents, {
    title: wizardState.publishTitle,
    description: wizardState.publishDescription,
    showDonateButton: wizardState.showDonateButton,
    useSeekPosition: wizardState.useSeekPosition,
    fundWalletAddress: wizardState.showDonateButton
      ? wizardState.walletAddress
      : null,
    donateAmountUsdfc: wizardState.showDonateButton
      ? wizardState.donateAmountUsdfc
      : undefined,
    poster: posterFile,
  });

  if (!detail) {
    wizardState.defineNextError =
      "Transcode metadata is not ready yet. Wait until encoding finishes, then try Next again.";
    renderWizard();
    return;
  }

  try {
    wizardState.publishedMeta = JSON.parse(detail.metaJsonText);
  } catch {
    wizardState.publishedMeta = null;
  }

  wizardState.step = 4;
  renderWizard();
  try {
    setWizardStatus("Uploading to storage…", "");
    const finalized = await finalizeStoreUpload();
    const masterUrl =
      typeof finalized?.masterAppUrl === "string" ? finalized.masterAppUrl : "";
    if (masterUrl) {
      setWizardStatus(`Stored. Master playback URL: ${masterUrl}`, "ok");
    } else {
      setWizardStatus("Stored and committed.", "ok");
    }
  } catch (e) {
    setWizardStatus(e instanceof Error ? e.message : String(e), "err");
  }
}

/** @type {(() => void) | null} */
let eip6963Unsub = null;

function ensureInjectedWalletSubscription() {
  if (eip6963Unsub) return;
  eip6963Unsub = subscribeInjectedWallets((list) => {
    wizardState.injectedWallets = list;
    renderWizard();
  });
}

function handleRefreshWallets() {
  requestInjectedProviders();
}

/**
 * @param {{ request: (a: { method: string, params?: unknown[] }) => Promise<unknown> }} provider
 * @param {{ uuid: string, name: string }} info
 */
async function handleConnectInjected(provider, info) {
  wizardState.walletBusy = true;
  wizardState.connectingUuid = info.uuid;
  wizardState.walletError = null;
  renderWizard();
  try {
    const addr = await connectInjectedProvider(provider);
    wizardState.walletAddress = addr;
    wizardState.connectedWalletName = info.name;
    if (!addr) wizardState.walletError = "No account returned from the wallet.";
  } catch (e) {
    wizardState.walletError = e instanceof Error ? e.message : String(e);
    wizardState.walletAddress = null;
    wizardState.connectedWalletName = null;
  } finally {
    wizardState.walletBusy = false;
    wizardState.connectingUuid = null;
    renderWizard();
  }
}

function handleDisconnectWallet() {
  wizardState.walletAddress = null;
  wizardState.connectedWalletName = null;
  wizardState.walletError = null;
  renderWizard();
}

async function handleDebugSave() {
  if (!hasDebugHlsSnapshot()) {
    setWizardStatus("Nothing to save — finish playback setup first.", "err");
    return;
  }
  wizardState.debugSaveBusy = true;
  renderWizard();
  try {
    const { savedTo } = await uploadDebugHlsToServer("");
    setWizardStatus(`Debug bundle saved on server: ${savedTo}`, "ok");
  } catch (e) {
    setWizardStatus(e instanceof Error ? e.message : String(e), "err");
  } finally {
    wizardState.debugSaveBusy = false;
    renderWizard();
  }
}

function renderWizard() {
  const root = document.getElementById("wizard-root");
  if (!root) return;
  const v = ensureVideoEl();
  const srcSeek = ensureSourcePreviewVideoEl();

  const stepClass = (n) => {
    if (wizardState.step === n) return "active";
    if (wizardState.step > n) return "done";
    return "";
  };

  render(
    html`
      <main class="wrap layout-main">
        <div class="site-top-bar">
          <header
            class="site-brand"
            role="banner"
            aria-label="FilStream — in-browser HLS"
          >
            <img
              class="site-brand-mark"
              src="favicon.svg"
              width="40"
              height="40"
              alt=""
              decoding="async"
            />
            <div class="site-brand-text">
              <span class="site-brand-name">FilStream</span>
              <span class="site-brand-tagline">In-browser HLS</span>
            </div>
          </header>

          <ol class="wizard-steps" aria-label="Progress">
            <li class=${stepClass(1)}>1 · Choose</li>
            <span class="sep" aria-hidden="true">→</span>
            <li class=${stepClass(2)}>2 · Fund</li>
            <span class="sep" aria-hidden="true">→</span>
            <li class=${stepClass(3)}>3 · Define</li>
            <span class="sep" aria-hidden="true">→</span>
            <li class=${stepClass(4)}>4 · Await</li>
            <span class="sep" aria-hidden="true">→</span>
            <li class=${stepClass(5)}>5 · Publish</li>
          </ol>
          <button
            type="button"
            class="btn btn-debug-mark-step"
            @click=${debugMarkStepDone}
          >
            DEBUG: Mark step done
          </button>
        </div>

        <div class="hero-stage">
          ${wizardState.step === 1
            ? html`
                <h1>Store your video as streamable on the Filecoin chain.</h1>
                <section class="wizard-step hero-dropzone-wrap" aria-labelledby="step1-title">
                  <p>Recommended browsers: Chromium-class browsers (Chrome, Edge) with MetaMask or Wallet-Class browsers (Brave, Opera)</p>
                  <p id="step1-title" class="hint">
                    Pick a video, such as
                    <a
                      href="https://download.blender.org/peach/bigbuckbunny_movies/big_buck_bunny_1080p_h264.mov"
                      >Big Buck Bunny</a
                    >. Output uses <strong>H.264 or VP9</strong>, plus <strong>Opus</strong>. Bitrate
                    rungs include 1080 / 720 / 360 / 144. After you choose a file, encoding and playback
                    wallet/configure and transcoding appear <strong>below</strong>. Chromium-class browsers work best.
                  </p>
                  <div
                    class="dropzone dropzone--hero"
                    tabindex="0"
                    role="button"
                    aria-label="Drop video file here or browse"
                    @dragenter=${(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      e.currentTarget.classList.add("dragover");
                    }}
                    @dragover=${(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      e.currentTarget.classList.add("dragover");
                    }}
                    @dragleave=${(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      e.currentTarget.classList.remove("dragover");
                    }}
                    @drop=${(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      e.currentTarget.classList.remove("dragover");
                      const f = e.dataTransfer?.files?.[0];
                      void onWizardFileChosen(f);
                    }}
                    @keydown=${(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        document.getElementById("wiz-file-input")?.click();
                      }
                    }}
                    @click=${(e) => {
                      if (e.target.closest("label.browse")) return;
                      document.getElementById("wiz-file-input")?.click();
                    }}
                  >
                    <div class="dropzone-inner">
                      <span class="dropzone-text">Drop video here</span>
                      <span class="dropzone-or">or</span>
                      <label class="browse">
                        <input
                          id="wiz-file-input"
                          type="file"
                          name="video"
                          accept="video/*"
                          hidden
                          @change=${(e) => {
                            const input = e.target;
                            const f = input.files?.[0];
                            void onWizardFileChosen(f);
                            input.value = "";
                          }}
                        />
                        <span>Choose video</span>
                      </label>
                    </div>
                  </div>
                  ${wizardState.statusMsg
                    ? html`<p class="status ${wizardState.statusKind}" aria-live="polite">
                        ${wizardState.statusMsg}
                      </p>`
                    : null}
                </section>
              `
            : html`
              `}
        </div>

        ${wizardState.step >= 2 && wizardState.step <= WIZARD_MAX_STEP
          ? html`
              <div class="step2-stack">
                ${wizardState.step === 5
                  ? html`
                      <section class="publish-broadcast-shell" aria-labelledby="publish-broadcast-title">
                        <h2 id="publish-broadcast-title" class="publish-broadcast-head">
                          Publish — broadcast preview
                        </h2>
                        <p class="publish-broadcast-lead">
                          Demo of <code class="publish-inline-code">filstream-broadcast-view.mjs</code>
                          using your <code class="publish-inline-code">meta.json</code> and stream.
                        </p>
                        ${broadcastViewTemplate({
                          meta: broadcastPreviewMeta(),
                          videoEl: v,
                          downloadSourceFile: wizardState.sourceFile,
                          downloadLabel: wizardState.sourceFile
                            ? `Download ${wizardState.sourceFile.name}`
                            : "Download source video",
                          variant: "embed-demo",
                          getWalletList: () => wizardState.injectedWallets,
                          viewerDonate: {
                            busy: wizardState.viewerDonateBusy,
                            error: wizardState.viewerDonateError,
                            txHash: wizardState.viewerDonateTxHash,
                            onClick: handleViewerDonateClick,
                          },
                        })}
                      </section>
                    `
                  : null}
                ${wizardState.step === 3
                  ? publishMetadataForm({
                      title: wizardState.publishTitle,
                      description: wizardState.publishDescription,
                      showDonateButton: wizardState.showDonateButton,
                      donateAmountUsdfc: wizardState.donateAmountUsdfc,
                      posterPreviewUrl: wizardState.posterObjectUrl,
                      useSeekPosition: wizardState.useSeekPosition,
                      sourceSeekVideoEl:
                        wizardState.useSeekPosition && wizardState.sourceFile
                          ? srcSeek
                          : null,
                      seekUsesSource: wizardState.sourceFile != null,
                      onTitle: handlePublishTitle,
                      onDescription: handlePublishDescription,
                      onShowDonate: handleShowDonate,
                      onDonateAmount: handleDonateAmount,
                      onPosterInput: handlePosterInput,
                      onUseSeekPosition: handleUseSeekPosition,
                      onNext: handleDefineNext,
                      nextBusy: wizardState.defineNextBusy,
                      nextError: wizardState.defineNextError,
                    })
                  : null}
                ${uploadConfigurePanel({
                  show: wizardState.step === 2,
                  fileName: wizardState.fileName,
                  injectedWallets: wizardState.injectedWallets,
                  walletAddress: wizardState.walletAddress,
                  connectedWalletName: wizardState.connectedWalletName,
                  walletBusy: wizardState.walletBusy,
                  walletError: wizardState.walletError,
                  connectingUuid: wizardState.connectingUuid,
                  onConnectInjected: handleConnectInjected,
                  onDisconnectWallet: handleDisconnectWallet,
                  onRefreshWallets: handleRefreshWallets,
                  fundStepActive: wizardState.step === 2,
                  onContinueFromFund: handleContinueFromFund,
                })}
                ${convertProgressPanel({
                  show: wizardState.step < 5 || wizardState.player != null,
                  phase:
                    wizardState.step === 4 && !wizardState.player
                      ? "awaiting"
                      : wizardState.step === 4 ||
                          wizardState.step === 5
                        ? "playback"
                        : wizardState.progress < 100
                          ? "encoding"
                          : "define",
                  fileName: wizardState.fileName,
                  progress: wizardState.progress,
                  statusMsg: wizardState.statusMsg,
                  statusKind: wizardState.statusKind,
                  videoEl: v,
                  rungs: wizardState.rungs,
                  streamMode: wizardState.streamMode,
                  onStreamMode: handleStreamMode,
                  playingLabel: wizardState.playingResolution,
                  onCancel: () => wizardGoBackToChoose(),
                  onStartOver: () => wizardStartOver(),
                  showDebugSave:
                    wizardState.step === 4 || wizardState.step === 5,
                  debugSaveBusy: wizardState.debugSaveBusy,
                  onDebugSave: handleDebugSave,
                  awaitListingLayout:
                    wizardState.step === 4 && wizardState.progress >= 100,
                  awaitListingTitle: wizardState.publishTitle,
                  awaitListingDescription: wizardState.publishDescription,
                  awaitPosterUrl: wizardState.posterObjectUrl,
                  awaitUploadBannerText: "Upload in progress",
                })}
              </div>
            `
          : null}
      </main>
    `,
    root,
  );
  queueMicrotask(() => {
    syncSourcePreviewSrc();
    const vid = ensureVideoEl();
    if (
      (wizardState.step === 4 || wizardState.step === 5) &&
      wizardState.progress >= 100 &&
      wizardState.posterObjectUrl
    ) {
      vid.poster = wizardState.posterObjectUrl;
    } else if (wizardState.step !== 4 && wizardState.step !== 5) {
      vid.removeAttribute("poster");
    }
  });
}

async function wizardGoBackToChoose() {
  await resetFilstreamPlayback();
  await resetStoreRuntime(true);
  if (variantListenerTeardown) {
    variantListenerTeardown();
    variantListenerTeardown = null;
  }
  const el = ensureVideoEl();
  el.removeAttribute("src");
  el.removeAttribute("poster");
  el.load();
  wizardState.step = 1;
  wizardState.fileName = "";
  wizardState.sourceFile = null;
  sourcePreviewBoundKey = null;
  if (wizardState.sourcePreviewObjectUrl) {
    URL.revokeObjectURL(wizardState.sourcePreviewObjectUrl);
    wizardState.sourcePreviewObjectUrl = null;
  }
  if (sourcePreviewVideoEl) {
    sourcePreviewVideoEl.removeAttribute("src");
    sourcePreviewVideoEl.load();
  }
  wizardState.statusMsg = "";
  wizardState.statusKind = "";
  wizardState.progress = 0;
  wizardState.playingResolution = "";
  wizardState.player = null;
  wizardState.rungs = [];
  wizardState.streamMode = "auto";
  wizardState.walletAddress = null;
  wizardState.connectedWalletName = null;
  wizardState.walletError = null;
  wizardState.walletBusy = false;
  wizardState.connectingUuid = null;
  wizardState.debugSaveBusy = false;
  wizardState.publishTitle = "";
  wizardState.publishDescription = "";
  wizardState.showDonateButton = false;
  wizardState.donateAmountUsdfc = 1;
  wizardState.publishedMeta = null;
  wizardState.viewerDonateBusy = false;
  wizardState.viewerDonateError = "";
  wizardState.viewerDonateTxHash = "";
  if (wizardState.posterObjectUrl) {
    URL.revokeObjectURL(wizardState.posterObjectUrl);
    wizardState.posterObjectUrl = null;
  }
  wizardState.posterImageFile = null;
  wizardState.defineNextBusy = false;
  wizardState.defineNextError = "";
  wizardState.useSeekPosition = false;
  renderWizard();
}

async function wizardStartOver() {
  await wizardGoBackToChoose();
}

async function onWizardFileChosen(file) {
  if (!file) return;
  if (!file.type.startsWith("video/")) {
    wizardState.statusMsg = "Please choose a video file.";
    wizardState.statusKind = "err";
    wizardState.step = 1;
    renderWizard();
    return;
  }
  await resetStoreRuntime(true);
  storeRuntime.assetId = randomAssetId();
  wizardState.fileName = file.name;
  wizardState.sourceFile = file;
  wizardState.step = 2;
  wizardState.statusMsg = "Reading media…";
  wizardState.statusKind = "";
  wizardState.progress = 0;
  wizardState.playingResolution = "";
  wizardState.player = null;
  wizardState.rungs = [];
  wizardState.streamMode = "auto";
  wizardState.walletError = null;
  ensureInjectedWalletSubscription();
  requestInjectedProviders();
  renderWizard();

  runFilstreamPipeline(file, {
    setStatus: setWizardStatus,
    setProgress: setWizardProgress,
    getVideoElement: ensureVideoEl,
    filstreamEventTarget: filstreamEvents.filstreamEventTarget,
    onPlaybackReady: (p, info) => {
      wizardState.player = p;
      wizardState.rungs = info.rungs.map((r) => ({
        width: r.width,
        height: r.height,
        bandwidth: r.bandwidth,
      }));
      wizardState.streamMode = "auto";
      attachVariantResolutionListener(p);
      renderWizard();
    },
  }).catch((e) => {
    setWizardStatus(e.message || String(e), "err");
  });
}

ensureInjectedWalletSubscription();
installStoreEventBridge();
renderWizard();
void probeVideoEncoderHardwareAcceleration();
