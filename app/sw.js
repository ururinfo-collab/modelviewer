// Offline cache for the app itself (models are kept in IndexedDB by the page),
// and Android's share target: files shared to the installed app are parked for the page to pick up.
const VERSION = 'mv-1.27.0';   // bump after changing any app file, so phones fetch the new copy
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/main.js', 'js/viewer.js', 'js/loaders.js', 'js/tools.js', 'js/transform.js', 'js/capture.js',
  'js/panels.js', 'js/sequence.js', 'js/edgebatch.js', 'js/history.js', 'js/look.js', 'js/quantities.js', 'js/compare.js', 'js/notes.js', 'js/ar.js', 'js/ai.js', 'js/share.js', 'js/present.js', 'js/joints.js', 'js/colours.js', 'js/explode.js', 'js/levels.js', 'js/export.js', 'js/store.js', 'js/icons.js', 'js/categories.js', 'js/units.js', 'js/sun.js',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
  'vendor/three/build/three.module.min.js', 'vendor/three/build/three.core.min.js',
  'vendor/three/examples/jsm/controls/OrbitControls.js', 'vendor/three/examples/jsm/controls/TransformControls.js',
  'vendor/three/examples/jsm/loaders/GLTFLoader.js', 'vendor/three/examples/jsm/loaders/ColladaLoader.js',
  'vendor/three/examples/jsm/loaders/TGALoader.js', 'vendor/three/examples/jsm/utils/BufferGeometryUtils.js',
  'vendor/three/examples/jsm/postprocessing/EffectComposer.js', 'vendor/three/examples/jsm/postprocessing/RenderPass.js',
  'vendor/three/examples/jsm/postprocessing/GTAOPass.js', 'vendor/three/examples/jsm/postprocessing/OutputPass.js',
  'vendor/three/examples/jsm/postprocessing/Pass.js', 'vendor/three/examples/jsm/postprocessing/ShaderPass.js',
  'vendor/three/examples/jsm/postprocessing/MaskPass.js', 'vendor/three/examples/jsm/shaders/CopyShader.js',
  'vendor/three/examples/jsm/shaders/GTAOShader.js', 'vendor/three/examples/jsm/shaders/PoissonDenoiseShader.js',
  'vendor/three/examples/jsm/shaders/OutputShader.js', 'vendor/three/examples/jsm/math/SimplexNoise.js',
  'vendor/three/examples/jsm/environments/RoomEnvironment.js', 'vendor/three/examples/jsm/exporters/GLTFExporter.js',
  'vendor/openskp/openskp.mjs', 'vendor/openskp/earcut.mjs', 'vendor/openskp/fflate.mjs', 'vendor/openskp/flatbuffers.mjs',
];

self.addEventListener('install', e => {
  // 'reload' skips the browser's own HTTP cache, so a new version never caches old files
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
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
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/models/') || url.pathname.includes('/ai/')) return;
  // app files: the newest copy when online (so updates show at once), the saved copy when offline
  e.respondWith(caches.open(VERSION).then(async cache => {
    try {
      // by URL: a page-open (navigate) request cannot be copied with new options
      const res = await fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' });
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    } catch {
      return (await cache.match(e.request, { ignoreSearch: true })) || Response.error();
    }
  }));
});
