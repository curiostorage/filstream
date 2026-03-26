/**
 * Wizard shell — edit and refresh; no `npm run build`.
 * Wallet/configure: `upload-configure.mjs`. Transcode + preview: `convert-progress.mjs`. Pipeline: `core.mjs`.
 */
import { html, render } from "https://cdn.jsdelivr.net/npm/lit-html@3.2.1/+esm";
import {
  createBrowserUploadSession,
  resolveOrCreateDataSet,
  StoreError,
} from "./browser-store.mjs";
import { applyStreamMode, convertProgressPanel } from "./convert-progress.mjs";
import {
  destroyActivePipelinePlayer,
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
  EIP6963_LEGACY_PROVIDER_UUID,
  requestInjectedProviders,
  subscribeInjectedWallets,
} from "./eip6963.mjs";
import {
  broadcastViewTemplate,
  formatUploadDateLabel,
} from "./filstream-broadcast-view.mjs";
import {
  buildReviewViewerIframeSrc,
  ensureFilstreamId,
  getFilstreamStoreConfig,
} from "./filstream-config.mjs";
import {
  donateConfigFromMeta,
  proposeDonateTransfer,
  resolveViewerProvider,
} from "./filstream-viewer-donate.mjs";
import { publishMetadataForm } from "./publish-metadata.mjs";
import {
  authorizeSessionKeyForUpload,
  minExpirationSummaryLocal,
} from "./session-key-bootstrap.mjs";
import {
  clearSessionKeyFromStorage,
  clearWalletFromStorage,
  expirationsForWizard,
  isSessionKeyRecoverable,
  loadSessionKeyFromStorage,
  loadWalletFromStorage,
  saveSessionKeyToStorage,
  saveWalletToStorage,
} from "./session-key-storage.mjs";
import { uploadConfigurePanel } from "./upload-configure.mjs";
import {
  custom,
  getAddress,
  getChain,
  Synapse,
} from "./vendor/synapse-browser.mjs";

const WIZARD_MAX_STEP = 5;

/** PDP finalize phase copy; must match {@link finalizeStoreUpload} and convert-progress highlight. */
const STORE_PHASE_FINALIZE_NOTE =
  "Finalizing playlists, manifest, and on-chain commit…";

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
 *   metaJsonUrl: string | null,
 *   dataSetId: number | null,
 *   catalogVersion: number | null,
 *   catalogPieceCid: string | null,
 * }} StoreFinalizeResponse
 */

/** Shared with {@link runFilstreamPipeline} and {@link emitListingDetailsEvent} for FilStream custom events. */
const filstreamEvents = { filstreamEventTarget: new EventTarget() };

const storeRuntime = {
  uploadId: "",
  assetId: "",
  /** @type {import("./browser-store.mjs").BrowserFilstreamUploadSession | null} */
  session: null,
  initPromise: null,
  queue: Promise.resolve(),
  disabled: false,
  finalized: false,
  finalizeResult: null,
};

/** Single in-flight funding preflight for step 2 (session + wallet + source file). */
let fundingPreflightPromise = null;

/** Resolves when the user answers the inline funding confirmation (replaces `window.confirm`). */
let fundingPromptResolve = null;

/** Resolves when the user answers the inline session-setup confirmation (replaces `window.confirm`). */
let setupConfirmResolve = null;

/** PDP ingest is deferred until Fund wallet + session key exist; backlog preserves segment order (no cap / drops). */
/** @type {{ eventType: string, detail: unknown }[]} */
let storeEventBacklog = [];

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
 * @param {string | null} addr
 * @returns {boolean}
 */
function tryApplyStoredSession(addr) {
  if (!addr) return false;
  const stored = loadSessionKeyFromStorage();
  if (!stored) return false;
  const cfg = getFilstreamStoreConfig();
  if (stored.chainId !== cfg.storeChainId) return false;
  try {
    if (getAddress(/** @type {`0x${string}`} */ (stored.rootAddress)) !== getAddress(/** @type {`0x${string}`} */ (addr))) {
      return false;
    }
  } catch {
    return false;
  }
  if (!isSessionKeyRecoverable(stored)) {
    clearSessionKeyFromStorage();
    return false;
  }
  wizardState.sessionPrivateKey = stored.sessionPrivateKey;
  wizardState.sessionExpirations = expirationsForWizard(stored);
  wizardState.sessionAuthError = null;
  flushStoreEventBacklog();
  return true;
}

function fundStepSessionAuthReady() {
  return readStoreSessionAuth() != null;
}

function resetFundingGateState() {
  wizardState.fundingBusy = false;
  wizardState.fundingReady = false;
  wizardState.fundingError = null;
  wizardState.fundingSummary = "";
  wizardState.fundingTxHash = "";
  wizardState.fundingCheckKey = "";
  wizardState.fundingPrompt = null;
  if (fundingPromptResolve) {
    const r = fundingPromptResolve;
    fundingPromptResolve = null;
    r(false);
  }
  resetSetupConfirmState();
}

function resetSetupConfirmState() {
  wizardState.setupConfirmPrompt = null;
  if (setupConfirmResolve) {
    const r = setupConfirmResolve;
    setupConfirmResolve = null;
    r(false);
  }
}

/**
 * @param {string} reason
 */
async function abortUploadSetupFlow(reason) {
  await wizardGoBackToChoose();
  setWizardStatus(reason, "err");
  renderWizard();
}

const USDFC_DECIMALS = 18n;
const USDFC_ONE = 10n ** USDFC_DECIMALS;

/**
 * @param {bigint} value
 * @returns {string}
 */
function formatWeiAsUsdfc(value) {
  if (value <= 0n) return "0 tUSDFC";
  const whole = value / USDFC_ONE;
  const frac = value % USDFC_ONE;
  if (frac === 0n) return `${whole} tUSDFC`;
  const fracMicro = (frac * 1_000_000n) / USDFC_ONE;
  const fracStr = fracMicro.toString().padStart(6, "0").replace(/0+$/, "");
  return fracStr === "" ? `${whole} tUSDFC` : `${whole}.${fracStr} tUSDFC`;
}
const FUNDING_MIN_TOPUP_WEI = 5n * USDFC_ONE;
const FUNDING_TARGET_NUMERATOR = 120n;
const FUNDING_TARGET_DENOMINATOR = 100n;

