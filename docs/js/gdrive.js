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
      resolve();
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
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
export const ensureAuth = async () => {
  if (accessToken) return accessToken;

  await ensureGIS();

  return new Promise((resolve, reject) => {
    if (!tokenClient) {
      tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file",
        callback: (resp) => {
          if (resp.error) {
            reject(new Error(resp.error_description || resp.error));
            return;
          }
          accessToken = resp.access_token;
          setTimeout(() => {
            accessToken = null;
            notifyAuthChange();
          }, (resp.expires_in - 60) * 1000);
          notifyAuthChange();
          resolve(accessToken);
        },
        error_callback: (err) => {
          reject(new Error(err.message || "Google sign-in failed"));
        },
      });
    }

    tokenClient.requestAccessToken();
  });
};

export const isSignedIn = () => !!accessToken;

export const signOut = () => {
  if (accessToken) {
    window.google.accounts.oauth2.revoke(accessToken);
    accessToken = null;
    notifyAuthChange();
  }
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
  const token = await ensureAuth();
  const q = `'${folderId}' in parents and trashed = false and (mimeType = 'application/vnd.google-apps.folder' or mimeType = 'audio/mpeg')`;
  const fields = "files(id,name,mimeType,size)";
  const orderBy = "folder,name";
  const url = `${DRIVE_FILES_URL}?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(fields)}&orderBy=${encodeURIComponent(orderBy)}&pageSize=200`;

  const resp = await fetch(url, {
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
 * @returns {Promise<File[]>}
 */
export const downloadFiles = async (items) => {
  const token = await ensureAuth();
  const files = [];
  for (const item of items) {
    const resp = await fetch(
      `${DRIVE_FILES_URL}/${item.id}?alt=media`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!resp.ok) {
      console.warn(`Failed to download ${item.name}: ${resp.status}`);
      continue;
    }
    const blob = await resp.blob();
    files.push(new File([blob], item.name, { type: "audio/mpeg" }));
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
  const token = await ensureAuth();

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
