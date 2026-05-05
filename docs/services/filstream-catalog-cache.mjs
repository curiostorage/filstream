/**
 * Small IndexedDB cache for on-chain catalog entries, creator profile rows, and manifest documents.
 */
import {
  CATALOG_CACHE_DB_NAME,
  CATALOG_CACHE_DB_VERSION,
  CATALOG_CACHE_CREATORS_STORE,
  CATALOG_CACHE_ENTRIES_STORE,
  CATALOG_CACHE_MANIFESTS_STORE,
  CATALOG_CACHE_STATE_STORE,
} from "./filstream-constants.mjs";

const DB_NAME = CATALOG_CACHE_DB_NAME;
const DB_VERSION = CATALOG_CACHE_DB_VERSION;
const ENTRIES_STORE = CATALOG_CACHE_ENTRIES_STORE;
const MANIFESTS_STORE = CATALOG_CACHE_MANIFESTS_STORE;
const STATE_STORE = CATALOG_CACHE_STATE_STORE;
const CREATORS_STORE = CATALOG_CACHE_CREATORS_STORE;

/**
 * @typedef {{
 *   entryId: number,
 *   createdAt: number,
 *   updatedAt: number,
 *   creator: string,
 *   assetId: string,
 *   providerId: number,
 *   manifestCid: string,
 *   title: string,
 *   active: boolean,
 * }} CachedCatalogEntry
 */

/**
 * @typedef {{
 *   creator: string,
 *   username: string,
 *   profilePieceCid: string,
 *   profileUrl: string,
 *   updatedAtMs: number,
 * }} CachedCreatorProfile
 */

/** @type {Promise<IDBDatabase> | null} */
let dbReady = null;

function openDb() {
  if (dbReady) return dbReady;
  dbReady = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error ?? new Error("indexedDB.open failed"));
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ENTRIES_STORE)) {
        const s = db.createObjectStore(ENTRIES_STORE, { keyPath: "entryId" });
        s.createIndex("byAssetId", "assetId", { unique: false });
      }
      if (!db.objectStoreNames.contains(MANIFESTS_STORE)) {
        db.createObjectStore(MANIFESTS_STORE, { keyPath: "videoId" });
      }
      if (!db.objectStoreNames.contains(STATE_STORE)) {
        db.createObjectStore(STATE_STORE, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(CREATORS_STORE)) {
        db.createObjectStore(CREATORS_STORE, { keyPath: "creator" });
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
  return dbReady;
}

/**
 * @template T
 * @param {IDBRequest<T>} req
 * @returns {Promise<T>}
 */
function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
    req.onsuccess = () => resolve(req.result);
  });
}

/**
 * @template T
 * @param {(db: IDBDatabase) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withDb(fn) {
  const db = await openDb();
  return fn(db);
}

/**
 * @param {CachedCatalogEntry[]} entries
 */
export async function cacheCatalogEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return;
  await withDb(async (db) => {
    const tx = db.transaction(ENTRIES_STORE, "readwrite");
    const store = tx.objectStore(ENTRIES_STORE);
    for (const row of entries) {
      store.put(row);
    }
    await new Promise((resolve, reject) => {
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
      tx.oncomplete = () => resolve(undefined);
    });
  });
}

/**
 * @param {{ limit?: number, activeOnly?: boolean }} [opts]
 * @returns {Promise<CachedCatalogEntry[]>}
 */
export async function loadCachedCatalogEntries(opts = {}) {
  const limit =
    Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : 50;
  const activeOnly = opts.activeOnly !== false;
  return withDb(async (db) => {
    const tx = db.transaction(ENTRIES_STORE, "readonly");
    const req = tx.objectStore(ENTRIES_STORE).getAll();
    const all = /** @type {CachedCatalogEntry[]} */ (await reqToPromise(req));
    all.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
      return b.entryId - a.entryId;
    });
    const filtered = activeOnly ? all.filter((x) => x.active) : all;
    return filtered.slice(0, limit);
  });
}

/**
 * @param {string} videoId
 * @returns {Promise<CachedCatalogEntry | null>}
 */
export async function findCachedEntryByVideoId(videoId) {
  const id = String(videoId || "").trim();
  if (!id) return null;
  return withDb(async (db) => {
    const tx = db.transaction(ENTRIES_STORE, "readonly");
    const index = tx.objectStore(ENTRIES_STORE).index("byAssetId");
    const req = index.getAll(id);
    const rows = /** @type {CachedCatalogEntry[]} */ (await reqToPromise(req));
    if (!rows.length) return null;
    rows.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
      return b.entryId - a.entryId;
    });
    return rows.find((x) => x.active) ?? rows[0] ?? null;
  });
}

/**
 * @returns {Promise<{ createdAt: number, entryId: number } | null>}
 */
export async function loadCatalogCursor() {
  return withDb(async (db) => {
    const tx = db.transaction(STATE_STORE, "readonly");
    const row = await reqToPromise(tx.objectStore(STATE_STORE).get("cursor"));
    if (!row || typeof row !== "object") return null;
    const createdAt = Number(/** @type {{ createdAt?: unknown }} */ (row).createdAt);
    const entryId = Number(/** @type {{ entryId?: unknown }} */ (row).entryId);
    if (!Number.isFinite(createdAt) || createdAt < 0) return null;
    if (!Number.isFinite(entryId) || entryId < 0) return null;
    return { createdAt: Math.floor(createdAt), entryId: Math.floor(entryId) };
  });
}