/**
 * @param {bigint} value
 * @param {bigint} numerator
 * @param {bigint} denominator
 * @returns {bigint}
 */
function ceilMulDiv(value, numerator, denominator) {
  if (value <= 0n) return 0n;
  return (value * numerator + (denominator - 1n)) / denominator;
}

/**
 * Upfront funding amount per upload.
 * Rule: max(5 USDFC, ceil(120% of prepare().costs.depositNeeded)).
 *
 * @param {bigint} expectedDeposit
 * @returns {bigint}
 */
function computeFundingTargetAmount(expectedDeposit) {
  const scaled = ceilMulDiv(
    expectedDeposit,
    FUNDING_TARGET_NUMERATOR,
    FUNDING_TARGET_DENOMINATOR,
  );
  return scaled > FUNDING_MIN_TOPUP_WEI ? scaled : FUNDING_MIN_TOPUP_WEI;
}

/**
 * Synapse client for funding/auth txs. Uses injected wallet transport (EIP-1193),
 * not the public RPC transport used by session-key storage operations.
 *
 * @param {string} clientAddress
 * @returns {import("./vendor/synapse-browser.mjs").Synapse}
 */
function createFundingSynapseForWallet(clientAddress) {
  if (!wizardState.eip1193Provider) {
    throw new Error("Missing wallet provider for funding transaction");
  }
  const cfg = getFilstreamStoreConfig();
  return Synapse.create({
    account: getAddress(/** @type {`0x${string}`} */ (clientAddress)),
    chain: getChain(cfg.storeChainId),
    transport: custom(wizardState.eip1193Provider),
    source: cfg.storeSource,
  });
}

async function ensureFundingPreparedForCurrentUpload(force = false) {
  if (wizardState.step !== 2) return;
  const auth = readStoreSessionAuth();
  const clientAddress = wizardState.walletAddress;
  const sourceFile = wizardState.sourceFile;
  if (!auth || !clientAddress || !sourceFile) return;
  if (fundingPreflightPromise) {
    await fundingPreflightPromise;
    return;
  }

  const cfgFlat = getFilstreamStoreConfig();
  const filstreamId = ensureFilstreamId(cfgFlat);
  const fundingKey = [
    clientAddress.toLowerCase(),
    String(cfgFlat.storeChainId),
    filstreamId,
    String(sourceFile.size),
    String(sourceFile.lastModified),
  ].join("|");
  if (!force && wizardState.fundingReady && wizardState.fundingCheckKey === fundingKey) {
    return;
  }

  fundingPreflightPromise = (async () => {
    wizardState.fundingBusy = true;
    wizardState.fundingError = null;
    wizardState.fundingSummary = "Checking funding and lockup requirements…";
    wizardState.fundingTxHash = "";
    renderWizard();
    try {
      const synapse = createFundingSynapseForWallet(clientAddress);
      const resolved = await resolveOrCreateDataSet({
        synapse,
        providerId: cfgFlat.storeProviderId,
        clientAddress,
        filstreamId,
      });
      const dataSize = BigInt(sourceFile.size);
      const prepared = await synapse.storage.prepare({
        dataSize,
        context: resolved.context,
      });
      const expectedDeposit = BigInt(prepared.costs?.depositNeeded ?? 0n);
      const targetDeposit = computeFundingTargetAmount(expectedDeposit);
      const availableFunds = BigInt(await synapse.payments.balance());
      const fundingShortfall =
        targetDeposit > availableFunds ? targetDeposit - availableFunds : 0n;
      const expected = formatWeiAsUsdfc(expectedDeposit);
      const target = formatWeiAsUsdfc(targetDeposit);
      const available = formatWeiAsUsdfc(availableFunds);
      const shortfall = formatWeiAsUsdfc(fundingShortfall);
      const needsFwssMaxApproval = prepared.costs?.needsFwssMaxApproval === true;
      const authCopy = needsFwssMaxApproval
        ? "This includes FilecoinPay operator approval (FWSS)."
        : "Operator approval is already in place.";
      const bufferCopy =
        expectedDeposit === 0n
          ? "Estimated required deposit is zero, but FilStream still targets a minimum 5 USDFC available balance as safety buffer."
          : "";
      if (fundingShortfall === 0n && !needsFwssMaxApproval) {
        wizardState.fundingSummary =
          "Funding and approvals are already ready for this upload.";
        wizardState.fundingReady = true;
        wizardState.fundingCheckKey = fundingKey;
        wizardState.fundingError = null;
        wizardState.fundingTxHash = "";
        maybeAutoAdvanceFromFund();
        return;
      }
      wizardState.fundingPrompt = {
        headline:
          "Funding or approval is required before upload can continue. Review the amounts below, then continue or cancel upload setup.",
        lines: [
          `Estimated required deposit: ${expected}`,
          `Target available balance (max(5 USDFC, 120% of estimate)): ${target}`,
          `Current available balance (FilecoinPay): ${available}`,
          `Required top-up now: ${shortfall}`,
          authCopy,
          ...(bufferCopy ? [bufferCopy] : []),
        ],
      };
      const ok = await new Promise((resolve) => {
        fundingPromptResolve = resolve;
        wizardState.fundingBusy = false;
        renderWizard();
      });
      wizardState.fundingPrompt = null;
      fundingPromptResolve = null;
      if (!ok) {
        return;
      }
      wizardState.fundingBusy = true;
      wizardState.fundingSummary =
        "Upfront funding transaction submitted — waiting for chain confirmation…";
      renderWizard();
      await synapse.payments.fundSync({
        amount: fundingShortfall,
        needsFwssMaxApproval,
        onHash: (hash) => {
          wizardState.fundingTxHash = hash;
          renderWizard();
        },
      });
      wizardState.fundingSummary =
        "Upfront funding and approvals are ready for this upload.";
      wizardState.fundingReady = true;
      wizardState.fundingCheckKey = fundingKey;
      wizardState.fundingError = null;
      maybeAutoAdvanceFromFund();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      wizardState.fundingReady = false;
      wizardState.fundingError = msg;
      wizardState.fundingSummary = "";
      if (wizardState.step === 2) {
        setWizardStatus(msg, "err");
      }
    } finally {
      wizardState.fundingBusy = false;
      renderWizard();
      fundingPreflightPromise = null;
    }
  })();

  await fundingPreflightPromise;
}

