// Service worker: precarga todo para usar la app sin señal.
// La versión vive en version.js: al subirla, el navegador detecta un service
// worker nuevo, la app muestra "Hay una versión nueva" y este espera a que el
// usuario acepte antes de reemplazar al anterior.
importScripts('version.js');
const VERSION = `glory-setup-${self.GLORY_VERSION}`;
const ARCHIVOS = [
  './',
  'index.html',
  'version.js',
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
  // Se piden a la red sin pasar por la caché HTTP, para no precargar copias viejas.
  // Si falla un archivo, falla la instalación entera y sigue la versión anterior.
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ARCHIVOS.map((a) => new Request(a, { cache: 'reload' })))));
});

self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
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
  const cache = await (await caches.open(VERSION)).match(req, { ignoreSearch: true });
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

// Código y estilos: siempre de la caché de ESTA versión, para no mezclar
// archivos de versiones distintas. Se renuevan todos juntos al subir la versión.
async function cachePrimero(req) {
  const c = await caches.open(VERSION);
  const cache = await c.match(req, { ignoreSearch: true });
  if (cache) return cache;
  try {
    return await fetch(req);
  } catch {
    if (req.mode === 'navigate') return (await c.match('index.html')) ?? Response.error();
    return Response.error();
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith(url.pathname.endsWith('.json') ? redPrimero(req) : cachePrimero(req));
});
