/**
 * Shared FilStream constants.
 *
 * Purpose:
 * - Keep stable values in one place so tuning and audits happen in a single file.
 * - Document each value with intent and primary usage sites.
 *
 * Scope:
 * - App/runtime constants only (no vendor constants).
 * - Pure data module (no imports, no side effects).
 */

/**
 * Default public app config consumed by `getFilstreamStoreConfig()` in `filstream-config.mjs`.
 * Used by: `filstream-config.mjs`.
 */
export const DEFAULT_FILSTREAM_PUBLIC_CONFIG = {
  storeRpcUrl: "https://api.calibration.node.glif.io/rpc/v1",
  storeChainId: 314159,
  storeProviderId: 4,
  storeSource: "filstream",
  storeFilstreamId: "019d3609-35d7-71b3-b13b-050cbf9a8fe1",
  storeMaxPieceBytes: 133_169_152,
  viewBaseUrl: "https://curiostorage.github.io/filstream/",
  catalogContractAddress: "0xFf774A245A07CDD89a628B9aBB1980fD5d30fD21",
  sessionKeyFundAttoFil: "500000000000000",
  catalogSyncIntervalMs: 30_000,
};

/**
 * LocalStorage key for persistent FilStream ID.
 * Used by: `filstream-config.mjs`.
 */
export const FILSTREAM_ID_STORAGE_KEY = "filstream_store_filstream_id_v1";

/**
 * Synthetic wallet UUID for `window.ethereum` fallback in EIP-6963 discovery.
 * Used by: `eip6963.mjs`, `ui.mjs`.
 */
export const EIP6963_LEGACY_PROVIDER_UUID = "eip6963:legacy-window-ethereum";

/**
 * Session payload storage key (`localStorage`).
 * Used by: `session-key-storage.mjs`, `ui.mjs`.
 */
export const FILSTREAM_SESSION_STORAGE_KEY = "filstream_synapse_session_v1";

/**
 * Cross-tab coordination channel name.
 * Used by: `session-key-storage.mjs`, `ui.mjs`.
 */
export const FILSTREAM_SESSION_CHANNEL_NAME = "filstream_session_coord_v1";

/**
 * Cross-tab lock key guarding retired-key cleanup.
 * Used by: `session-key-storage.mjs`, `ui.mjs`.
 */
export const FILSTREAM_SESSION_CLEANUP_LOCK_KEY = "filstream_session_cleanup_lock_v1";

/**
 * Last connected wallet identity storage key.
 * Used by: `session-key-storage.mjs`, `ui.mjs`.
 */
export const FILSTREAM_WALLET_STORAGE_KEY = "filstream_wallet_v1";

/**
 * Maximum age for restoring a previously authorized session key.
 * Used by: `session-key-storage.mjs`.
 */
export const SESSION_RECOVER_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * SessionKeyRegistry origin label used for login/revoke operations.
 * Used by: `session-key-bootstrap.mjs`.
 */
export const FILSTREAM_SESSION_ORIGIN = "filstream";

/**
 * Gas limit for simple native-token sweep tx (session key -> root wallet).
 * Used by: `session-key-bootstrap.mjs`.
 */
export const SESSION_KEY_SWEEP_GAS_LIMIT = 21_000n;

/**
 * On-chain catalog add-entry permission hash.
 * Used by: `filstream-catalog-chain.mjs`, `session-key-bootstrap.mjs`.
 */
export const FILSTREAM_CATALOG_ADD_PERMISSION =
  "0xfa83bd1269e8de58de2d0c88e18dda8179b888d02fc443f21c7f188eb16e11bd";

/**
 * On-chain catalog delete-entry permission hash.
 * Used by: `filstream-catalog-chain.mjs`, `session-key-bootstrap.mjs`.
 */
export const FILSTREAM_CATALOG_DELETE_PERMISSION =
  "0xbfa4735938e1ee3e0022c2e29ad7850c9dd9fb4e314cad4b750278d4b434b26a";

/**
 * CatalogRegistry ABI used for browser reads/writes.
 * Used by: `filstream-catalog-chain.mjs`.
 */
