/* global caches, Headers, Request, Response */
/**
 * sw.js — BookForge unified service worker
 *
 * Combines cross-origin isolation (COEP/COOP headers for SharedArrayBuffer)
 * with PWA app-shell caching. Replaces the separate coi-serviceworker.js
 * to avoid dual-SW registration conflicts.
 */

let coepCredentialless = false;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      /**
       * Add cross-origin isolation headers ONLY to files in the explicit allowlist.
       * Never add to HTML, JS, CSS, manifest, favicon, or any app shell files.
       * Extend the allowlist as needed for new WASM or special files.
       */
      function addIsolationHeaders(response, url) {
        if (!response || response.status === 0) return response;
        if (!url) return response;

        // Explicit allowlist for COOP/COEP headers (add more as needed)
        const COOP_COEP_ALLOWLIST = [
          // Example: WASM files only
          /\.wasm(\?.*)?$/i,
          // Add more patterns here if needed
        ];

        // Explicit denylist for app shell files (never add headers)
        const COOP_COEP_DENYLIST = [
          /index\.html(\?.*)?$/i,
          /\.js(\?.*)?$/i,
          /\.css(\?.*)?$/i,
          /manifest\.json(\?.*)?$/i,
          /favicon\.ico(\?.*)?$/i,
          // Add more patterns here if needed
        ];

        // Denylist check: never add headers to these
        for (const pattern of COOP_COEP_DENYLIST) {
          if (pattern.test(url)) return response;
        }

        // Allowlist check: only add headers to these
        let shouldAddHeaders = false;
        for (const pattern of COOP_COEP_ALLOWLIST) {
          if (pattern.test(url)) {
            shouldAddHeaders = true;
            break;
          }
        }
        if (!shouldAddHeaders) return response;

        // Add COOP/COEP headers
        const headers = new Headers(response.headers);
        headers.set(
          "Cross-Origin-Embedder-Policy",
          coepCredentialless ? "credentialless" : "require-corp"
        );
        if (!coepCredentialless) {
          headers.set("Cross-Origin-Resource-Policy", "cross-origin");
        }
        headers.set("Cross-Origin-Opener-Policy", "same-origin");
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }
  "./js/history.js",
  "./js/metadata.js",
  "./js/session.js",
  "./js/waveform.js",
  "./manifest.json",
];

// ---------------------------------------------------------------------------
// Fetch — adds COEP/COOP headers + stale-while-revalidate caching
// ---------------------------------------------------------------------------
self.addEventListener("fetch", (event) => {
  const r = event.request;

  // Skip non-GET and browser internal requests
  if (r.method !== "GET") return;
  if (r.cache === "only-if-cached" && r.mode !== "same-origin") return;

  const url = new URL(r.url);
  const isSameOrigin = url.origin === self.location.origin;

  // Cross-origin requests: just add isolation headers (no caching)
  if (!isSameOrigin) {
    const request = (coepCredentialless && r.mode === "no-cors")
      ? new Request(r, { credentials: "omit" })
      : r;
    event.respondWith(
      fetch(request).then((resp) => addIsolationHeaders(resp, r.url))
    );
    return;
  }

  // Same-origin navigation: network-first with offline fallback
  if (r.mode === "navigate") {
    event.respondWith(
      fetch(r)
        .then((resp) => addIsolationHeaders(resp, r.url))
        .catch(() => caches.match("./index.html").then((c) => c ? addIsolationHeaders(c, r.url) : c))
    );
    return;
  }

  // Same-origin assets: cache-first, update cache in background
  event.respondWith(
    caches.match(r).then((cached) => {
      if (cached) {
        // Update cache in background (don't block response)
        fetch(r).then((resp) => {
          if (resp.ok) {
            caches.open(CACHE_NAME).then((cache) => cache.put(r, resp));
          }
        }).catch(() => {});
        return addIsolationHeaders(cached, r.url);
      }
      // Not cached — fetch, cache, and return
      return fetch(r).then((resp) => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(r, clone));
        }
        return addIsolationHeaders(resp, r.url);
      });
    })
  );
});

/**
 * Add cross-origin isolation headers to a response so SharedArrayBuffer works.
 */
function addIsolationHeaders(response, url) {
  if (!response || response.status === 0) return response;
  // Only add COOP/COEP headers to WASM files (or other specific types if needed)
  // Do NOT add to index.html, JS, CSS, manifest, or other app shell files
  if (
    !url ||
    /index\.html(\?.*)?$/.test(url) ||
    /\.js(\?.*)?$/.test(url) ||
    /\.css(\?.*)?$/.test(url) ||
    /manifest\.json(\?.*)?$/.test(url) ||
    /favicon\.ico(\?.*)?$/.test(url)
  ) {
    return response;
  }
  // Only add to .wasm or other explicitly listed files
  if (!/\.wasm(\?.*)?$/.test(url)) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set(
    "Cross-Origin-Embedder-Policy",
    coepCredentialless ? "credentialless" : "require-corp"
  );
  if (!coepCredentialless) {
    headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  }
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
