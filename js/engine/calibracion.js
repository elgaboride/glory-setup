// La calibración es una función pura de la bitácora: cada registro con avisos
// ("hizo tope", "rebota mucho", "se hunde en curvas") mueve los parámetros
// calibrables del modelo. Borrar el registro deshace su efecto.

import { calibracionNeutra } from './motor.js';

const clamp = (v, [a, b]) => Math.min(Math.max(v, a), b);

function aplicarComponente(cal, id, cambios, lim) {
  if (!id || !cambios) return;
  const c = (cal.componentes[id] ??= { efecto_mult: {}, bias: {}, presion_mult: 1 });
  for (const [tipo, m] of Object.entries(cambios.efecto_mult ?? {})) {
    c.efecto_mult[tipo] = clamp((c.efecto_mult[tipo] ?? 1) * m, lim.efecto_mult);
  }
  for (const [tipo, b] of Object.entries(cambios.bias ?? {})) {
    c.bias[tipo] = clamp((c.bias[tipo] ?? 0) + b, lim.bias);
  }
  if (cambios.presion_mult) c.presion_mult = clamp(c.presion_mult * cambios.presion_mult, lim.presion_mult);
}

export function calibrar(bitacora, rules) {
  const cal = calibracionNeutra(rules);
  const cfg = rules.calibracion;
  const lim = cfg.limites;
  const orden = [...(bitacora ?? [])].sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));
  for (const reg of orden) {
    for (const aviso of reg.avisos ?? []) {
      const fb = cfg.feedback[aviso];
      if (!fb) continue;
      if (fb.sesgo_trasero) cal.sesgo_trasero = clamp(cal.sesgo_trasero + fb.sesgo_trasero, rules.modelo.sesgo_limites);
      if (fb.impacto_mult) cal.impacto_mult = clamp(cal.impacto_mult * fb.impacto_mult, lim.impacto_mult);
      aplicarComponente(cal, reg.horquilla, fb.horquilla, lim);
      aplicarComponente(cal, reg.amortiguador, fb.amortiguador, lim);
    }
  }
  // psi_por_punto_sag: pendiente presión–sag de las salidas donde se midió el
  // sag de la horquilla junto con la presión usada (mínimos cuadrados).
  const porHorquilla = {};
  for (const reg of orden) {
    const m = reg.medidas;
    if (!reg.horquilla || !(m?.sag_adelante_pct > 0) || !(m?.presion_horquilla_psi > 0)) continue;
    (porHorquilla[reg.horquilla] ??= []).push([m.sag_adelante_pct, m.presion_horquilla_psi]);
  }
  for (const [id, pts] of Object.entries(porHorquilla)) {
    if (pts.length < 2) continue;
    const ms = pts.reduce((a, p) => a + p[0], 0) / pts.length;
    const mp = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    const varS = pts.reduce((a, p) => a + (p[0] - ms) ** 2, 0);
    if (varS < 0.5) continue; // todas las mediciones con casi el mismo sag: no hay pendiente
    const pendiente = -pts.reduce((a, p) => a + (p[0] - ms) * (p[1] - mp), 0) / varS;
    if (!(pendiente > 0)) continue;
    const c = (cal.componentes[id] ??= { efecto_mult: {}, bias: {}, presion_mult: 1 });
    c.psi_por_punto_sag = clamp(pendiente, lim.psi_por_punto_sag ?? [0.5, 6]);
  }
  return cal;
}

export function resumenCalibracion(cal, rules, components) {
  const lineas = [];
  if (Math.abs(cal.sesgo_trasero - rules.modelo.sesgo_trasero) > 1e-9) {
    lineas.push(`Sesgo trasero: ${rules.modelo.sesgo_trasero} → ${cal.sesgo_trasero.toFixed(2)}`);
  }
  if (cal.impacto_mult !== 1) lineas.push(`Impacto de referencia ×${cal.impacto_mult.toFixed(2)}`);
  for (const [id, c] of Object.entries(cal.componentes)) {
    const nombre = components.horquillas[id]?.nombre ?? components.amortiguadores[id]?.nombre ?? id;
    const partes = [];
    for (const [t, m] of Object.entries(c.efecto_mult)) partes.push(`efecto ${t} ×${m.toFixed(2)}`);
    for (const [t, b] of Object.entries(c.bias)) partes.push(`${t} +${Math.round(b * 100)} %`);
    if (c.presion_mult !== 1) partes.push(`presión ×${c.presion_mult.toFixed(2)}`);
    if (c.psi_por_punto_sag != null) partes.push(`${c.psi_por_punto_sag.toFixed(1)} psi por punto de sag`);
    if (partes.length) lineas.push(`${nombre}: ${partes.join(', ')}`);
  }
  return lineas;
}
