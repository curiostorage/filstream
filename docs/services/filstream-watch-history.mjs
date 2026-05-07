/**
 * Client-side “watched past 95%” markers and resume position for catalog videos (localStorage).
 * - `watched-<videoId>` → `"1"`
 * - `position-<videoId>` → whole seconds (string) for resume playback
 */

/**
 * @param {string} id Trimmed asset / video id
 */
export function watchedStorageKey(id) {
  return `watched-${id}`;
}

/**
 * @param {string} videoId
 */
export function hasWatchedTo95Percent(videoId) {
  const id = String(videoId || "").trim();
  if (!id) return false;
  try {
    return localStorage.getItem(watchedStorageKey(id)) != null;
  } catch {
    return false;
  }
}

/**
 * @param {string} videoId
 * @returns {boolean} True if this call newly persisted the marker.
 */
export function markWatchedTo95Percent(videoId) {
  const id = String(videoId || "").trim();
  if (!id) return false;
  const key = watchedStorageKey(id);
  try {
    if (localStorage.getItem(key) != null) return false;
    localStorage.setItem(key, "1");
  } catch {
    return false;
  }
  return true;
}

/**
 * @param {string} id Trimmed asset / video id
 */
export function positionStorageKey(id) {
  return `position-${id}`;
}

/**
 * @param {string} videoId
 * @returns {number | null} Saved whole seconds, or null if missing / invalid.
 */
export function getResumePositionSeconds(videoId) {
  const id = String(videoId || "").trim();
  if (!id) return null;
  try {
    const v = localStorage.getItem(positionStorageKey(id));
    if (v == null || v === "") return null;
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n < 0) return null;
    return n;
  } catch {
    return null;
  }
}

/**
 * @param {string} videoId
 * @param {number} seconds
 */
export function setResumePositionSeconds(videoId, seconds) {
  const id = String(videoId || "").trim();
  if (!id) return;
  const sec = Math.floor(Number(seconds));
  if (!Number.isFinite(sec) || sec < 0) return;
  try {
    localStorage.setItem(positionStorageKey(id), String(sec));
  } catch {
    /* ignore quota / private mode */
  }
}

/**
 * @param {string} videoId
 */
export function clearResumePosition(videoId) {
  const id = String(videoId || "").trim();
  if (!id) return;
  try {
    localStorage.removeItem(positionStorageKey(id));
  } catch {
    /* ignore */
  }
}
