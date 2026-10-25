// Offline cache for the app itself (models are kept in IndexedDB by the page),
// and Android's share target: files shared to the installed app are parked for the page to pick up.
const VERSION = 'mv-1.0.0';   // bump after changing any app file, so phones fetch the new copy
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/main.js', 'js/viewer.js', 'js/loaders.js', 'js/tools.js', 'js/transform.js', 'js/capture.js',
  'js/panels.js', 'js/sequence.js', 'js/store.js', 'js/icons.js', 'js/categories.js', 'js/units.js', 'js/sun.js',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
  'vendor/three/build/three.module.min.js', 'vendor/three/build/three.core.min.js',
  'vendor/three/examples/jsm/controls/OrbitControls.js', 'vendor/three/examples/jsm/controls/TransformControls.js',
  'vendor/three/examples/jsm/loaders/GLTFLoader.js', 'vendor/three/examples/jsm/loaders/ColladaLoader.js',
  'vendor/three/examples/jsm/loaders/TGALoader.js', 'vendor/three/examples/jsm/utils/BufferGeometryUtils.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(k => k !== VERSION && k !== 'mv-share').map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      const form = await e.request.formData();
      const cache = await caches.open('mv-share');
      for (const f of form.getAll('model')) {
        if (f && f.name) await cache.put(new Request(`shared/${encodeURIComponent(f.name)}`), new Response(f));
      }
      return Response.redirect('./?shared=1', 303);
    })());
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/models/')) return;
  // app files: cached copy at once, refreshed in the background for next time
  e.respondWith(caches.open(VERSION).then(async cache => {
    const hit = await cache.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then(res => { if (res.ok) cache.put(e.request, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  }));
});