/** When Fund step session is already valid (restored or pre-authorized), advance without a manual Continue. */
function maybeAutoAdvanceFromFund() {
  if (wizardState.step !== 2) return;
  if (!fundStepSessionAuthReady()) return;
  if (!wizardState.fundingReady) {
    void ensureFundingPreparedForCurrentUpload();
    return;
  }
  wizardState.sessionAuthError = null;
  wizardState.fundingError = null;
  wizardState.step = 3;
}

function computeWizardConvertPhase() {
  const st = wizardState;
  if (st.step === 5) {
    return st.player ? "playback" : "awaiting";
  }
  if (st.step === 4) {
    if (st.defineListingFlowPending) {
      return "encoding";
    }
    return "awaiting";
  }
  if (st.step === 3) {
    return st.progress < 100 ? "encoding" : "define";
  }
  return st.progress < 100 ? "encoding" : "define";
}

/**
 * @returns {Parameters<typeof emitListingDetailsEvent>[1] | null}
 */
function buildListingEmitPayloadFromWizard() {
  const poster = wizardState.posterImageFile;
  if (!poster) return null;
  return {
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
    poster,
  };
}

/** @param {NonNullable<ReturnType<typeof emitListingDetailsEvent>>} detail */
async function runFinalizeAfterListingDetail(detail) {
  try {
    wizardState.publishedMeta = JSON.parse(detail.metaJsonText);
  } catch {
    wizardState.publishedMeta = null;
  }
  wizardState.storageUploadActive = true;
  wizardState.storeUploadProgressPct = 0;
  wizardState.storeUploadPhaseNote = "Preparing finalize…";
  wizardState.storeUploadLabel = "";
  wizardState.reviewMetaJsonUrl = "";
  updateStoreUploadProgressFromSession();
  renderWizard();
  try {
    setWizardStatus("Uploading to Filecoin PDP — progress below.", "");
    const finalized = await finalizeStoreUpload();
    const masterUrl =
      typeof finalized?.masterAppUrl === "string" ? finalized.masterAppUrl : "";
    const metaJsonUrl =
      typeof finalized?.metaJsonUrl === "string" ? finalized.metaJsonUrl : "";
    wizardState.reviewMetaJsonUrl = metaJsonUrl;
    tryMergePlaybackIntoPublishedMeta(masterUrl);
    wizardState.storeUploadProgressPct = 100;
    wizardState.storeUploadLabel = masterUrl ? "Stored — loading playback…" : "Stored.";
    wizardState.storeUploadPhaseNote = "";
    wizardState.step = 5;
    renderWizard();
    setWizardStatus(
      masterUrl
        ? "Review below."
        : "Stored and committed. (No master URL returned.)",
      "ok",
    );
    renderWizard();
  } catch (e) {
    setWizardStatus(e instanceof Error ? e.message : String(e), "err");
  } finally {
    wizardState.storageUploadActive = false;
    wizardState.storeUploadPhaseNote = "";
    renderWizard();
  }
}

async function flushListingFlowAfterTranscode() {
  if (!wizardState.defineListingFlowPending || wizardState.step !== 4) return;
  if (listingFlowFinalizeStarted) return;

  const listing = buildListingEmitPayloadFromWizard();
  if (!listing) {
    wizardState.defineListingFlowPending = false;
    setWizardStatus("Poster missing. Use Cancel and return to Define.", "err");
    renderWizard();
    return;
  }

  const detail = emitListingDetailsEvent(filstreamEvents, listing);
  if (!detail) return;

  listingFlowFinalizeStarted = true;
  wizardState.defineListingFlowPending = false;
  try {
    await runFinalizeAfterListingDetail(detail);
  } finally {
    listingFlowFinalizeStarted = false;
  }
}

function scheduleListingFlowWhenTranscodeReady() {
  void flushListingFlowAfterTranscode();
  queueMicrotask(() => void flushListingFlowAfterTranscode());
  filstreamEvents.filstreamEventTarget.addEventListener(
    TRANSCODE_COMPLETE_EVENT,
    () => void flushListingFlowAfterTranscode(),
    { once: true },
  );
}

/** @returns {string | null} */
function sessionExpiresSummary() {
  const ex = wizardState.sessionExpirations;
  if (!ex) return null;
  /** @type {Record<string, string>} */
  const o = {};
  for (const [k, v] of Object.entries(ex)) {
    o[k] = typeof v === "bigint" ? v.toString() : String(v);
  }
  return minExpirationSummaryLocal(o);
}

/**
 * Restore wallet + session key after page reload if `eth_accounts` still matches `sessionStorage`.
 *
 * @param {Array<{ info: { uuid: string, name: string, icon: string, rdns: string }, provider: import("./eip6963.mjs").Eip1193Provider }>} list
 */