/**
 * @param {{ createdAt: number, entryId: number }} cursor
 */
export async function saveCatalogCursor(cursor) {
  await withDb(async (db) => {
    const tx = db.transaction(STATE_STORE, "readwrite");
    tx.objectStore(STATE_STORE).put({
      key: "cursor",
      createdAt: Math.floor(cursor.createdAt),
      entryId: Math.floor(cursor.entryId),
      updatedAtMs: Date.now(),
    });
    await new Promise((resolve, reject) => {
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
      tx.oncomplete = () => resolve(undefined);
    });
  });
}

/**
 * @returns {Promise<number>}
 */
export async function loadLastFullRefreshAtMs() {
  return withDb(async (db) => {
    const tx = db.transaction(STATE_STORE, "readonly");
    const row = await reqToPromise(tx.objectStore(STATE_STORE).get("full_refresh_at"));
    const value = Number(/** @type {{ value?: unknown }} */ (row)?.value);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  });
}

/**
 * @param {number} tsMs
 */
export async function saveLastFullRefreshAtMs(tsMs) {
  await withDb(async (db) => {
    const tx = db.transaction(STATE_STORE, "readwrite");
    tx.objectStore(STATE_STORE).put({
      key: "full_refresh_at",
      value: Math.floor(tsMs),
      updatedAtMs: Date.now(),
    });
    await new Promise((resolve, reject) => {
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
      tx.oncomplete = () => resolve(undefined);
    });
  });
}

/**
 * @param {string} videoId
 * @returns {Promise<{ videoId: string, manifestUrl: string, manifestDoc: unknown, fetchedAtMs: number } | null>}
 */
export async function loadManifestCache(videoId) {
  const id = String(videoId || "").trim();
  if (!id) return null;
  return withDb(async (db) => {
    const tx = db.transaction(MANIFESTS_STORE, "readonly");
    const row = await reqToPromise(tx.objectStore(MANIFESTS_STORE).get(id));
    if (!row || typeof row !== "object") return null;
    const manifestUrl =
      typeof /** @type {{ manifestUrl?: unknown }} */ (row).manifestUrl === "string"
        ? /** @type {{ manifestUrl: string }} */ (row).manifestUrl
        : "";
    if (!manifestUrl) return null;
    return /** @type {{ videoId: string, manifestUrl: string, manifestDoc: unknown, fetchedAtMs: number }} */ (
      row
    );
  });
}

/**
 * @param {{
 *   videoId: string,
 *   manifestUrl: string,
 *   manifestDoc: unknown,
 * }} input
 */
export async function saveManifestCache(input) {
  const videoId = String(input.videoId || "").trim();
  const manifestUrl = String(input.manifestUrl || "").trim();
  if (!videoId || !manifestUrl) return;
  await withDb(async (db) => {
    const tx = db.transaction(MANIFESTS_STORE, "readwrite");
    tx.objectStore(MANIFESTS_STORE).put({
      videoId,
      manifestUrl,
      manifestDoc: input.manifestDoc,
      fetchedAtMs: Date.now(),
    });
    await new Promise((resolve, reject) => {
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
      tx.oncomplete = () => resolve(undefined);
    });
  });
}

function normalizeCreatorKey(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.toLowerCase();
}

/**
 * @param {string[]} creators
 * @returns {Promise<CachedCreatorProfile[]>}
 */
export async function loadCachedCreatorProfiles(creators) {
  const wanted = Array.from(
    new Set(
      (Array.isArray(creators) ? creators : [])
        .map((addr) => normalizeCreatorKey(addr))
        .filter(Boolean),
    ),
  );
  if (!wanted.length) return [];
  return withDb(async (db) => {
    const tx = db.transaction(CREATORS_STORE, "readonly");
    const store = tx.objectStore(CREATORS_STORE);
    const rows = [];
    for (const creator of wanted) {
      const row = await reqToPromise(store.get(creator));
      if (!row || typeof row !== "object") continue;
      rows.push(/** @type {CachedCreatorProfile} */ (row));
    }
    return rows;
  });
}

/**
 * @param {CachedCreatorProfile[]} rows
 */
export async function saveCachedCreatorProfiles(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  await withDb(async (db) => {
    const tx = db.transaction(CREATORS_STORE, "readwrite");
    const store = tx.objectStore(CREATORS_STORE);
    for (const row of rows) {
      const creator = normalizeCreatorKey(row.creator);
      if (!creator) continue;
      store.put({
        creator,
        username: typeof row.username === "string" ? row.username : "",
        profilePieceCid:
          typeof row.profilePieceCid === "string" ? row.profilePieceCid : "",
        profileUrl: typeof row.profileUrl === "string" ? row.profileUrl : "",
        updatedAtMs:
          Number.isFinite(row.updatedAtMs) && row.updatedAtMs > 0
            ? Math.floor(row.updatedAtMs)
            : Date.now(),
      });
    }
    await new Promise((resolve, reject) => {
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
      tx.oncomplete = () => resolve(undefined);
    });
  });
}
