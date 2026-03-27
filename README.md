# filstream

A whole movie upload site at [https://curiostorage.github.io/filstream/](https://curiostorage.github.io/filstream/).
They're your movies. 
Share movies with the world without a Terms of Service nor a gatekeeper company, and in a company-independent way.
Requires tUSDFC in a browser-wallet (Metamask).

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
