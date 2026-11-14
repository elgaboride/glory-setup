// Modelo físico de la suspensión trasera: cinemática, equilibrio estático,
// rigidez en la rueda, resorte ideal, frecuencia y uso de recorrido en un impacto.
// Unidades: mm, N, N/mm, kg. Los resortes se expresan en lb/in como en catálogo.

import { crearSplineMonotona } from './spline.js';

export const G = 9.80665;
export const LBIN_A_NMM = 0.1751268; // 1 lb/in en N/mm

// LR(x) = d(rueda)/d(shock). El desplazamiento del shock es la integral de 1/LR.
export function crearCinematica(bike) {
  const st = bike.suspension_trasera;
  const recorrido = st.recorrido_mm;
  const LR = crearSplineMonotona(st.cinematica.curva_leverage.puntos);
  const PASO = 0.5;
  const n = Math.round(recorrido / PASO);
  const xs = new Float64Array(n + 1);
  const ss = new Float64Array(n + 1);
  for (let i = 1; i <= n; i++) {
    const a = (i - 1) * PASO;
    const b = i * PASO;
    xs[i] = b;
    // Simpson en cada tramo
    ss[i] = ss[i - 1] + (PASO / 6) * (1 / LR(a) + 4 / LR((a + b) / 2) + 1 / LR(b));
  }
  const carreraIntegrada = ss[n];

  function shockEn(x) {
    const xc = Math.min(Math.max(x, 0), recorrido);
    const i = Math.min(Math.floor(xc / PASO), n - 1);
    const t = (xc - xs[i]) / PASO;
    return ss[i] + t * (ss[i + 1] - ss[i]);
  }
  function ruedaEn(s) {
    if (s <= 0) return 0;
    if (s >= carreraIntegrada) return recorrido;
    let lo = 0;
    let hi = n;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (ss[mid] <= s) lo = mid;
      else hi = mid;
    }
    return xs[lo] + ((s - ss[lo]) / (ss[hi] - ss[lo])) * PASO;
  }
  return { LR, shockEn, ruedaEn, recorrido, carrera: st.carrera_mm, carreraIntegrada };
}

// Fuerza vertical en la rueda con el shock comprimido hasta el recorrido x.
function fuerzaRueda(cin, kNmm, precargaMm, x) {
  return (kNmm * (cin.shockEn(x) + precargaMm)) / cin.LR(x);
}

// Equilibrio estático: k·(s + precarga) / LR(x) = carga en la rueda.
export function sagEstatico({ cin, k_lb, cargaN, precarga_mm = 0 }) {
  const k = k_lb * LBIN_A_NMM;
  let x;
  if (fuerzaRueda(cin, k, precarga_mm, 0) >= cargaN) x = 0;
  else if (fuerzaRueda(cin, k, precarga_mm, cin.recorrido) <= cargaN) x = cin.recorrido;
  else {
    let lo = 0;
    let hi = cin.recorrido;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (fuerzaRueda(cin, k, precarga_mm, mid) < cargaN) lo = mid;
      else hi = mid;
    }
    x = (lo + hi) / 2;
  }
  const s = cin.shockEn(x);
  return {
    rueda_mm: x,
    shock_mm: s,
    pct_shock: (s / cin.carrera) * 100,
    pct_rueda: (x / cin.recorrido) * 100,
    en_tope: x >= cin.recorrido,
  };
}

// Rigidez vertical en la rueda (N/mm) con el recorrido x.
export function wheelRate(cin, k_lb, x) {
  const lr = cin.LR(x);
  return (k_lb * LBIN_A_NMM) / (lr * lr);
}

// Resorte que da el sag objetivo (% de carrera) con la curva real.
export function resorteIdeal({ cin, cargaN, sagObjetivoPct, precarga_mm = 0, paso_lb = 25 }) {
  const s = (sagObjetivoPct / 100) * cin.carrera;
  const x = cin.ruedaEn(s);
  const kNmm = (cargaN * cin.LR(x)) / (s + precarga_mm);
  const exacto = kNmm / LBIN_A_NMM;
  return { exacto_lb: exacto, catalogo_lb: Math.round(exacto / paso_lb) * paso_lb };
}

// Sesgo trasero que hace coincidir el modelo con un sag medido (mm de shock).
export function sesgoDesdeSag({ cin, k_lb, sagShockMm, precarga_mm = 0, masaTotalKg }) {
  const x = cin.ruedaEn(sagShockMm);
  const carga = (k_lb * LBIN_A_NMM * (sagShockMm + precarga_mm)) / cin.LR(x);
  return carga / (masaTotalKg * G);
}

export function frecuenciaHz(wheelRateNmm, masaKg) {
  return Math.sqrt((wheelRateNmm * 1000) / masaKg) / (2 * Math.PI);
}

// Impacto de referencia: energía (J) que debe absorber el resorte trasero
// partiendo del sag. Devuelve la fracción del recorrido de rueda que se usa.
export function usoRecorridoImpacto({ cin, k_lb, cargaN, precarga_mm = 0, energiaJ }) {
  const k = k_lb * LBIN_A_NMM;
  const sag = sagEstatico({ cin, k_lb, cargaN, precarga_mm });
  const s0 = sag.shock_mm + precarga_mm;
  const absorbida = (x) => {
    const s = cin.shockEn(x) + precarga_mm;
    return (0.5 * k * (s * s - s0 * s0) - cargaN * (x - sag.rueda_mm)) / 1000;
  };
  if (absorbida(cin.recorrido) <= energiaJ) return { uso: 1, hace_tope: true, rueda_mm: cin.recorrido };
  let lo = sag.rueda_mm;
  let hi = cin.recorrido;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (absorbida(mid) < energiaJ) lo = mid;
    else hi = mid;
  }
  const x = (lo + hi) / 2;
  return { uso: x / cin.recorrido, hace_tope: false, rueda_mm: x };
}
