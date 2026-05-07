# Potential FilStream Projects

Filtered for FilStream's deploy surface:

- a static GitHub-Pages bundle (`docs/`),
- PDP storage via Synapse,
- the on-chain reads/writes Synapse already does through the glif RPC indexers.

Anything that would need a backend, queue worker, push gateway, or third-party SaaS is demoted into "Borderline" or "Doesn't fit cleanly". Within each tier, projects are ordered by how cheaply they could ship today.

## Bolder static-native bets

### 1. Local AI Text Detection & Cut-File Generator

Load an OCR / vision model in the browser, sample frames from the selected video, detect on-screen text, and produce a creator-editable cut file before upload. The output could be a FilStream JSON edit-decision list, WebVTT chapters, or an FFmpeg-compatible sidecar that says:

- where text appears,
- what text was detected,
- confidence,
- suggested cuts or chapter boundaries,
- suggested blur/redaction windows.

This stays inside the no-new-service rule if the model is shipped as static assets or fetched from PDP, runs through WebGPU/WASM in the browser, and stores only the resulting metadata in IndexedDB/PDP. The caveat is weight and device variance: model download size, slow phones, Safari support, and battery use become product concerns.

Useful first version: scan one frame every 1-2 seconds, detect title cards / slides / lower thirds, let the creator review timestamps, then export `cuts.json` into the upload manifest. Later versions could add face/logo detection, automatic chapter generation, redaction suggestions, and "skip intro / skip credits" metadata.

## Strong fit — pure static + PDP + on-chain


### 3. Better Discovery on Catalog Data

Tags, categories, duration filters, sorted feeds, and substring search over the cached `CatalogRegistry` rows. The Discover sidebar already pages through `loadCachedCatalogEntries`; this is mostly UI and a few extra indexable fields in `manifest.json`.

### 4. Local Subscriptions

Track followed creator wallet addresses in localStorage, surface a "Subscribed" rail on Discover, and badge new uploads using the existing `syncCatalogOnce` poll. No account service.

### 5. Resumable PDP Upload Queue

Pause, resume, and recover long PDP uploads from IndexedDB after tab crashes, network drops, or session-key expiry. Pure client state plus the existing Synapse upload path.

### 6. Draft Recovery for Uploads

Persist titles, descriptions, posters, encoded segments, and progress in IndexedDB so creators can return on another tab or after a crash and resume the wizard.

### 7. Offline Creator Workspace

Stage titles, descriptions, posters, chapters, and playlists before a wallet is connected. Submits in one batch once a session key is authorized.

### 8. Upload ETA & Cost Planner

Estimate upload time, encoding time, browser storage needs, and Filecoin USDFC cost before the creator commits. All math runs locally against `getFilstreamStoreConfig` plus Synapse pricing.

### 9. Video Quality Preview Before Upload

In-browser encoding already happens; surface poster frames, motion thumbnails, and the generated `manifest.json` before the creator commits storage.

### 10. Chapters, Captions, Transcripts

Reference VTT/JSON sidecars from the PDP `manifest.json`. Shaka already supports text tracks, so playback wires up without new infra.

### 11. Creator Playlists & Series

Store playlist manifests in PDP and reference them via either an extra `manifest.json` block or a sibling on-chain registry. Fits the existing `CatalogRegistry` pattern.

### 12. Embeddable Channel Widgets

Extend today's `view/?embed=true` with `?embed=channel`, `?embed=playlist`, and `?embed=donate` modes. Static iframes only.

### 13. Creator-Controlled Ads / Sponsor Slots

Let creators attach PDP-hosted pre-rolls, sponsor cards, or mid-roll metadata inside their manifest. Player handles them client-side; no ad network.

### 14. PDP Health & Retrieval Badges

Probe piece availability, provider info, last-verified time, and dataset health from the browser using existing Synapse helpers. Pure read-side.

### 15. YouTube Metadata Import Tool

Parse a creator's YouTube takeout / channel JSON in-browser and pre-fill the upload wizard. No third-party API call.

### 16. Creator Analytics from Local & Public Signals

Local upload history, on-chain catalog deltas, file sizes, dataset spend. Privacy-preserving and computed in the browser from data the creator already has access to.

### 17. Collaborative Publishing Permissions

Lean on the existing session-key flow (`authorizeSessionKeyForUpload`, `setMyUsername`, `deleteEntry`) to authorize specific addresses for upload, delete, profile edit, or playlist management. All on-chain.

## Borderline — fits with a clear caveat

### 18. Scheduled Publishing

"Publish later" cannot fire a chain write while the tab is closed (no worker, no cron service). Reframe as: drafts live in IndexedDB, plus an optional "auto-publish when this tab is open at time T" mode. True wall-clock scheduling needs a server.

### 19. Private / Unlisted Videos

Unlisted (off-catalog, manifest only, share-link discovery) is trivial. Wallet-gated playback needs a key-wrapping scheme (per-viewer wallet → content key) that creators must manage manually; doable but UX-heavy and easy to misuse.

### 20. Signed Comments & Reactions

Wallet-signed payloads are easy. Discovery without an indexer is the hard part. Two paths that stay in-scope:

- ship a small `CommentsRegistry` contract so reads piggy-back on the same glif/RPC pattern as the catalog, or
- accept "creator-curated comments only" — a creator publishes an aggregated comments PDP object referenced from `manifest.json`.

Skip if neither tradeoff is acceptable.

## Doesn't fit cleanly — would need extra infra

### 21. Static Creator Feeds (RSS / JSON)

RSS readers don't run JavaScript, so feed XML must be served as static content. Options:

- pre-build feeds in CI from the on-chain catalog (stale until next deploy), or
- run a tiny renderer that reads on-chain state and serves XML (a server).

JSON-feed-rendered-by-a-FilStream-tab is fine for FilStream-aware viewers but doesn't replace real RSS. Drop or downgrade unless we're willing to add a build step or service.
