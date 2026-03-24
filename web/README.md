# FilStream web (static + in-browser pipeline)

The Go binary is a **static file server only** — it serves whatever is in `statics/`. There is no API, transcoding, or upload handling on the server (suitable for later static / serverless hosting).

Video pick → transcode → HLS (fMP4) → playback runs **entirely in the browser**. **Mediabunny** and **Shaka Player** are loaded from **public CDNs** (always the current npm `latest` for those URLs) inside `statics/core.mjs` — no bundling step. The **UI** is unbundled `statics/ui.mjs` and `statics/upload-configure.mjs` (lit-html from jsDelivr). Edit any `.mjs` / `style.css` and refresh.

Output uses **hardware H.264** when supported, else **VP9**, plus **Opus** when the source has audio; ladder **1080 / 720 / 360 / 144** (1080 omitted if max dimension &lt; 1200), two parallel encodes, HLS multivariant with blob URLs + a request filter.

**CSP / network:** the app loads **Mediabunny** and **Shaka** from **`esm.sh`** (browser-safe bundles). Serve the **`statics/`** folder as the site root (e.g. `npx serve statics -l 3000`). If you point a dev server at **`web/`** and it resolves local `node_modules/mediabunny`, you can hit `node:fs` errors — use **`statics/`** as root instead.

## Run (local dev)

```bash
cd web
go run .
```

Open http://localhost:8080

No `npm install` is required for the app.

## Deploy

Upload the **entire** contents of `statics/` — `index.html`, `style.css`, `core.mjs`, `ui.mjs`, `upload-configure.mjs`. No server-side logic is required in production.

## Environment (optional)

| Variable | Purpose |
|----------|---------|
| `PORT` | Listen port (default `:8080`) — only used by the temporary Go static server |
