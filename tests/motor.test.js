import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { crearSplineMonotona } from '../js/engine/spline.js';
import { geometriaResultante, trailConOffset } from '../js/engine/geometria.js';
import {
  crearCinematica, sagEstatico, wheelRate, resorteIdeal, sesgoDesdeSag, usoRecorridoImpacto, G, LBIN_A_NMM,
} from '../js/engine/fisica.js';
import { recomendar, curvaAmortiguacion, clickParaAmortiguacion } from '../js/engine/motor.js';
import { calibrar } from '../js/engine/calibracion.js';

const leer = (f) => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url), 'utf8'));
const bike = leer('bike.json');
const components = leer('components.json');
const rules = leer('rules.json');
const clon = (o) => structuredClone(o);

const BASE = { peso_kg: 80, feel: 0, grip: 'Medium', tipo: 'Mixed', saltos: false };
const BOXXER = { horquilla: 'boxxer_ultimate_c2', amortiguador: 'dhx2_factory' };
const FOX = { horquilla: 'fox40_2027', amortiguador: 'dhx2_factory' };
const rec = (inputs = {}, extra = {}) =>
  recomendar({ bike, components, rules, seleccion: BOXXER, inputs: { ...BASE, ...inputs }, ...extra });
const aj = (lista, tipo) => lista.find((a) => a.tipo === tipo);
const cerca = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} esperado ${b} ± ${tol}, obtenido ${a}`);

// ---------- Geometría ----------

test('con offset de 52 mm la geometría coincide con la tabla de Giant', () => {
  for (const pos of ['Low', 'Mid', 'High']) {
    const g = geometriaResultante(bike, { maestro: pos, direccion: 'Mid' }, 52);
    const t = bike.geometria.maestro[pos];
    cerca(g.trail_mm, t.trail_mm, 1e-9);
    cerca(g.distancia_ejes_mm, t.distancia_ejes_mm, 1e-9);
    assert.equal(g.reach_mm, t.reach_mm);
  }
});

test('con offset de 48 mm: trail 150,7 / 148,0 / 145,3 y distancia entre ejes ≈ -3,5 mm', () => {
  const esperado = { Low: 150.7, Mid: 148.0, High: 145.3 };
  for (const pos of ['Low', 'Mid', 'High']) {
    const g = geometriaResultante(bike, { maestro: pos, direccion: 'Mid' }, 48);
    cerca(g.trail_mm, esperado[pos], 0.06, `trail ${pos}`);
    cerca(g.distancia_ejes_mm - bike.geometria.maestro[pos].distancia_ejes_mm, -3.5, 0.06, `ejes ${pos}`);
  }
});

test('el chip de dirección suma su offset al reach', () => {
  cerca(geometriaResultante(bike, { maestro: 'Mid', direccion: 'Short' }, 48).reach_mm, 459.9, 1e-9);
  cerca(geometriaResultante(bike, { maestro: 'Mid', direccion: 'Long' }, 48).reach_mm, 469.9, 1e-9);
});

test('la geometría cambia sola con el offset de la horquilla activa', () => {
  const a = rec();
  cerca(a.geometria.medidas.trail_mm, 148.0, 0.06);
  const c2 = clon(components);
  c2.horquillas.boxxer_ultimate_c2.offset_mm = 52;
  const b = recomendar({ bike, components: c2, rules, seleccion: BOXXER, inputs: BASE });
  cerca(b.geometria.medidas.trail_mm, 143.5, 1e-6);
});

test('Tech: Maestro Low solo si el trail en Low queda ≤ 147 mm', () => {
  assert.equal(rec({ tipo: 'Tech' }).geometria.maestro.valor, 'Mid'); // 48 mm → 150,7
  const c2 = clon(components);
  c2.horquillas.boxxer_ultimate_c2.offset_mm = 52; // → 146,2
  const r = recomendar({ bike, components: c2, rules, seleccion: BOXXER, inputs: { ...BASE, tipo: 'Tech' } });
  assert.equal(r.geometria.maestro.valor, 'Low');
  assert.equal(r.geometria.dropout.valor, 'Short');
});

test('Mixed = baseline; Flow y Saltos van a dropout Long, salvo Tech', () => {
  const m = rec().geometria;
  assert.deepEqual([m.maestro.valor, m.direccion.valor, m.dropout.valor], ['Mid', 'Mid', 'Short']);
  assert.equal(rec({ tipo: 'Flow' }).geometria.dropout.valor, 'Long');
  assert.equal(rec({ saltos: true }).geometria.dropout.valor, 'Long');
  assert.equal(rec({ saltos: true }).geometria.maestro.valor, 'Mid');
  assert.equal(rec({ tipo: 'Tech', saltos: true }).geometria.dropout.valor, 'Short');
});

test('horquilla sin offset definido: usa el elegido por el usuario o avisa', () => {
  const sin = recomendar({ bike, components, rules, seleccion: FOX, inputs: BASE });
  assert.equal(sin.geometria.offset_mm, 52);
  assert.ok(sin.avisos.some((a) => a.includes('offset')));
  const con = recomendar({ bike, components, rules, seleccion: FOX, inputs: BASE, offsetUsuario: 44 });
  assert.equal(con.geometria.offset_mm, 44);
});

// ---------- Cinemática y resorte ----------

test('la spline pasa por los puntos y es monótona', () => {
  const pts = bike.suspension_trasera.cinematica.curva_leverage.puntos;
  const f = crearSplineMonotona(pts);
  for (const [x, y] of pts) cerca(f(x), y, 1e-12);
  let prev = f(0);
  for (let x = 1; x <= 200; x++) {
    const v = f(x);
    assert.ok(v <= prev + 1e-12, `LR sube en x=${x}`);
    prev = v;
  }
});

test('la curva integra a la carrera del amortiguador (75 mm ± 2 %)', () => {
  const cin = crearCinematica(bike);
  cerca(cin.carreraIntegrada, 75, 1.5);
  cerca(cin.ruedaEn(cin.shockEn(123)), 123, 1e-6);
});

test('equilibrio estático: la fuerza en la rueda iguala la carga', () => {
  const cin = crearCinematica(bike);
  const cargaN = 96.5 * G * 0.65;
  const s = sagEstatico({ cin, k_lb: 475, cargaN, precarga_mm: 1 });
  const fuerza = (475 * LBIN_A_NMM * (s.shock_mm + 1)) / cin.LR(s.rueda_mm);
  cerca(fuerza, cargaN, 1e-6);
  assert.ok(s.pct_shock > 20 && s.pct_shock < 35);
});

test('más peso = más sag; resorte más duro = menos sag', () => {
  const cin = crearCinematica(bike);
  const sag = (kg, k) => sagEstatico({ cin, k_lb: k, cargaN: kg * G * 0.65 }).pct_shock;
  assert.ok(sag(110, 475) > sag(90, 475));
  assert.ok(sag(100, 525) < sag(100, 475));
});

test('wheel rate = k / LR² y crece hacia el final (curva progresiva)', () => {
  const cin = crearCinematica(bike);
  cerca(wheelRate(cin, 475, 60), (475 * LBIN_A_NMM) / 2.84 ** 2, 1e-9);
  assert.ok(wheelRate(cin, 475, 160) > wheelRate(cin, 475, 100));
  assert.ok(wheelRate(cin, 475, 100) > wheelRate(cin, 475, 60));
});

test('resorte ideal: da el sag objetivo y se redondea a pasos de 25 lb', () => {
  const cin = crearCinematica(bike);
  for (const kg of [65, 80, 95, 110]) {
    const cargaN = (kg + 16.5) * G * 0.65;
    const id = resorteIdeal({ cin, cargaN, sagObjetivoPct: 30, precarga_mm: 1 });
    const s = sagEstatico({ cin, k_lb: id.exacto_lb, cargaN, precarga_mm: 1 });
    cerca(s.pct_shock, 30, 0.01);
    assert.equal(id.catalogo_lb % 25, 0);
    assert.ok(Math.abs(id.catalogo_lb - id.exacto_lb) <= 12.5);
  }
});

test('el resorte ideal no es una regla de tres: depende de la curva', () => {
  const cin = crearCinematica(bike);
  const cargaN = 96.5 * G * 0.65;
  const a = resorteIdeal({ cin, cargaN, sagObjetivoPct: 28 }).exacto_lb;
  const b = resorteIdeal({ cin, cargaN, sagObjetivoPct: 33 }).exacto_lb;
  assert.ok(Math.abs(a / b - 33 / 28) > 0.005);
});

test('el sag medido calibra el sesgo trasero y el modelo lo reproduce', () => {
  const cin = crearCinematica(bike);
  const sesgo = sesgoDesdeSag({ cin, k_lb: 475, sagShockMm: 22.5, precarga_mm: 1, masaTotalKg: 96.5 });
  const s = sagEstatico({ cin, k_lb: 475, cargaN: 96.5 * G * sesgo, precarga_mm: 1 });
  cerca(s.shock_mm, 22.5, 1e-4);

  const r = rec({ sag_atras: { valor: 30, unidad: '%' } });
  cerca(r.amortiguador.sag.pct_shock, 30, 0.01);
  assert.equal(r.amortiguador.sag.medido, true);
  assert.notEqual(r.modelo.sesgo_trasero, rules.modelo.sesgo_trasero);
  const mm = rec({ sag_atras: { valor: 22.5, unidad: 'mm' } });
  cerca(mm.amortiguador.sag.pct_shock, 30, 0.01);
});

test('sin sag medido avisa que es una estimación', () => {
  assert.ok(rec().avisos.some((a) => a.includes('estimación')));
  assert.ok(!rec({ sag_atras: { valor: 30, unidad: '%' } }).avisos.some((a) => a.includes('estimación')));
});

test('precarga nunca pasa de 2 vueltas; si no alcanza, cambia el resorte', () => {
  for (const kg of [55, 70, 80, 90, 100, 115, 130]) {
    const a = rec({ peso_kg: kg }).amortiguador;
    assert.ok(a.precarga.vueltas >= 1 && a.precarga.vueltas <= 2);
    if (a.resorte.veredicto === 'cambiar') assert.notEqual(a.resorte.recomendado_lb, 475);
  }
  const pesado = rec({ peso_kg: 125 }).amortiguador.resorte;
  assert.equal(pesado.veredicto, 'cambiar');
  assert.ok(pesado.recomendado_lb > 475);
  const liviano = rec({ peso_kg: 58 }).amortiguador.resorte;
  assert.equal(liviano.veredicto, 'cambiar');
  assert.ok(liviano.recomendado_lb < 475);
});

test('impacto de referencia: más energía usa más recorrido', () => {
  const cin = crearCinematica(bike);
  const cargaN = 96.5 * G * 0.65;
  const u = (e) => usoRecorridoImpacto({ cin, k_lb: 475, cargaN, energiaJ: e }).uso;
  assert.ok(u(120) > u(60));
  assert.equal(usoRecorridoImpacto({ cin, k_lb: 475, cargaN, energiaJ: 5000 }).hace_tope, true);
});

// ---------- Clicks ----------

const INPUTS_EXTREMOS = [];
for (const feel of [-4, -1, 0, 3, 4]) {
  for (const grip of ['Low', 'Medium', 'High']) {
    for (const tipo of ['Tech', 'Mixed', 'Flow']) {
      for (const saltos of [false, true]) {
        for (const peso_kg of [50, 80, 130]) INPUTS_EXTREMOS.push({ peso_kg, feel, grip, tipo, saltos });
      }
    }
  }
}

function verificarRangos(comps, calibracion) {
  for (const h of Object.keys(comps.horquillas)) {
    for (const a of Object.keys(comps.amortiguadores)) {
      for (const inputs of INPUTS_EXTREMOS) {
        const r = recomendar({ bike, components: comps, rules, seleccion: { horquilla: h, amortiguador: a }, inputs, calibracion, offsetUsuario: 44 });
        for (const x of [...r.horquilla.ajustadores, ...r.amortiguador.ajustadores]) {
          if (x.sin_datos) continue;
          assert.ok(Number.isInteger(x.click), `${x.etiqueta} no es entero`);
          assert.ok(x.click >= 0 && x.click <= x.clicks_totales, `${h}/${a} ${x.etiqueta}=${x.click} fuera de 0…${x.clicks_totales}`);
        }
        for (const n of [r.neumaticos.adelante, r.neumaticos.atras]) assert.ok(n.psi >= 16 && n.psi <= 35);
      }
    }
  }
}

test('ningún click queda fuera de 0…clicks_totales (todas las combinaciones)', () => {
  verificarRangos(components);
});

test('ningún click queda fuera de rango ni con bases en los extremos ni con calibración al límite', () => {
  const c2 = clon(components);
  for (const grupo of [c2.horquillas, c2.amortiguadores]) {
    for (const comp of Object.values(grupo)) comp.ajustadores.forEach((a, i) => { a.base_desde_cerrado = i % 2 ? 0 : a.clicks_totales; });
  }
  const avisos = Object.keys(rules.calibracion.feedback);
  const bitacora = Array.from({ length: 40 }, (_, i) => ({ fecha: `2026-01-${i}`, horquilla: 'boxxer_ultimate_c2', amortiguador: 'dhx2_factory', avisos }));
  verificarRangos(c2, calibrar(bitacora, rules));
});

test('convención: más amortiguación = menos clicks desde cerrado', () => {
  const D = curvaAmortiguacion({ clicks_totales: 10, efecto_por_click: 0.1 });
  assert.equal(D[0], 1);
  assert.equal(clickParaAmortiguacion(D, 1), 0);
  assert.equal(clickParaAmortiguacion(D, 0.52), 5);
  assert.equal(clickParaAmortiguacion(D, -3), 10);
  assert.equal(clickParaAmortiguacion(D, 9), 0);
});

test('efecto_por_click no lineal: el mismo cambio pide distinta cantidad de clicks', () => {
  const D = curvaAmortiguacion({ clicks_totales: 4, efecto_por_click: [0.4, 0.3, 0.2, 0.1] });
  assert.deepEqual(D.map((d) => Math.abs(+d.toFixed(2))), [1, 0.6, 0.3, 0.1, 0]);
  assert.equal(clickParaAmortiguacion(D, 0.32), 2);
});

test('Feel hacia Firm cierra LSC en ambos extremos; hacia Soft abre', () => {
  const n = rec();
  const firme = rec({ feel: 3 });
  const blando = rec({ feel: -3 });
  for (const lado of ['horquilla', 'amortiguador']) {
    const base = aj(n[lado].ajustadores, 'LSC').click;
    assert.ok(aj(firme[lado].ajustadores, 'LSC').click < base);
    assert.ok(aj(blando[lado].ajustadores, 'LSC').click > base);
  }
  assert.ok(aj(rec({ feel: 4 }).amortiguador.ajustadores, 'HSC').click < aj(n.amortiguador.ajustadores, 'HSC').click);
  assert.equal(firme.horquilla.presion.psi - n.horquilla.presion.psi, 1); // +1 psi cada 2 pasos
  assert.deepEqual(firme.geometria, n.geometria); // Feel no toca la geometría
});

test('BoXXer muestra 3 ajustadores y Fox 40 muestra 4, sin tocar código', () => {
  const b = rec();
  assert.deepEqual(b.horquilla.ajustadores.map((a) => a.tipo), ['REBOTE_UNICO', 'LSC', 'HSC']);
  const f = recomendar({ bike, components, rules, seleccion: FOX, inputs: BASE });
  assert.deepEqual(f.horquilla.ajustadores.map((a) => a.tipo).sort(), ['HSC', 'HSR', 'LSC', 'LSR']);
  assert.equal(f.montado, 'Fox 40 2027 · DHX2 475');
  assert.equal(b.montado, 'BoXXer Ultimate · DHX2 475');
});

test('REBOTE_UNICO recibe el delta de LSR e ignora el de HSR (y lo explica)', () => {
  const soloHSR = clon(rules);
  soloHSR.saltos.si.efectos = [{ extremo: 'ambos', tipo: 'HSR', delta_clicks: -6 }];
  const n = recomendar({ bike, components, rules: soloHSR, seleccion: BOXXER, inputs: BASE });
  const s = recomendar({ bike, components, rules: soloHSR, seleccion: BOXXER, inputs: { ...BASE, saltos: true } });
  const rb = aj(s.horquilla.ajustadores, 'REBOTE_UNICO');
  assert.equal(rb.click, aj(n.horquilla.ajustadores, 'REBOTE_UNICO').click);
  assert.equal(rb.hsr_ignorado, true);
  assert.match(rb.porque, /HSR ignorado/);
  // el amortiguador sí tiene HSR y lo aplica
  assert.ok(aj(s.amortiguador.ajustadores, 'HSR').click < aj(n.amortiguador.ajustadores, 'HSR').click);

  const soloLSR = clon(rules);
  soloLSR.saltos.si.efectos = [{ extremo: 'ambos', tipo: 'LSR', delta_clicks: -3 }];
  const s2 = recomendar({ bike, components, rules: soloLSR, seleccion: BOXXER, inputs: { ...BASE, saltos: true } });
  assert.equal(aj(s2.horquilla.ajustadores, 'REBOTE_UNICO').click, aj(n.horquilla.ajustadores, 'REBOTE_UNICO').click - 3);
  assert.ok(!s.horquilla.ajustadores.some((a) => a.tipo === 'HSR')); // sin HSR en pantalla
});

test('Saltos: sube HSC atrás solo si el modelo predice > 90 % de recorrido', () => {
  const poco = rec({ saltos: true, peso_kg: 70 });
  assert.ok(poco.modelo.impacto.uso <= 0.9);
  assert.equal(aj(poco.amortiguador.ajustadores, 'HSC').click, aj(rec({ peso_kg: 70 }).amortiguador.ajustadores, 'HSC').click);
  assert.ok(aj(poco.amortiguador.ajustadores, 'LSR').click < aj(rec({ peso_kg: 70 }).amortiguador.ajustadores, 'LSR').click);

  const mucho = rec({ saltos: true, peso_kg: 100 });
  assert.ok(mucho.modelo.impacto.uso > 0.9);
  assert.ok(aj(mucho.amortiguador.ajustadores, 'HSC').click < aj(rec({ peso_kg: 100 }).amortiguador.ajustadores, 'HSC').click);
  // adelante siempre sube HSC y pide token
  assert.ok(aj(poco.horquilla.ajustadores, 'HSC').click < aj(rec({ peso_kg: 70 }).horquilla.ajustadores, 'HSC').click);
  assert.equal(poco.horquilla.tokens.delta, 1);
  assert.equal(poco.neumaticos.atras.psi - rec({ peso_kg: 70 }).neumaticos.atras.psi, 1);
});

test('el rebote base escala con peso y resorte', () => {
  const liviano = rec({ peso_kg: 60 }).modelo.escala_rebote.atras;
  const pesado = rec({ peso_kg: 110 }).modelo.escala_rebote.atras;
  cerca(rec().modelo.escala_rebote.atras, 1, 1e-9); // condición de referencia
  assert.ok(pesado > 1 && liviano < 1);
  const c2 = clon(components);
  c2.amortiguadores.dhx2_factory.resorte_lb = 550;
  const duro = recomendar({ bike, components: c2, rules, seleccion: BOXXER, inputs: BASE });
  assert.ok(duro.modelo.frecuencia_hz > rec().modelo.frecuencia_hz);
  assert.ok(duro.modelo.escala_rebote.atras > 1);
});

test('ajustador sin clicks_totales: aparece como "falta dato" y no rompe', () => {
  const c2 = clon(components);
  c2.horquillas.fox40_2027.ajustadores.forEach((a) => { a.clicks_totales = null; });
  const r = recomendar({ bike, components: c2, rules, seleccion: FOX, inputs: { ...BASE, saltos: true, feel: 4 } });
  assert.equal(r.horquilla.ajustadores.length, 4);
  assert.ok(r.horquilla.ajustadores.every((a) => a.sin_datos && a.click === null));
});

// ---------- Reglas editables ----------

test('cambiar una regla en rules.json cambia la recomendación', () => {
  const antes = rec({ grip: 'High' });
  const r2 = clon(rules);
  r2.trail_grip.High.efectos[0].delta_clicks = -4;
  r2.trail_grip.High.neumaticos_psi.adelante = 3;
  r2.geometria.dropout.unshift({ si: { trail_grip: 'High' }, valor: 'Long', porque: 'regla nueva' });
  const despues = recomendar({ bike, components, rules: r2, seleccion: BOXXER, inputs: { ...BASE, grip: 'High' } });
  assert.equal(aj(despues.horquilla.ajustadores, 'LSC').click, aj(antes.horquilla.ajustadores, 'LSC').click - 3);
  assert.equal(despues.neumaticos.adelante.psi - antes.neumaticos.adelante.psi, 2);
  assert.equal(despues.geometria.dropout.valor, 'Long');
  assert.equal(despues.geometria.dropout.porque, 'regla nueva');
});

test('neumáticos: base 23/26 psi a 80 kg, ±1 psi cada 7,5 kg y modifiers', () => {
  const n = rec().neumaticos;
  assert.equal(n.adelante.psi, 23);
  assert.equal(n.atras.psi, 26);
  cerca(n.adelante.bar, 1.586, 0.001);
  assert.equal(rec({ peso_kg: 95 }).neumaticos.adelante.psi, 25);
  assert.equal(rec({ tipo: 'Tech' }).neumaticos.atras.psi, 25);
  assert.equal(rec({ tipo: 'Flow', grip: 'High' }).neumaticos.adelante.psi, 25);
  assert.equal(rec({ grip: 'Low' }).neumaticos.adelante.psi, 21.5);
});

test('cada recomendación trae su porqué', () => {
  for (const inputs of [BASE, { ...BASE, feel: -2, grip: 'Low', tipo: 'Tech', saltos: true }]) {
    for (const sel of [BOXXER, FOX]) {
      const r = recomendar({ bike, components, rules, seleccion: sel, inputs });
      const lineas = [
        r.geometria.maestro, r.geometria.direccion, r.geometria.dropout,
        r.neumaticos.adelante, r.neumaticos.atras, r.horquilla.presion, r.horquilla.tokens,
        r.amortiguador.resorte, r.amortiguador.precarga, r.balance,
        ...r.horquilla.ajustadores, ...r.amortiguador.ajustadores,
      ];
      for (const l of lineas) {
        assert.ok(typeof l.porque === 'string' && l.porque.length > 5, JSON.stringify(l));
        assert.ok(!l.porque.includes('\n') && !/[{}]/.test(l.porque), l.porque);
      }
    }
  }
});

test('balance: la horquilla apunta a 7-10 puntos menos de sag que la trasera', () => {
  const r = rec({ sag_atras: { valor: 31, unidad: '%' } });
  assert.equal(r.horquilla.sag_objetivo.ideal, 22.5);
  assert.equal(r.balance.ok, true);
  const d = rec({ sag_atras: { valor: 31, unidad: '%' }, sag_adelante: { valor: 28, unidad: '%' }, presion_horquilla_actual: 140 });
  assert.equal(d.balance.ok, false);
  assert.equal(d.horquilla.presion.psi, Math.round(140 * (28 / 22.5))); // primero presión
});

// ---------- Componentes ----------

test('un tercer amortiguador de ejemplo aparece y funciona sin tocar código', () => {
  const c3 = clon(components);
  c3.amortiguadores.ejemplo_coil_2 = {
    nombre: 'Coil de ejemplo', tipo_resorte: 'coil', carrera_mm: 75, resorte_lb: 450,
    ajustadores: [
      { id: 'lsc', tipo: 'LSC', clicks_totales: 12, base_desde_cerrado: 6, efecto_por_click: 0.08, verificado: true },
      { id: 'rebote', tipo: 'REBOTE_UNICO', clicks_totales: 14, base_desde_cerrado: 7, efecto_por_click: 0.07, verificado: true },
    ],
    notas: 'Ejemplo',
  };
  c3.amortiguadores.ejemplo_aire = {
    nombre: 'Aire de ejemplo', tipo_resorte: 'aire', carrera_mm: 75, presion_base: { psi_por_kg: 2.4, verificado: false },
    ajustadores: [{ id: 'lsr', tipo: 'LSR', clicks_totales: 10, base_desde_cerrado: 5, efecto_por_click: 0.1, verificado: true }],
  };
  assert.equal(Object.keys(c3.amortiguadores).length, 3);
  const r = recomendar({ bike, components: c3, rules, seleccion: { horquilla: 'boxxer_ultimate_c2', amortiguador: 'ejemplo_coil_2' }, inputs: { ...BASE, saltos: true } });
  assert.equal(r.montado, 'BoXXer Ultimate · Coil de ejemplo 450');
  assert.deepEqual(r.amortiguador.ajustadores.map((a) => a.tipo), ['LSC', 'REBOTE_UNICO']);
  assert.equal(r.amortiguador.resorte.actual_lb, 450);
  const aire = recomendar({ bike, components: c3, rules, seleccion: { horquilla: 'fox40_2027', amortiguador: 'ejemplo_aire' }, inputs: BASE });
  assert.equal(aire.amortiguador.resorte.veredicto, 'aire');
  cerca(aire.amortiguador.presion_base, 192, 1e-9);
  verificarRangos(c3);
});

// ---------- Calibración con la bitácora ----------

test('la bitácora ajusta sesgo_trasero y efecto_por_click, por componente', () => {
  const reg = (avisos, horquilla = 'boxxer_ultimate_c2') => ({ fecha: '2026-11-01', horquilla, amortiguador: 'dhx2_factory', avisos });
  const cal = calibrar([reg(['tope_atras']), reg(['tope_atras', 'rebota_adelante'])], rules);
  cerca(cal.sesgo_trasero, 0.67, 1e-9);
  assert.ok(cal.componentes.dhx2_factory.efecto_mult.HSC < 1);
  assert.ok(cal.componentes.boxxer_ultimate_c2.bias.LSR > 0);
  assert.equal(cal.componentes.fox40_2027, undefined); // no mezcla horquillas

  const antes = rec({ saltos: true });
  const despues = rec({ saltos: true }, { calibracion: cal });
  assert.ok(despues.amortiguador.sag.pct_shock > antes.amortiguador.sag.pct_shock);
  assert.ok(aj(despues.amortiguador.ajustadores, 'HSC').click < aj(antes.amortiguador.ajustadores, 'HSC').click);
  const rebota = rec({}, { calibracion: calibrar([reg(['rebota_adelante'])], rules) });
  assert.ok(aj(rebota.horquilla.ajustadores, 'REBOTE_UNICO').click < aj(rec().horquilla.ajustadores, 'REBOTE_UNICO').click);
  assert.deepEqual(calibrar([], rules).componentes, {});
});
