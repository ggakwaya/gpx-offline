// Service worker : appli disponible hors ligne + cache des tuiles de carte et d'altitude.

const SHELL_CACHE = 'shell-v3';
const TILE_CACHE = 'tiles-v1';
const FONT_RANGES = ['0-255', '256-511', '8192-8447'];
const FONTS = ['noto-regular', 'noto-bold', 'noto-italic']
  .flatMap(f => FONT_RANGES.map(r => `fonts/${f}/${r}.pbf`))
  .concat(['fonts/noto-regular/9472-9727.pbf', 'fonts/noto-bold/9472-9727.pbf']);
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/gpx.js', 'js/map.js', 'js/match.js', 'js/offline.js', 'js/profile.js', 'js/store.js',
  'vendor/maplibre-gl.js', 'vendor/maplibre-gl.css', 'vendor/maplibre-contour.min.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
  ...FONTS,
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('shell-') && k !== SHELL_CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Clé de cache stable : le chemin OpenFreeMap contient une version qui change chaque semaine.
function tileKey(url) {
  if (url.hostname === 'tiles.openfreemap.org' && url.pathname.startsWith('/planet/')) {
    return url.origin + url.pathname.replace(/^\/planet\/[^/]+\//, '/planet/_/');
  }
  if (url.hostname === 's3.amazonaws.com' && url.pathname.startsWith('/elevation-tiles-prod/')) {
    return url.origin + url.pathname;
  }
  return null;
}

async function tileResponse(request, key) {
  const cache = await caches.open(TILE_CACHE);
  const hit = await cache.match(key, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) await cache.put(key, res.clone());
  return res;
}

async function shellResponse(request) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(request, { ignoreSearch: true }) ||
    (request.mode === 'navigate' && await cache.match('index.html'));
  return hit || fetch(request);
}

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  const key = tileKey(url);
  if (key) event.respondWith(tileResponse(event.request, key));
  else if (url.origin === self.location.origin) event.respondWith(shellResponse(event.request));
});
