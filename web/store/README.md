# Store Service (`web/store`)

Server-side Synapse adapter for FilStream. The service is event-driven: frontend streams encoder events to the API, the backend packs/stores piece bytes during encode with `store()`, then commits once at finalize with `commit()`.

This README is the backend contract for any frontend, not only the current UI.

## Architecture

Runtime components:

- HTTP API (`server.mjs`): validates JSON and routes requests.
- Upload session manager (`service.mjs`): in-memory state per `uploadId`.
- Event processor (`service.mjs`): handles `segmentready`, `segmentflush`, `fileEvent`, `transcodeComplete`, `listingDetails`.
- Synapse adapter (`synapse.mjs`): creates session-bound Synapse client and resolves dataset.

Storage/data flow:

- Frontend sends media and metadata as event stream.
- Backend stores media bytes as parked pieces (`store()`), not committed yet.
- Backend stages text artifacts (`playlist-app`, `master-app`, `meta.json`) in memory.
- During finalize, backend rewrites `playlist-app` and `master-app` to provider retrieval URLs (with byte ranges for packed segment bytes).
- Finalize stores rewritten playlists plus `manifest.json` (with embedded `meta`), then commits all non-abandoned pieces in one transaction.

State model:

- Upload state is in-memory only (`Map<uploadId, session>`).
- No DB is used in current implementation.
- Process restart loses in-memory upload sessions.

Dataset model:

- One dataset per tuple: `clientAddress + providerId + metadata["FILSTREAM-ID"]`.
- If multiple datasets match, oldest dataset is reused.

## Config (`.env`)

Required:

- `STORE_RPC_URL`
- `STORE_CHAIN_ID`
- `STORE_PROVIDER_ID`
- `STORE_SOURCE`

Optional:

- `STORE_HOST` default `127.0.0.1`
- `STORE_PORT` default `8090`
- `STORE_REQUEST_BODY_LIMIT_BYTES` default `41943040`
- `STORE_MAX_PIECE_BYTES` default `266338304` (254 MiB)
- `STORE_FILSTREAM_ID`

`STORE_FILSTREAM_ID` behavior:

- If non-empty, service uses it.
- If missing/empty, service generates a UUID and writes it into `.env`.
- This value is used for dataset matching and creation metadata.

## Run

```bash
cd web/store
npm install
npm start
```

## API Surface

- `GET /api/store/healthz`
- `POST /api/store/uploads/init`
- `POST /api/store/uploads/:uploadId/events`
- `POST /api/store/uploads/:uploadId/finalize`
- `GET /api/store/uploads/:uploadId/status`
- `POST /api/store/uploads/:uploadId/abort`
- `POST /api/store/uploads/:uploadId/delete-asset`
- `POST /api/store/uploads/:uploadId/delete-account`

If you run the Go server, call these through the proxy path `/api/store/*`.
If you run Node store directly, call it on the Node host/port with the same path.
All POST endpoints expect `Content-Type: application/json`.
Auth is not enforced inside store service in the current implementation; secure this at the gateway/server layer.

## Frontend Integration Contract

### 1) Upload init

`POST /api/store/uploads/init`

Request:

```json
{
  "assetId": "asset_123",
  "clientAddress": "0xabc...",
  "sessionPrivateKey": "0x...",
  "sessionExpirations": {
    "0x<CreateDataSetPermissionHash>": "1742900000",
    "0x<AddPiecesPermissionHash>": "1742900000",
    "0x<SchedulePieceRemovalsPermissionHash>": "1742900000",
    "0x<DeleteDataSetPermissionHash>": "1742900000"
  }
}
```

Rules:

- `clientAddress` is the root wallet address used as Synapse `account`.
- `sessionPrivateKey` is the session key private key, not the root key.
- `sessionExpirations` must include all required FWSS permission expirations.
- Backend does not run login/funding/sync-expiration. Frontend must do that before calling init.

Response:

```json
{
  "uploadId": "uuid",
  "dataSetId": 123,
  "providerId": 42,
  "filstreamId": "uuid-from-env",
  "createdDataSet": false
}
```

### 2) Stream events

`POST /api/store/uploads/:uploadId/events`

You should send events in encode order. Binary payloads must be base64 in `detail.dataBase64`.

Supported event types:

- `segmentready`
- `segmentflush`
- `fileEvent`
- `transcodeComplete`
- `listingDetails`

Event payloads:

```json
{
  "type": "segmentready",
  "detail": {
    "variantIndex": 0,
    "kind": "media",
    "segmentIndex": 1,
    "dataBase64": "..."
  }
}
```

```json
{
  "type": "segmentready",
  "detail": {
    "variant": "v0",
    "kind": "init",
    "dataBase64": "..."
  }
}
```

