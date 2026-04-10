/**
 * gdrive.js
 *
 * Google Drive integration for BookForge.
 * Handles OAuth2 (via Google Identity Services) and Drive API v3
 * for listing, downloading, and uploading files.
 */

// Client ID is public by design in OAuth2 client-side flows.
const GOOGLE_CLIENT_ID = "306789600163-6hrqppjduqchesalvqp400rj78hbku8l.apps.googleusercontent.com";

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------
let accessToken = null;
let tokenClient = null;
let gisLoaded = false;
let authChangeCallback = null;
let tokenExpiryTimer = null;

/**
 * Register a callback that fires whenever sign-in state changes.
 * @param {(signedIn: boolean) => void} cb
 */
export const onAuthChange = (cb) => { authChangeCallback = cb; };

const notifyAuthChange = () => { authChangeCallback?.(!!accessToken); };

// ---------------------------------------------------------------------------
// Script loader
// ---------------------------------------------------------------------------
const loadScript = (src) =>
  new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      console.debug("GIS script already loaded:", src);
      resolve();
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => {
      console.debug("GIS script loaded:", src);
      resolve();
    };
    s.onerror = () => {
      console.error("Failed to load GIS script:", src);
      reject(new Error(`Failed to load ${src}`));
    };
    document.head.appendChild(s);
  });

const ensureGIS = async () => {
  if (gisLoaded) return;
  await loadScript("https://accounts.google.com/gsi/client");
  gisLoaded = true;
};

// ---------------------------------------------------------------------------
// Auth — Google Identity Services token model (implicit flow)
// ---------------------------------------------------------------------------

const TOKEN_STORAGE_KEY = "bf-gdrive-token";
const TOKEN_EXPIRY_KEY = "bf-gdrive-token-expiry";

/** Restore a previously cached token if it hasn't expired. */
const restoreCachedToken = () => {
  try {
    const cached = sessionStorage.getItem(TOKEN_STORAGE_KEY);
    const expiry = Number(sessionStorage.getItem(TOKEN_EXPIRY_KEY));
    if (cached && expiry && Date.now() < expiry) {
      accessToken = cached;
      // Schedule expiry cleanup (cancel any previous timer first)
      if (tokenExpiryTimer) clearTimeout(tokenExpiryTimer);
      tokenExpiryTimer = setTimeout(() => {
        tokenExpiryTimer = null;
        accessToken = null;
        sessionStorage.removeItem(TOKEN_STORAGE_KEY);
        sessionStorage.removeItem(TOKEN_EXPIRY_KEY);
        notifyAuthChange();
      }, expiry - Date.now());
      return true;
    }
  } catch { /* sessionStorage blocked */ }
  return false;
};

/** Cache token so it survives page reloads within the session. */
const cacheToken = (token, expiresInSec) => {
  try {
    const expiryMs = Date.now() + (expiresInSec - 60) * 1000;
    sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
    sessionStorage.setItem(TOKEN_EXPIRY_KEY, String(expiryMs));
  } catch { /* sessionStorage blocked */ }
};

// Try to restore on module load
restoreCachedToken();

// Pre-load GIS in the background so it is ready before the user clicks.
// This prevents the script-load network I/O from sitting between the user
// gesture and requestAccessToken() — iOS Safari drops popup permission after
// any macrotask (network/setTimeout) following the gesture.
ensureGIS().catch(() => {});

const DRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";


let lastScope = null;
let pendingResolve = null;
let pendingReject = null;
const initTokenClient = (scope, resolve, reject, promptMode) => {
  // Always update the pending callbacks so the current caller's promise settles
  pendingResolve = resolve;
  pendingReject = reject;

  // If scope changes, re-init the token client
  if (!tokenClient || lastScope !== scope) {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope,
      callback: (resp) => {
        if (resp.error) {
          console.error("GIS error in callback:", resp.error, resp.error_description);
          pendingReject?.(new Error(resp.error_description || resp.error));
          return;
        }
        if (!resp.access_token) {
          console.error("No access token in GIS response:", resp);
        }
        accessToken = resp.access_token;
        cacheToken(accessToken, resp.expires_in);
        if (tokenExpiryTimer) clearTimeout(tokenExpiryTimer);
        tokenExpiryTimer = setTimeout(() => {
          tokenExpiryTimer = null;
          accessToken = null;
          sessionStorage.removeItem(TOKEN_STORAGE_KEY);
          sessionStorage.removeItem(TOKEN_EXPIRY_KEY);
          notifyAuthChange();
        }, (resp.expires_in - 60) * 1000);
        notifyAuthChange();
        pendingResolve?.(accessToken);
      },
      error_callback: (err) => {
        console.error("[GIS] error_callback:", err);
        pendingReject?.(new Error(err.message || "Google sign-in failed"));
      },
    });
    lastScope = scope;
  }
  tokenClient.requestAccessToken({ prompt: promptMode });
};


