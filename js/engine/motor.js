// Motor de recomendaciones. Función pura: datos (bike, components, rules) +
// selección + inputs + calibración → setup completo con el porqué de cada línea.

import {
  G, crearCinematica, sagEstatico, wheelRate, resorteIdeal, sesgoDesdeSag,
  frecuenciaHz, usoRecorridoImpacto,
} from './fisica.js';
import { geometriaResultante, trailConOffset } from './geometria.js';

const PSI_A_BAR = 0.0689476;
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const redondear = (v, paso) => Math.round(v / paso) * paso;
const num = (v, dec = 1) => (Math.round(v * 10 ** dec) / 10 ** dec).toFixed(dec).replace('.', ',').replace(/,0+$/, '');
const conSigno = (v, dec = 1) => (v > 0 ? '+' : v < 0 ? '−' : '') + num(Math.abs(v), dec);

export const NOMBRE_TIPO = {
  LSC: 'LSC', HSC: 'HSC', LSR: 'LSR', HSR: 'HSR', REBOTE_UNICO: 'Rebote',
};
export const DESCRIPCION_TIPO = {
  LSC: 'Compresión de baja velocidad',
  HSC: 'Compresión de alta velocidad',
  LSR: 'Rebote de baja velocidad',
  HSR: 'Rebote de alta velocidad',
  REBOTE_UNICO: 'Rebote',
};
const ES_REBOTE = { LSR: true, HSR: true, REBOTE_UNICO: true };

export function calibracionNeutra(rules) {
  return {
    sesgo_trasero: rules.modelo.sesgo_trasero,
    impacto_mult: 1,
    componentes: {}, // id → { efecto_mult: {tipo}, bias: {tipo}, presion_mult }
  };
}

// ---------- Amortiguación relativa por click ----------

// D[c] = amortiguación relativa con c clicks desde cerrado. D[0] = 1 (cerrado).
// efecto_por_click: número (lineal) o lista con la caída de cada click (no lineal).
export function curvaAmortiguacion(aj, mult = 1) {
  const n = aj.clicks_totales;
  const e = aj.efecto_por_click;
  const D = [1];
  for (let i = 0; i < n; i++) {
    const paso = Array.isArray(e) ? (e[i] ?? e[e.length - 1]) : (e ?? 1 / n);
    D.push(D[i] - paso * mult);
  }
  return D;
}

export function clickParaAmortiguacion(D, objetivo) {
  let mejor = 0;
  for (let c = 1; c < D.length; c++) {
    if (Math.abs(D[c] - objetivo) < Math.abs(D[mejor] - objetivo) - 1e-9) mejor = c;
  }
  return mejor;
}

function resolverAjustador({ aj, extremo, contribs, rules, calComp, escalaRebote, baseTabla }) {
  const tipoRegla = aj.tipo === 'REBOTE_UNICO' ? 'LSR' : aj.tipo;
  const etiquetaExtremo = extremo === 'adelante' ? 'adelante' : 'atrás';
  const base = {
    id: aj.id,
    tipo: aj.tipo,
    nombre: NOMBRE_TIPO[aj.tipo] ?? aj.tipo,
    descripcion: DESCRIPCION_TIPO[aj.tipo] ?? aj.tipo,
    etiqueta: `${NOMBRE_TIPO[aj.tipo] ?? aj.tipo} ${etiquetaExtremo}`,
    unidad: aj.unidad === 'posiciones' ? 'posiciones' : 'clicks',
    verificado: aj.verificado === true,
    clicks_totales: aj.clicks_totales ?? null,
  };
  if (!Number.isInteger(aj.clicks_totales) || aj.clicks_totales <= 0) {
    return {
      ...base, sin_datos: true, click: null,
      texto: `${base.etiqueta}: falta dato`,
      porque: 'Falta clicks_totales en components.json: carga el dato del manual.',
      detalle: [],
    };
  }
  const total = aj.clicks_totales;
  // Prioridad de la base: tabla del componente (por presión, peso o resorte),
  // después base_desde_cerrado y, si falta todo, la mitad del rango.
  const baseProvisoria = !baseTabla && !Number.isInteger(aj.base_desde_cerrado);
  const baseCruda = baseTabla ? Math.round(baseTabla.valor) : baseProvisoria ? Math.round(total / 2) : aj.base_desde_cerrado;
  const clickBase = clamp(baseCruda, 0, total);
  const baseAcotada = baseCruda !== clickBase;
  const efectoProvisorio = aj.efecto_por_click == null;
  const mult = calComp?.efecto_mult?.[tipoRegla] ?? 1;
  const bias = calComp?.bias?.[tipoRegla] ?? 0;
  const D = curvaAmortiguacion(aj, mult);
  const efRef = rules.modelo.efecto_referencia_por_click[tipoRegla] ?? 1 / total;

  const mias = (c) => (c.extremo === extremo || c.extremo === 'ambos') && c.delta !== 0;
  const propias = contribs.filter((c) => mias(c) && c.tipo === tipoRegla);
  const ignoradas = aj.tipo === 'REBOTE_UNICO' ? contribs.filter((c) => mias(c) && c.tipo === 'HSR') : [];
  const deltaRef = propias.reduce((s, c) => s + c.delta, 0);

  const esRebote = !!ES_REBOTE[aj.tipo];
  // Con base de tabla, el peso y el resorte ya vienen incluidos: no se reescala.
  const escala = esRebote && !baseTabla ? escalaRebote : 1;
  const objetivo = D[clickBase] * escala - deltaRef * efRef + bias;
  const click = clickParaAmortiguacion(D, objetivo);
  const medioPaso = Math.abs(D[0] - D[1]) / 2;
  const enLimite = objetivo > D[0] + medioPaso || objetivo < D[total] - medioPaso;

  const detalle = [];
  const origenBase = baseTabla ? baseTabla.texto : baseProvisoria ? 'provisoria: mitad del rango, falta base_desde_cerrado' : aj.verificado === true ? '' : 'provisoria';
  const notaAcotada = baseAcotada ? `${baseCruda} acotado al máximo de ${total}` : '';
  const parentesis = [origenBase, notaAcotada].filter(Boolean).join('; ');
  detalle.push(`Base: ${clickBase} desde cerrado${parentesis ? ` (${parentesis})` : ''}.`);
  detalle.push(`Efecto por click: ${num(Math.abs(D[0] - D[1]) * 100, 1)} % del rango${efectoProvisorio ? ' (provisorio: lineal)' : ''}${mult !== 1 ? `, calibrado ×${num(mult, 2)}` : ''}.`);
  if (esRebote && Math.abs(escala - 1) > 0.005) {
    detalle.push(`Rebote escalado ×${num(escala, 2)} por frecuencia natural y masa (${escala > 1 ? 'más' : 'menos'} amortiguación que la base).`);
  }
  for (const c of propias) detalle.push(`${c.fuente}: ${conSigno(c.delta)} click de referencia${c.porque ? ` (${c.porque})` : ''}.`);
  if (bias) detalle.push(`Calibración de bitácora: ${conSigno(bias * 100, 0)} % de amortiguación.`);
  for (const c of ignoradas) detalle.push(`${c.fuente}: delta de HSR ignorado, esta horquilla tiene un solo rebote.`);
  detalle.push(`Amortiguación objetivo ${num(objetivo * 100, 0)} % → ${click} desde cerrado${enLimite ? ' (al límite del rango)' : ''}.`);

  // Porqué en una línea
  const partes = [];
  if (esRebote && Math.abs(escala - 1) > 0.005) partes.push(`peso/resorte ×${num(escala, 2)}`);
  for (const c of propias) partes.push(c.porque ? `${c.fuente} (${c.porque})` : c.fuente);
  if (bias) partes.push('bitácora');
  const baseTxt = `Base ${clickBase}${parentesis ? ` (${parentesis})` : ''}`;
  let porque;
  if (click === clickBase) {
    porque = partes.length ? `${baseTxt}: ${partes.join(' · ')} se compensan o no alcanzan un click` : `${baseTxt}: sin cambios con estos modifiers`;
  } else {
    porque = `${baseTxt} → ${click}: ${partes.join(' · ') || 'ajuste del modelo'}`;
  }
  if (ignoradas.length) porque += ' · HSR ignorado (rebote único)';
  if (enLimite) porque += ' · al límite del rango';

  const unidadTxt = base.unidad === 'posiciones' ? `posición ${click}` : `${click} click${click === 1 ? '' : 's'}`;
  return {
    ...base,
    click,
    base_click: clickBase,
    base_provisoria: baseProvisoria,
    base_de_tabla: !!baseTabla,
    base_acotada: baseAcotada,
    efecto_provisorio: efectoProvisorio,
    en_limite: enLimite,
    hsr_ignorado: ignoradas.length > 0,
    texto: `${base.etiqueta}: ${unidadTxt} desde cerrado`,
    porque,
    detalle,
  };
}

