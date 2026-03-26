# filstream

## Documentation Map

- [`web/README.md`](web/README.md): Go static server + local dev.
- [`web/statics/filstream-config.mjs`](web/statics/filstream-config.mjs): upload settings (`window.__FILSTREAM_CONFIG__`) with Calibration-oriented defaults.
- [`web/statics/env.example`](web/statics/env.example): field names and mapping from legacy `STORE_*` vars.
- [`web/bundle-synapse/`](web/bundle-synapse/): rebuild `statics/vendor/synapse-browser.mjs` after SDK upgrades.

## Runtime Overview

- `web/` (Go): serves `statics/` for the wizard UI (`POST /api/debug-hls` for optional HLS debug dumps).
- **Synapse upload runs in the browser** via [`web/statics/browser-store.mjs`](web/statics/browser-store.mjs) and [`web/statics/vendor/synapse-browser.mjs`](web/statics/vendor/synapse-browser.mjs).

See [`web/README.md`](web/README.md).

## Current Storage Model

- Browser does transcode + segment generation.
- Encoder events feed an in-page upload session (`segmentready`, `segmentflush`, `fileEvent`, `transcodeComplete`, `listingDetails`).
- Packed media is staged in **IndexedDB**, streamed to Synapse `store()` as a `ReadableStream`; each segment row is removed after it is read.
- Finalize rewrites playlists, stores manifest-side artifacts, then `commit()` in bounded batches.
- Dataset model: one dataset per client / provider / `FILSTREAM-ID` metadata tuple.

## Session init (browser)

The UI calls `createBrowserUploadSession({ assetId, clientAddress, sessionPrivateKey, sessionExpirations })` when the first store-bound event is queued. Public RPC/chain/provider settings use [`filstream-config.mjs`](web/statics/filstream-config.mjs) defaults unless you set `window.__FILSTREAM_CONFIG__` in [`web/statics/index.html`](web/statics/index.html) (see [`web/statics/env.example`](web/statics/env.example)).

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