function attemptRestoreWalletFromStorage(list) {
  if (wizardState.walletAddress) return;
  const stored = loadWalletFromStorage();
  if (!stored) return;

  const found = list.find((w) => w.info.uuid === stored.walletUuid);
  /** @type {import("./eip6963.mjs").Eip1193Provider | null} */
  let provider =
    found && typeof found.provider?.request === "function" ? found.provider : null;

  if (
    !provider &&
    stored.walletUuid === EIP6963_LEGACY_PROVIDER_UUID &&
    typeof window !== "undefined" &&
    window.ethereum &&
    typeof window.ethereum.request === "function"
  ) {
    provider = window.ethereum;
  }

  if (!provider) return;

  void (async () => {
    try {
      const accounts = /** @type {string[]} */ (
        await provider.request({ method: "eth_accounts" })
      );
      const a = accounts?.[0];
      if (!a || typeof a !== "string") return;

      if (
        getAddress(/** @type {`0x${string}`} */ (a)) !==
        getAddress(/** @type {`0x${string}`} */ (stored.address))
      ) {
        clearWalletFromStorage();
        renderWizard();
        return;
      }

      wizardState.walletAddress = a;
      wizardState.connectedWalletName = stored.walletName || null;
      wizardState.eip1193Provider = provider;
      if (!tryApplyStoredSession(a)) {
        wizardState.sessionPrivateKey = "";
        wizardState.sessionExpirations = null;
        resetFundingGateState();
      }
      wizardState.walletError = null;
      maybeAutoAdvanceFromFund();
      renderWizard();
    } catch {
      /* ignore */
    }
  })();
}

/**
 * Clone encoder event detail for the in-browser store (keeps Uint8Array `data`).
 *
 * @param {string} eventType
 * @param {unknown} detail
 * @returns {Record<string, unknown>}
 */
function toBrowserStoreEventDetail(eventType, detail) {
  if (!detail || typeof detail !== "object") return {};
  const src = /** @type {Record<string, unknown>} */ (detail);
  if (eventType === SEGMENT_READY_EVENT || eventType === FILE_EVENT) {
    return { ...src };
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
 * Resolve session auth inputs for in-browser Synapse (`Fund` step session key).
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
  if (readStoreSessionAuth() && storeRuntime.disabled) {
    storeRuntime.disabled = false;
  }
  if (storeRuntime.disabled) return;
  if (storeRuntime.uploadId && !storeRuntime.session) {
    storeRuntime.uploadId = "";
  }
  if (storeRuntime.uploadId && storeRuntime.session) return;

  const auth = readStoreSessionAuth();
  if (!auth) {
    /* Transcode runs during Fund before session bootstrap; ingest starts once auth exists. */
    return;
  }

  const clientAddress = wizardState.walletAddress;
  if (!clientAddress) {
    throw new Error(
      "Missing client wallet address. Connect wallet before starting upload.",
    );
  }

  if (storeRuntime.initPromise) {
    await storeRuntime.initPromise;
    return;
  }
  storeRuntime.initPromise = (async () => {
    const assetId = storeRuntime.assetId || randomAssetId();
    storeRuntime.assetId = assetId;
    const payload = /** @type {StoreInitRequest} */ ({
      assetId,
      clientAddress,
      sessionPrivateKey: auth.sessionPrivateKey,
      sessionExpirations: auth.sessionExpirations,
    });
    const initRes = await createBrowserUploadSession(payload);
    storeRuntime.session = initRes.session;
    initRes.session.onStagingStateChanged = scheduleAwaitStagingUiRefresh;
    storeRuntime.uploadId =
      typeof initRes?.uploadId === "string" ? initRes.uploadId : "";
    if (!storeRuntime.uploadId || !storeRuntime.session) {
      throw new Error("store init failed: missing upload session");
    }
  })();
  try {
    await storeRuntime.initPromise;
  } finally {
    storeRuntime.initPromise = null;
  }
}

/**
 * @param {unknown} detail
 * @returns {unknown}
 */
function cloneStoreEventDetailForBacklog(detail) {
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(detail);
    } catch {
      /* fall through — e.g. uncloneable proxy; use manual copy */
    }
  }
  if (!detail || typeof detail !== "object") return detail;
  const src = /** @type {Record<string, unknown>} */ (detail);
  const o = { ...src };
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v instanceof Uint8Array) {
      o[k] = new Uint8Array(v);
    } else if (v instanceof ArrayBuffer) {
      o[k] = v.slice(0);
    }
  }
  return o;
}

function canIngestStoreEvents() {
  return (
    readStoreSessionAuth() != null &&
    typeof wizardState.walletAddress === "string" &&
    wizardState.walletAddress.length > 0
  );
}

function flushStoreEventBacklog() {
  if (!canIngestStoreEvents()) return;
  if (storeRuntime.disabled || storeRuntime.finalized) return;
  if (storeEventBacklog.length === 0) return;
  const batch = storeEventBacklog;
  storeEventBacklog = [];
  let i = 0;
  for (; i < batch.length; i++) {
    if (storeRuntime.finalized || storeRuntime.disabled) {
      break;
    }
    appendToStoreIngestQueue(batch[i].eventType, batch[i].detail);
  }
  if (i < batch.length) {
    storeEventBacklog = batch.slice(i).concat(storeEventBacklog);
  }
}

function appendToStoreIngestQueue(eventType, detail) {
  const payloadDetail = toBrowserStoreEventDetail(eventType, detail);
  storeRuntime.queue = storeRuntime.queue
    .then(async () => {
      if (storeRuntime.disabled || storeRuntime.finalized) return;
      await ensureStoreUploadSession();
      if (!storeRuntime.session) {
        return;
      }
      await storeRuntime.session.ingestEvent(eventType, payloadDetail);
      updateStoreUploadProgressFromSession();
    })
    .catch((error) => {
      storeRuntime.disabled = true;
      const msg =
        error instanceof StoreError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
      setWizardStatus(`[Store] ${msg}`, "err");
    });
}

function queueStoreEvent(eventType, detail) {
  if (wizardState.step === 1 || !wizardState.sourceFile) {
    return;
  }
  if (storeRuntime.finalized) {
    return;
  }
  const backpressure =
    storeRuntime.disabled ||
    !canIngestStoreEvents();
  if (backpressure) {
    try {
      storeEventBacklog.push({
        eventType,
        detail: cloneStoreEventDetailForBacklog(detail),
      });
    } catch (e) {
      setWizardStatus(
        `[Store] Could not queue ${eventType}: ${e instanceof Error ? e.message : String(e)}`,
        "err",
      );
    }
    return;
  }
  appendToStoreIngestQueue(eventType, detail);
}

