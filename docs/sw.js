
/* global caches */
const CACHE_NAME = 'bookforge-cache-v2';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/main.css',
  './js/app.js',
  './js/book-file-import.js',
  './js/book-lookup.js',
  './js/book-parser.js',
  './js/compiler.js',
  './js/drive-ui.js',
  './js/gdrive.js',
  './js/history.js',
  './js/metadata.js',
  './js/session.js',
  './icon.svg'
];

// Install: cache app shell
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))
    )
  );
  self.clients.claim();
});

// Fetch: serve from cache, fall back to network
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then(response =>
      response || fetch(event.request)
    )
  );
});