// ---------- Reglas ----------

function cumple(si, ctx) {
  if (!si) return true;
  for (const [k, v] of Object.entries(si)) {
    if (k === 'trail_low_max_mm') { if (!(ctx.trail_low_mm <= v)) return false; }
    else if (k === 'uso_recorrido_mayor_que') { if (!(ctx.uso_recorrido > v)) return false; }
    else if (k === 'uso_recorrido_hasta') { if (!(ctx.uso_recorrido <= v)) return false; }
    else if (ctx[k] !== v) return false;
  }
  return true;
}

function plantilla(txt, ctx) {
  return (txt ?? '')
    .replaceAll('{trail_low}', num(ctx.trail_low_mm, 1))
    .replaceAll('{offset}', num(ctx.offset_mm, 0))
    .replaceAll('{uso}', num((ctx.uso_recorrido ?? 0) * 100, 0));
}

function decidirChip(lista, ctx) {
  const regla = lista.find((r) => cumple(r.si, ctx)) ?? lista[lista.length - 1];
  return { valor: regla.valor, porque: plantilla(regla.porque, ctx) };
}

function interpolarTabla(tabla, x) {
  const t = [...tabla].sort((a, b) => a[0] - b[0]);
  if (t.length === 1) return t[0][1];
  let i = 0;
  while (i < t.length - 2 && x > t[i + 1][0]) i++;
  const [x0, y0] = t[i];
  const [x1, y1] = t[i + 1];
  return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0); // extrapola en los extremos
}

function presionBase(comp, pesoKg) {
  const pb = comp.presion_base;
  if (pb == null) return null;
  if (typeof pb === 'number') return pb;
  if (pb.formula && typeof pb.formula.psi_por_kg === 'number') return (pb.formula.psi_fijo ?? 0) + pb.formula.psi_por_kg * pesoKg;
  if (Array.isArray(pb.tabla_peso_psi) && pb.tabla_peso_psi.length) return interpolarTabla(pb.tabla_peso_psi, pesoKg);
  if (typeof pb.psi_por_kg === 'number') return pb.psi_por_kg * pesoKg + (pb.psi_fijo ?? 0);
  if (typeof pb.psi === 'number') return pb.psi;
  return null;
}

// Base de rebote propia del componente: derivada de la presión (Trailhead) o
// de una tabla por peso, corregida por clicks_por_psi si la presión cambia.
export function reboteBase(comp, pesoKg, psiFinal, psiTabla) {
  const rb = comp.rebote_base;
  if (!rb) return null;
  const tipos = rb.tipos ?? ['LSR', 'HSR', 'REBOTE_UNICO'];
  if (rb.desde_presion && psiFinal != null) {
    const d = rb.desde_presion;
    return { tipos, valor: d.clicks_ref - d.clicks_por_psi * (psiFinal - d.psi_ref), texto: `${num(psiFinal, 0)} psi, ${rb.fuente_corta ?? 'tabla del fabricante'}` };
  }
  const filas = rb.tabla_peso?.filas;
  if (Array.isArray(filas) && filas.length) {
    const orden = [...filas].sort((a, b) => a[0] - b[0]);
    // En un límite exacto gana el rango más pesado.
    let fila = orden.findLast((f) => pesoKg >= f[0]) ?? orden[0];
    if (pesoKg >= orden[orden.length - 1][1]) fila = orden[orden.length - 1];
    const dPsi = psiFinal != null && psiTabla != null ? psiFinal - Math.round(psiTabla) : 0;
    const ajuste = (rb.clicks_por_psi ?? 0) * dPsi;
    return {
      tipos,
      valor: fila[2] - ajuste,
      texto: `${rb.fuente_corta ?? 'tabla del fabricante'} para ${fila[0]}-${fila[1]} kg${Math.round(fila[2] - ajuste) !== fila[2] ? `, ${conSigno(dPsi, 0)} psi` : ''}`,
    };
  }
  return null;
}

