
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
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("message", (ev) => {
  if (!ev.data) return;
  if (ev.data.type === "deregister") {
    self.registration
      .unregister()
      .then(() => self.clients.matchAll())
      .then((clients) => clients.forEach((c) => c.navigate(c.url)));
  } else if (ev.data.type === "coepCredentialless") {
    coepCredentialless = ev.data.value;
  }
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const CACHE_NAME = "bookforge-v2";
const APP_SHELL = [
  "./",
  "./index.html",
  "./css/main.css",
  "./js/app.js",
  "./js/book-lookup.js",
  "./js/book-parser.js",
  "./js/compiler.js",
  "./js/drive-ui.js",
  "./js/gdrive.js",
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
      fetch(request).then((resp) => addIsolationHeaders(resp))
    );
    return;
  }

  // Same-origin navigation: network-first with offline fallback
  if (r.mode === "navigate") {
    event.respondWith(
      fetch(r)
        .then((resp) => addIsolationHeaders(resp))
        .catch(() => caches.match("./index.html").then((c) => c ? addIsolationHeaders(c) : c))
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
        return addIsolationHeaders(cached);
      }
      // Not cached — fetch, cache, and return
      return fetch(r).then((resp) => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(r, clone));
        }
        return addIsolationHeaders(resp);
      });
    })
  );
});

/**
 * Add cross-origin isolation headers to a response so SharedArrayBuffer works.
 */
function addIsolationHeaders(response) {
  if (!response || response.status === 0) return response;
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
