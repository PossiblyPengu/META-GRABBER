/**
 * gdrive.js
 *
 * Google Drive integration for M4B Foundry.
 * Handles OAuth2 (via Google Identity Services), the Google Picker for
 * selecting files, and Drive API v3 for downloading / uploading.
 *
 * The user must supply their own Google Cloud Client ID and API Key
 * via the in-app settings dialog. Values are persisted in localStorage.
 */

// ---------------------------------------------------------------------------
// Configuration (localStorage-backed)
// ---------------------------------------------------------------------------
const STORAGE_CLIENT_ID = "m4b_gdrive_client_id";
const STORAGE_API_KEY = "m4b_gdrive_api_key";

export const getConfig = () => ({
  clientId: localStorage.getItem(STORAGE_CLIENT_ID) || "",
  apiKey: localStorage.getItem(STORAGE_API_KEY) || "",
});

export const saveConfig = (clientId, apiKey) => {
  localStorage.setItem(STORAGE_CLIENT_ID, clientId.trim());
  localStorage.setItem(STORAGE_API_KEY, apiKey.trim());
  // Reset cached state so next operation re-initialises with new creds
  tokenClient = null;
  accessToken = null;
  pickerInited = false;
};

export const isConfigured = () => {
  const { clientId, apiKey } = getConfig();
  return clientId.length > 0 && apiKey.length > 0;
};

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------
let accessToken = null;
let tokenClient = null;
let gisLoaded = false;
let gapiLoaded = false;
let pickerInited = false;

// ---------------------------------------------------------------------------
// Script loaders (dynamic, like metadata.js loads jsmediatags)
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

const ensureGAPI = async () => {
  if (gapiLoaded) return;
  await loadScript("https://apis.google.com/js/api.js");
  await new Promise((resolve) => window.gapi.load("picker", resolve));
  gapiLoaded = true;
  pickerInited = true;
};

// ---------------------------------------------------------------------------
// Auth — Google Identity Services token model (implicit flow)
// ---------------------------------------------------------------------------

/**
 * Ensure we have a valid access token. Prompts the user to sign in if
 * no token exists. Returns the token string.
 */
export const ensureAuth = () =>
  new Promise(async (resolve, reject) => {
    if (accessToken) {
      resolve(accessToken);
      return;
    }

    const { clientId } = getConfig();
    if (!clientId) {
      reject(new Error("Google Drive Client ID not configured. Open Settings to add it."));
      return;
    }

    await ensureGIS();

    if (!tokenClient) {
      tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: "https://www.googleapis.com/auth/drive.file",
        callback: (resp) => {
          if (resp.error) {
            reject(new Error(resp.error_description || resp.error));
            return;
          }
          accessToken = resp.access_token;
          // Auto-clear when it expires
          setTimeout(() => { accessToken = null; }, (resp.expires_in - 60) * 1000);
          resolve(accessToken);
        },
        error_callback: (err) => {
          reject(new Error(err.message || "Google sign-in failed"));
        },
      });
    }

    tokenClient.requestAccessToken();
  });

export const isSignedIn = () => !!accessToken;

export const signOut = () => {
  if (accessToken) {
    window.google.accounts.oauth2.revoke(accessToken);
    accessToken = null;
  }
};

// ---------------------------------------------------------------------------
// Import — Google Picker → Drive API download
// ---------------------------------------------------------------------------

/**
 * Open the Google Picker filtered to audio files, download the selected
 * files via the Drive API, and return them as File objects.
 *
 * @returns {Promise<File[]>}
 */
export const pickFiles = async () => {
  const token = await ensureAuth();
  const { apiKey } = getConfig();

  await ensureGAPI();

  return new Promise((resolve, reject) => {
    const view = new window.google.picker.DocsView(window.google.picker.ViewId.DOCS)
      .setMimeTypes("audio/mpeg")
      .setMode(window.google.picker.DocsViewMode.LIST);

    const picker = new window.google.picker.PickerBuilder()
      .addView(view)
      .enableFeature(window.google.picker.Feature.MULTISELECT_ENABLED)
      .setOAuthToken(token)
      .setDeveloperKey(apiKey)
      .setTitle("Select MP3 files")
      .setCallback(async (data) => {
        if (data.action === window.google.picker.Action.CANCEL) {
          resolve([]);
          return;
        }
        if (data.action !== window.google.picker.Action.PICKED) return;

        try {
          const files = await downloadPickedFiles(data.docs, token);
          resolve(files);
        } catch (err) {
          reject(err);
        }
      })
      .build();

    picker.setVisible(true);
  });
};

/**
 * Download an array of Picker doc metadata into File objects.
 */
const downloadPickedFiles = async (docs, token) => {
  const files = [];
  for (const doc of docs) {
    const resp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${doc.id}?alt=media`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!resp.ok) {
      console.warn(`Failed to download ${doc.name}: ${resp.status}`);
      continue;
    }
    const blob = await resp.blob();
    const file = new File([blob], doc.name, { type: "audio/mpeg" });
    files.push(file);
  }
  return files;
};

// ---------------------------------------------------------------------------
// Export — Upload to Google Drive (multipart)
// ---------------------------------------------------------------------------

/**
 * Upload a Blob to Google Drive using a multipart request.
 *
 * @param {Blob} blob  - The file content
 * @param {string} filename - Desired filename on Drive
 * @returns {Promise<{id: string, webViewLink: string}>}
 */
export const uploadToDrive = async (blob, filename) => {
  const token = await ensureAuth();

  const metadata = {
    name: filename,
    mimeType: blob.type || "audio/x-m4b",
  };

  // Build multipart body
  const boundary = "m4b_foundry_boundary_" + Date.now();
  const metaPart =
    `--${boundary}\r\n` +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    JSON.stringify(metadata) +
    "\r\n";

  const closePart = `\r\n--${boundary}--`;

  const mediaPart =
    `--${boundary}\r\n` +
    `Content-Type: ${blob.type || "audio/x-m4b"}\r\n\r\n`;

  // Assemble as a single Blob for streaming
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
