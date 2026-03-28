#!/usr/bin/env bash
set -euo pipefail

# Migrate entries/usernames from old catalog contract to new contract, with
# per-transaction cast gas estimation (no gas guessing).
#
# Required env vars:
#   RPC_URL, OLD_CATALOG, NEW_CATALOG, PRIVATE_KEY
#
# Optional env vars:
#   START_ENTRY_ID=<n>          # Default: owner mode => new.nextEntryId(), creator => 1
#   MAX_ENTRY_ID=<n>            # Default: old.totalEntries()
#   MIGRATE_PROFILE=0           # Creator mode only; set 1 to write PROFILE_PIECE_CID
#   PROFILE_PIECE_CID=""
#   GAS_BUFFER_PCT=130          # Applied to cast estimate
#   MIN_GAS_LIMIT=0             # Floor for gas limit after buffering
#   DRY_RUN=0                   # Set 1 to print actions only
#   RUN_FORGE_BUILD=1           # Set 0 to skip forge build precheck

: "${RPC_URL:?Missing RPC_URL}"
: "${OLD_CATALOG:?Missing OLD_CATALOG}"
: "${NEW_CATALOG:?Missing NEW_CATALOG}"
: "${PRIVATE_KEY:?Missing PRIVATE_KEY}"

START_ENTRY_ID="${START_ENTRY_ID:-}"
MAX_ENTRY_ID="${MAX_ENTRY_ID:-}"
PROFILE_PIECE_CID="${PROFILE_PIECE_CID:-}"
MIGRATE_PROFILE="${MIGRATE_PROFILE:-0}"
GAS_BUFFER_PCT="${GAS_BUFFER_PCT:-130}"
MIN_GAS_LIMIT="${MIN_GAS_LIMIT:-0}"
DRY_RUN="${DRY_RUN:-0}"
RUN_FORGE_BUILD="${RUN_FORGE_BUILD:-1}"

lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

if [[ "$RUN_FORGE_BUILD" == "1" ]]; then
  forge build -q
fi

SIGNER="$(cast wallet address --private-key "$PRIVATE_KEY")"
OWNER="$(cast call "$NEW_CATALOG" "owner()(address)" --rpc-url "$RPC_URL")"
SIGNER_LC="$(lower "$SIGNER")"
OWNER_LC="$(lower "$OWNER")"

if [[ "$SIGNER_LC" == "$OWNER_LC" ]]; then
  MODE="owner"
else
  MODE="creator"
fi

TOTAL_OLD="$(cast call "$OLD_CATALOG" "totalEntries()(uint256)" --rpc-url "$RPC_URL")"
if [[ "$TOTAL_OLD" == "0" ]]; then
  echo "Old catalog has no entries. Nothing to migrate."
  exit 0
fi

if [[ -n "$MAX_ENTRY_ID" ]]; then
  END_ID="$MAX_ENTRY_ID"
else
  END_ID="$TOTAL_OLD"
fi
if (( END_ID > TOTAL_OLD )); then
  END_ID="$TOTAL_OLD"
fi

if [[ -n "$START_ENTRY_ID" ]]; then
  START_ID="$START_ENTRY_ID"
else
  if [[ "$MODE" == "owner" ]]; then
    START_ID="$(cast call "$NEW_CATALOG" "nextEntryId()(uint256)" --rpc-url "$RPC_URL")"
  else
    START_ID="1"
  fi
fi
if (( START_ID < 1 )); then
  START_ID=1
fi

echo "Signer:      $SIGNER"
echo "New owner:   $OWNER"
echo "Mode:        $MODE"
echo "Old catalog: $OLD_CATALOG"
echo "New catalog: $NEW_CATALOG"
echo "Entry range: $START_ID .. $END_ID (old total: $TOTAL_OLD)"
echo "Gas buffer:  ${GAS_BUFFER_PCT}%"
echo "Gas floor:   $MIN_GAS_LIMIT"
if [[ "$DRY_RUN" == "1" ]]; then
  echo "DRY_RUN:     enabled"
