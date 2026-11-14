// Service worker: precarga todo para usar la app sin señal.
// Sube VERSION al publicar cambios para renovar la caché.
const VERSION = 'glory-setup-v1';
const ARCHIVOS = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'js/app.js',
  'js/almacen.js',
  'js/engine/motor.js',
  'js/engine/fisica.js',
  'js/engine/geometria.js',
  'js/engine/spline.js',
  'js/engine/calibracion.js',
  'data/bike.json',
  'data/components.json',
  'data/rules.json',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function guardar(req, res) {
  if (res && res.ok) {
    const c = await caches.open(VERSION);
    await c.put(req, res.clone());
  }
  return res;
}

// Red primero con límite de tiempo (para que editar un JSON se note al tiro
// con señal), y caché si no hay red.
async function redPrimero(req) {
  const cache = await caches.match(req, { ignoreSearch: true });
  try {
    const red = fetch(req).then((r) => guardar(req, r));
    if (!cache) return await red;
    const limite = new Promise((ok) => setTimeout(() => ok(null), 2500));
    const r = await Promise.race([red, limite]);
    return r && r.ok ? r : cache;
  } catch {
    if (cache) return cache;
    throw new Error('Sin conexión y sin caché');
  }
}

// Caché primero y actualización en segundo plano.
async function cachePrimero(req) {
  const cache = await caches.match(req, { ignoreSearch: true });
  const red = fetch(req).then((r) => guardar(req, r)).catch(() => null);
  if (cache) return cache;
  const r = await red;
  if (r) return r;
  if (req.mode === 'navigate') return caches.match('index.html');
  return Response.error();
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith(url.pathname.endsWith('.json') ? redPrimero(req) : cachePrimero(req));
});