/**
 * Ensure authentication for a given Drive scope.
 * @param {string} scope - OAuth scope to request (e.g., DRIVE_READONLY_SCOPE or DRIVE_FILE_SCOPE)
 * @returns {Promise<string>} accessToken
 */
export const ensureAuth = async (scope) => {
  // 1. Use in-memory token if available
  if (accessToken) return accessToken;

  // 2. Try cached token from sessionStorage.
  // restoreCachedToken already validates the expiry timestamp (with a 60-second
  // buffer), so a separate tokeninfo round-trip on every page load is unnecessary.
  if (restoreCachedToken()) {
    notifyAuthChange();
    return accessToken;
  }

  // 3. Interactive consent (shows popup).
  // We skip the prompt:"none" silent attempt intentionally: it opens a transient
  // cross-origin popup that triggers COOP warnings and burns the user-gesture
  // token, causing the real consent popup to be blocked or to silently fail.
  // Cached-token handling above covers the silent-refresh case.
  //
  // iOS Safari: only load GIS with await if it is not already loaded.
  // When gisLoaded=true, calling initTokenClient synchronously (without any
  // extra await/microtask) keeps requestAccessToken() within the same
  // user-gesture callback, which is required for iOS to grant popup permission.
  if (!gisLoaded) {
    try {
      await ensureGIS();
    } catch (err) {
      console.error("Failed to load Google Identity Services:", err);
      throw new Error("Failed to load Google Identity Services: " + err.message, { cause: err });
    }
  }
  return new Promise((resolve, reject) => {
    initTokenClient(scope, resolve, reject, "");
  });
};

export const isSignedIn = () => !!accessToken;

export const signOut = () => {
  if (accessToken) {
    window.google.accounts.oauth2.revoke(accessToken);
    accessToken = null;
    if (tokenExpiryTimer) { clearTimeout(tokenExpiryTimer); tokenExpiryTimer = null; }
    try {
      sessionStorage.removeItem(TOKEN_STORAGE_KEY);
      sessionStorage.removeItem(TOKEN_EXPIRY_KEY);
    } catch { /* ignore */ }
    notifyAuthChange();
  }
};

// ---------------------------------------------------------------------------
// Fetch with timeout (for metadata calls, not large downloads)
// ---------------------------------------------------------------------------
const FETCH_TIMEOUT_MS = 15000;

const fetchWithTimeout = (url, opts = {}) => {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(id));
};

// ---------------------------------------------------------------------------
// Drive API — List files in a folder
// ---------------------------------------------------------------------------
const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";

/**
 * List files in a Drive folder.
 * Returns folders first, then audio files, sorted by name.
 *
 * @param {string} folderId - "root" for My Drive top level
 * @returns {Promise<Array<{id, name, mimeType, size}>>}
 */
