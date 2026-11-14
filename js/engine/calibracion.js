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
    if (partes.length) lineas.push(`${nombre}: ${partes.join(', ')}`);
  }
  return lineas;
}
