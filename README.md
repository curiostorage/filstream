# filstream

## Documentation Map

- [`web/README.md`](web/README.md): Go web server (static hosting + `/api/store/*` reverse proxy).
- [`web/store/README.md`](web/store/README.md): Store service architecture, API contract, and Synapse flow.
- [`web/store/.env.example`](web/store/.env.example): example environment values for local setup.

## Runtime Overview

FilStream currently has two runtime parts:

- `web/` (Go): serves static UI and proxies `/api/store/*` to the store service.
- `web/store/` (Node): Synapse-backed storage service that ingests encoder events and stores/commits pieces.

See:

- [`web/README.md`](web/README.md) for web server + proxy run details.
- [`web/store/README.md`](web/store/README.md) for store API and env config.

## Current Storage Model

- Browser does transcode + segment generation.
- Browser emits events to store service (`segmentready`, `segmentflush`, `fileEvent`, `transcodeComplete`, `listingDetails`).
- Store service packs/stores pieces during encode and commits on finalize.
- Dataset model is one dataset per client/provider/FILSTREAM-ID tuple.

## Init Contract (Backend)

`POST /api/store/uploads/init` now expects:

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

- `clientAddress` is the root client account for Synapse `account`.
- `sessionPrivateKey` is only for session signing, not the root account.
- `sessionExpirations` must be supplied by frontend session flow.
- Backend does not run session login/funding/expiry sync logic. It only validates and initializes storage context.

## Remaining Work

### Frontend work required for backend init to succeed

1. Add a real session bootstrap on page entry or wallet-connect. This must create or restore session key material, run session login + funding init in frontend, and build the expiration map for required FWSS permissions.
2. Send the full init payload to backend by including both `sessionPrivateKey` and `sessionExpirations` in `POST /api/store/uploads/init`.
3. Keep session validity logic on frontend by checking expiry before upload init and renewing or re-logging session when expired or near expiry.
4. Add frontend init error handling for backend responses, especially 400 (missing or invalid session data) and 403 (missing required permissions).
5. Figure out what ASSET ID should be.
6. Review DataSet and Piece Metadata models.
