// Plan B Installation App - Service Worker v3
var CACHE_NAME = 'planb-v3';

self.addEventListener('install', function(event) {
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(names) {
      // ลบเฉพาะแคชเก่าของแอปนี้ — ไม่ลบแคชโมเดล AI (transformers-cache) ที่โหลดมาแล้ว ~120 MB
      return Promise.all(names.filter(function(name) {
        return name.indexOf('planb-') === 0 && name !== CACHE_NAME;
      }).map(function(name) { return caches.delete(name); }));
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

  // ไฟล์จากเว็บอื่น (CDN / โมเดล AI) — ไม่แคชซ้ำ ปล่อยให้เบราว์เซอร์จัดการเอง
  if (new URL(url).origin !== self.location.origin) return;

  // Static assets (icons, manifest): network first, cache fallback
  event.respondWith(
    fetch(event.request).then(function(response) {
      if (response.ok && response.status === 200) {
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
