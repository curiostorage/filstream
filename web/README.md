# FilStream web (static server)

The Go binary serves `statics/` and `POST /api/debug-hls`. **Uploads use in-browser Synapse** (`statics/browser-store.mjs`); there is no Node store or `/api/store` proxy.

Related docs:

- [`../README.md`](../README.md) for repo overview.
- [`statics/filstream-config.mjs`](statics/filstream-config.mjs) and [`statics/env.example`](statics/env.example) for RPC/chain/provider defaults and overrides.

Video pick → transcode → HLS (fMP4) → playback runs **entirely in the browser**. **Mediabunny** and **Shaka Player** load from public CDNs in `statics/core.mjs`. The **UI** is `statics/ui.mjs` (lit-html from jsDelivr). **Synapse** is bundled in `statics/vendor/synapse-browser.mjs`; rebuild from [`bundle-synapse`](bundle-synapse) when upgrading SDK versions.

Output uses **hardware H.264** when supported, else **VP9**, plus **Opus** when the source has audio; ladder **1080 / 720 / 360 / 144** (1080 omitted if max dimension &lt; 1200), two parallel encodes, HLS multivariant with blob URLs + a request filter.

**CSP / network:** Mediabunny and Shaka load from **`esm.sh`**. Serve **`statics/`** as the site root (e.g. `npx serve statics -l 3000`). If a dev server resolves local `node_modules/mediabunny` under `web/`, you can hit `node:fs` errors — use **`statics/`** as root instead.

## Run (local dev)

```bash
cd web
go run .
```

Open http://localhost:8080

Upload settings default to Filecoin Calibration in `filstream-config.mjs`. Override with `window.__FILSTREAM_CONFIG__` before `ui.mjs` loads (`statics/index.html` or `statics/env.example`).

Funding behavior in the wizard:

- Step 2 (`Fund`) performs a single upfront `storage.prepare(...)`.
- It computes:
  - `target = max(5 USDFC, ceil(120% of prepare().costs.depositNeeded))`
  - `shortfall = max(0, target - payments.balance())`
- It calls `payments.fundSync(...)` only if needed:
  - `amount = shortfall`
  - `needsFwssMaxApproval = prepare().costs.needsFwssMaxApproval ?? false`
- Encode/store starts only after this completes.

## Environment

| Variable | Purpose |
|----------|---------|
| `PORT` | Go server listen port (default `:8080`) |
| Browser `__FILSTREAM_CONFIG__` | Optional overrides; see `statics/filstream-config.mjs` |
