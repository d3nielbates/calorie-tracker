// Offline support: cache the app shell and food database; network-first for
// the app files so updates arrive, cache fallback when offline. Open Food
// Facts requests are never cached here.
const CACHE = 'calorie-tracker-v3';
const SHELL = [
  './', 'index.html', 'styles.css', 'icon.svg', 'manifest.webmanifest', 'data/foods.json', 'data/packs.json',
  'src/app.js', 'src/nutrients.js', 'src/targets.js', 'src/meals.js', 'src/planner.js', 'src/search.js',
  'src/store.js', 'src/cloud.js', 'src/fooddb.js', 'src/trend.js', 'src/units.js', 'src/prices.js', 'src/coach.js', 'src/importers/sr28.js', 'src/importers/off.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))),
  );
});
