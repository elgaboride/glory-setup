// Prueba en navegador (requiere Playwright): la app bajo /glory-setup/, flip
// chips actuales, uso sin conexión y actualización del service worker sin
// pantalla en blanco. Uso: npm run test:e2e
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const { chromium, devices } = createRequire(import.meta.url)('playwright');
const REPO = fileURLToPath(new URL('../..', import.meta.url));
const TIPOS = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
};

// Copia de trabajo servida bajo /glory-setup/ (queda en la carpeta temporal del sistema).
const raiz = await mkdtemp(join(tmpdir(), 'glory-e2e-'));
const sitio = join(raiz, 'glory-setup');
for (const f of ['index.html', 'styles.css', 'manifest.webmanifest', 'sw.js', 'version.js', 'js', 'data', 'icons']) {
  await cp(join(REPO, f), join(sitio, f), { recursive: true });
}
const servidor = createServer(async (req, res) => {
  try {
    let ruta = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (ruta.endsWith('/')) ruta += 'index.html';
    const datos = await readFile(join(raiz, ruta));
    res.writeHead(200, { 'Content-Type': TIPOS[extname(ruta)] ?? 'application/octet-stream' });
    res.end(datos);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((ok) => servidor.listen(0, ok));
const URL_APP = `http://localhost:${servidor.address().port}/glory-setup/`;

const navegador = await chromium.launch();
const errores = [];
try {
  const ctx = await navegador.newContext({ ...devices['iPhone 13'] });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errores.push(e.message));
  const lista = () => p.waitForSelector('#btn-guardar', { timeout: 10000 });
  const pie = () => p.textContent('#pie');

  // Carga bajo el subdirectorio y versión visible
  await p.goto(URL_APP);
  await lista();
  const version1 = (await readFile(join(sitio, 'version.js'), 'utf8')).match(/GLORY_VERSION = '([^']+)'/)[1];
  assert.ok((await pie()).includes(`v${version1}`), 'la versión no está en el pie');
  assert.equal(await p.textContent('#montado'), 'BoXXer Ultimate · DHX2 475');

  // Flip chips: por defecto coincide con Mixed → "Sin cambios"
  const cambios = () => p.$$eval('.cambio', (els) => els.map((e) => e.textContent));
  assert.ok((await cambios()).every((t) => t.startsWith('Sin cambios')));
  assert.equal(await p.$('#btn-aplique'), null);
  // Cambio la posición actual en "Mi bici"
  await p.click('[data-tab=bici]');
  await p.click('[data-chip=maestro][data-valor=Low]');
  await p.click('[data-chip=dropout][data-valor=Long]');
  await p.click('[data-tab=setup]');
  await lista();
  const c = await cambios();
  assert.match(c[0], /Low → Mid: reach \+3,7 mm · trail −2,7 mm/);
  assert.ok(c[1].startsWith('Sin cambios'));
  assert.match(c[2], /Long → Short/);
  // Guardar en bitácora con actual y recomendado
  await p.click('#btn-guardar');
  await p.fill('input[name=pista]', 'Pista de prueba');
  await p.click('#form-bitacora button[type=submit]');
  const reg = await p.evaluate(() => JSON.parse(localStorage.getItem('glory-setup:bitacora'))[0].setup);
  assert.deepEqual(reg.chips_actuales, { maestro: 'Low', direccion: 'Mid', dropout: 'Long' });
  assert.deepEqual(reg.chips, { maestro: 'Mid', direccion: 'Mid', dropout: 'Short' });
  // "Apliqué la recomendación"
  await p.click('#btn-aplique');
  assert.ok((await cambios()).every((t) => t.startsWith('Sin cambios')));
  assert.deepEqual(
    await p.evaluate(() => JSON.parse(localStorage.getItem('glory-setup:chips'))),
    { maestro: 'Mid', direccion: 'Mid', dropout: 'Short' },
  );

  // Sin conexión después de la primera carga
  await p.evaluate(() => navigator.serviceWorker.ready);
  await p.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await ctx.setOffline(true);
  await p.reload();
  await lista();
  assert.ok((await pie()).includes(`v${version1}`));
  await ctx.setOffline(false);

  // Publico una versión nueva: aparece el aviso, y al tocarlo la app recarga con contenido
  assert.equal(await p.isHidden('#aviso-version'), true);
  await writeFile(join(sitio, 'version.js'), "self.GLORY_VERSION = '99.0.0';\nself.GLORY_FECHA = 'prueba';\n");
  await p.reload();
  await lista(); // la versión vieja sigue funcionando mientras tanto
  assert.ok((await pie()).includes(`v${version1}`));
  await p.waitForSelector('#aviso-version:not([hidden])', { timeout: 10000 });
  assert.match(await p.textContent('#aviso-version'), /Hay una versión nueva, toca para actualizar/);
  await Promise.all([p.waitForEvent('load'), p.click('#aviso-version')]);
  await lista();
  assert.ok((await pie()).includes('v99.0.0'), `pie tras actualizar: ${await pie()}`);
  assert.ok((await p.$$('section.tarjeta')).length >= 5, 'la app quedó en blanco tras actualizar');
  assert.equal(await p.isHidden('#aviso-version'), true);
  assert.equal(await p.evaluate(() => JSON.parse(localStorage.getItem('glory-setup:bitacora')).length), 1);
  // y la versión nueva también queda disponible sin conexión
  await ctx.setOffline(true);
  await p.reload();
  await lista();
  assert.ok((await pie()).includes('v99.0.0'));

  assert.deepEqual(errores, []);
  console.log('e2e OK: subdirectorio, flip chips, offline y actualización del service worker');
} finally {
  await navegador.close();
  servidor.close();
}