/**
 * Wait until `storeRuntime.queue` has no pending work. A single `await` can settle
 * before another `appendToStoreIngestQueue` extends the chain (microtask ordering).
 *
 * @param {number} maxPasses
 */
async function drainStoreIngestQueue(maxPasses = 500) {
  for (let pass = 0; pass < maxPasses; pass++) {
    flushStoreEventBacklog();
    const snapshot = storeRuntime.queue;
    await snapshot;
    flushStoreEventBacklog();
    if (wizardState.storageUploadActive && storeRuntime.session) {
      updateStoreUploadProgressFromSession();
    }
    if (storeRuntime.queue === snapshot) {
      return;
    }
  }
  throw new Error(
    "Upload queue did not finish draining — too many chained passes. Check your network, then try Refresh session key or start over.",
  );
}

async function finalizeStoreUpload() {
  if (storeRuntime.finalized) {
    return storeRuntime.finalizeResult;
  }
  if (readStoreSessionAuth() && storeRuntime.disabled) {
    storeRuntime.disabled = false;
  }
  wizardState.storeUploadPhaseNote = "";
  updateStoreUploadProgressFromSession();
  flushStoreEventBacklog();
  await drainStoreIngestQueue();
  await ensureStoreUploadSession();
  if (!storeRuntime.session) {
    const auth = readStoreSessionAuth();
    if (!auth) {
      throw new Error(
        "Store upload session not initialized — session key missing. Go back to Fund and authorize the upload session, then try Next again.",
      );
    }
    throw new Error(
      "Store upload session not initialized — an earlier segment failed before the store could start. This is often fixed automatically; if it persists, use Refresh session key on Fund then try Next again.",
    );
  }
  if (wizardState.storageUploadActive) {
    wizardState.storeUploadPhaseNote = STORE_PHASE_FINALIZE_NOTE;
    updateStoreUploadProgressFromSession();
    wizardState.storeUploadProgressPct = Math.max(
      wizardState.storeUploadProgressPct,
      90,
    );
    renderWizard();
  }
  const result = /** @type {StoreFinalizeResponse} */ (
    await storeRuntime.session.finalizeUpload()
  );
  storeRuntime.finalized = true;
  storeRuntime.finalizeResult = result;
  try {
    await storeRuntime.session.deleteUploadDatabase();
  } catch {
    /* ignore IDB cleanup errors */
  }
  return result;
}

