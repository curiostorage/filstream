# FilStream

**FilStream brings Web3’s freedoms and possibilities to every skill level in the video space.** You get a full, in-browser path from your files to on-chain storage and shareable playback—without surrendering custody to a platform’s terms or a single company’s roadmap. The experience is intentionally approachable: connect a wallet, walk through the upload flow, and ship video the same way you’d expect from a modern web app, while the plumbing underneath is Filecoin Onchain Cloud (FOC), Synapse, and open protocols.

**It also works as a flagship product:** a real, end-to-end app that stress-tests the stack and surfaces concrete needs in the **FOC ecosystem**—storage, payments, sessions, metadata, and UX—so developers and the community can see what “video on FOC” actually requires in practice.

**It runs on modern devices.** The site is a static, responsive front end (`docs/` on GitHub Pages): phones, tablets, and desktops with current browsers can use the upload wizard and the lightweight viewer. No native install; no server-side app code in your path for day-to-day use.

---

Live site: [https://curiostorage.github.io/filstream/](https://curiostorage.github.io/filstream/)

They’re your movies. Share them with the world without a gatekeeper company or a single vendor’s ToS—storage and links are anchored in open, verifiable infrastructure. The demo flow uses **tUSDFC** in a browser wallet (e.g. MetaMask) on Calibration.

---

## What this is (design)

- **Browser-first pipeline:** Transcoding and segmentation run in the page; encoder output feeds an upload session that stages packed media in **IndexedDB** and streams it to Synapse `store()` as a `ReadableStream`. You stay in one tab for encode → fund → store.
- **Wallet + session model:** The root account is your **client** account; **session keys** sign upload operations with scoped expiry and permissions—so the UX can be smooth without putting long-lived keys in hot paths.
- **Static + config-driven:** Pages ship as static HTML/JS/CSS; public RPC, chain, provider, and viewer base URL come from **`window.__FILSTREAM_CONFIG__`** (defaults in [`docs/filstream-config.mjs`](docs/filstream-config.mjs)), aligned with Filecoin Calibration.
- **Shareable playback:** Published links use the static viewer: `viewer.html?meta=<absolute-https-url-to-meta.json>` so anyone with the URL can play back without your app server.
- **Creator + catalog:** The repo includes a creator flow and shared catalog/metadata helpers so publishing and discovery stay coherent with the upload path.

---

## What this is (implementation map)

| Area | Role |
|------|------|
| [`docs/ui.mjs`](docs/ui.mjs) + [`docs/upload-configure.mjs`](docs/upload-configure.mjs) | Upload wizard UI, wallet/EIP-6963 wiring, step flow |
| [`docs/core.mjs`](docs/core.mjs) | Encode/segment pipeline feeding the store session |
| [`docs/browser-store.mjs`](docs/browser-store.mjs) | IndexedDB staging, Synapse session, streaming `store()` |
| [`docs/vendor/synapse-browser.mjs`](docs/vendor/synapse-browser.mjs) | Bundled Synapse SDK for the browser (rebuild via [`bundle-synapse/`](bundle-synapse/)) |
| [`docs/viewer/`](docs/viewer/) + [`docs/viewer.html`](docs/viewer.html) | Static playback UI |
| [`docs/filstream-config.mjs`](docs/filstream-config.mjs) | Public upload defaults (`__FILSTREAM_CONFIG__`) |
| [`docs/env.example`](docs/env.example) | Field names and legacy `STORE_*` mapping |
| [`main.go`](main.go) | Tiny static file server for local dev (`docs/` → `http://localhost:8080`) |

---

## Documentation Map

- [`docs/filstream-config.mjs`](docs/filstream-config.mjs): upload settings (`window.__FILSTREAM_CONFIG__`) with Calibration-oriented defaults.
- [`docs/env.example`](docs/env.example): field names and mapping from legacy `STORE_*` vars.
- [`bundle-synapse/`](bundle-synapse/): rebuild `docs/vendor/synapse-browser.mjs` after SDK upgrades.

## Local dev (Go)

From the repo root:

```bash
go run .
```

Serves [`docs/`](docs/) at `http://localhost:8080` (landing at `/`, upload wizard at `/upload.html`, static viewer at `/viewer.html`).

**Synapse upload runs in the browser** via [`docs/browser-store.mjs`](docs/browser-store.mjs) and [`docs/vendor/synapse-browser.mjs`](docs/vendor/synapse-browser.mjs).

## GitHub Pages

The [`docs/`](docs/) folder is the published site root for `https://curiostorage.github.io/filstream/`. Shared playback links use `viewer.html?meta=<absolute-https-url-to-meta.json>`.

## Runtime Overview

- Browser transcode + segment generation; encoder events feed an in-page upload session.
- Packed media is staged in **IndexedDB**, streamed to Synapse `store()` as a `ReadableStream`.

## Session init (browser)

The UI calls `createBrowserUploadSession({ assetId, clientAddress, sessionPrivateKey, sessionExpirations })` when the first store-bound event is queued. Public RPC/chain/provider settings use [`filstream-config.mjs`](docs/filstream-config.mjs) defaults unless you set `window.__FILSTREAM_CONFIG__` in [`docs/upload.html`](docs/upload.html) (see [`docs/env.example`](docs/env.example)).

Rules:

- `clientAddress` is the root client account for Synapse `account`.
- `sessionPrivateKey` is only for session signing, not the root account.
- `sessionExpirations` must be supplied by the frontend session flow.
- Frontend owns session login, funding, and expiry; the page must have a valid session before upload.

## Funding Model (browser)

- Funding is handled once in **Fund (step 2)** before any transcode/store processing starts.
- Frontend runs `synapse.storage.prepare({ dataSize, context })` for the selected file.
- Funding target is:
  - `target = max(5 USDFC, ceil(120% of prepare().costs.depositNeeded))`
- Frontend checks `payments.balance()` and only tops up the shortfall:
  - `amount = max(0, target - availableFunds)`
- FWSS approval uses `prepare().costs.needsFwssMaxApproval`.
- `payments.fundSync(...)` runs only when top-up or approval is required.
- There is no extra funding prompt during encoding/upload for that same run.

## Remaining Work

### Frontend work required for in-browser Synapse upload to succeed

1. DONE Add a real session bootstrap on wallet-connect. This creates or restores session key material, run session login + funding init in frontend, and build the expiration map for required FWSS permissions.
2. DONE Keep session validity logic on frontend by checking expiry before upload init and renewing or re-logging session when expired or near expiry.
3. Add clear UX for init/store failures (403 session permissions, IndexedDB quota, RPC errors).
4. Figure out what ASSET ID should be.
5. Review DataSet and Piece Metadata models.