// Base de amortiguación según el resorte (tabla del fabricante). Donde hay
// rango se usa el menor valor (más amortiguación).
export function basePorResorte(comp, resorteLb, tipo) {
  const filas = comp.base_por_resorte?.filas;
  if (!filas || !Number.isFinite(resorteLb)) return null;
  const claves = Object.keys(filas).map(Number).sort((a, b) => a - b);
  if (!claves.length) return null;
  const clave = claves.reduce((m, k) => (Math.abs(k - resorteLb) < Math.abs(m - resorteLb) ? k : m), claves[0]);
  const celda = filas[String(clave)]?.[tipo];
  if (celda == null) return null;
  const [min, max] = Array.isArray(celda) ? [celda[0], celda[celda.length - 1]] : [celda, celda];
  const nombreTabla = comp.base_por_resorte.tabla ? `tabla ${comp.base_por_resorte.tabla}` : 'tabla';
  return { valor: min, texto: `${nombreTabla}, resorte ${clave} lb: ${min === max ? min : `${min}-${max}`}` };
}

const CHIPS = ['maestro', 'direccion', 'dropout'];

// Qué cambia al mover UN chip desde la posición actual a la recomendada.
function compararChip(bike, chip, actuales, recomendado, offset) {
  const actual = actuales[chip];
  if (actual === recomendado) return { actual, recomendado, cambia: false, texto: 'Sin cambios' };
  if (chip === 'dropout') {
    const d = bike.geometria.dropout[recomendado]?.descripcion;
    return { actual, recomendado, cambia: true, texto: `${actual} → ${recomendado}${d ? `: ${d.charAt(0).toLowerCase()}${d.slice(1)}` : ''}` };
  }
  const antes = geometriaResultante(bike, actuales, offset);
  const despues = geometriaResultante(bike, { ...actuales, [chip]: recomendado }, offset);
  const campos = [
    ['reach', 'reach_mm', ' mm', 1], ['trail', 'trail_mm', ' mm', 1],
    ['dirección', 'angulo_direccion', '°', 1], ['caída del pedalier', 'caida_pedalier_mm', ' mm', 1],
  ];
  const partes = campos
    .map(([n, k, u, dec]) => [n, despues[k] - antes[k], u, dec])
    .filter(([, d]) => Math.abs(d) >= 0.05)
    .map(([n, d, u, dec]) => `${n} ${conSigno(d, dec)}${u}`);
  return { actual, recomendado, cambia: true, texto: `${actual} → ${recomendado}: ${partes.join(' · ')}` };
}

function sagAPct(medida, totalMm) {
  if (!medida || medida.valor == null || medida.valor === '' || !Number.isFinite(+medida.valor) || +medida.valor <= 0) return null;
  const pct = medida.unidad === 'mm' ? (+medida.valor / totalMm) * 100 : +medida.valor;
  return pct > 0 && pct < 100 ? pct : null;
}

export function nombreMontado(components, seleccion) {
  const h = components.horquillas[seleccion.horquilla];
  const a = components.amortiguadores[seleccion.amortiguador];
  return `${h?.nombre ?? '¿horquilla?'} · ${a?.nombre ?? '¿amortiguador?'}${a?.resorte_lb ? ` ${a.resorte_lb}` : ''}`;
}

export function camposSinVerificar(comp) {
  const lista = [];
  for (const aj of comp.ajustadores ?? []) if (aj.verificado !== true) lista.push(NOMBRE_TIPO[aj.tipo] ?? aj.id);
  if ((comp.ajustadores ?? []).some((aj) => aj.efecto_por_click == null)) lista.push('efecto por click');
  if (comp.sag_objetivo && comp.sag_objetivo.verificado !== true) lista.push('sag objetivo');
  if (comp.presion_base && comp.presion_base.verificado !== true) lista.push('presión base');
  if (comp.presion_base?.psi_por_punto_sag != null && comp.presion_base.psi_por_punto_sag_verificado !== true) lista.push('psi por punto de sag');
  if (comp.spacers && comp.spacers.verificado !== true) lista.push(comp.spacers.nombre ?? 'spacers');
  if ('offset_verificado' in comp && comp.offset_verificado !== true) lista.push('offset');
  return lista;
}

const ETIQUETA_FEEL = (v) => (v === 0 ? 'Feel 0' : `Feel ${v > 0 ? 'Firm' : 'Soft'} ${conSigno(v, 0)}`);

// ---------- Recomendación completa ----------

