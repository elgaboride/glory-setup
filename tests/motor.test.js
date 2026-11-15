import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { crearSplineMonotona } from '../js/engine/spline.js';
import { geometriaResultante, trailConOffset } from '../js/engine/geometria.js';
import {
  crearCinematica, sagEstatico, wheelRate, resorteIdeal, sesgoDesdeSag, usoRecorridoImpacto, G, LBIN_A_NMM,
} from '../js/engine/fisica.js';
import {
  recomendar, curvaAmortiguacion, clickParaAmortiguacion, normalizarAjustador, esCompatible, resortesDisponibles, offsetParaHorquilla,
} from '../js/engine/motor.js';
import { calibrar } from '../js/engine/calibracion.js';

const leer = (f) => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url), 'utf8'));
const bike = leer('bike.json');
const components = leer('components.json');
const rules = leer('rules.json');
const clon = (o) => structuredClone(o);

const BASE = { peso_kg: 80, feel: 0, grip: 'Medium', tipo: 'Mixed', saltos: false };
const BOXXER = { horquilla: 'boxxer_ultimate_c2', amortiguador: 'dhx2_factory_2024' };
const FOX = { horquilla: 'fox40_2027', amortiguador: 'dhx2_factory_2024' };
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

test('offset: de serie por defecto, el elegido si la horquilla lo ofrece, y aviso si falta', () => {
  const fox = (extra) => recomendar({ bike, components, rules, seleccion: FOX, inputs: BASE, ...extra });
  assert.equal(fox().geometria.offset_mm, 52); // de serie
  assert.equal(fox({ offsetUsuario: 44 }).geometria.offset_mm, 44);
  assert.equal(fox({ offsetUsuario: 50 }).geometria.offset_mm, 52); // 50 no existe en la Fox 40
  assert.equal(rec({}, { offsetUsuario: 52 }).geometria.offset_mm, 48); // la BoXXer C2 solo tiene 48
  const c2 = clon(components);
  delete c2.horquillas.fox40_2027.offsets_disponibles;
  c2.horquillas.fox40_2027.offset_mm = null;
  const sin = recomendar({ bike, components: c2, rules, seleccion: FOX, inputs: BASE });
  assert.equal(sin.geometria.offset_mm, 52);
  assert.ok(sin.avisos.some((a) => a.includes('offset')));
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
  const bitacora = Array.from({ length: 40 }, (_, i) => ({ fecha: `2026-01-${i}`, horquilla: 'boxxer_ultimate_c2', amortiguador: 'dhx2_factory_2024', avisos }));
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
  assert.equal(f.montado, 'Fox 40 2027 · DHX2 2024 475');
  assert.equal(b.montado, 'BoXXer Ultimate · DHX2 2024 475');
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

test('sin tabla del fabricante, el rebote base escala con peso y resorte', () => {
  const c2 = clon(components);
  c2.amortiguadores.sin_tabla = {
    nombre: 'Sin tabla', tipo_resorte: 'coil', carrera_mm: 75, resorte_lb: 475, referencia_base: { peso_kg: 80, resorte_lb: 475 },
    ajustadores: [{ id: 'lsr', tipo: 'LSR', clicks_totales: 16, base_desde_cerrado: 8, efecto_por_click: null, verificado: true }],
  };
  const r = (peso_kg, lb = 475) => {
    c2.amortiguadores.sin_tabla.resorte_lb = lb;
    return recomendar({ bike, components: c2, rules, seleccion: { horquilla: 'boxxer_ultimate_c2', amortiguador: 'sin_tabla' }, inputs: { ...BASE, peso_kg } });
  };
  cerca(r(80).modelo.escala_rebote.atras, 1, 1e-9); // condición de referencia
  assert.ok(r(110).modelo.escala_rebote.atras > 1 && r(60).modelo.escala_rebote.atras < 1);
  assert.ok(aj(r(110).amortiguador.ajustadores, 'LSR').click < aj(r(60).amortiguador.ajustadores, 'LSR').click);
  assert.ok(r(80, 550).modelo.frecuencia_hz > r(80).modelo.frecuencia_hz);
  assert.ok(r(80, 550).modelo.escala_rebote.atras > 1);
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
  const d = rec({ sag_atras: { valor: 28, unidad: '%' } }); // trasera alta → la horquilla baja su objetivo
  cerca(d.horquilla.sag_objetivo.ideal, 21, 1e-6);
});

test('sag medido en la horquilla: corrige con psi_por_punto_sag, y solo si hace falta', () => {
  const base = { sag_atras: { valor: 30, unidad: '%' }, peso_kg: 80 };
  // 28 % medido con 140 psi; zona válida 20-23 % → 5 puntos × 2 psi
  const d = rec({ ...base, sag_adelante: { valor: 28, unidad: '%' }, presion_horquilla_actual: 140 });
  assert.equal(d.balance.ok, false);
  assert.equal(d.horquilla.presion.psi, 150);
  assert.match(d.horquilla.presion.porque, /estimación/);
  // sin presión actual parte de la fórmula (123 psi)
  assert.equal(rec({ ...base, sag_adelante: { valor: 28, unidad: '%' } }).horquilla.presion.psi, 133);
  // en mm: 36 mm de 200 = 18 % → sube a 20 % → −4 psi
  assert.equal(rec({ ...base, sag_adelante: { valor: 36, unidad: 'mm' }, presion_horquilla_actual: 140 }).horquilla.presion.psi, 136);
  // dentro de la zona válida no toca nada
  assert.equal(rec({ ...base, sag_adelante: { valor: 22, unidad: '%' }, presion_horquilla_actual: 140 }).horquilla.presion.psi, 140);
  // la bitácora calibra la pendiente
  const reg = (sag, psi) => ({ fecha: '2026-11-01', horquilla: 'boxxer_ultimate_c2', amortiguador: 'dhx2_factory_2024', avisos: [], medidas: { sag_adelante_pct: sag, presion_horquilla_psi: psi } });
  const cal = calibrar([reg(26, 120), reg(22, 132)], rules);
  cerca(cal.componentes.boxxer_ultimate_c2.psi_por_punto_sag, 3, 1e-9);
  const c = rec({ ...base, sag_adelante: { valor: 28, unidad: '%' }, presion_horquilla_actual: 140 }, { calibracion: cal });
  assert.equal(c.horquilla.presion.psi, 155);
  assert.doesNotMatch(c.horquilla.presion.porque, /estimación/);
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
  assert.equal(Object.keys(c3.amortiguadores).length, Object.keys(components.amortiguadores).length + 2);
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
  const reg = (avisos, horquilla = 'boxxer_ultimate_c2') => ({ fecha: '2026-11-01', horquilla, amortiguador: 'dhx2_factory_2024', avisos });
  const cal = calibrar([reg(['tope_atras']), reg(['tope_atras', 'rebota_adelante'])], rules);
  cerca(cal.sesgo_trasero, 0.67, 1e-9);
  assert.ok(cal.componentes.dhx2_factory_2024.efecto_mult.HSC < 1);
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

// ---------- Segunda tanda: datos oficiales, chips actuales y PWA ----------

const TRAILHEAD = components.horquillas.boxxer_ultimate_c2.presion_base.puntos_fuente.filas;

test('BoXXer: presión y rebote coinciden con los 6 puntos de Trailhead', () => {
  assert.equal(TRAILHEAD.length, 6);
  for (const [peso_kg, psi, rebote] of TRAILHEAD) {
    const r = rec({ peso_kg });
    assert.ok(Math.abs(r.horquilla.presion.psi - psi) <= 1, `${peso_kg} kg: ${r.horquilla.presion.psi} psi vs ${psi}`);
    const rb = aj(r.horquilla.ajustadores, 'REBOTE_UNICO');
    assert.ok(Math.abs(rb.click - rebote) <= 1, `${peso_kg} kg: rebote ${rb.click} vs ${rebote}`);
    assert.equal(rb.base_de_tabla, true);
    assert.equal(r.horquilla.presion.provisoria, false);
  }
  // con estos datos el calce es exacto
  assert.deepEqual(TRAILHEAD.map(([peso_kg]) => rec({ peso_kg }).horquilla.presion.psi), TRAILHEAD.map((f) => f[1]));
  assert.deepEqual(TRAILHEAD.map(([peso_kg]) => aj(rec({ peso_kg }).horquilla.ajustadores, 'REBOTE_UNICO').click), TRAILHEAD.map((f) => f[2]));
});

test('BoXXer: la presión crece con el peso, el rebote nunca sale de 0…18 y se avisa sobre 200 psi', () => {
  let previa = 0;
  for (let peso_kg = 40; peso_kg <= 160; peso_kg += 2.5) {
    for (const extra of [{}, { feel: 4, saltos: true, tipo: 'Tech', grip: 'Low' }, { feel: -4 }]) {
      const r = rec({ peso_kg, ...extra });
      const rb = aj(r.horquilla.ajustadores, 'REBOTE_UNICO');
      assert.ok(rb.click >= 0 && rb.click <= 18 && rb.base_click >= 0 && rb.base_click <= 18);
      assert.ok(r.horquilla.presion.psi <= 200);
    }
    const psi = rec({ peso_kg }).horquilla.presion.psi;
    assert.ok(psi >= previa, `${peso_kg} kg`);
    previa = psi;
  }
  const pesado = rec({ peso_kg: 160 });
  assert.equal(pesado.horquilla.presion.psi, 200);
  assert.equal(pesado.horquilla.presion.supera_maximo, true);
  assert.ok(pesado.avisos.some((a) => a.includes('200 psi')));
  assert.ok(!rec({ peso_kg: 90 }).avisos.some((a) => a.includes('máximo')));
});

test('BoXXer: más presión por los modifiers = menos clicks de rebote (clicks_por_psi)', () => {
  const c2 = clon(components);
  const r2 = clon(rules);
  r2.suspension_feel.horquilla_psi = { delta: 10, cada_pasos: 1 };
  r2.suspension_feel.por_paso = [];
  const con = (feel) => recomendar({ bike, components: c2, rules: r2, seleccion: BOXXER, inputs: { ...BASE, feel } });
  assert.equal(con(2).horquilla.presion.psi - con(0).horquilla.presion.psi, 20);
  assert.equal(aj(con(0).horquilla.ajustadores, 'REBOTE_UNICO').base_click, 9);
  assert.equal(aj(con(2).horquilla.ajustadores, 'REBOTE_UNICO').base_click, Math.round(10 - 0.118 * (143 - 113)));
  assert.ok(aj(con(-2).horquilla.ajustadores, 'REBOTE_UNICO').base_click > 9);
});

test('BoXXer: compresión con base provisoria al medio (LSC 9, HSC 2) y aviso de conteo real', () => {
  const r = rec();
  assert.equal(aj(r.horquilla.ajustadores, 'LSC').click, 9);
  assert.equal(aj(r.horquilla.ajustadores, 'HSC').click, 2);
  assert.equal(aj(r.horquilla.ajustadores, 'LSC').verificado, false);
  assert.equal(aj(r.horquilla.ajustadores, 'REBOTE_UNICO').verificado, true);
  assert.ok(r.avisos_componentes.some((a) => a.includes('conteo real')));
  assert.ok(r.sin_verificar.horquilla.includes('efecto por click'));
});

test('cambiar de horquilla cambia la tabla de presión y los ajustadores sin tocar código', () => {
  const b = rec({ peso_kg: 82 });
  const f = recomendar({ bike, components, rules, seleccion: FOX, inputs: { ...BASE, peso_kg: 82 } });
  assert.equal(b.horquilla.presion.psi, 125);
  assert.equal(f.horquilla.presion.psi, 76);
  assert.equal(b.horquilla.ajustadores.length, 3);
  assert.equal(f.horquilla.ajustadores.length, 4);
});

test('Fox 40 con 82 kg: 76 psi, LSR 6, HSR 6, LSC 10, HSC 5; con 70 kg: ≈ 65,7 psi y rebote 8', () => {
  const fox = (peso_kg, extra = {}) => recomendar({ bike, components, rules, seleccion: FOX, inputs: { ...BASE, peso_kg, ...extra }, offsetUsuario: 48 });
  const r = fox(82);
  assert.equal(r.horquilla.presion.psi, 76);
  assert.deepEqual(
    Object.fromEntries(r.horquilla.ajustadores.map((a) => [a.tipo, a.click])),
    { HSC: 5, LSC: 10, HSR: 6, LSR: 6 },
  );
  assert.equal(aj(r.horquilla.ajustadores, 'LSC').clicks_totales, 18);
  const s = fox(70);
  cerca(s.horquilla.presion.psi_exacta, 65.7, 0.05);
  assert.equal(s.horquilla.presion.psi, 66);
  assert.equal(aj(s.horquilla.ajustadores, 'LSR').click, 8);
  assert.equal(aj(s.horquilla.ajustadores, 'HSR').click, 8);
  // límites de rango: gana el rango más pesado; fuera de la tabla, el extremo
  assert.equal(aj(fox(59).horquilla.ajustadores, 'LSR').click, 9);
  assert.equal(aj(fox(58.9).horquilla.ajustadores, 'LSR').click, 10);
  assert.equal(aj(fox(113).horquilla.ajustadores, 'LSR').click, 2);
  assert.equal(aj(fox(50).horquilla.ajustadores, 'LSR').click, 10);
  // HSR tiene 8 clicks: 10 de la tabla se acota y se explica
  const hsr = aj(fox(56).horquilla.ajustadores, 'HSR');
  assert.equal(hsr.click, 8);
  assert.match(hsr.porque, /acotado/);
  // spacers: 2 de fábrica, +1 con saltos, máximo 5
  assert.equal(r.horquilla.tokens.cantidad, 2);
  assert.equal(fox(82, { saltos: true }).horquilla.tokens.cantidad, 3);
});

test('Fox 40: sag objetivo 15-20 %, balance con ese sag y presión nunca sobre 120 psi', () => {
  for (let peso_kg = 45; peso_kg <= 170; peso_kg += 5) {
    for (const extra of [{}, { feel: 4, saltos: true }, { sag_adelante: { valor: 30, unidad: '%' } }]) {
      const r = recomendar({ bike, components, rules, seleccion: FOX, inputs: { ...BASE, peso_kg, ...extra } });
      assert.equal(r.horquilla.sag_objetivo.min, 15);
      assert.equal(r.horquilla.sag_objetivo.max, 20);
      assert.ok(r.horquilla.sag_objetivo.ideal >= 15 && r.horquilla.sag_objetivo.ideal <= 20);
      assert.ok(r.horquilla.presion.psi <= 120, `${peso_kg} kg: ${r.horquilla.presion.psi}`);
    }
  }
  const r = recomendar({ bike, components, rules, seleccion: FOX, inputs: { ...BASE, peso_kg: 92 } });
  cerca(r.horquilla.sag_objetivo.mm, 0.175 * 203, 0.01);
  assert.equal(r.balance.ok, true); // 30 % atrás con 17,5 % adelante es el balance esperado para esta horquilla
  assert.equal(rec().horquilla.sag_objetivo.min, 20); // la BoXXer mantiene 20-25 %
  const tope = recomendar({ bike, components, rules, seleccion: FOX, inputs: { ...BASE, peso_kg: 170 } });
  assert.equal(tope.horquilla.presion.psi, 120);
  assert.ok(tope.avisos.some((a) => a.includes('120 psi')));
});

test('DHX2 2024 tabla B: los clicks salen SIEMPRE de la fila del resorte instalado', () => {
  const bases = (r) => Object.fromEntries(r.amortiguador.ajustadores.map((a) => [a.tipo, a.base_click]));
  const con475 = rec({ peso_kg: 92 });
  assert.equal(con475.amortiguador.resorte.veredicto, 'mantener');
  assert.deepEqual(bases(con475), { HSC: 4, LSC: 9, HSR: 4, LSR: 5 });
  assert.match(aj(con475.amortiguador.ajustadores, 'LSC').porque, /tabla B, resorte 475 lb: 9-10/);
  assert.equal(con475.amortiguador.palanca, 'Palanca en Open');
  cerca(con475.amortiguador.sag_objetivo.mm, 22.5, 1e-9);

  // 475 instalado y 450 recomendado: fila 475
  const a450 = [78, 80, 82, 84, 85, 86, 88].map((peso_kg) => rec({ peso_kg })).find((r) => r.amortiguador.resorte.recomendado_lb === 450);
  assert.ok(a450, 'ningún peso de prueba recomienda 450 lb');
  assert.equal(a450.amortiguador.resorte.instalado_lb, 475);
  assert.equal(a450.amortiguador.resorte.linea, 'Resorte instalado: 475 lb · Recomendado: 450 lb (sag objetivo 30 %)');
  assert.deepEqual(bases(a450), { HSC: 4, LSC: 9, HSR: 4, LSR: 5 });
  assert.equal(a450.amortiguador.resorte_para_clicks_lb, 475);
  // al cambiar el instalado a 450: fila 450
  const ya450 = rec({ peso_kg: a450.inputs.peso_kg }, { resorteInstalado: 450 });
  assert.equal(ya450.amortiguador.resorte.instalado_lb, 450);
  assert.deepEqual(bases(ya450), { HSC: 5, LSC: 10, HSR: 4, LSR: 5 });
  assert.equal(ya450.montado, 'BoXXer Ultimate · DHX2 2024 450');
  assert.equal(ya450.amortiguador.resorte.veredicto, 'mantener');
});

test('DHX2 tabla B: completa, y un valor sobre clicks_totales se acota y se explica', () => {
  const filas = components.amortiguadores.dhx2_factory_2024.base_por_resorte.filas;
  assert.equal(Object.keys(filas).length, 22);
  assert.deepEqual(filas['200'].LSC, [16, 17]);
  assert.deepEqual(filas['725'], { LSR: [0, 1], HSR: [0, 1], LSC: [2, 3], HSC: [0, 1] });
  const totales = Object.fromEntries(components.amortiguadores.dhx2_factory_2024.ajustadores.map((a) => [a.tipo, a.clicks_totales]));
  assert.deepEqual(totales, { HSC: 8, LSC: 16, HSR: 8, LSR: 16 });
  const c2 = clon(components);
  c2.amortiguadores.dhx2_factory_2024.base_por_resorte.filas['200'].LSC = [17, 18];
  c2.amortiguadores.dhx2_factory_2024.resorte_lb = 200;
  const r = recomendar({ bike, components: c2, rules, seleccion: BOXXER, inputs: { ...BASE, peso_kg: 40, sag_atras: { valor: 30, unidad: '%' } } });
  const lsc = aj(r.amortiguador.ajustadores, 'LSC');
  assert.equal(lsc.base_click, 16);
  assert.match(lsc.porque, /17 acotado al máximo de 16/);
});

test('Actual → Recomendado: "Sin cambios" si coinciden y el detalle correcto si difieren', () => {
  const igual = rec().geometria; // por defecto Mid / Mid / Short = baseline
  assert.deepEqual(igual.actuales, { maestro: 'Mid', direccion: 'Mid', dropout: 'Short' });
  for (const c of ['maestro', 'direccion', 'dropout']) {
    assert.equal(igual[c].cambia, false);
    assert.equal(igual[c].texto, 'Sin cambios');
  }
  assert.equal(igual.hay_cambios, false);

  const g = rec({}, { chipsActuales: { maestro: 'Low', direccion: 'Long', dropout: 'Long' } }).geometria;
  assert.equal(g.hay_cambios, true);
  assert.equal(g.maestro.actual, 'Low');
  assert.equal(g.maestro.recomendado, 'Mid');
  assert.equal(g.maestro.texto, 'Low → Mid: reach +3,7 mm · trail −2,7 mm · dirección +0,4° · caída del pedalier −5 mm');
  assert.equal(g.direccion.texto, 'Long → Mid: reach −5 mm');
  assert.match(g.dropout.texto, /^Long → Short: /);
  // la geometría mostrada es la ACTUAL, con el offset de la horquilla activa
  cerca(g.medidas.trail_mm, 150.7, 0.06);
  cerca(g.medidas.reach_mm, 461.2 + 5, 0.06); // la BoXXer C2 es 0,1 mm más alta que la de serie
  cerca(g.medidas_recomendadas.trail_mm, 148.0, 0.06);
  // la posición actual no cambia la recomendación
  assert.deepEqual(g.recomendados, igual.recomendados);
  assert.deepEqual(rec({}, { chipsActuales: { maestro: 'Inventado' } }).geometria.actuales.maestro, 'Mid');
});

test('PWA: rutas relativas, y todo lo que precarga el service worker existe', () => {
  const raiz = new URL('../', import.meta.url);
  const txt = (f) => readFileSync(new URL(f, raiz), 'utf8');
  const manifest = JSON.parse(txt('manifest.webmanifest'));
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  for (const i of manifest.icons) assert.ok(!i.src.startsWith('/'));
  const sw = txt('sw.js');
  const lista = [...sw.matchAll(/^\s*'([^']+)',$/gm)].map((m) => m[1]);
  assert.ok(lista.length >= 15);
  for (const f of lista) {
    assert.ok(!f.startsWith('/') && !f.startsWith('http'), `ruta absoluta: ${f}`);
    if (f !== './') assert.doesNotThrow(() => readFileSync(new URL(f, raiz)), `falta ${f}`);
  }
  for (const f of ['version.js', 'js/app.js', 'js/almacen.js', 'data/rules.json']) assert.ok(lista.includes(f), `no se precarga ${f}`);
  assert.match(sw, /importScripts\('version\.js'\)/);
  assert.doesNotMatch(txt('index.html'), /(href|src)="\//);
  assert.match(txt('version.js'), /GLORY_VERSION = '\d+\.\d+\.\d+'/);
  // el service worker nuevo espera a que el usuario acepte: no reemplaza la app a mitad de uso
  assert.match(sw, /SKIP_WAITING/);
});

// ---------- Tercera tanda: catálogo completo, A2C, diales y resorte instalado ----------

const D2 = { horquilla: 'boxxer_ultimate_d2_2027', amortiguador: 'dhx2_factory_2024' };
const con = (seleccion, inputs = {}, extra = {}) => recomendar({ bike, components, rules, seleccion: { ...BOXXER, ...seleccion }, inputs: { ...BASE, ...inputs }, ...extra });

test('catálogo: toda la gama, con fuente, confianza, offsets, A2C y montaje', () => {
  assert.deepEqual(Object.keys(components.horquillas), ['boxxer_ultimate_c2', 'fox40_2027', 'boxxer_ultimate_d2_2027']);
  assert.deepEqual(Object.keys(components.amortiguadores), ['dhx2_factory_2024', 'dhx2_factory_2027', 'vivid_coil_ultimate_dh_2027']);
  for (const c of [...Object.values(components.horquillas), ...Object.values(components.amortiguadores)]) {
    assert.ok(typeof c.fuente === 'string' && c.fuente.length > 10, c.nombre);
    assert.ok(['oficial', 'no_verificado'].includes(c.confianza), c.nombre);
  }
  const h = components.horquillas;
  assert.deepEqual([h.boxxer_ultimate_c2.offsets_disponibles, h.fox40_2027.offsets_disponibles, h.boxxer_ultimate_d2_2027.offsets_disponibles], [[48], [44, 48, 52, 56], [48, 52]]);
  assert.deepEqual([h.boxxer_ultimate_c2.a2c_mm, h.fox40_2027.a2c_mm, h.boxxer_ultimate_d2_2027.a2c_mm], [602, 601.9, 605]);
  assert.deepEqual([h.boxxer_ultimate_c2.offset_mm, h.fox40_2027.offset_mm, h.boxxer_ultimate_d2_2027.offset_mm], [48, 52, 48]);
  for (const a of Object.values(components.amortiguadores)) assert.equal(esCompatible(bike, a), true);
  assert.deepEqual(components.amortiguadores.dhx2_factory_2024.alias, ['dhx2_factory']);
  assert.equal(Object.keys(components.amortiguadores.dhx2_factory_2027.base_por_resorte.filas).length, 22);
});

test('aviso discreto solo para componentes no verificados con el fabricante', () => {
  assert.deepEqual(rec().sin_verificar_fabricante, []);
  assert.deepEqual(con(D2).sin_verificar_fabricante, ['Datos de BoXXer Ultimate D2 sin verificar con el fabricante']);
  assert.deepEqual(con({ ...D2, amortiguador: 'vivid_coil_ultimate_dh_2027' }).sin_verificar_fabricante.length, 2);
});

test('geometría: Fox 40 con 52 mm (A2C 601,9) = tabla de Giant exacta', () => {
  for (const pos of ['Low', 'Mid', 'High']) {
    const g = con({ horquilla: 'fox40_2027' }, {}, { chipsActuales: { maestro: pos, direccion: 'Mid', dropout: 'Short' } }).geometria;
    const t = bike.geometria.maestro[pos];
    for (const k of ['angulo_direccion', 'angulo_sillin', 'reach_mm', 'stack_mm', 'caida_pedalier_mm', 'vaina_mm', 'distancia_ejes_mm', 'trail_mm']) {
      cerca(g.medidas[k], t[k], 1e-9, `${pos} ${k}`);
    }
  }
  const mid = con({ horquilla: 'fox40_2027' }).geometria.delta_giant_mid;
  for (const v of Object.values(mid)) cerca(v, 0, 1e-9);
});

test('geometría: BoXXer D2 (A2C 605) ≈ 0,12° más lanzada y ≈ 1 mm más alto el pedalier; C2 (602) ≈ sin cambio', () => {
  const d2 = con(D2).geometria;
  cerca(d2.medidas.angulo_direccion, 62.0 - 0.12, 0.005);
  cerca(d2.medidas.angulo_sillin, 78.8 - 0.12, 0.005);
  cerca(d2.medidas.caida_pedalier_mm, 8.3 - 0.95, 0.05);
  cerca(d2.medidas.stack_mm - 632.2, 3.1 * Math.sin((62 * Math.PI) / 180), 1e-6);
  cerca(d2.medidas.reach_mm - 464.9, -3.1 * Math.cos((62 * Math.PI) / 180), 1e-6);
  cerca(d2.delta_giant_mid.angulo_direccion, -0.12, 0.005);
  const c2 = rec().geometria;
  cerca(c2.medidas.angulo_direccion, 62.0, 0.005);
  cerca(c2.medidas.caida_pedalier_mm, 8.3, 0.05);
  cerca(geometriaResultante(bike, { maestro: 'Mid', direccion: 'Mid' }, 52, 601.9).angulo_direccion, 62, 1e-12);
});

test('geometría: BoXXer D2 con 48 mm = mismos valores corregidos de offset; con 52 = trail de la tabla', () => {
  const esperado = { Low: 150.7, Mid: 148.0, High: 145.3 };
  for (const pos of ['Low', 'Mid', 'High']) {
    const g = con(D2, {}, { chipsActuales: { maestro: pos } }).geometria.medidas;
    cerca(g.trail_mm, esperado[pos], 0.06, `trail ${pos}`);
    cerca(g.distancia_ejes_mm - bike.geometria.maestro[pos].distancia_ejes_mm, -3.5, 0.06, `ejes ${pos}`);
    cerca(con(D2, {}, { chipsActuales: { maestro: pos }, offsetUsuario: 52 }).geometria.medidas.trail_mm, bike.geometria.maestro[pos].trail_mm, 1e-9);
  }
});

test('geometría: el chip de dirección cambia solo el reach (±5) y la distancia entre ejes', () => {
  const g = (direccion) => con(D2, {}, { chipsActuales: { direccion } }).geometria.medidas;
  const [s, m, l] = [g('Short'), g('Mid'), g('Long')];
  cerca(s.reach_mm - m.reach_mm, -5, 1e-9);
  cerca(l.reach_mm - m.reach_mm, 5, 1e-9);
  for (const k of ['angulo_direccion', 'angulo_sillin', 'stack_mm', 'trail_mm', 'caida_pedalier_mm', 'vaina_mm']) {
    assert.equal(s[k], m[k]);
    assert.equal(l[k], m[k]);
  }
});

test('offset al cambiar de horquilla: se mantiene si existe, o el más cercano con aviso', () => {
  const h = components.horquillas;
  assert.deepEqual(offsetParaHorquilla(h.fox40_2027, 48), { offset: 48, cambio: false });
  assert.deepEqual(offsetParaHorquilla(h.boxxer_ultimate_c2, 56), { offset: 48, cambio: true });
  assert.deepEqual(offsetParaHorquilla(h.boxxer_ultimate_d2_2027, 44), { offset: 48, cambio: true });
  assert.deepEqual(offsetParaHorquilla(h.boxxer_ultimate_d2_2027, 56), { offset: 52, cambio: true });
  assert.deepEqual(offsetParaHorquilla(h.fox40_2027, null), { offset: 52, cambio: false });
});

test('dial numerado: clicks desde cerrado = max − dial, y se muestra el dial entre paréntesis', () => {
  const n = normalizarAjustador({ id: 'lsc', tipo: 'LSC', tipo_escala: 'numerado', min: -7, max: 7, positivo_es_firme: true, base_dial: 0 });
  assert.equal(n.clicks_totales, 14);
  assert.equal(n.base_desde_cerrado, 7);
  assert.equal(n.aDial(0), 7);
  assert.equal(n.aDial(14), -7);
  const r = con(D2);
  const lsc = aj(r.horquilla.ajustadores, 'LSC');
  assert.equal(lsc.texto, 'LSC adelante: 7 clicks desde cerrado (dial 0)');
  assert.equal(aj(r.horquilla.ajustadores, 'HSC').texto, 'HSC adelante: 2 clicks desde cerrado (dial 0)');
  // más firme = menos clicks desde cerrado = dial positivo
  const firme = aj(con(D2, { feel: 3 }).horquilla.ajustadores, 'LSC');
  assert.equal(firme.click, 5);
  assert.equal(firme.dial, 2);
  assert.match(firme.texto, /\(dial \+2\)/);
  assert.match(aj(con(D2, { feel: -4 }).horquilla.ajustadores, 'LSC').texto, /10 clicks desde cerrado \(dial −3\)/);
  for (const feel of [-4, 4]) {
    for (const a of con({ ...D2, amortiguador: 'vivid_coil_ultimate_dh_2027' }, { feel, saltos: true, grip: 'High' }).amortiguador.ajustadores) {
      if (a.dial != null) assert.ok(a.dial >= -2 && a.dial <= 2, `${a.etiqueta} dial ${a.dial}`);
    }
  }
});

test('BoXXer D2: presión por tabla (máx. 300 psi), sag 20-30 %, tokens 0 de 6 y rebote pendiente', () => {
  const r = con(D2, { peso_kg: 76.5 });
  assert.equal(r.horquilla.presion.psi, 140);
  assert.equal(con(D2, { peso_kg: 81 }).horquilla.presion.psi, 150);
  assert.equal(r.horquilla.presion.maximo_psi, 300);
  assert.equal(r.horquilla.presion.provisoria, true);
  assert.deepEqual([r.horquilla.sag_objetivo.min, r.horquilla.sag_objetivo.max], [20, 30]);
  assert.equal(r.horquilla.tokens.cantidad, 0);
  assert.equal(con(D2, { saltos: true }).horquilla.tokens.cantidad, 1);
  const rebote = aj(r.horquilla.ajustadores, 'REBOTE_UNICO');
  assert.equal(rebote.sin_datos, true);
  assert.match(rebote.porque, /Trailhead/);
  assert.equal(r.horquilla.ajustadores.length, 3);
  for (let peso_kg = 45; peso_kg <= 200; peso_kg += 5) assert.ok(con(D2, { peso_kg, feel: 4 }).horquilla.presion.psi <= 300);
});

test('DHX2 2027: bases de su propia tabla por resorte instalado', () => {
  const bases = (r) => Object.fromEntries(r.amortiguador.ajustadores.map((a) => [a.tipo, a.base_click]));
  const sel = { amortiguador: 'dhx2_factory_2027' };
  assert.deepEqual(bases(con(sel)), { HSC: 4, LSC: 9, HSR: 4, LSR: 8 });
  assert.deepEqual(bases(con(sel, {}, { resorteInstalado: 525 })), { HSC: 2, LSC: 7, HSR: 3, LSR: 6 });
  assert.deepEqual(bases(con(sel, {}, { resorteInstalado: 325 })), { HSC: 6, LSC: 11, HSR: 6, LSR: 11 });
  assert.match(aj(con(sel).amortiguador.ajustadores, 'LSR').porque, /tabla 2027, resorte 475 lb: 8/);
  assert.deepEqual(con(sel).sin_verificar_fabricante, []);
});

test('Vivid Coil: diales, ABO 1-5 (Saltos +1), precarga 2-5 vueltas, pasos de 50 lb y tabla por peso', () => {
  const sel = { amortiguador: 'vivid_coil_ultimate_dh_2027' };
  const viv = components.amortiguadores.vivid_coil_ultimate_dh_2027;
  assert.deepEqual(resortesDisponibles(viv, rules), [250, 300, 350, 400, 450, 500, 550, 600, 650]);
  assert.equal(resortesDisponibles(components.amortiguadores.dhx2_factory_2024, rules).length, 22);
  assert.ok(resortesDisponibles(components.amortiguadores.dhx2_factory_2024, rules).includes(475));

  const r = con(sel, { peso_kg: 85 }, { resorteInstalado: 450 });
  assert.deepEqual(r.amortiguador.ajustadores.map((a) => a.tipo), ['HSC', 'LSC', 'ABO', 'LSR']);
  const abo = aj(r.amortiguador.ajustadores, 'ABO');
  assert.equal(abo.texto, 'ABO: posición 1 de 5');
  assert.equal(abo.es_posicion, true);
  const aboSaltos = aj(con(sel, { peso_kg: 85, saltos: true }, { resorteInstalado: 450 }).amortiguador.ajustadores, 'ABO');
  assert.equal(aboSaltos.click, 2);
  assert.match(aboSaltos.porque, /Saltos/);
  assert.equal(aj(r.amortiguador.ajustadores, 'HSC').texto, 'HSC atrás: 2 clicks desde cerrado (dial 0)');
  assert.equal(aj(r.amortiguador.ajustadores, 'LSR').clicks_totales, 19);
  assert.equal(r.amortiguador.resorte.recomendado_lb % 50, 0);
  assert.equal(r.amortiguador.resorte.tabla_fabricante.texto, 'Tabla del fabricante para 85 kg: 450-500 lb');
  assert.deepEqual([r.amortiguador.sag_objetivo.min, r.amortiguador.sag_objetivo.max], [30, 33]);
  for (const peso_kg of [50, 70, 90, 110, 130]) {
    for (const resorteInstalado of [250, 450, 650]) {
      const p = con(sel, { peso_kg }, { resorteInstalado }).amortiguador;
      assert.ok(p.precarga.vueltas >= 2 && p.precarga.vueltas <= 5, `${peso_kg} kg / ${resorteInstalado} lb: ${p.precarga.vueltas}`);
      assert.ok(p.resorte.recomendado_lb >= 250 && p.resorte.recomendado_lb <= 650);
    }
  }
  // rebote según resorte: 1,5 clicks por cada 50 lb cuando hay resorte de referencia
  const c2 = clon(components);
  c2.amortiguadores.vivid_coil_ultimate_dh_2027.rebote_por_resorte.resorte_ref_lb = 450;
  const lsr = (lb) => aj(recomendar({ bike, components: c2, rules, seleccion: { ...BOXXER, ...sel }, inputs: BASE, resorteInstalado: lb }).amortiguador.ajustadores, 'LSR').base_click;
  assert.deepEqual([lsr(450), lsr(550), lsr(350)], [10, 7, 13]);
});

test('resorte instalado vs recomendado: precarga dentro de límites o aviso de cambio', () => {
  const duro = rec({ peso_kg: 60 }).amortiguador; // 475 lb muy duro
  assert.equal(duro.resorte.veredicto, 'cambiar');
  assert.match(duro.resorte.porque, /^Con este resorte no llegas al sag objetivo: cambia a \d+ lb/);
  assert.ok(duro.resorte.recomendado_lb < 475);
  const blando = rec({ peso_kg: 125 }).amortiguador;
  assert.equal(blando.precarga.vueltas, 2);
  assert.match(blando.resorte.porque, /cambia a \d+ lb/);
  assert.ok(blando.resorte.recomendado_lb > 475);
  // el sag medido recalibra el sesgo con el resorte INSTALADO y cambia el recomendado
  const a = rec({ sag_atras: { valor: 33, unidad: '%' } }, { resorteInstalado: 450 });
  const b = rec({ sag_atras: { valor: 33, unidad: '%' } }, { resorteInstalado: 500 });
  assert.ok(b.modelo.sesgo_trasero > a.modelo.sesgo_trasero);
  assert.ok(b.amortiguador.resorte.recomendado_lb > a.amortiguador.resorte.recomendado_lb);
  // el sag que se muestra es el del resorte instalado
  assert.ok(rec({}, { resorteInstalado: 400 }).amortiguador.sag.pct_shock > rec({}, { resorteInstalado: 500 }).amortiguador.sag.pct_shock);
});

test('amortiguador que no es 225×75 trunnion: no calza en la Glory', () => {
  assert.equal(esCompatible(bike, { montaje: '225×75 Trunnion' }), true);
  assert.equal(esCompatible(bike, { montaje: '250x75 estándar' }), false);
  assert.equal(esCompatible(bike, {}), true); // sin dato no se bloquea
  const c2 = clon(components);
  c2.amortiguadores.otro = { ...clon(c2.amortiguadores.dhx2_factory_2027), nombre: 'Otro', montaje: '250x75' };
  assert.equal(recomendar({ bike, components: c2, rules, seleccion: { ...BOXXER, amortiguador: 'otro' }, inputs: BASE }).compatible, false);
  assert.equal(rec().compatible, true);
});

test('presión de la horquilla activa: cambia mucho entre horquillas y nunca supera su máximo', () => {
  const psi = (horquilla, peso_kg = 82) => con({ horquilla }, { peso_kg }).horquilla.presion;
  assert.equal(psi('fox40_2027').psi, 76);
  assert.equal(psi('boxxer_ultimate_c2').psi, 125);
  assert.deepEqual([psi('fox40_2027').maximo_psi, psi('boxxer_ultimate_c2').maximo_psi, psi('boxxer_ultimate_d2_2027').maximo_psi], [120, 200, 300]);
  for (const horquilla of Object.keys(components.horquillas)) {
    for (let peso_kg = 40; peso_kg <= 200; peso_kg += 10) {
      const p = con({ horquilla }, { peso_kg, feel: 4, saltos: true }).horquilla.presion;
      assert.ok(p.psi <= p.maximo_psi, `${horquilla} ${peso_kg} kg: ${p.psi} > ${p.maximo_psi}`);
    }
  }
});

test('todas las combinaciones del catálogo: clicks en rango y un porqué por línea', () => {
  verificarRangos(components);
});
