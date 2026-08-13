// Plan B Installation App - Service Worker v3
var CACHE_NAME = 'planb-v3';

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

  // ข้อมูลงาน/สถานะจาก Apps Script (API) — ห้ามแคชเด็ดขาด ดึงสดเสมอ
  // (เดิมตกไปอยู่กลุ่ม "static assets" ด้านล่าง ทำให้มือถือเน็ตกระตุกแล้วเห็นข้อมูลเก่าค้าง)
  if (url.indexOf('script.google.com') > -1 || url.indexOf('/macros/') > -1) {
    event.respondWith(fetch(event.request, { cache: 'no-store' }));
    return;
  }

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
