# FilStream web (static + store proxy)

The Go binary serves `statics/` and proxies `/api/store/*` to the Node store service (default `http://127.0.0.1:8090` via `STORE_BASE_URL`).

Related docs:

- [`../README.md`](../README.md) for repo overview and navigation.
- [`store/README.md`](store/README.md) for backend store architecture and API details.

Video pick → transcode → HLS (fMP4) → playback runs **entirely in the browser**. **Mediabunny** and **Shaka Player** are loaded from **public CDNs** (always the current npm `latest` for those URLs) inside `statics/core.mjs` — no bundling step. The **UI** is unbundled `statics/ui.mjs` and `statics/upload-configure.mjs` (lit-html from jsDelivr). Edit any `.mjs` / `style.css` and refresh.

Output uses **hardware H.264** when supported, else **VP9**, plus **Opus** when the source has audio; ladder **1080 / 720 / 360 / 144** (1080 omitted if max dimension &lt; 1200), two parallel encodes, HLS multivariant with blob URLs + a request filter.

**CSP / network:** the app loads **Mediabunny** and **Shaka** from **`esm.sh`** (browser-safe bundles). Serve the **`statics/`** folder as the site root (e.g. `npx serve statics -l 3000`). If you point a dev server at **`web/`** and it resolves local `node_modules/mediabunny`, you can hit `node:fs` errors — use **`statics/`** as root instead.

## Run (local dev)

```bash
cd web
go run .
```

Open http://localhost:8080

Store service (separate process):

```bash
cd web/store
npm install
npm start
```

The store service reads configuration from `.env` (repo root or `web/.env`). It ingests encoder events and finalizes uploads internally (`/events` + `/finalize`), and auto-generates `STORE_FILSTREAM_ID` in `.env` when blank.

## Environment

| Variable | Purpose |
|----------|---------|
| `PORT` | Go server listen port (default `:8080`) |
| `STORE_BASE_URL` | Store service base URL for Go proxy (default `http://127.0.0.1:8090`) |
| `.env` values for store | See `web/store/README.md` (`STORE_RPC_URL`, `STORE_PROVIDER_ID`, etc.) |