export const listFolder = async (folderId = "root") => {
  // Validate folderId to prevent query injection — Drive IDs are alphanumeric + hyphens,
  // or the special literal "root".
  if (!/^[a-zA-Z0-9_-]+$/.test(folderId)) {
    throw new Error(`Invalid folderId: ${folderId}`);
  }
  const token = await ensureAuth(DRIVE_READONLY_SCOPE);
  // Also include video/mp4 because Google Drive (especially its iOS app) often
  // stores M4B / M4A files with mimeType='video/mp4' rather than an audio type.
  // The picker in drive-ui.js filters these to known audio extensions so plain
  // MP4 video files are not shown to the user.
  const q = `'${folderId}' in parents and trashed = false and (mimeType = 'application/vnd.google-apps.folder' or mimeType contains 'audio/' or mimeType = 'video/mp4')`;
  const fields = "files(id,name,mimeType,size)";
  const orderBy = "folder,name";
  const url = `${DRIVE_FILES_URL}?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(fields)}&orderBy=${encodeURIComponent(orderBy)}&pageSize=200`;

  const resp = await fetchWithTimeout(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Drive list failed (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  return data.files || [];
};

// ---------------------------------------------------------------------------
// Drive API — Download files
// ---------------------------------------------------------------------------

/**
 * Download Drive files by ID and return them as File objects.
 * @param {Array<{id, name}>} items
 * @param {(index: number, name: string, loaded: number, total: number, done: boolean) => void} [onProgress]
 * @returns {Promise<File[]>}
 */
// iOS Safari has unreliable ReadableStream support for cross-origin fetches
// (broken on iOS < 14.5; partially broken on 14.5–15).  Always use the
// simpler resp.blob() path there to avoid silent download failures.
const isIOS = typeof navigator !== "undefined" &&
  /iPad|iPhone|iPod/.test(navigator.userAgent) && !("MSStream" in window);

export const downloadFiles = async (items, onProgress) => {
  const token = await ensureAuth(DRIVE_READONLY_SCOPE);
  const files = [];

  // Derive MIME type from filename extension so M4B, FLAC, OGG etc. are
  // correctly identified downstream (metadata.js branches on isMp3 check).
  const mimeFromName = (name, fallbackMime) => {
    const ext = (name.match(/\.([^.]+)$/) || [])[1]?.toLowerCase();
    const map = {
      mp3: "audio/mpeg", m4a: "audio/mp4", m4b: "audio/x-m4b",
      aac: "audio/aac", ogg: "audio/ogg", oga: "audio/ogg",
      opus: "audio/ogg", flac: "audio/flac", wav: "audio/wav",
    };
    return map[ext] || fallbackMime || "audio/mpeg";
  };

  // Download one item, returning a File or null on failure.
  // Tries streaming (for progress) first; falls back to a fresh blob() fetch.
  const fetchItem = async (item, mimeType, idx) => {
    const fetchOpts = { headers: { Authorization: `Bearer ${token}` } };
    const url = `${DRIVE_FILES_URL}/${item.id}?alt=media`;

    const resp = await fetch(url, fetchOpts);
    if (!resp.ok) {
      console.warn(`Failed to download ${item.name}: ${resp.status}`);
      onProgress?.(idx, item.name, 0, 0, true);
      return null;
    }

    const total = parseInt(resp.headers.get("Content-Length") || "0", 10);
    const canStream = !isIOS && onProgress && resp.body && total > 0;

    if (canStream) {
      const reader = resp.body.getReader();
      try {
        const chunks = [];
        let loaded = 0;
        onProgress(idx, item.name, 0, total, false);
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          loaded += value.length;
          onProgress(idx, item.name, loaded, total, false);
        }
        const blob = new Blob(chunks, { type: mimeType });
        onProgress(idx, item.name, total, total, true);
        return new File([blob], item.name, { type: mimeType });
      } catch (streamErr) {
        console.warn(`Stream read failed for ${item.name}, retrying with blob():`, streamErr);
        reader.releaseLock();
        // Body partially consumed — issue a fresh request for the blob() fallback.
        const retry = await fetch(url, fetchOpts).catch(() => null);
        if (!retry?.ok) {
          onProgress?.(idx, item.name, 0, 0, true);
          return null;
        }
        const blob = await retry.blob().catch(() => null);
        if (!blob) { onProgress?.(idx, item.name, 0, 0, true); return null; }
        const finalType = blob.type && blob.type !== "application/octet-stream" ? blob.type : mimeType;
        onProgress?.(idx, item.name, blob.size, blob.size, true);
        return new File([blob], item.name, { type: finalType });
      }
    } else {
      onProgress?.(idx, item.name, 0, 0, false);
      const blob = await resp.blob();
      // resp.blob() preserves the Content-Type from the response; override only
      // if the server sent a generic type (e.g. application/octet-stream).
      const finalType = blob.type && blob.type !== "application/octet-stream" ? blob.type : mimeType;
      onProgress?.(idx, item.name, blob.size, blob.size, true);
      return new File([blob], item.name, { type: finalType });
    }
  };

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const mimeType = mimeFromName(item.name, item.mimeType);
    const file = await fetchItem(item, mimeType, i);
    if (file) files.push(file);
  }
  return files;
};

// ---------------------------------------------------------------------------
// Drive API — Upload (multipart)
// ---------------------------------------------------------------------------

/**
 * Upload a Blob to Google Drive.
 * @param {Blob} blob
 * @param {string} filename
 * @returns {Promise<{id: string, webViewLink: string}>}
 */
export const uploadToDrive = async (blob, filename) => {
  const token = await ensureAuth(DRIVE_FILE_SCOPE);

  const metadata = {
    name: filename,
    mimeType: blob.type || "audio/x-m4b",
  };

  const boundary = "bookforge_boundary_" + crypto.randomUUID().replace(/-/g, "");
  const metaPart =
    `--${boundary}\r\n` +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    JSON.stringify(metadata) +
    "\r\n";
  const mediaPart =
    `--${boundary}\r\n` +
    `Content-Type: ${blob.type || "audio/x-m4b"}\r\n\r\n`;
  const closePart = `\r\n--${boundary}--`;

  const body = new Blob([metaPart, mediaPart, blob, closePart]);

  const resp = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    }
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Drive upload failed (${resp.status}): ${text}`);
  }

  return resp.json();
};

// ---------------------------------------------------------------------------
// Drive auth wrapper (all platforms use GIS popup — no redirect URI needed)
// ---------------------------------------------------------------------------

// Stubs kept for backward-compatibility with app.js imports.
// The iOS redirect flow was removed: it requires a redirect_uri registered in
// Google Cloud Console, which caused redirect_uri_mismatch on mobile.
// GIS initTokenClient only needs Authorized JavaScript Origins.
export const handleRedirectReturn = () => false;
export const hasPendingRedirect = () => false;
export const clearPendingRedirect = () => {};

export const ensureDriveAuth = (scope) => ensureAuth(scope);
