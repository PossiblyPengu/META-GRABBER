/* global caches */
// Define cache name and app shell resources
const CACHE_NAME = 'meta-grabber-cache-v1';
const APP_SHELL = [
  '/index.html',
  '/manifest.json',
  '/css/main.css',
  '/js/app.js',
  '/js/book-file-import.js',
  '/js/book-lookup.js',
  '/js/book-parser.js',
  '/js/compiler.js',
  '/js/drive-ui.js',
  '/js/gdrive.js',
  '/js/history.js',
  '/js/metadata.js',
  '/js/session.js',
  '/js/waveform.js'
];
/**
 * sw.js — BookForge unified service worker
 *
 * Combines cross-origin isolation (COEP/COOP headers for SharedArrayBuffer)
 * with PWA app-shell caching. Replaces the separate coi-serviceworker.js
 * to avoid dual-SW registration conflicts.
 */



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
});
self.clients.claim();
