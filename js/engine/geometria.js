// Geometría resultante según flip chips y offset de la horquilla activa.

const rad = (g) => (g * Math.PI) / 180;

// Radio efectivo de la rueda delantera que hace cuadrar la tabla de Giant:
// trail = (R·cosθ − offset) / sinθ  →  R = (trail·sinθ + offset) / cosθ
export function radioEfectivo(trailTabla, anguloDireccion, offsetRef) {
  const th = rad(anguloDireccion);
  return (trailTabla * Math.sin(th) + offsetRef) / Math.cos(th);
}

export function trailConOffset(bike, maestro, offsetMm) {
  const g = bike.geometria;
  const base = g.maestro[maestro];
  const th = rad(base.angulo_direccion);
  const R = radioEfectivo(base.trail_mm, base.angulo_direccion, g.offset_referencia_mm);
  return (R * Math.cos(th) - offsetMm) / Math.sin(th);
}

// Orden de la combinación: tabla de Giant según Maestro → chip de dirección
// (reach) → offset (trail y entre ejes) → altura de la horquilla (A2C) → el
// dropout es cualitativo y no mueve medidas.
export function geometriaResultante(bike, chips, offsetMm, a2cMm) {
  const g = bike.geometria;
  const base = g.maestro[chips.maestro];
  if (!base) throw new Error(`Posición Maestro desconocida: ${chips.maestro}`);
  const dir = g.direccion[chips.direccion];
  if (!dir) throw new Error(`Posición de dirección desconocida: ${chips.direccion}`);
  const offset = offsetMm ?? g.offset_referencia_mm;
  const th = rad(base.angulo_direccion);
  const deltaEjesOffset = (offset - g.offset_referencia_mm) * Math.sin(th);
  // El chip de dirección mueve el eje delantero lo mismo que el reach.
  const ejes = base.distancia_ejes_mm + deltaEjesOffset + dir.reach_mm;

  // Altura de la horquilla respecto de la de serie (referencia de la tabla).
  const a2cRef = g.a2c_referencia_mm ?? null;
  const dA2c = a2cMm != null && a2cRef != null ? a2cMm - a2cRef : 0;
  const dAltura = dA2c * Math.sin(th); // cuánto sube el frente
  const dAngulo = ((dAltura / base.distancia_ejes_mm) * 180) / Math.PI; // grados más lanzado
  const dPedalier = dAltura * (base.vaina_mm / base.distancia_ejes_mm); // cuánto sube el pedalier
  const dReachA2c = -dA2c * Math.cos(th);

  return {
    ...base,
    angulo_direccion: base.angulo_direccion - dAngulo,
    angulo_sillin: base.angulo_sillin - dAngulo,
    stack_mm: base.stack_mm + dAltura,
    caida_pedalier_mm: base.caida_pedalier_mm - dPedalier,
    offset_mm: offset,
    reach_maestro_mm: base.reach_mm,
    reach_offset_mm: dir.reach_mm,
    reach_mm: base.reach_mm + dir.reach_mm + dReachA2c,
    trail_mm: trailConOffset(bike, chips.maestro, offset),
    delta_ejes_offset_mm: deltaEjesOffset,
    distancia_ejes_mm: ejes,
    a2c: {
      a2c_mm: a2cMm ?? a2cRef, referencia_mm: a2cRef, delta_mm: dA2c,
      altura_frente_mm: dAltura, angulo_grados: -dAngulo, pedalier_mm: dPedalier, stack_mm: dAltura, reach_mm: dReachA2c,
    },
  };
}
