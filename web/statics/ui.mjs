/**
 * Wizard shell — edit and refresh; no `npm run build`.
 * Wallet/configure: `upload-configure.mjs`. Transcode + preview: `convert-progress.mjs`. Pipeline: `core.mjs`.
 */
import { html, render } from "https://cdn.jsdelivr.net/npm/lit-html@3.2.1/+esm";
import { applyStreamMode, convertProgressPanel } from "./convert-progress.mjs";
import {
  hasDebugHlsSnapshot,
  probeVideoEncoderHardwareAcceleration,
  resetFilstreamPlayback,
  runFilstreamPipeline,
  uploadDebugHlsToServer,
} from "./core.mjs";
import {
  connectInjectedProvider,
  requestInjectedProviders,
  subscribeInjectedWallets,
} from "./eip6963.mjs";
import { uploadConfigurePanel } from "./upload-configure.mjs";

const wizardState = {
  step: 1,
  fileName: "",
  statusMsg: "",
  statusKind: "",
  progress: 0,
  /** @type {Array<{ info: { uuid: string, name: string, icon: string, rdns: string }, provider: { request: (a: { method: string, params?: unknown[] }) => Promise<unknown> } }>} */
  injectedWallets: [],
  /** @type {string | null} */
  walletAddress: null,
  /** @type {string | null} */
  connectedWalletName: null,
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
};

/** @type {HTMLVideoElement | null} */
let videoEl = null;
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
            <li class=${stepClass(2)}>2 · Prepare</li>
            <span class="sep" aria-hidden="true">→</span>
            <li class=${stepClass(3)}>3 · Watch</li>
          </ol>
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
                      href="https://download.blender.org/peach/bigbuckbunny_movies/big_buck_bunny_1080p_stereo.avi"
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
                      onWizardFileChosen(f);
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
                            onWizardFileChosen(f);
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

        ${wizardState.step >= 2
          ? html`
              <div class="step2-stack">
                ${uploadConfigurePanel({
                  show: true,
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
                })}
                ${convertProgressPanel({
                  show: true,
                  phase: wizardState.step === 2 ? "encoding" : "playback",
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
                  showDebugSave: wizardState.step === 3,
                  debugSaveBusy: wizardState.debugSaveBusy,
                  onDebugSave: handleDebugSave,
                })}
              </div>
            `
          : null}
      </main>
    `,
    root,
  );
}

async function wizardGoBackToChoose() {
  await resetFilstreamPlayback();
  if (variantListenerTeardown) {
    variantListenerTeardown();
    variantListenerTeardown = null;
  }
  const el = ensureVideoEl();
  el.removeAttribute("src");
  el.load();
  wizardState.step = 1;
  wizardState.fileName = "";
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
  renderWizard();
}

async function wizardStartOver() {
  await wizardGoBackToChoose();
}

function onWizardFileChosen(file) {
  if (!file) return;
  if (!file.type.startsWith("video/")) {
    wizardState.statusMsg = "Please choose a video file.";
    wizardState.statusKind = "err";
    wizardState.step = 1;
    renderWizard();
    return;
  }
  wizardState.fileName = file.name;
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
    onPlaybackReady: (p, info) => {
      wizardState.player = p;
      wizardState.rungs = info.rungs.map((r) => ({
        width: r.width,
        height: r.height,
        bandwidth: r.bandwidth,
      }));
      wizardState.streamMode = "auto";
      wizardState.step = 3;
      attachVariantResolutionListener(p);
      renderWizard();
    },
  }).catch((e) => {
    setWizardStatus(e.message || String(e), "err");
  });
}

ensureInjectedWalletSubscription();
renderWizard();
void probeVideoEncoderHardwareAcceleration();
