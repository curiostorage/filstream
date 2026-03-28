#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

: "${RPC_URL:?RPC_URL is required}"
: "${PRIVATE_KEY:?PRIVATE_KEY is required}"
: "${SESSION_KEY_REGISTRY:?SESSION_KEY_REGISTRY is required}"

PERM_ADD_ENTRY="${PERM_ADD_ENTRY:-$(cast keccak "FILSTREAM_CATALOG_ADD_V1")}"
PERM_DELETE_ENTRY="${PERM_DELETE_ENTRY:-$(cast keccak "FILSTREAM_CATALOG_DELETE_V1")}"

if [[ -z "${OWNER:-}" ]]; then
  OWNER="$(cast wallet address --private-key "$PRIVATE_KEY")"
fi

echo "Deploying CatalogRegistry..."
echo "OWNER=$OWNER"
echo "SESSION_KEY_REGISTRY=$SESSION_KEY_REGISTRY"
echo "PERM_ADD_ENTRY=$PERM_ADD_ENTRY"
echo "PERM_DELETE_ENTRY=$PERM_DELETE_ENTRY"

forge create src/CatalogRegistry.sol:CatalogRegistry \
  --broadcast \
  --rpc-url "$RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --constructor-args "$OWNER" "$SESSION_KEY_REGISTRY" "$PERM_ADD_ENTRY" "$PERM_DELETE_ENTRY"

