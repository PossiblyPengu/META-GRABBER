/**
 * session.js
 *
 * IndexedDB-backed session persistence for BookForge.
 * Stores tracks (with MP3 blobs), cover art, form fields,
 * wizard step, and inferred book info.
 */

const DB_NAME = "bookforge";
const DB_VERSION = 1;
const STORE = "session";
const TRACK_STORE = "sessionTracks";
const SESSION_KEY = "session";

const openDB = () =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(TRACK_STORE)) {
        db.createObjectStore(TRACK_STORE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/**
 * Save the current session state to IndexedDB.
 * @param {object} state
 * @param {string} state.currentStep
 * @param {object} state.formFields
 * @param {object|null} state.inferredBook
 * @param {Blob|null} state.coverBlob
 * @param {Array} state.tracks - [{ blob, fileName, fileType, fileLastModified, chapterName, meta }]
 */
export const saveSession = async (state) => {
  const {
    trackBlobs = [],
    pruneTrackStore = false,
    ...rest
  } = state || {};
  try {
    const db = await openDB();
    const stores = pruneTrackStore || trackBlobs.length ? [STORE, TRACK_STORE] : [STORE];
    const tx = db.transaction(stores, "readwrite");
    const sessionStore = tx.objectStore(STORE);
    sessionStore.put({
      id: SESSION_KEY,
      version: 1,
      savedAt: Date.now(),
      ...rest,
    });

    if (trackBlobs.length) {
      const blobStore = tx.objectStore(TRACK_STORE);
      trackBlobs.forEach(({ key, blob }) => {
        if (!key || !blob) return;
        blobStore.put({ key, blob });
      });
    }

    if (pruneTrackStore) {
      const activeKeys = new Set((rest.tracks || []).map((t) => t.fileKey).filter(Boolean));
      const blobStore = tx.objectStore(TRACK_STORE);
      blobStore.openCursor().onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor) return;
        if (!activeKeys.has(cursor.key)) {
          cursor.delete();
        }
        cursor.continue();
      };
    }

    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (err) {
    if (err?.name === "QuotaExceededError") {
      console.warn("Session save failed: IndexedDB storage quota exceeded");
    } else {
      console.warn("Session save failed:", err);
    }
    return { error: err?.name || "unknown" };
  }
};

/**
 * Load the saved session from IndexedDB.
 * @returns {Promise<object|null>} The session state, or null if none exists.
 */
export const loadSession = async () => {
  try {
    const db = await openDB();
    const tx = db.transaction([STORE, TRACK_STORE], "readonly");
    const sessionReq = tx.objectStore(STORE).get(SESSION_KEY);
    const session = await new Promise((resolve, reject) => {
      sessionReq.onsuccess = () => resolve(sessionReq.result || null);
      sessionReq.onerror = () => reject(sessionReq.error);
    });
    if (!session) {
      db.close();
      return null;
    }

    const tracks = Array.isArray(session.tracks) ? session.tracks : [];
    const blobStore = tx.objectStore(TRACK_STORE);
    await Promise.all(tracks.map((track, index) => new Promise((resolve, reject) => {
      if (!track?.fileKey) {
        resolve();
        return;
      }
      const blobReq = blobStore.get(track.fileKey);
      blobReq.onsuccess = () => {
        tracks[index] = { ...track, blob: blobReq.result?.blob || null };
        resolve();
      };
      blobReq.onerror = () => reject(blobReq.error);
    })));

    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return { ...session, tracks };
  } catch (err) {
    console.warn("Session load failed:", err);
    return null;
  }
};

/**
 * Delete the saved session from IndexedDB.
 */
export const clearSession = async () => {
  try {
    const db = await openDB();
    const tx = db.transaction([STORE, TRACK_STORE], "readwrite");
    tx.objectStore(STORE).delete(SESSION_KEY);
    tx.objectStore(TRACK_STORE).clear();
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (err) {
    console.warn("Session clear failed:", err);
  }
};