fi
if [[ "$MIGRATE_PROFILE" == "1" && -n "$PROFILE_PIECE_CID" ]]; then
  echo "Profile CID: $PROFILE_PIECE_CID"
fi

if (( START_ID > END_ID )); then
  echo "Nothing to migrate in requested range."
  exit 0
fi

SEEN_CREATORS_FILE="$(mktemp)"
trap 'rm -f "$SEEN_CREATORS_FILE"' EXIT

eth_call_raw() {
  local to="$1"
  local data="$2"
  local obj out
  obj="$(jq -cn --arg to "$to" --arg data "$data" '{to:$to,data:$data}')"
  out="$(cast rpc --rpc-url "$RPC_URL" eth_call "$obj" latest)"
  # Some cast versions return a JSON string literal (e.g. "\"0x...\""), while others return plain 0x...
  if [[ "$out" == \"*\" && "$out" == *\" ]]; then
    out="${out#\"}"
    out="${out%\"}"
  fi
  printf '%s' "$out"
}

decode_entry_json() {
  local raw="$1"
  local decoded offset_hex offset_dec start inner
  local sig_flat="getEntry(uint256)(uint256,uint64,uint64,address,string,uint64,string,string,bool)"

  # Some nodes/cast versions can decode directly as flat return fields.
  if decoded="$(cast decode-abi --json "$sig_flat" "$raw" 2>/dev/null)"; then
    if jq -e 'type == "array" and length == 9' >/dev/null <<< "$decoded"; then
      printf '%s' "$decoded"
      return 0
    fi
  fi

  # For a single dynamic tuple return, ABI payload is:
  # [offset_to_tuple][tuple_encoded_data...]
  # Unwrap by slicing from the reported offset, then decode tuple body as flat fields.
  if [[ "${#raw}" -lt 66 ]]; then
    return 1
  fi
  offset_hex="${raw:2:64}"
  if [[ ! "$offset_hex" =~ ^[0-9a-fA-F]+$ ]]; then
    return 1
  fi

  offset_dec=$((16#$offset_hex))
  start=$((2 + offset_dec * 2))
  if (( start >= ${#raw} )); then
    return 1
  fi

  inner="0x${raw:$start}"
  if decoded="$(cast decode-abi --json "$sig_flat" "$inner" 2>/dev/null)"; then
    if jq -e 'type == "array" and length == 9' >/dev/null <<< "$decoded"; then
      printf '%s' "$decoded"
      return 0
    fi
  fi

  return 1
}

estimate_and_send() {
  local to="$1"
  local sig="$2"
  shift 2
  local est gas_limit
  est="$(cast estimate --rpc-url "$RPC_URL" --private-key "$PRIVATE_KEY" "$to" "$sig" "$@")"
  if [[ ! "$est" =~ ^[0-9]+$ ]]; then
    echo "Failed to parse gas estimate for $sig: $est" >&2
    exit 1
  fi
  gas_limit=$(( est * GAS_BUFFER_PCT / 100 ))
  if (( gas_limit < MIN_GAS_LIMIT )); then
    gas_limit="$MIN_GAS_LIMIT"
  fi
  echo "  -> $sig gas_est=$est gas_limit=$gas_limit"
  if [[ "$DRY_RUN" == "1" ]]; then
    return
  fi
  cast send \
    --rpc-url "$RPC_URL" \
    --private-key "$PRIVATE_KEY" \
    --gas-limit "$gas_limit" \
    "$to" "$sig" "$@"
}

copy_creator_username_owner_mode() {
  local creator="$1"
  local creator_lc
  creator_lc="$(lower "$creator")"
  if grep -qx "$creator_lc" "$SEEN_CREATORS_FILE" 2>/dev/null; then
    return
  fi
  echo "$creator_lc" >> "$SEEN_CREATORS_FILE"

  local old_name new_name
  old_name="$(cast call "$OLD_CATALOG" "usernameOf(address)(string)" "$creator" --rpc-url "$RPC_URL")"
  new_name="$(cast call "$NEW_CATALOG" "usernameOf(address)(string)" "$creator" --rpc-url "$RPC_URL")"
  if [[ -n "$old_name" && "$old_name" != "$new_name" ]]; then
    echo "Copy username for $creator"
    estimate_and_send "$NEW_CATALOG" "ownerSetUsername(address,string)" "$creator" "$old_name"
  fi
}

if [[ "$MODE" == "creator" ]]; then
  OLD_NAME="$(cast call "$OLD_CATALOG" "usernameOf(address)(string)" "$SIGNER" --rpc-url "$RPC_URL")"
  NEW_NAME="$(cast call "$NEW_CATALOG" "usernameOf(address)(string)" "$SIGNER" --rpc-url "$RPC_URL")"
  if [[ -n "$OLD_NAME" && "$OLD_NAME" != "$NEW_NAME" ]]; then
    echo "Copy creator username for $SIGNER"
    estimate_and_send "$NEW_CATALOG" "setMyUsername(string)" "$OLD_NAME"
  fi

  if [[ "$MIGRATE_PROFILE" == "1" && -n "$PROFILE_PIECE_CID" ]]; then
    echo "Set creator profile picture CID"
    estimate_and_send "$NEW_CATALOG" "setMyProfilePicturePieceCid(string)" "$PROFILE_PIECE_CID"
  fi
fi

for (( entry_id=START_ID; entry_id<=END_ID; entry_id++ )); do
  call_data="$(cast calldata "getEntry(uint256)" "$entry_id")"
  raw_out="$(eth_call_raw "$OLD_CATALOG" "$call_data")"
  if [[ "$raw_out" != 0x* ]]; then
    echo "Unexpected eth_call output for entry $entry_id: $raw_out" >&2
    exit 1
  fi
  if ! decoded="$(decode_entry_json "$raw_out")"; then
    echo "Failed to decode getEntry($entry_id) payload from old catalog." >&2
    echo "Raw payload: $raw_out" >&2
    exit 1
  fi

  e_id="$(jq -r '.[0]' <<< "$decoded")"
  creator="$(jq -r '.[3]' <<< "$decoded")"
  asset_id="$(jq -r '.[4]' <<< "$decoded")"
  provider_id="$(jq -r '.[5]' <<< "$decoded")"
  manifest_cid="$(jq -r '.[6]' <<< "$decoded")"
  title="$(jq -r '.[7]' <<< "$decoded")"
  active="$(jq -r '.[8]' <<< "$decoded")"

  if [[ "$e_id" != "$entry_id" ]]; then
    echo "Skip entry $entry_id (missing or mismatched id $e_id)"
    continue
  fi

  if [[ "$MODE" == "owner" ]]; then
    echo "Entry $entry_id: migrate ownerCreateEntry creator=$creator active=$active"
    copy_creator_username_owner_mode "$creator"
    estimate_and_send \
      "$NEW_CATALOG" \
      "ownerCreateEntry(address,string,uint64,string,string,bool)" \
      "$creator" "$asset_id" "$provider_id" "$manifest_cid" "$title" "$active"
    continue
  fi

  creator_lc="$(lower "$creator")"
  if [[ "$creator_lc" != "$SIGNER_LC" ]]; then
    continue
  fi

  echo "Entry $entry_id: migrate creator add/delete active=$active"
  new_entry_id="$(cast call "$NEW_CATALOG" "nextEntryId()(uint256)" --rpc-url "$RPC_URL")"
  estimate_and_send \
    "$NEW_CATALOG" \
    "addEntry(address,string,uint64,string,string)" \
    "$SIGNER" "$asset_id" "$provider_id" "$manifest_cid" "$title"
  if [[ "$active" != "true" ]]; then
    estimate_and_send \
      "$NEW_CATALOG" \
      "deleteEntry(address,uint256)" \
      "$SIGNER" "$new_entry_id"
  fi
done

echo "Migration complete."
