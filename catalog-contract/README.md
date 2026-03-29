# Catalog Contract (Standalone Package)

This package contains the on-chain catalog index contract for FilStream.

## Scope
- Non-upgradeable contract.
- Owner is deployer EOA (current phase).
- Session-key aware write auth via `SessionKeyRegistry`.
- Owner override controls for legal/compliance and long-term maintenance.

## Directory Layout
- `src/CatalogRegistry.sol` — contract source.
- `test/CatalogRegistry.t.sol` — Foundry tests.
- `script/deploy.sh` — deployment script.
- `foundry.toml` — Foundry config for this package.

## Contract Summary
`CatalogRegistry` supports:
- `addEntry(claimedUser, assetId, providerId, manifestCid, title)`
- `deleteEntry(claimedUser, entryId)`
- `getLatest(offset, limit, activeOnly)`
- `getNewerThan(cursorCreatedAt, cursorEntryId, limit, activeOnly)`
- `getByCreator(creator, offset, limit, activeOnly)`
- profile mapping:
  - `setMyUsername`, `ownerSetUsername`, `usernameOf`
  - `setMyProfilePicturePieceCid`, `ownerSetProfilePicturePieceCid`, `profilePicturePieceCidOf`

Owner overrides:
- update ownership/config (`setOwner`, `setSessionKeyRegistry`, `setPermissions`, `setPaused`)
- content controls (`ownerCreateEntry`, `ownerUpdateEntry`, `ownerDeleteEntry`)

## Session Key Auth Model
For non-owner writes:
- Direct wallet call is allowed if `msg.sender == claimedUser`.
- Otherwise caller must be a session signer with non-expired permission in `SessionKeyRegistry`:
  `authorizationExpiry(claimedUser, msg.sender, permission) >= block.timestamp`.

Permission constants are provided at deploy time:
- `PERM_ADD_ENTRY`
- `PERM_DELETE_ENTRY`

Suggested defaults:
- `keccak256("FILSTREAM_CATALOG_ADD_V1")`
- `keccak256("FILSTREAM_CATALOG_DELETE_V1")`

## Deploy
Prereqs:
- `forge` and `cast` installed.
- funded deployer key.

Run:
```bash
cd catalog-contract
RPC_URL="https://..." \
PRIVATE_KEY="0x..." \
SESSION_KEY_REGISTRY="0x..." \
./script/deploy.sh
```

Optional env vars:
- `OWNER` (defaults to deployer address derived from `PRIVATE_KEY`)
- `PERM_ADD_ENTRY`
- `PERM_DELETE_ENTRY`

## Migrate Old Catalog -> New Catalog
Use the migration wrapper:

```bash
cd catalog-contract
RPC_URL="https://..." \
OLD_CATALOG="0xOldContract" \
NEW_CATALOG="0xNewContract" \
PRIVATE_KEY="0x..." \
./script/migrate.sh
```

Notes:
- If `PRIVATE_KEY` is the new contract owner, script copies all entries + usernames.
- If `PRIVATE_KEY` is a creator wallet, script copies only that creator's entries + username.
- Optional creator-mode profile picture seed:
  - `MIGRATE_PROFILE=1`
  - `PROFILE_PIECE_CID="bafy..."`
  - no profile CID is read from old contract (old schema does not have it)
- Script estimates gas per transaction with `cast estimate` and applies a buffer.
- Optional gas controls (useful on Calibration):
  - `GAS_BUFFER_PCT=130`
  - `MIN_GAS_LIMIT=0`
- Optional range controls:
  - `START_ENTRY_ID=<n>`
  - `MAX_ENTRY_ID=<n>`
- Optional dry-run:
  - `DRY_RUN=1`

## Legal/Compliance Operations (Owner)
- Force deactivate entry (`ownerDeleteEntry`).
- Force correct metadata (`ownerUpdateEntry`).
- Pause user mutations globally (`setPaused(true)`).
- Rotate session registry or permission constants (`setSessionKeyRegistry`, `setPermissions`).

## Notes
- Owner EOA is accepted risk in this phase (non-upgradeable).
- Multi-tab/session-key coordination is handled in app logic, not in this package.