export function recomendar({ bike, components, rules, seleccion, inputs, calibracion, offsetUsuario, chipsActuales }) {
  const sel = { ...components.seleccion_por_defecto, ...seleccion };
  const horquilla = components.horquillas[sel.horquilla];
  const amortiguador = components.amortiguadores[sel.amortiguador];
  if (!horquilla) throw new Error(`Horquilla desconocida: ${sel.horquilla}`);
  if (!amortiguador) throw new Error(`Amortiguador desconocido: ${sel.amortiguador}`);
  const cal = { ...calibracionNeutra(rules), ...(calibracion ?? {}) };
  const obj = rules.objetivos;
  const avisos = [];

  const peso = clamp(Number(inputs.peso_kg) || rules.referencia.peso_kg, 30, 200);
  const feel = clamp(Math.round(Number(inputs.feel) || 0), rules.suspension_feel.min, rules.suspension_feel.max);
  const grip = rules.trail_grip[inputs.grip] ? inputs.grip : 'Medium';
  const tipo = rules.trail_type[inputs.tipo] ? inputs.tipo : 'Mixed';
  const saltos = inputs.saltos === true;
  const rSaltos = saltos ? rules.saltos.si : rules.saltos.no;

  // ----- Offset y geometría -----
  const offsetRef = bike.geometria.offset_referencia_mm;
  let offset = horquilla.offset_mm ?? offsetUsuario ?? null;
  if (offset == null) {
    offset = offsetRef;
    avisos.push(`Falta el offset de ${horquilla.nombre}: la geometría usa ${offsetRef} mm (tabla de Giant) hasta que lo elijas en "Mi bici".`);
  }
  const ctx = {
    trail_type: tipo, trail_grip: grip, saltos,
    trail_low_mm: trailConOffset(bike, 'Low', offset),
    offset_mm: offset,
  };
  const chipMaestro = decidirChip(rules.geometria.maestro, ctx);
  const chipDireccion = decidirChip(rules.geometria.direccion, ctx);
  const chipDropout = decidirChip(rules.geometria.dropout, ctx);
  const recomendados = { maestro: chipMaestro.valor, direccion: chipDireccion.valor, dropout: chipDropout.valor };
  // Posición en que está montada la bici hoy; solo se usa para mostrar y comparar.
  const actuales = { ...bike.geometria.baseline };
  for (const c of CHIPS) if (chipsActuales?.[c] != null && bike.geometria[c]?.[chipsActuales[c]]) actuales[c] = chipsActuales[c];
  const medidas = geometriaResultante(bike, actuales, offset);
  const medidasRecomendadas = geometriaResultante(bike, recomendados, offset);
  const comparacion = Object.fromEntries(CHIPS.map((c) => [c, compararChip(bike, c, actuales, recomendados[c], offset)]));

  // ----- Modelo físico trasero -----
  const cin = crearCinematica(bike);
  const masaTotal = peso + bike.masas.peso_bici_kg;
  const mmVuelta = amortiguador.precarga_mm_por_vuelta ?? rules.modelo.precarga_mm_por_vuelta;
  const vueltasMin = obj.precarga_vueltas.min;
  const vueltasMax = obj.precarga_vueltas.max;
  const esCoil = amortiguador.tipo_resorte === 'coil' && Number.isFinite(amortiguador.resorte_lb);
  const sagObjT = { ...obj.sag_amortiguador_pct, ...(amortiguador.sag_objetivo ?? {}) };

  let sesgo = clamp(cal.sesgo_trasero, ...rules.modelo.sesgo_limites);
  let origenSesgo = sesgo === rules.modelo.sesgo_trasero ? 'por defecto' : 'calibrado con la bitácora';
  const sagMedidoT = sagAPct(inputs.sag_atras, cin.carrera);
  let sagEsMedido = false;
  if (sagMedidoT != null && esCoil) {
    const s = sesgoDesdeSag({
      cin, k_lb: amortiguador.resorte_lb, sagShockMm: (sagMedidoT / 100) * cin.carrera,
      precarga_mm: vueltasMin * mmVuelta, masaTotalKg: masaTotal,
    });
    sesgo = clamp(s, ...rules.modelo.sesgo_limites);
    sagEsMedido = true;
    origenSesgo = 'calibrado con tu sag medido';
    if (s !== sesgo) avisos.push('El sag medido atrás da un reparto de peso fuera de lo razonable: revisa la medición, el resorte o la precarga.');
  }
  const cargaN = masaTotal * G * sesgo;

  // Resorte ideal para el sag objetivo con la curva real
  const ideal = resorteIdeal({
    cin, cargaN, sagObjetivoPct: sagObjT.ideal, precarga_mm: vueltasMin * mmVuelta, paso_lb: rules.modelo.paso_resorte_lb,
  });
  // Resorte con el que se calcula todo: el instalado (coil) o un equivalente lineal (aire)
  const kActual = esCoil ? amortiguador.resorte_lb : ideal.exacto_lb;
  const sagCon = (vueltas, k = kActual) => sagEstatico({ cin, k_lb: k, cargaN, precarga_mm: vueltas * mmVuelta });
  const sag1 = sagCon(vueltasMin);
  let vueltas = vueltasMin;
  let sagFinal = sag1;
  let veredicto;
  let resortePorque;
  const estim = sagEsMedido ? '' : ' (estimación hasta que midas el sag)';
  if (!esCoil) {
    veredicto = 'aire';
    resortePorque = `Amortiguador de aire: ajusta la presión hasta ${sagObjT.min}-${sagObjT.max} % de sag.`;
  } else if (sag1.pct_shock >= sagObjT.min && sag1.pct_shock <= sagObjT.max) {
    veredicto = 'mantener';
    resortePorque = `Con ${kActual} lb el modelo da ${num(sag1.pct_shock)} % de sag: dentro de ${sagObjT.min}-${sagObjT.max} %${estim}.`;
  } else if (sag1.pct_shock > sagObjT.max) {
    const sag2 = sagCon(vueltasMax);
    if (sag2.pct_shock <= sagObjT.max || ideal.catalogo_lb <= kActual) {
      veredicto = 'mantener';
      vueltas = vueltasMax;
      sagFinal = sag2;
      resortePorque = `Con ${kActual} lb el sag es ${num(sag1.pct_shock)} %; con ${vueltasMax} vueltas de precarga baja a ${num(sag2.pct_shock)} %${estim}.`;
    } else {
      veredicto = 'cambiar';
      resortePorque = `Con ${kActual} lb el sag es ${num(sag1.pct_shock)} % y ni con ${vueltasMax} vueltas de precarga entra en rango: toca resorte más duro (ideal ${num(ideal.exacto_lb, 0)} lb)${estim}.`;
    }
  } else if (ideal.catalogo_lb >= kActual) {
    veredicto = 'mantener';
    resortePorque = `Con ${kActual} lb el sag es ${num(sag1.pct_shock)} %, apenas bajo el rango, pero es el resorte de catálogo más cercano al ideal (${num(ideal.exacto_lb, 0)} lb)${estim}.`;
  } else {
    veredicto = 'cambiar';
    resortePorque = `Con ${kActual} lb el sag es solo ${num(sag1.pct_shock)} % (< ${sagObjT.min} %): el resorte está duro, el ideal es ${num(ideal.exacto_lb, 0)} lb${estim}.`;
  }
  const sagIdealCatalogo = sagCon(vueltasMin, ideal.catalogo_lb);

  const xSag = sagFinal.rueda_mm;
  const wr = {
    sag: wheelRate(cin, kActual, xSag),
    p50: wheelRate(cin, kActual, cin.recorrido * 0.5),
    p80: wheelRate(cin, kActual, cin.recorrido * 0.8),
  };

  // Frecuencia natural y escala del rebote trasero respecto a la condición de la base
  const noSuspT = bike.masas.no_suspendida_atras_kg;
  const noSuspD = bike.masas.no_suspendida_adelante_kg;
  const expMasa = rules.modelo.rebote.exponente_masa ?? 1;
  const masaSuspT = Math.max(masaTotal * sesgo - noSuspT, 10);
  const frec = frecuenciaHz(wr.sag, masaSuspT);
  const ref = amortiguador.referencia_base ?? {};
  const pesoRef = ref.peso_kg ?? rules.referencia.peso_kg;
  const masaTotalRef = pesoRef + bike.masas.peso_bici_kg;
  const sesgoRef = rules.modelo.sesgo_trasero;
  const cargaRef = masaTotalRef * G * sesgoRef;
  const kRef = esCoil
    ? (ref.resorte_lb ?? amortiguador.resorte_lb)
    : resorteIdeal({ cin, cargaN: cargaRef, sagObjetivoPct: sagObjT.ideal, precarga_mm: vueltasMin * mmVuelta }).exacto_lb;
  const sagRef = sagEstatico({ cin, k_lb: kRef, cargaN: cargaRef, precarga_mm: vueltasMin * mmVuelta });
  const masaSuspRef = Math.max(masaTotalRef * sesgoRef - noSuspT, 10);
  const frecRef = frecuenciaHz(wheelRate(cin, kRef, sagRef.rueda_mm), masaSuspRef);
  const escalaReboteT = (frec / frecRef) * (masaSuspT / masaSuspRef) ** expMasa;

  // Impacto de referencia → uso de recorrido
  const imp = rules.modelo.impacto_referencia;
  const energiaJ = cargaN * imp.altura_equivalente_m * imp.fraccion_al_resorte * (cal.impacto_mult ?? 1);
  const impacto = usoRecorridoImpacto({ cin, k_lb: kActual, cargaN, precarga_mm: vueltas * mmVuelta, energiaJ });
  ctx.uso_recorrido = impacto.uso;

  // ----- Horquilla: sag, balance y presión -----
  const sagObjH = { ...obj.sag_horquilla_pct, ...(horquilla.sag_objetivo ?? {}) };
  // La meta de balance (7-10 puntos) está definida para los sag de referencia de
  // rules.json; se desplaza según el sag objetivo de los componentes activos.
  const corrBal = (obj.sag_horquilla_pct.ideal - sagObjH.ideal) + (sagObjT.ideal - obj.sag_amortiguador_pct.ideal);
  const bal = { min: obj.balance_puntos.min + corrBal, max: obj.balance_puntos.max + corrBal, ideal: obj.balance_puntos.ideal + corrBal };
  const sagMedidoH = sagAPct(inputs.sag_adelante, horquilla.recorrido_mm);
  // Sag trasero de destino: el actual, o el que dará el resorte recomendado.
  const sagAtrasPct = veredicto === 'cambiar' ? sagIdealCatalogo.pct_shock : sagFinal.pct_shock;
  // Cambio mínimo: el sag ideal de la horquilla, movido solo lo necesario para
  // que la trasera quede con bal.min…bal.max puntos más.
  const sagObjetivoH = clamp(
    clamp(sagObjH.ideal, sagAtrasPct - bal.max, sagAtrasPct - bal.min),
    sagObjH.min, sagObjH.max,
  );
  const sagAdelanteActual = sagMedidoH ?? sagObjetivoH; // sin medición se asume el objetivo
  const difActual = sagAtrasPct - sagAdelanteActual;
  const difCorregida = sagAtrasPct - sagObjetivoH;
  const balance = {
    sag_adelante_pct: sagAdelanteActual,
    sag_adelante_medido: sagMedidoH != null,
    sag_atras_pct: sagAtrasPct,
    sag_atras_medido: sagEsMedido,
    diferencia: difActual,
    diferencia_corregida: difCorregida,
    objetivo: bal,
    ok: difActual >= bal.min && difActual <= bal.max,
  };
  const contribs = [];
  if (balance.ok) {
    balance.porque = `La trasera tiene ${num(difActual)} puntos más de sag que la horquilla: nivelada (meta ${num(bal.min)}-${num(bal.max)}).`;
  } else {
    balance.porque = `Diferencia de sag ${num(difActual)} puntos (meta ${num(bal.min)}-${num(bal.max)}): `
      + (sagMedidoH != null
        ? `primero se corrige con presión${veredicto === 'cambiar' ? ' y resorte' : ''} (horquilla hacia ${num(sagObjetivoH)} % de sag)`
        : `la horquilla ya apunta al borde de su rango (${num(sagObjetivoH)} %)${veredicto === 'cambiar' ? ' y el resorte nuevo lo corrige' : ''}`);
    if (difCorregida > bal.max + 0.01 && veredicto !== 'cambiar') {
      const r = rules.balance.trasera_baja;
      contribs.push({ extremo: r.extremo, tipo: r.tipo, delta: r.delta_clicks, fuente: 'Balance', porque: 'trasera baja' });
      balance.porque += ' y, como no alcanza, con más LSC atrás.';
    } else if (difCorregida < bal.min - 0.01 && veredicto !== 'cambiar') {
      const r = rules.balance.delantera_baja;
      contribs.push({ extremo: r.extremo, tipo: r.tipo, delta: r.delta_clicks, fuente: 'Balance', porque: 'horquilla baja' });
      balance.porque += ' y, como no alcanza, con más LSC adelante.';
    } else balance.porque += '.';
  }

  const calH = cal.componentes?.[sel.horquilla] ?? {};
  const calA = cal.componentes?.[sel.amortiguador] ?? {};
  const pasosFeel = (cada) => Math.trunc(feel / (cada || 1));
  const psiFeel = rules.suspension_feel.horquilla_psi.delta * pasosFeel(rules.suspension_feel.horquilla_psi.cada_pasos);
  const esAire = horquilla.tipo_resorte === 'aire';
  const presionActual = Number(inputs.presion_horquilla_actual) > 0 ? Number(inputs.presion_horquilla_actual) : null;
  const pBase = esAire ? presionBase(horquilla, peso) : null;
  const pProvisoria = horquilla.presion_base?.verificado !== true;
  let presion = null;
  let psiTabla = null; // presión de tabla/fórmula sin modifiers (referencia del rebote)
  if (esAire) {
    const pb = horquilla.presion_base ?? {};
    const kSag = calH.psi_por_punto_sag ?? (typeof pb.psi_por_punto_sag === 'number' ? pb.psi_por_punto_sag : null);
    const kSagEstimado = calH.psi_por_punto_sag == null && pb.psi_por_punto_sag_verificado !== true;
    const origen = pb.formula ? 'Fórmula' : 'Tabla';
    let psi = null;
    const partes = [];
    const detalleP = [];
    if (pBase != null) {
      psiTabla = pBase;
      psi = pBase * (calH.presion_mult ?? 1);
      partes.push(`${origen}${pProvisoria ? ' provisoria' : ''} para ${num(peso)} kg: ${num(pBase)} psi`);
      detalleP.push(pb.formula
        ? `Presión = ${num(pb.formula.psi_fijo ?? 0)} + ${num(pb.formula.psi_por_kg, 3)} × ${num(peso)} kg = ${num(pBase)} psi${pb.fuente ? ` (${pb.fuente})` : ''}.`
        : `Presión interpolada en la tabla por peso: ${num(pBase)} psi para ${num(peso)} kg${pb.fuente ? ` (${pb.fuente})` : ''}.`);
      if ((calH.presion_mult ?? 1) !== 1) {
        partes.push(`bitácora ×${num(calH.presion_mult, 2)}`);
        detalleP.push(`Calibración de bitácora: ×${num(calH.presion_mult, 2)}.`);
      }
    }
    if (sagMedidoH != null) {
      // Solo se corrige si el sag medido está fuera del rango del componente o
      // rompe el balance; se lleva al borde más cercano de la zona válida.
      let lo = Math.max(sagObjH.min, sagAtrasPct - bal.max);
      let hi = Math.min(sagObjH.max, sagAtrasPct - bal.min);
      if (lo > hi) lo = hi = sagObjetivoH;
      const destino = clamp(sagMedidoH, lo, hi);
      const dSag = sagMedidoH - destino;
      const partida = presionActual ?? psi;
      if (Math.abs(dSag) < 0.05) {
        if (presionActual != null) { psi = presionActual; partes.length = 0; partes.push(`Tus ${num(presionActual, 0)} psi dan ${num(sagMedidoH)} % de sag: en rango`); }
        else partes.push(`sag medido ${num(sagMedidoH)} %: en rango`);
        detalleP.push(`Sag medido ${num(sagMedidoH)} %: dentro de la zona válida (${num(lo)}-${num(hi)} %), sin corrección.`);
      } else if (partida != null && kSag != null) {
        const dPsi = dSag * kSag;
        psi = partida + dPsi;
        if (presionActual != null) partes.length = 0;
        partes.push(`${presionActual != null ? `Tus ${num(presionActual, 0)} psi` : 'sag medido'}: ${num(sagMedidoH)} % → ${num(destino)} % = ${conSigno(dPsi, 0)} psi${kSagEstimado ? ' (estimación)' : ''}`);
        detalleP.push(`Corrección por sag medido: (${num(sagMedidoH)} − ${num(destino)}) × ${num(kSag, 2)} psi por punto${kSagEstimado ? ' (estimación, se calibra con la bitácora)' : ''} = ${conSigno(dPsi)} psi sobre ${num(partida)} psi${presionActual == null ? ' (asume que mediste con la presión recomendada)' : ''}.`);
      } else if (partida != null) {
        psi = partida * (sagMedidoH / destino);
        if (presionActual != null) partes.length = 0;
        partes.push(`${presionActual != null ? `Tus ${num(presionActual, 0)} psi` : 'sag medido'}: ${num(sagMedidoH)} % → ${num(destino)} % (proporcional)`);
        detalleP.push(`Corrección proporcional por sag medido: ${num(partida)} psi × ${num(sagMedidoH)} / ${num(destino)}${presionActual == null ? ' (asume que mediste con la presión recomendada)' : ''}.`);
      }
    }
    if (psi != null) {
      if (psiFeel) { partes.push(`${ETIQUETA_FEEL(feel)}: ${conSigno(psiFeel, 0)} psi`); detalleP.push(`${ETIQUETA_FEEL(feel)}: ${conSigno(psiFeel, 0)} psi.`); }
      const exacta = psi + psiFeel;
      psi = Math.round(exacta);
      const maximo = typeof pb.maximo_psi === 'number' ? pb.maximo_psi : null;
      let superaMaximo = false;
      if (maximo != null && psi > maximo) {
        superaMaximo = true;
        avisos.push(`La presión calculada para ${horquilla.nombre} (${psi} psi) supera el máximo de ${maximo} psi: se limita a ${maximo} psi.`);
        partes.push(`limitada al máximo de ${maximo} psi`);
        detalleP.push(`La presión calculada (${psi} psi) supera el máximo de la horquilla: se limita a ${maximo} psi.`);
        psi = maximo;
      }
      detalleP.push(`Presión recomendada: ${psi} psi.`);
      presion = {
        psi, psi_exacta: Math.min(exacta, maximo ?? Infinity), psi_tabla: psiTabla, bar: psi * PSI_A_BAR, maximo_psi: maximo, supera_maximo: superaMaximo,
        provisoria: pProvisoria && presionActual == null, porque: partes.join(' · '), detalle: detalleP,
      };
    } else {
      presion = {
        psi: null, psi_exacta: null, psi_tabla: null, bar: null, provisoria: true, detalle: [],
        porque: `Falta la tabla de presión de ${horquilla.nombre} en components.json: infla hasta lograr ${num(sagObjetivoH)} % de sag${psiFeel ? ` y ajusta ${conSigno(psiFeel, 0)} psi por ${ETIQUETA_FEEL(feel)}` : ''}.`,
      };
    }
  }

  // Tokens / spacers
  const sp = horquilla.spacers ?? {};
  const nombreSp = sp.nombre ?? 'tokens';
  const dTokens = rSaltos.horquilla?.tokens ?? 0;
  const psiAlt = rSaltos.horquilla?.psi_alternativa ?? 0;
  let tokens;
  if (dTokens > 0) {
    const inst = Number.isInteger(sp.instalados) ? sp.instalados : null;
    const objetivoTk = inst != null ? (Number.isInteger(sp.maximo) ? Math.min(inst + dTokens, sp.maximo) : inst + dTokens) : null;
    tokens = {
      delta: dTokens,
      cantidad: objetivoTk,
      texto: objetivoTk != null ? `${objetivoTk}${Number.isInteger(sp.maximo) ? ` de ${sp.maximo}` : ''}` : `+${dTokens} sobre los actuales`,
      porque: inst != null && objetivoTk === inst
        ? `Saltos: ya estás en el máximo de ${nombreSp} (${sp.maximo}); sube ${psiAlt} psi si hace tope.`
        : `Saltos: suma ${dTokens} a los ${nombreSp} para no hacer tope en las caídas${presion?.psi != null ? ` (o, sin abrir la horquilla, ${Math.min(presion.psi + psiAlt, presion.maximo_psi ?? Infinity)} psi)` : ` (o +${psiAlt} psi)`}.`,
    };
  } else {
    const inst = Number.isInteger(sp.instalados) ? sp.instalados : null;
    tokens = {
      delta: 0,
      cantidad: inst,
      texto: inst != null ? `${inst}${Number.isInteger(sp.maximo) ? ` de ${sp.maximo}` : ''}` : 'Sin cambios',
      porque: `Sin saltos grandes: mantén los ${nombreSp} ${inst != null ? 'instalados' : 'que ya tienes'}.`,
    };
  }

  // Escala del rebote delantero (resorte de aire linealizado: k ≈ carga / sag)
  const masaSuspD = Math.max(masaTotal * (1 - sesgo) - noSuspD, 10);
  const masaSuspDRef = Math.max(masaTotalRef * (1 - sesgoRef) - noSuspD, 10);
  const escalaReboteD = Math.sqrt(sagObjH.ideal / sagObjetivoH) * (masaSuspD / masaSuspDRef) ** expMasa;

  // ----- Contribuciones de los ride modifiers -----
  const agregar = (efectos, fuente) => {
    for (const e of efectos ?? []) {
      if (!cumple(e.si, ctx)) continue;
      contribs.push({ extremo: e.extremo ?? 'ambos', tipo: e.tipo, delta: e.delta_clicks, fuente, porque: plantilla(e.porque, ctx) });
    }
  };
  if (feel !== 0) {
    for (const e of rules.suspension_feel.por_paso) {
      const delta = e.delta_clicks * pasosFeel(e.cada_pasos);
      if (delta !== 0) contribs.push({ extremo: e.extremo ?? 'ambos', tipo: e.tipo, delta, fuente: ETIQUETA_FEEL(feel), porque: '' });
    }
  }
  agregar(rules.trail_type[tipo].efectos, tipo);
  agregar(rules.trail_grip[grip].efectos, `Grip ${grip}`);
  agregar(rSaltos.efectos, 'Saltos');

  const rbH = reboteBase(horquilla, peso, presion?.psi ?? null, psiTabla);
  const ajH = (horquilla.ajustadores ?? []).map((aj) => resolverAjustador({
    aj, extremo: 'adelante', contribs, rules, calComp: calH, escalaRebote: escalaReboteD,
    baseTabla: rbH && ES_REBOTE[aj.tipo] && rbH.tipos.includes(aj.tipo === 'REBOTE_UNICO' && !rbH.tipos.includes('REBOTE_UNICO') ? 'LSR' : aj.tipo) ? rbH : null,
  }));
  // Si se recomienda otro resorte, la base sale de la fila del resorte nuevo.
  const resorteParaBase = esCoil ? (veredicto === 'cambiar' ? ideal.catalogo_lb : kActual) : null;
  const rbA = reboteBase(amortiguador, peso, null, null);
  const ajA = (amortiguador.ajustadores ?? []).map((aj) => resolverAjustador({
    aj, extremo: 'atras', contribs, rules, calComp: calA, escalaRebote: escalaReboteT,
    baseTabla: basePorResorte(amortiguador, resorteParaBase, aj.tipo === 'REBOTE_UNICO' ? 'LSR' : aj.tipo)
      ?? (rbA && ES_REBOTE[aj.tipo] ? rbA : null),
  }));

  // ----- Neumáticos -----
  const rn = rules.neumaticos;
  const neumatico = (lado) => {
    const basePsi = rn[`${lado}_psi`];
    const dPeso = (peso - rn.peso_referencia_kg) / rn.kg_por_psi;
    const mods = [
      [tipo, rules.trail_type[tipo].neumaticos_psi?.[lado] ?? 0],
      [`Grip ${grip}`, rules.trail_grip[grip].neumaticos_psi?.[lado] ?? 0],
      ['Saltos', rSaltos.neumaticos_psi?.[lado] ?? 0],
    ].filter(([, d]) => d !== 0);
    const total = basePsi + dPeso + mods.reduce((s, [, d]) => s + d, 0);
    const psi = clamp(redondear(total, rn.redondeo_psi), ...rn.limites_psi);
    const partes = [`Base ${num(basePsi)} psi a ${rn.peso_referencia_kg} kg`];
    if (Math.abs(dPeso) >= 0.05) partes.push(`${num(peso, 0)} kg ${conSigno(dPeso)}`);
    for (const [f, d] of mods) partes.push(`${f} ${conSigno(d)}`);
    return { psi, bar: psi * PSI_A_BAR, porque: partes.join(' · ') };
  };

  // ----- Avisos -----
  const sinVerH = camposSinVerificar(horquilla);
  const sinVerA = camposSinVerificar(amortiguador);
  if (!sagEsMedido && esCoil) avisos.push(`El chequeo del resorte usa un reparto de peso ${origenSesgo} (${num(sesgo * 100, 0)} % atrás): es una estimación hasta que midas el sag.`);
  if (bike.suspension_trasera.cinematica.verificar) avisos.push('La curva de leverage no es dato oficial de Giant: verificar.');

  // ----- Detalle del cálculo -----
  const calculo = [
    {
      titulo: 'Carga y sag (modelo físico)',
      lineas: [
        `Peso total ${num(masaTotal)} kg (tú ${num(peso)} + bici ${num(bike.masas.peso_bici_kg)}) × sesgo trasero ${num(sesgo, 3)} (${origenSesgo}) = ${num(cargaN, 0)} N en la rueda trasera.`,
        `Sag ${sagEsMedido ? 'medido' : 'predicho'} con ${esCoil ? `${kActual} lb` : `resorte equivalente ${num(kActual, 0)} lb`} y ${vueltas} vuelta${vueltas === 1 ? '' : 's'} de precarga: ${num(sagFinal.shock_mm)} mm de shock (${num(sagFinal.pct_shock)} %) = ${num(sagFinal.rueda_mm)} mm en la rueda (${num(sagFinal.pct_rueda)} %).`,
        `Leverage en el sag: ${num(cin.LR(xSag), 2)}.`,
      ],
    },
    {
      titulo: 'Rigidez en la rueda (wheel rate)',
      lineas: [
        `En el sag: ${num(wr.sag)} N/mm · al 50 %: ${num(wr.p50)} N/mm · al 80 %: ${num(wr.p80)} N/mm.`,
        `Frecuencia natural trasera: ${num(frec, 2)} Hz (referencia de la base: ${num(frecRef, 2)} Hz con ${num(pesoRef, 0)} kg${esCoil ? ` y ${kRef} lb` : ''}).`,
        `Escala de rebote: atrás ×${num(escalaReboteT, 2)} · adelante ×${num(escalaReboteD, 2)}.`,
      ],
    },
    {
      titulo: 'Resorte',
      lineas: [
        `Resorte ideal para ${num(sagObjT.ideal)} % de sag: ${num(ideal.exacto_lb, 0)} lb → catálogo ${ideal.catalogo_lb} lb (daría ${num(sagIdealCatalogo.pct_shock)} % de sag).`,
        resortePorque,
      ],
    },
    {
      titulo: 'Impacto de referencia (saltos)',
      lineas: [
        `Energía al resorte trasero: ${num(energiaJ, 0)} J → usa ${num(impacto.uso * 100, 0)} % del recorrido${impacto.hace_tope ? ' (hace tope)' : ''}. Umbral para subir HSC atrás: ${num(imp.uso_maximo * 100, 0)} %.`,
      ],
    },
    { titulo: 'Balance adelante/atrás', lineas: [balance.porque] },
    ...(presion?.detalle?.length ? [{ titulo: 'Presión de la horquilla', lineas: presion.detalle }] : []),
    ...[...ajH, ...ajA].filter((a) => !a.sin_datos).map((a) => ({ titulo: a.texto, lineas: a.detalle })),
  ];

  return {
    seleccion: sel,
    montado: nombreMontado(components, sel),
    inputs: { peso_kg: peso, feel, grip, tipo, saltos },
    medidas_usuario: { sag_adelante_pct: sagMedidoH, sag_atras_pct: sagMedidoT, presion_horquilla_psi: presionActual },
    avisos,
    avisos_componentes: [...(horquilla.avisos ?? []), ...(amortiguador.avisos ?? [])],
    sin_verificar: { horquilla: sinVerH, amortiguador: sinVerA },
    geometria: {
      maestro: { ...chipMaestro, ...comparacion.maestro },
      direccion: { ...chipDireccion, ...comparacion.direccion },
      dropout: { ...chipDropout, ...comparacion.dropout },
      actuales, recomendados,
      hay_cambios: CHIPS.some((c) => comparacion[c].cambia),
      medidas, medidas_recomendadas: medidasRecomendadas,
      offset_mm: offset,
    },
    neumaticos: { adelante: neumatico('adelante'), atras: neumatico('atras') },
    horquilla: {
      id: sel.horquilla,
      nombre: horquilla.nombre,
      sag_objetivo: { min: sagObjH.min, max: sagObjH.max, ideal: sagObjetivoH, mm: (sagObjetivoH / 100) * horquilla.recorrido_mm },
      presion,
      tokens,
      ajustadores: ajH,
    },
    amortiguador: {
      id: sel.amortiguador,
      nombre: amortiguador.nombre,
      es_coil: esCoil,
      sag_objetivo: { min: sagObjT.min, max: sagObjT.max, ideal: sagObjT.ideal, mm: (sagObjT.ideal / 100) * cin.carrera },
      resorte_para_clicks_lb: resorteParaBase,
      palanca: amortiguador.palanca?.recomendada ? `Palanca en ${amortiguador.palanca.recomendada}` : null,
      sag: { ...sagFinal, medido: sagEsMedido },
      resorte: {
        actual_lb: esCoil ? kActual : null,
        ideal_exacto_lb: ideal.exacto_lb,
        ideal_catalogo_lb: ideal.catalogo_lb,
        recomendado_lb: veredicto === 'cambiar' ? ideal.catalogo_lb : (esCoil ? kActual : null),
        veredicto,
        porque: resortePorque,
      },
      precarga: {
        vueltas,
        maximo: vueltasMax,
        porque: vueltas > vueltasMin
          ? `${vueltas} vueltas para bajar el sag; más que eso es señal de cambiar el resorte.`
          : `Aprieta hasta que el resorte no se mueva y da ${vueltasMin} vuelta; nunca más de ${vueltasMax}.`,
      },
      presion_base: !esCoil ? presionBase(amortiguador, peso) : null,
      ajustadores: ajA,
    },
    balance,
    modelo: {
      sesgo_trasero: sesgo, origen_sesgo: origenSesgo, carga_N: cargaN,
      wheel_rate: wr, frecuencia_hz: frec, frecuencia_ref_hz: frecRef,
      escala_rebote: { adelante: escalaReboteD, atras: escalaReboteT },
      impacto: { ...impacto, energia_J: energiaJ },
      lr_sag: cin.LR(xSag),
    },
    calculo,
  };
}
