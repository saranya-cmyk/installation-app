// Plan B Installation App - Service Worker v2
var CACHE_NAME = 'planb-v2';

self.addEventListener('install', function(event) {
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(names) {
      return Promise.all(names.map(function(name) {
        return caches.delete(name);
      }));
    })
  );
  self.clients.claim();
});

// ALWAYS network-first for HTML - never serve stale pages
self.addEventListener('fetch', function(event) {
  if (event.request.method !== 'GET') return;
  var url = event.request.url;

  // HTML pages: network only, no cache (prevents admin/installer mixing)
  if (url.indexOf('.html') > -1 || url.endsWith('/') || url.indexOf('installation-app') > -1 && url.indexOf('.') === -1) {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' }).catch(function() {
        return caches.match(event.request);
      })
    );
    return;
  }

  // Static assets (icons, manifest): network first, cache fallback
  event.respondWith(
    fetch(event.request).then(function(response) {
      if (response.ok) {
        var clone = response.clone();
        caches.open(CACHE_NAME).then(function(cache) {
          cache.put(event.request, clone);
        });
      }
      return response;
    }).catch(function() {
      return caches.match(event.request);
    })
  );
});
