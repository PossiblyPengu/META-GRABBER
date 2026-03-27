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

/** Validate that a cached token is still accepted by Google. */
const validateToken = async (token) => {
  try {
    const resp = await fetch(`https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=${token}`);
    return resp.ok;
  } catch {
    return false;
  }
};

// Try to restore on module load
restoreCachedToken();

const DRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";


let lastScope = null;
const initTokenClient = (scope, resolve, reject, promptMode) => {
  // If scope changes, re-init the token client
  if (!tokenClient || lastScope !== scope) {
    console.debug("[GIS] Initializing token client", { client_id: GOOGLE_CLIENT_ID, scope, promptMode, time: new Date().toISOString(), stack: (new Error().stack) });
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope,
      callback: (resp) => {
        console.debug("[GIS] Callback response", { resp, time: new Date().toISOString(), stack: (new Error().stack) });
        if (resp.error) {
          console.error("GIS error in callback:", resp.error, resp.error_description);
          reject(new Error(resp.error_description || resp.error));
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
        resolve(accessToken);
      },
      error_callback: (err) => {
        console.error("[GIS] error_callback", { err, time: new Date().toISOString(), stack: (new Error().stack) });
        reject(new Error(err.message || "Google sign-in failed"));
      },
    });
    lastScope = scope;
  }
  console.debug("[GIS] Requesting access token", { prompt: promptMode, scope, time: new Date().toISOString(), stack: (new Error().stack) });
  tokenClient.requestAccessToken({ prompt: promptMode });
};


/**
 * Ensure authentication for a given Drive scope.
 * @param {string} scope - OAuth scope to request (e.g., DRIVE_READONLY_SCOPE or DRIVE_FILE_SCOPE)
 * @returns {Promise<string>} accessToken
 */
export const ensureAuth = async (scope) => {
  console.debug("[GIS] ensureAuth called", { scope, time: new Date().toISOString(), stack: (new Error().stack) });
  // 1. Use in-memory token if available
  if (accessToken) {
    console.debug("[GIS] Using in-memory access token", { time: new Date().toISOString(), stack: (new Error().stack) });
    return accessToken;
  }

  // 2. Try cached token from sessionStorage
  if (restoreCachedToken()) {
    console.debug("[GIS] Restored cached token from sessionStorage", { time: new Date().toISOString(), stack: (new Error().stack) });
    const valid = await validateToken(accessToken);
    if (valid) {
      console.debug("[GIS] Cached token is valid", { time: new Date().toISOString(), stack: (new Error().stack) });
      notifyAuthChange();
      return accessToken;
    }
    // Cached token expired/revoked — clear it
    console.debug("[GIS] Cached token expired or revoked", { time: new Date().toISOString(), stack: (new Error().stack) });
    accessToken = null;
    sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    sessionStorage.removeItem(TOKEN_EXPIRY_KEY);
  }

  try {
    await ensureGIS();
    console.debug("[GIS] GIS library loaded", { time: new Date().toISOString(), stack: (new Error().stack) });
  } catch (err) {
    console.error("Failed to load Google Identity Services:", err);
    throw new Error("Failed to load Google Identity Services: " + err.message, { cause: err });
  }

  // 3. Try silent re-auth (no popup if user previously consented)
  try {
    console.debug("[GIS] Attempting silent GIS re-auth", { time: new Date().toISOString(), stack: (new Error().stack) });
    return await new Promise((resolve, reject) => {
      initTokenClient(scope, resolve, reject, "none");
    });
  } catch (e) {
    console.debug("[GIS] Silent GIS re-auth failed", { error: e, time: new Date().toISOString(), stack: (new Error().stack) });
    // Silent auth failed — fall through to interactive prompt
  }

  // 4. Interactive consent (shows popup)
  console.debug("[GIS] Requesting interactive GIS consent", { time: new Date().toISOString(), stack: (new Error().stack) });
  return new Promise((resolve, reject) => {
    initTokenClient(scope, resolve, reject, "consent");
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
  const token = await ensureAuth(DRIVE_READONLY_SCOPE);
  const q = `'${folderId}' in parents and trashed = false and (mimeType = 'application/vnd.google-apps.folder' or mimeType = 'audio/mpeg')`;
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
export const downloadFiles = async (items, onProgress) => {
  const token = await ensureAuth(DRIVE_READONLY_SCOPE);
  const files = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const resp = await fetch(
      `${DRIVE_FILES_URL}/${item.id}?alt=media`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!resp.ok) {
      console.warn(`Failed to download ${item.name}: ${resp.status}`);
      onProgress?.(i, item.name, 0, 0, true);
      continue;
    }
    const total = parseInt(resp.headers.get("Content-Length") || "0", 10);
    if (onProgress && resp.body && total > 0) {
      const reader = resp.body.getReader();
      try {
        const chunks = [];
        let loaded = 0;
        onProgress(i, item.name, 0, total, false);
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          loaded += value.length;
          onProgress(i, item.name, loaded, total, false);
        }
        const blob = new Blob(chunks, { type: "audio/mpeg" });
        files.push(new File([blob], item.name, { type: "audio/mpeg" }));
        onProgress(i, item.name, total, total, true);
      } catch (err) {
        console.warn(`Stream read failed for ${item.name}:`, err);
        onProgress(i, item.name, 0, 0, true);
      } finally {
        reader.releaseLock();
      }
    } else {
      onProgress?.(i, item.name, 0, 0, false);
      const blob = await resp.blob();
      files.push(new File([blob], item.name, { type: "audio/mpeg" }));
      onProgress?.(i, item.name, blob.size, blob.size, true);
    }
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

  const boundary = "bookforge_boundary_" + Date.now();
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

  const resp = await fetchWithTimeout(
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
