// Genera los PNG del manifest a partir de icons/icon.svg (requiere Playwright).
// Uso: node scripts/iconos.mjs
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const svg = await readFile(new URL('../icons/icon.svg', import.meta.url), 'utf8');
const navegador = await chromium.launch();
const pagina = await navegador.newPage();
const generar = async (nombre, lado, relleno) => {
  await pagina.setViewportSize({ width: lado, height: lado });
  const interior = Math.round(lado * (1 - 2 * relleno));
  await pagina.setContent(`<body style="margin:0;background:${relleno ? '#0b0d10' : 'transparent'};display:grid;place-items:center;height:100vh"><div style="width:${interior}px;height:${interior}px">${svg}</div></body>`);
  await pagina.screenshot({ path: new URL(`../icons/${nombre}`, import.meta.url).pathname, omitBackground: !relleno });
};
await generar('icon-192.png', 192, 0);
await generar('icon-512.png', 512, 0);
await generar('icon-maskable-512.png', 512, 0.1);
await navegador.close();