async function resetStoreRuntime(abortRemote) {
  const previousSession = storeRuntime.session;
  const hadFinalized = storeRuntime.finalized;
  storeRuntime.uploadId = "";
  storeRuntime.assetId = "";
  storeRuntime.session = null;
  storeRuntime.initPromise = null;
  storeRuntime.queue = Promise.resolve();
  storeRuntime.disabled = false;
  storeRuntime.finalized = false;
  storeRuntime.finalizeResult = null;
  storeEventBacklog = [];
  if (abortRemote && previousSession && !hadFinalized) {
    try {
      await previousSession.deleteUploadDatabase();
    } catch {
      /* ignore */
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
  /** Synapse session key seed (hex); set after Fund-step authorize or from `sessionStorage`. */
  sessionPrivateKey: "",
  /**
   * FWSS permission hash → on-chain expiry (epoch seconds), as strings from storage or bootstrap.
   *
   * @type {StoreSessionExpirations | null}
   */
  sessionExpirations: null,
  /** EIP-1193 provider used for `loginSync` (same instance as connect). */
  eip1193Provider: null,
  sessionAuthBusy: false,
  /** @type {"idle" | "wallet" | "chain" | "session_sync"} */
  sessionAuthWaitPhase: "idle",
  sessionAuthError: null,
  fundingBusy: false,
  fundingReady: false,
  /** @type {string | null} */
  fundingError: null,
  fundingSummary: "",
  fundingTxHash: "",
  fundingCheckKey: "",
  /**
   * Inline confirmation UI (replaces native confirm). Copy-friendly text lines.
   *
   * @type {{ headline: string, lines: string[] } | null}
   */
  fundingPrompt: null,
  /**
   * Inline confirmation before session authorize (replaces native confirm).
   *
   * @type {{ headline: string, lines: string[], declineReason: string } | null}
   */
  setupConfirmPrompt: null,
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
  /** User clicked Define Next before transcode meta existed; step 4 shows progress until upload runs. */
  defineListingFlowPending: false,
  /** @type {unknown | null} parsed listing meta.json after Define → Next */
  publishedMeta: null,
  /** While `finalizeStoreUpload` runs — queue + on-chain commit. */
  storageUploadActive: false,
  storeUploadProgressPct: 0,
  /** PDP stats line from {@link computeStoreUploadProgressFromSession} (pieces, paths, segments). */
  storeUploadLabel: "",
  /** Short finalize phase hint shown after stats (e.g. draining queue, on-chain commit). */
  storeUploadPhaseNote: "",
  viewerDonateBusy: false,
  viewerDonateError: "",
  viewerDonateTxHash: "",
  /** PDP `meta.json` retrieval URL for Review iframe */
  reviewMetaJsonUrl: "",
};

/** @type {HTMLVideoElement | null} */
let videoEl = null;
/** @type {HTMLVideoElement | null} */
let sourcePreviewVideoEl = null;
/** @type {string | null} */
let sourcePreviewBoundKey = null;
/** @type {null | (() => void)} */
let variantListenerTeardown = null;

/** Avoid double finalize if flush runs from microtask + event. */
let listingFlowFinalizeStarted = false;

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

/** Coalesce rapid staging updates from the browser upload session (IDB + PDP store span many frames). */
let awaitStagingUiRefreshPending = false;
function scheduleAwaitStagingUiRefresh() {
  if (awaitStagingUiRefreshPending) return;
  awaitStagingUiRefreshPending = true;
  queueMicrotask(() => {
    awaitStagingUiRefreshPending = false;
    updateStoreUploadProgressFromSession();
  });
}

/**
 * @returns {{ pct: number, label: string } | null}
 */
function computeStoreUploadProgressFromSession() {
  const s = storeRuntime.session;
  if (!s) return null;
  const sum =
    typeof s.getStagingSummary === "function"
      ? s.getStagingSummary()
      : {
          pieceCount: s.piecesByCid.size,
          pathCount: s.fileMappings.length,
          pendingSegments: 0,
          bufferingBytes: 0,
          bufferingBytesMax: 0,
          flushGoalForLargestBytes: 0,
          pendingRungFlushes: 0,
          pdpUploadsInFlight: 0,
          pdpUploadsQueued: 0,
          unpiecedBlobCount: 0,
        };
  const pieceCount = sum.pieceCount;
  const inFlight = sum.pdpUploadsInFlight ?? 0;
  const queuedUploads = sum.pdpUploadsQueued ?? 0;
  const pendingSegments = sum.pendingSegments;
  const unpieced = sum.unpiecedBlobCount ?? 0;
  const ps = pieceCount === 1 ? "" : "s";
  const label = `${pieceCount} PDP piece${ps} finished · ${inFlight} HTTP upload(s) in flight · ${queuedUploads} upload(s) queued · ${pendingSegments} segment(s) in local buffers`;
  /** No PDP upload % until transcode is done and every ladder buffer has been flushed into pieces. */
  const pieceAssemblyDone =
    wizardState.progress >= 100 &&
    s.transcodeCompleteReceived === true &&
    unpieced === 0 &&
    pendingSegments === 0;
  let pct = 0;
  if (pieceAssemblyDone) {
    if (pieceCount === 0 && inFlight === 0 && queuedUploads === 0) {
      pct = 100;
    } else {
      const targetPieces = Math.max(1, pieceCount + inFlight + queuedUploads);
      pct = Math.min(100, Math.floor((100 * pieceCount) / targetPieces));
    }
  }
  return { label, pct };
}

function updateStoreUploadProgressFromSession() {
  if (!wizardState.storageUploadActive && wizardState.step !== 4) return;
  const u = computeStoreUploadProgressFromSession();
  if (u) {
    wizardState.storeUploadLabel = u.label;
    wizardState.storeUploadProgressPct = u.pct;
  }
  renderWizard();
}

function tryMergePlaybackIntoPublishedMeta(masterUrl) {
  if (!masterUrl || !wizardState.publishedMeta || typeof wizardState.publishedMeta !== "object") {
    return;
  }
  const m = /** @type {Record<string, unknown>} */ (wizardState.publishedMeta);
  wizardState.publishedMeta = {
    ...m,
    playback: {
      ...(typeof m.playback === "object" && m.playback !== null && !Array.isArray(m.playback)
        ? /** @type {Record<string, unknown>} */ (m.playback)
        : {}),
      masterAppUrl: masterUrl,
    },
  };
}

async function releaseLocalEncodePreviewPlayer() {
  if (variantListenerTeardown) {
    variantListenerTeardown();
    variantListenerTeardown = null;
  }
  await destroyActivePipelinePlayer();
  wizardState.player = null;
  wizardState.playingResolution = "";
  wizardState.streamMode = "auto";
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

/**
 * Shows inline copy-friendly confirm UI; on cancel, aborts setup with `declineReason`.
 *
 * @param {string} message
 * @param {string} declineReason
 * @returns {Promise<boolean>}
 */
function confirmSetupActionOrAbort(message, declineReason) {
  return new Promise((resolve) => {
    wizardState.setupConfirmPrompt = {
      headline: message,
      lines: [],
      declineReason,
    };
    setupConfirmResolve = resolve;
    renderWizard();
  });
}

function handleSetupConfirmContinue() {
  if (!setupConfirmResolve) return;
  const r = setupConfirmResolve;
  setupConfirmResolve = null;
  wizardState.setupConfirmPrompt = null;
  renderWizard();
  r(true);
}

async function handleSetupConfirmCancel() {
  if (!setupConfirmResolve) return;
  const r = setupConfirmResolve;
  const declineReason =
    wizardState.setupConfirmPrompt?.declineReason ??
    "Session-key authorization declined. Upload canceled.";
  setupConfirmResolve = null;
  wizardState.setupConfirmPrompt = null;
  r(false);
  await abortUploadSetupFlow(declineReason);
}

async function handleAuthorizeSession() {
  if (!wizardState.eip1193Provider || !wizardState.walletAddress) return;
  const confirmed = await confirmSetupActionOrAbort(
    "Authorize a 1-hour upload session key now? If you decline, this upload will be canceled.",
    "Session-key authorization declined. Upload canceled.",
  );
  if (!confirmed) {
    return;
  }
  wizardState.sessionAuthBusy = true;
  wizardState.sessionAuthWaitPhase = "wallet";
  wizardState.sessionAuthError = null;
  renderWizard();
  try {
    const { sessionPrivateKey, sessionExpirations } =
      await authorizeSessionKeyForUpload(
        wizardState.eip1193Provider,
        wizardState.walletAddress,
        {
          onTransactionSubmitted: () => {
            wizardState.sessionAuthWaitPhase = "chain";
            renderWizard();
          },
          afterLoginSync: () => {
            wizardState.sessionAuthWaitPhase = "session_sync";
            renderWizard();
          },
        },
      );
    wizardState.sessionPrivateKey = sessionPrivateKey;
    wizardState.sessionExpirations = sessionExpirations;
    resetFundingGateState();
    const cfg = getFilstreamStoreConfig();
    saveSessionKeyToStorage({
      rootAddress: wizardState.walletAddress,
      chainId: cfg.storeChainId,
      sessionPrivateKey,
      sessionExpirations,
    });
    storeRuntime.disabled = false;
    flushStoreEventBacklog();
    maybeAutoAdvanceFromFund();
  } catch (e) {
    wizardState.sessionAuthError = e instanceof Error ? e.message : String(e);
    wizardState.sessionPrivateKey = "";
    wizardState.sessionExpirations = null;
    resetFundingGateState();
  } finally {
    wizardState.sessionAuthBusy = false;
    wizardState.sessionAuthWaitPhase = "idle";
    renderWizard();
  }
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
    wizardState.defineListingFlowPending = true;
    wizardState.defineNextError = "";
    await releaseLocalEncodePreviewPlayer();
    wizardState.step = 4;
    setWizardStatus(
      "Transcode still running — segment upload starts once Fund step completes (wallet + session key + funding check). Listing metadata and final commit continue after encode finishes.",
      "",
    );
    scheduleListingFlowWhenTranscodeReady();
    renderWizard();
    return;
  }

  await releaseLocalEncodePreviewPlayer();
  wizardState.step = 4;
  await runFinalizeAfterListingDetail(detail);
}

/** @type {(() => void) | null} */
let eip6963Unsub = null;

function ensureInjectedWalletSubscription() {
  if (eip6963Unsub) return;
  eip6963Unsub = subscribeInjectedWallets((list) => {
    wizardState.injectedWallets = list;
    attemptRestoreWalletFromStorage(list);
    renderWizard();
  });
}

function handleRefreshWallets() {
  requestInjectedProviders();
}

async function handleRetryFundingCheck() {
  if (wizardState.step !== 2) return;
  if (wizardState.fundingPrompt && fundingPromptResolve) {
    const r = fundingPromptResolve;
    fundingPromptResolve = null;
    wizardState.fundingPrompt = null;
    r(false);
    if (fundingPreflightPromise) {
      await fundingPreflightPromise;
    }
  }
  await ensureFundingPreparedForCurrentUpload(true);
}

function handleFundingPromptContinue() {
  if (!fundingPromptResolve) return;
  const r = fundingPromptResolve;
  fundingPromptResolve = null;
  wizardState.fundingPrompt = null;
  wizardState.fundingBusy = true;
  renderWizard();
  r(true);
}

async function handleFundingPromptCancel() {
  if (!fundingPromptResolve) return;
  const r = fundingPromptResolve;
  fundingPromptResolve = null;
  wizardState.fundingPrompt = null;
  r(false);
  await abortUploadSetupFlow("Funding authorization declined. Upload canceled.");
}

/**
 * @param {{ request: (a: { method: string, params?: unknown[] }) => Promise<unknown> }} provider
 * @param {{ uuid: string, name: string }} info
 */
async function handleConnectInjected(provider, info) {
  wizardState.walletBusy = true;
  wizardState.connectingUuid = info.uuid;
  wizardState.walletError = null;
  resetFundingGateState();
  renderWizard();
  try {
    const addr = await connectInjectedProvider(provider);
    wizardState.walletAddress = addr;
    wizardState.connectedWalletName = info.name;
    wizardState.eip1193Provider = addr ? provider : null;
    if (addr) {
      saveWalletToStorage({
        address: addr,
        walletUuid: info.uuid,
        walletName: typeof info.name === "string" ? info.name : "",
      });
      if (!tryApplyStoredSession(addr)) {
        wizardState.sessionPrivateKey = "";
        wizardState.sessionExpirations = null;
        resetFundingGateState();
      }
    } else {
      wizardState.eip1193Provider = null;
    }
    if (!addr) wizardState.walletError = "No account returned from the wallet.";
  } catch (e) {
    wizardState.walletError = e instanceof Error ? e.message : String(e);
    wizardState.walletAddress = null;
    wizardState.connectedWalletName = null;
    wizardState.eip1193Provider = null;
  } finally {
    wizardState.walletBusy = false;
    wizardState.connectingUuid = null;
    maybeAutoAdvanceFromFund();
    renderWizard();
  }
}

function handleDisconnectWallet() {
  storeEventBacklog = [];
  wizardState.walletAddress = null;
  wizardState.connectedWalletName = null;
  wizardState.walletError = null;
  wizardState.eip1193Provider = null;
  wizardState.sessionPrivateKey = "";
  wizardState.sessionExpirations = null;
  wizardState.sessionAuthBusy = false;
  wizardState.sessionAuthWaitPhase = "idle";
  wizardState.sessionAuthError = null;
  resetFundingGateState();
  clearSessionKeyFromStorage();
  clearWalletFromStorage();
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
            aria-label="FilStream — CalibrationNet edition"
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
              <span class="site-brand-tagline">CalibrationNet edition</span>
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
            <li class=${stepClass(5)}>5 · Review</li>
          </ol>
        </div>

        <div class="hero-stage">
          ${wizardState.step === 1
            ? html`
                <h1>Store your video as streamable on the Filecoin chain.</h1>
                <p class="hero-price-estimate">
                  Estimated price: $0.15 per 10 minutes of 1080p video.
                  Estimated time: 1/3 of the movie run length, plus 1 minute.
                </p>
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
                        <h2 id="publish-broadcast-title" class="publish-broadcast-head">Review</h2>
                        ${broadcastViewTemplate({
                          meta: broadcastPreviewMeta(),
                          videoEl: v,
                          reviewIframeSrc: wizardState.reviewMetaJsonUrl
                            ? buildReviewViewerIframeSrc(wizardState.reviewMetaJsonUrl)
                            : null,
                          uploadDateLabel: (() => {
                            const when = formatUploadDateLabel(broadcastPreviewMeta());
                            return when ? `Uploaded ${when}` : null;
                          })(),
                          downloadSourceFile: null,
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
                  injectedWallets: wizardState.injectedWallets,
                  walletAddress: wizardState.walletAddress,
                  connectedWalletName: wizardState.connectedWalletName,
                  walletBusy: wizardState.walletBusy,
                  walletError: wizardState.walletError,
                  connectingUuid: wizardState.connectingUuid,
                  onConnectInjected: handleConnectInjected,
                  onDisconnectWallet: handleDisconnectWallet,
                  onRefreshWallets: handleRefreshWallets,
                  sessionAuthReady: fundStepSessionAuthReady(),
                  sessionAuthBusy: wizardState.sessionAuthBusy,
                  sessionAuthWaitPhase: wizardState.sessionAuthWaitPhase,
                  sessionAuthError: wizardState.sessionAuthError,
                  sessionExpiresSummary: sessionExpiresSummary(),
                  fundingReady: wizardState.fundingReady,
                  fundingBusy: wizardState.fundingBusy,
                  fundingError: wizardState.fundingError,
                  fundingSummary: wizardState.fundingSummary,
                  fundingTxHash: wizardState.fundingTxHash,
                  canAuthorizeSession: Boolean(
                    wizardState.walletAddress && wizardState.eip1193Provider,
                  ),
                  onAuthorizeSession: handleAuthorizeSession,
                  onRetryFundingCheck: handleRetryFundingCheck,
                  fundingPrompt: wizardState.fundingPrompt,
                  onFundingPromptContinue: handleFundingPromptContinue,
                  onFundingPromptCancel: handleFundingPromptCancel,
                  setupConfirmPrompt: wizardState.setupConfirmPrompt,
                  onSetupConfirmContinue: handleSetupConfirmContinue,
                  onSetupConfirmCancel: handleSetupConfirmCancel,
                })}
                ${convertProgressPanel({
                  show: wizardState.step < 5,
                  phase: computeWizardConvertPhase(),
                  fileName:
                    wizardState.step === 2 ? "" : wizardState.fileName,
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
                    wizardState.step === 4 &&
                    wizardState.progress >= 100 &&
                    !wizardState.defineListingFlowPending,
                  awaitListingTitle: wizardState.publishTitle,
                  awaitListingDescription: wizardState.publishDescription,
                  awaitPosterUrl: wizardState.posterObjectUrl,
                  awaitUploadBannerText: "Upload in progress",
                  awaitCommitHighlight: (() => {
                    if (wizardState.step !== 4) return null;
                    if (!wizardState.storageUploadActive) return null;
                    const n = wizardState.storeUploadPhaseNote?.trim() ?? "";
                    return n === STORE_PHASE_FINALIZE_NOTE ? n : null;
                  })(),
                  awaitPipelineBars: (() => {
                    if (wizardState.step !== 4) return null;
                    if (wizardState.storageUploadActive) {
                      const n = wizardState.storeUploadPhaseNote?.trim() ?? "";
                      if (n === STORE_PHASE_FINALIZE_NOTE) return null;
                    }
                    const s = storeRuntime.session;
                    const rungN = wizardState.rungs?.length ?? 0;
                    const transcodeDetail =
                      rungN > 0
                        ? ""
                        : "";

                    const sum =
                      s && typeof s.getStagingSummary === "function"
                        ? s.getStagingSummary()
                        : null;

                    let uploadDetail = "";
                    if (sum) {
                      const pc = sum.pieceCount;
                      const fly = sum.pdpUploadsInFlight ?? 0;
                      const queued = sum.pdpUploadsQueued ?? 0;
                      uploadDetail = `${pc} pieces · ${fly} in flight · ${queued} queued`;
                    } else {
                      uploadDetail = s ? "" : "";
                    }

                    const computed = computeStoreUploadProgressFromSession();
                    let uploadPct = 0;
                    let uploadPhaseNote = "";
                    if (wizardState.storageUploadActive) {
                      uploadPct = wizardState.storeUploadProgressPct;
                      uploadPhaseNote =
                        wizardState.storeUploadPhaseNote?.trim() ?? "";
                    } else if (computed) {
                      uploadPct = computed.pct;
                    }
                    return {
                      transcodePct: wizardState.progress,
                      transcodeDetail,
                      uploadPct,
                      uploadDetail,
                      ...(uploadPhaseNote ? { uploadPhaseNote } : {}),
                    };
                  })(),
                  storageUpload:
                    wizardState.storageUploadActive &&
                    wizardState.step !== 4
                      ? {
                          pct: wizardState.storeUploadProgressPct,
                          label: (() => {
                            const a = wizardState.storeUploadLabel.trim();
                            const b = wizardState.storeUploadPhaseNote.trim();
                            if (a && b) return `${a} · ${b}`;
                            return a || b;
                          })(),
                        }
                      : null,
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
  fundingPreflightPromise = null;
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
  wizardState.walletError = null;
  wizardState.walletBusy = false;
  wizardState.connectingUuid = null;
  wizardState.sessionAuthBusy = false;
  wizardState.sessionAuthWaitPhase = "idle";
  wizardState.sessionAuthError = null;
  resetFundingGateState();
  wizardState.debugSaveBusy = false;
  wizardState.publishTitle = "";
  wizardState.publishDescription = "";
  wizardState.showDonateButton = false;
  wizardState.donateAmountUsdfc = 1;
  wizardState.publishedMeta = null;
  wizardState.storageUploadActive = false;
  wizardState.storeUploadProgressPct = 0;
  wizardState.storeUploadLabel = "";
  wizardState.storeUploadPhaseNote = "";
  wizardState.viewerDonateBusy = false;
  wizardState.viewerDonateError = "";
  wizardState.viewerDonateTxHash = "";
  wizardState.reviewMetaJsonUrl = "";
  if (wizardState.posterObjectUrl) {
    URL.revokeObjectURL(wizardState.posterObjectUrl);
    wizardState.posterObjectUrl = null;
  }
  wizardState.posterImageFile = null;
  wizardState.defineNextBusy = false;
  wizardState.defineNextError = "";
  wizardState.defineListingFlowPending = false;
  listingFlowFinalizeStarted = false;
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
  resetFundingGateState();
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
  maybeAutoAdvanceFromFund();
  renderWizard();

  runFilstreamPipeline(file, {
    setStatus: setWizardStatus,
    setProgress: setWizardProgress,
    getVideoElement: ensureVideoEl,
    filstreamEventTarget: filstreamEvents.filstreamEventTarget,
    onPlaybackReady: (p, info) => {
      wizardState.rungs = info.rungs.map((r) => ({
        width: r.width,
        height: r.height,
        bandwidth: r.bandwidth,
      }));
      if (wizardState.step === 4) {
        void releaseLocalEncodePreviewPlayer().then(() => renderWizard());
        return;
      }
      wizardState.player = p;
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