```json
{
  "type": "segmentflush",
  "detail": {
    "variantIndex": 0
  }
}
```

```json
{
  "type": "fileEvent",
  "detail": {
    "path": "v0/playlist-app.m3u8",
    "mimeType": "application/vnd.apple.mpegurl",
    "dataBase64": "..."
  }
}
```

```json
{
  "type": "transcodeComplete",
  "detail": {
    "masterAppM3U8Text": "#EXTM3U...",
    "rootM3U8Text": "#EXTM3U..."
  }
}
```

```json
{
  "type": "listingDetails",
  "detail": {
    "metaPath": "meta.json",
    "metaJsonText": "{...}"
  }
}
```

What backend does for each event:

- `segmentready`: appends `init.mp4`/`seg-N.m4s` bytes into variant pack buffer and auto-flushes to a parked piece once buffer hits `STORE_MAX_PIECE_BYTES`.
- `segmentflush`: drops variant in-memory buffer and marks parked uncommitted pieces for that variant as abandoned.
- `fileEvent`: stages text files in memory.
- `transcodeComplete`: stages `master-app.m3u8` and `master-local.m3u8`.
- `listingDetails`: stages metadata JSON text (current UI uses `meta.json`).

### 3) Finalize upload

`POST /api/store/uploads/:uploadId/finalize`

Backend finalize pipeline:

1. Flush all variant buffers to parked pieces.
2. Rewrite each `v*/playlist-app.m3u8` to retrieval URL + `#EXT-X-BYTERANGE` entries and store as pieces.
3. Rewrite `master-app.m3u8` to direct variant-playlist retrieval URLs and store it as a piece.
4. Build and store `manifest.json` as a piece (including parsed `meta.json` content under `meta` when present).
5. Commit all non-abandoned pieces in one `commit()` call.
6. Return playback URLs from stored file mappings.

Response:

```json
{
  "finalized": true,
  "committedCount": 12,
  "transactionHash": "0x...",
  "masterAppUrl": "https://...",
  "manifestUrl": "https://...",
  "dataSetId": 123
}
```

The intended player input is `masterAppUrl`.
`manifestUrl` is returned by finalize response for convenience, but is not embedded inside `manifest.json.playback`.
Player fetches piece retrieval URLs directly from PDP/provider; backend does not proxy byte-range playback in current design.

## Other Endpoints

`GET /api/store/uploads/:uploadId/status`

- Returns session health and counters: event counts, piece totals, commit/abandon counts, timestamps.

`POST /api/store/uploads/:uploadId/abort`

- Removes in-memory upload session.
- Already parked but uncommitted pieces remain uncommitted.

`POST /api/store/uploads/:uploadId/delete-asset`

- Deletes committed pieces tracked inside this upload session.
- Intended for per-video deletion from this session context.

`POST /api/store/uploads/:uploadId/delete-account`

- Calls dataset terminate on Synapse context.
- Intended for account-level data deletion.

## Error Model

Typical responses are JSON:

```json
{
  "error": "message",
  "details": "optional"
}
```

Common status codes:

- `400` missing/invalid request fields
- `403` session key does not satisfy required permissions
- `404` unknown route or upload session id
- `409` upload already finalized
- `415` non-JSON content type on JSON endpoints
- `500` internal/server or Synapse initialization failures

## Piece Metadata Keys

Each committed piece uses compact metadata keys:

- `FS_ASSET` asset id
- `FS_VAR` variant (`v0`, `v1`, `root`)
- `FS_SEQ` sequence number for packed variant pieces
- `FS_SEGS` segment range like `1-20` for packed variant pieces
- `FS_FILE` logical file path for single-file pieces (`master-app.m3u8`, `manifest.json`, ...)

Constraints enforced in code:

- Maximum 5 key/value pairs.
- Key length max 32 chars.
- Value length max 128 chars.

## Minimal Frontend Algorithm

1. Obtain/refresh session key and required expirations on frontend.
2. Call `POST /api/store/uploads/init` and keep returned `uploadId`.
3. During encode, send `segmentready` and `fileEvent` as data becomes available.
4. On encoder retry/reset, send `segmentflush` for affected variant.
5. After encode completes, send `transcodeComplete`.
6. After listing metadata is prepared, send `listingDetails`.
7. Call `POST /api/store/uploads/:uploadId/finalize`.
8. Use `masterAppUrl` for playback.
9. Optionally poll `GET /api/store/uploads/:uploadId/status` for diagnostics.

## Current UI Notes

- Existing UI bridge is in `web/statics/ui.mjs`.
- Frontend wiring of session bootstrap values (`sessionPrivateKey`, `sessionExpirations`) is still TODO in the UI.
