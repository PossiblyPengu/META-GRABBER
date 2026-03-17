/**
 * gdrive.js
 *
 * Google Drive integration for BookForge.
 * Handles OAuth2 (via Google Identity Services), the Google Picker for
 * selecting files, and Drive API v3 for downloading / uploading.
 */

// Client ID is public by design in OAuth2 client-side flows.
// API Key is restricted by HTTP referrer and Picker API only in Google Cloud Console.
const GOOGLE_CLIENT_ID = "306789600163-6hrqppjduqchesalvqp400rj78hbku8l.apps.googleusercontent.com";
const GOOGLE_API_KEY = "AIzaSyCRyWZvo0VbiUQpzbYRqbN2o7Katf3PuvQ";

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------
let accessToken = null;
let tokenClient = null;
let gisLoaded = false;
let gapiLoaded = false;
let authChangeCallback = null;

/**
 * Register a callback that fires whenever sign-in state changes.
 * @param {(signedIn: boolean) => void} cb
 */
export const onAuthChange = (cb) => { authChangeCallback = cb; };

const notifyAuthChange = () => { authChangeCallback?.(!!accessToken); };

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
};

// ---------------------------------------------------------------------------
// Auth — Google Identity Services token model (implicit flow)
// ---------------------------------------------------------------------------

/**
 * Ensure we have a valid access token. Prompts the user to sign in if
 * no token exists. Returns the token string.
 */
export const ensureAuth = async () => {
  if (accessToken) return accessToken;

  await ensureGIS();

  return new Promise((resolve, reject) => {
    if (!tokenClient) {
      tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: "https://www.googleapis.com/auth/drive.file",
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

  await ensureGAPI();

  return new Promise((resolve, reject) => {
    const view = new window.google.picker.DocsView(window.google.picker.ViewId.DOCS)
      .setMimeTypes("audio/mpeg")
      .setMode(window.google.picker.DocsViewMode.LIST);

    const picker = new window.google.picker.PickerBuilder()
      .addView(view)
      .enableFeature(window.google.picker.Feature.MULTISELECT_ENABLED)
      .setOAuthToken(token)
      .setDeveloperKey(GOOGLE_API_KEY)
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
  const boundary = "bookforge_boundary_" + Date.now();
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