export const CATALOG_REGISTRY_ABI = [
  {
    type: "function",
    stateMutability: "view",
    name: "getLatest",
    inputs: [
      { name: "offset", type: "uint256", internalType: "uint256" },
      { name: "limit", type: "uint256", internalType: "uint256" },
      { name: "activeOnly", type: "bool", internalType: "bool" },
    ],
    outputs: [
      {
        name: "out",
        type: "tuple[]",
        internalType: "struct CatalogRegistry.Entry[]",
        components: [
          { name: "entryId", type: "uint256", internalType: "uint256" },
          { name: "createdAt", type: "uint64", internalType: "uint64" },
          { name: "updatedAt", type: "uint64", internalType: "uint64" },
          { name: "creator", type: "address", internalType: "address" },
          { name: "assetId", type: "string", internalType: "string" },
          { name: "providerId", type: "uint64", internalType: "uint64" },
          { name: "manifestCid", type: "string", internalType: "string" },
          { name: "title", type: "string", internalType: "string" },
          { name: "active", type: "bool", internalType: "bool" },
        ],
      },
    ],
  },
  {
    type: "function",
    stateMutability: "view",
    name: "getNewerThan",
    inputs: [
      { name: "cursorCreatedAt", type: "uint64", internalType: "uint64" },
      { name: "cursorEntryId", type: "uint256", internalType: "uint256" },
      { name: "limit", type: "uint256", internalType: "uint256" },
      { name: "activeOnly", type: "bool", internalType: "bool" },
    ],
    outputs: [
      {
        name: "out",
        type: "tuple[]",
        internalType: "struct CatalogRegistry.Entry[]",
        components: [
          { name: "entryId", type: "uint256", internalType: "uint256" },
          { name: "createdAt", type: "uint64", internalType: "uint64" },
          { name: "updatedAt", type: "uint64", internalType: "uint64" },
          { name: "creator", type: "address", internalType: "address" },
          { name: "assetId", type: "string", internalType: "string" },
          { name: "providerId", type: "uint64", internalType: "uint64" },
          { name: "manifestCid", type: "string", internalType: "string" },
          { name: "title", type: "string", internalType: "string" },
          { name: "active", type: "bool", internalType: "bool" },
        ],
      },
    ],
  },
  {
    type: "function",
    stateMutability: "view",
    name: "usernameOf",
    inputs: [{ name: "user", type: "address", internalType: "address" }],
    outputs: [{ name: "", type: "string", internalType: "string" }],
  },
  {
    type: "function",
    stateMutability: "view",
    name: "profilePicturePieceCidOf",
    inputs: [{ name: "user", type: "address", internalType: "address" }],
    outputs: [{ name: "", type: "string", internalType: "string" }],
  },
  {
    type: "function",
    stateMutability: "view",
    name: "getByCreator",
    inputs: [
      { name: "creator", type: "address", internalType: "address" },
      { name: "offset", type: "uint256", internalType: "uint256" },
      { name: "limit", type: "uint256", internalType: "uint256" },
      { name: "activeOnly", type: "bool", internalType: "bool" },
    ],
    outputs: [
      {
        name: "out",
        type: "tuple[]",
        internalType: "struct CatalogRegistry.Entry[]",
        components: [
          { name: "entryId", type: "uint256", internalType: "uint256" },
          { name: "createdAt", type: "uint64", internalType: "uint64" },
          { name: "updatedAt", type: "uint64", internalType: "uint64" },
          { name: "creator", type: "address", internalType: "address" },
          { name: "assetId", type: "string", internalType: "string" },
          { name: "providerId", type: "uint64", internalType: "uint64" },
          { name: "manifestCid", type: "string", internalType: "string" },
          { name: "title", type: "string", internalType: "string" },
          { name: "active", type: "bool", internalType: "bool" },
        ],
      },
    ],
  },
  {
    type: "function",
    stateMutability: "nonpayable",
    name: "setMyUsername",
    inputs: [{ name: "username", type: "string", internalType: "string" }],
    outputs: [],
  },
  {
    type: "function",
    stateMutability: "nonpayable",
    name: "setMyProfilePicturePieceCid",
    inputs: [{ name: "pieceCid", type: "string", internalType: "string" }],
    outputs: [],
  },
  {
    type: "function",
    stateMutability: "nonpayable",
    name: "ownerSetProfilePicturePieceCid",
    inputs: [
      { name: "user", type: "address", internalType: "address" },
      { name: "pieceCid", type: "string", internalType: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    stateMutability: "nonpayable",
    name: "addEntry",
    inputs: [
      { name: "claimedUser", type: "address", internalType: "address" },
      { name: "assetId", type: "string", internalType: "string" },
      { name: "providerId", type: "uint64", internalType: "uint64" },
      { name: "manifestCid", type: "string", internalType: "string" },
      { name: "title", type: "string", internalType: "string" },
    ],
    outputs: [{ name: "entryId", type: "uint256", internalType: "uint256" }],
  },
  {
    type: "function",
    stateMutability: "nonpayable",
    name: "deleteEntry",
    inputs: [
      { name: "claimedUser", type: "address", internalType: "address" },
      { name: "entryId", type: "uint256", internalType: "uint256" },
    ],
    outputs: [],
  },
];

/**
 * Wizard max step count.
 * Used by: `ui.mjs`.
 */
export const WIZARD_MAX_STEP = 5;

/**
 * User-facing finalize phase note shown under upload progress.
 * Used by: `ui.mjs`.
 */
export const STORE_PHASE_FINALIZE_NOTE =
  "Finalizing playlists, manifest, and on-chain commit…";

/**
 * Remote tab upload activity considered stale after this duration.
 * Used by: `ui.mjs`.
 */
export const SESSION_UPLOAD_ACTIVITY_STALE_MS = 45_000;

/**
 * Cross-tab upload heartbeat interval.
 * Used by: `ui.mjs`.
 */
export const SESSION_ACTIVITY_HEARTBEAT_MS = 15_000;

/**
 * Background retired-key cleanup polling interval.
 * Used by: `ui.mjs`.
 */
export const SESSION_RETIRE_CLEANUP_INTERVAL_MS = 20_000;

/**
 * TTL for local cleanup lock ownership records.
 * Used by: `ui.mjs`.
 */
export const SESSION_CLEANUP_LOCK_TTL_MS = 20_000;

/**
 * USDFC token decimals for funding math.
 * Used by: `ui.mjs`.
 */
export const USDFC_DECIMALS = 18n;

/**
 * One whole USDFC token in base units.
 * Used by: `ui.mjs`.
 */
export const USDFC_ONE = 10n ** USDFC_DECIMALS;

/**
 * Minimum top-up amount per funding preflight.
 * Used by: `ui.mjs`.
 */
export const FUNDING_MIN_TOPUP_WEI = 5n * USDFC_ONE;

/**
 * Funding buffer numerator (e.g. 120 for +20% headroom).
 * Used by: `ui.mjs`.
 */
export const FUNDING_TARGET_NUMERATOR = 120n;

/**
 * Funding buffer denominator.
 * Used by: `ui.mjs`.
 */
export const FUNDING_TARGET_DENOMINATOR = 100n;

/**
 * Viewer sidebar page size for catalog reads.
 * Used by: `viewer/viewer.mjs`.
 */
export const CATALOG_PAGE_SIZE = 100;

/**
 * Viewer cadence for occasional full catalog refresh.
 * Used by: `viewer/viewer.mjs`.
 */
export const CATALOG_FULL_REFRESH_MS = 10 * 60 * 1000;

/**
 * Maximum unique creators refreshed per viewer sync tick for username/profile updates.
 * Set to current viewer cache cap so all currently listed creators are covered.
 * Used by: `viewer/viewer.mjs`.
 */
export const CATALOG_CREATOR_PROFILE_SYNC_LIMIT = 250;

/**
 * IndexedDB database name for viewer/creator catalog cache.
 * Used by: `filstream-catalog-cache.mjs`.
 */
export const CATALOG_CACHE_DB_NAME = "filstream_catalog_cache_v1";

/**
 * IndexedDB schema version for catalog cache.
 * Used by: `filstream-catalog-cache.mjs`.
 */
export const CATALOG_CACHE_DB_VERSION = 2;

/**
 * Store name for cached catalog entries.
 * Used by: `filstream-catalog-cache.mjs`.
 */
export const CATALOG_CACHE_ENTRIES_STORE = "entries";

/**
 * Store name for cached manifest documents.
 * Used by: `filstream-catalog-cache.mjs`.
 */
export const CATALOG_CACHE_MANIFESTS_STORE = "manifests";

/**
 * Store name for cache state/cursor rows.
 * Used by: `filstream-catalog-cache.mjs`.
 */
export const CATALOG_CACHE_STATE_STORE = "state";

/**
 * Store name for cached creator profile rows (username + profile picture pointer/url).
 * Used by: `filstream-catalog-cache.mjs`.
 */
export const CATALOG_CACHE_CREATORS_STORE = "creators";

/**
 * Shared fake origin used to build stable URL-like paths during in-browser pipeline assembly.
 * Used by: `core.mjs`, `browser-store.mjs`.
 */
export const FILSTREAM_FAKE_ORIGIN = "https://filstream.invalid";

/**
 * Pipeline segment duration target in seconds.
 * Used by: `core.mjs`.
 */
export const CORE_FRAGMENT_SECONDS = 5;

/**
 * Minimum major dimension required before offering a 1080 rung.
 * Used by: `core.mjs`.
 */
export const MIN_MAJOR_DIM_FOR_1080_RUNG = 1200;

/**
 * H.264 level lookup table for codec string selection.
 * Used by: `core.mjs`.
 */
export const AVC_LEVEL_TABLE = [
  { maxMacroblocks: 99, maxBitrate: 64000, level: 0x0a },
  { maxMacroblocks: 396, maxBitrate: 192000, level: 0x0b },
  { maxMacroblocks: 396, maxBitrate: 384000, level: 0x0c },
  { maxMacroblocks: 396, maxBitrate: 768000, level: 0x0d },
  { maxMacroblocks: 396, maxBitrate: 2000000, level: 0x14 },
  { maxMacroblocks: 792, maxBitrate: 4000000, level: 0x15 },
  { maxMacroblocks: 1620, maxBitrate: 4000000, level: 0x16 },
  { maxMacroblocks: 1620, maxBitrate: 10000000, level: 0x1e },
  { maxMacroblocks: 3600, maxBitrate: 14000000, level: 0x1f },
  { maxMacroblocks: 5120, maxBitrate: 20000000, level: 0x20 },
  { maxMacroblocks: 8192, maxBitrate: 20000000, level: 0x28 },
  { maxMacroblocks: 8192, maxBitrate: 50000000, level: 0x29 },
  { maxMacroblocks: 8704, maxBitrate: 50000000, level: 0x2a },
  { maxMacroblocks: 22080, maxBitrate: 135000000, level: 0x32 },
  { maxMacroblocks: 36864, maxBitrate: 240000000, level: 0x33 },
  { maxMacroblocks: 36864, maxBitrate: 240000000, level: 0x34 },
  { maxMacroblocks: 139264, maxBitrate: 240000000, level: 0x3c },
  { maxMacroblocks: 139264, maxBitrate: 480000000, level: 0x3d },
  { maxMacroblocks: 139264, maxBitrate: 800000000, level: 0x3e },
];

/**
 * Pipeline/event bridge names emitted by the transcode pipeline.
 * Used by: `core.mjs` (export/emit), `ui.mjs` (listen/route).
 */
export const SEGMENT_READY_EVENT = "segmentready";
export const SEGMENT_FLUSH_EVENT = "segmentflush";
export const FILE_EVENT = "fileEvent";
export const TRANSCODE_COMPLETE_EVENT = "transcodeComplete";
export const LISTING_DETAILS_EVENT = "listingDetails";

/**
 * Minimum/maximum PDP piece byte sizes used by browser upload session.
 * Used by: `browser-store.mjs`.
 */
export const SYNAPSE_MIN_PIECE_BYTES = 127;
export const SYNAPSE_MAX_PIECE_BYTES = 200 * 1024 * 1024;

/**
 * Commit and upload parallelism controls for browser session flushing.
 * Used by: `browser-store.mjs`.
 */
export const MAX_COMMIT_BATCH_PIECES = 32;
export const MAX_PARALLEL_PDP_UPLOADS = 4;

/**
 * Playlist path matcher for variant app playlists.
 * Used by: `browser-store.mjs`.
 */
export const VARIANT_PLAYLIST_APP_RE = /^v\d+\/playlist-app\.m3u8$/;

/**
 * Upload IndexedDB store/schema constants.
 * Used by: `browser-store.mjs`.
 */
export const UPLOAD_SEGMENTS_STORE = "segments";
export const UPLOAD_DB_VERSION = 1;

/**
 * Piece metadata marker used for creator poster asset pieces.
 * Used by: `browser-store.mjs`.
 */
export const CREATOR_POSTER_FS_NAME = "filstream_creator_poster";

/**
 * LocalStorage key for deferred piece deletion queue.
 * Used by: `browser-store.mjs`.
 */
export const DEFERRED_PIECE_DELETE_STORAGE_KEY = "filstream_deferred_piece_delete_v1";

/**
 * Batched metadata read tuning for multicall payload size and parallelism.
 * Used by: `browser-store.mjs`.
 */
export const FETCH_METADATA_MULTICALL_BATCH_BYTES = 131_072;
export const FETCH_METADATA_MULTICALL_PARALLEL = 2;

/**
 * Catalog mini-poster WebP frame plan.
 * Used by: `animated-webp.mjs`.
 */
export const FRAME_COUNT = 20;
export const START_SEC = 10;
export const STEP_SEC = 2;
export const PLAYBACK_FPS = 4;
export const MIN_DURATION_FOR_ANIM_SEC = START_SEC + 0.05;

/**
 * Max width for catalog mini-poster images.
 * Used by: `animated-webp.mjs`, CSS in `viewer.css`/`creator.css`.
 */
export const CATALOG_ANIM_MAX_WIDTH_PX = 168;

/**
 * Shared spinner style element id and CSS payload.
 * Used by: `spinner.mjs`.
 */
export const SPINNER_STYLE_ID = "filstream-spinner-styles";
export const SPINNER_CSS = `
.filstream-spinner {
  --fs-spin-size: 2.5rem;
  margin: 0;
  width: var(--fs-spin-size);
  height: var(--fs-spin-size);
  position: relative;
  text-align: center;
  flex-shrink: 0;
  animation: filstream-sk-rotate 2s infinite linear;
}
.filstream-spinner--sm {
  --fs-spin-size: 1.25rem;
}
.filstream-spinner--md {
  --fs-spin-size: 1.75rem;
}
.filstream-spinner--lg {
  --fs-spin-size: 2.25rem;
}
.filstream-spinner__dot {
  width: 60%;
  height: 60%;
  position: absolute;
  left: 0;
  right: 0;
  margin-left: auto;
  margin-right: auto;
  background-color: #18C8FF;
  border-radius: 100%;
  animation: filstream-sk-bounce 2s infinite ease-in-out;
}
.filstream-spinner__dot--1 {
  top: 0;
}
.filstream-spinner__dot--2 {
  top: auto;
  bottom: 0;
  animation-delay: -1s;
}

@keyframes filstream-sk-rotate {
  100% {
    transform: rotate(360deg);
  }
}
@keyframes filstream-sk-bounce {
  0%,
  100% {
    transform: scale(0);
  }
  50% {
    transform: scale(1);
  }
}
`;

/**
 * Default donate token metadata embedded into listing/manifest docs.
 * Used by: `filstream-chain-config.mjs`, `core.mjs`.
 */
export const USDFC_DONATE_TOKEN = {
  symbol: "USDFC",
  address: "0x0000000000000000000000000000000000000000",
  decimals: 18,
  chainId: 314159,
  chainName: "Filecoin Calibration",
};

/**
 * Shared FilStream brand data.
 * Used by: `filstream-brand.mjs`, `viewer/viewer.mjs`.
 */
export const FILSTREAM_BRAND = {
  name: "FilStream",
  tagline: "CalibrationNet edition",
  logoSrc: "favicon.svg",
};
