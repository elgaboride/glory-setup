import { leer, guardar } from './almacen.js';
import {
  recomendar, nombreMontado, camposSinVerificar, esCompatible, resortesDisponibles, offsetParaHorquilla,
} from './engine/motor.js';
import { calibrar, resumenCalibracion } from './engine/calibracion.js';

const $ = (sel, raiz = document) => raiz.querySelector(sel);
const $$ = (sel, raiz = document) => [...raiz.querySelectorAll(sel)];
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const f = (v, dec = 1) => (v == null || !Number.isFinite(+v) ? '–' : (Math.round(v * 10 ** dec) / 10 ** dec).toFixed(dec).replace('.', ',').replace(/,0+$/, ''));
const mayuscula = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const hoy = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const fechaCorta = (iso) => {
  const [a, m, d] = String(iso).split('-');
  return d ? `${d}/${m}/${a.slice(2)}` : String(iso);
};

const GRIPS = ['Low', 'Medium', 'High'];
const TIPOS = ['Tech', 'Mixed', 'Flow'];
const INPUTS_DEFECTO = {
  peso_kg: 80, feel: 0, grip: 'Medium', tipo: 'Mixed', saltos: false,
  sag_atras: { valor: '', unidad: '%' }, sag_adelante: { valor: '', unidad: '%' }, presion_horquilla_actual: '',
};

const datos = { bike: null, components: null, rules: null };
const estado = {
  tab: 'setup',
  inputs: { ...INPUTS_DEFECTO, ...leer('inputs', {}) },
  seleccion: leer('seleccion', null),
  offsets: leer('offsets', {}), // offset elegido por horquilla
  resortes: leer('resortes', {}), // resorte instalado por amortiguador
  chips: leer('chips', null), // posición ACTUAL de los flip chips
  bitacora: leer('bitacora', []),
  filtros: { pista: '', horquilla: '', amortiguador: '' },
};
let ultima = null; // última recomendación calculada

// ---------- Utilidades de UI ----------

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('visible');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('visible'), 2600);
}

function persistir(clave, valor) {
  if (!guardar(clave, valor)) toast('No se pudo guardar en el teléfono: exporta tu bitácora por si acaso.');
}

function dialogo(html) {
  const d = $('#dlg');
  d.innerHTML = html;
  if (!d.open) d.showModal();
  return d;
}
const cerrarDialogo = () => $('#dlg').close();

function seleccionValida() {
  const def = datos.components.seleccion_por_defecto;
  const s = estado.seleccion ?? {};
  const a = datos.components.amortiguadores[s.amortiguador];
  return {
    horquilla: datos.components.horquillas[s.horquilla] ? s.horquilla : def.horquilla,
    amortiguador: a && esCompatible(datos.bike, a) ? s.amortiguador : def.amortiguador,
  };
}

// Offset de la horquilla activa: el elegido en "Mi bici" si la horquilla lo ofrece.
function offsetActivo(sel = seleccionValida()) {
  const h = datos.components.horquillas[sel.horquilla];
  const elegido = estado.offsets[sel.horquilla];
  const disp = h.offsets_disponibles;
  if (elegido != null && (!disp || disp.includes(elegido))) return elegido;
  return h.offset_mm ?? disp?.[0] ?? null;
}

// Resorte instalado del amortiguador activo (lb/in), dentro de los pasos que ofrece.
function resorteInstalado(sel = seleccionValida()) {
  const a = datos.components.amortiguadores[sel.amortiguador];
  const lista = resortesDisponibles(a, datos.rules);
  if (!lista.length) return null;
  const elegido = estado.resortes[sel.amortiguador];
  if (lista.includes(elegido)) return elegido;
  const defecto = a.resorte_lb ?? 475;
  return lista.reduce((m, k) => (Math.abs(k - defecto) < Math.abs(m - defecto) ? k : m), lista[0]);
}

// Componentes renombrados: lleva selección, ajustes y bitácora guardados al id nuevo.
function migrarIds() {
  const alias = {};
  for (const grupo of [datos.components.horquillas, datos.components.amortiguadores]) {
    for (const [id, c] of Object.entries(grupo)) for (const viejo of c.alias ?? []) alias[viejo] = id;
  }
  const nuevo = (id) => alias[id] ?? id;
  let cambio = false;
  const migrarMapa = (m) => {
    for (const k of Object.keys(m ?? {})) if (alias[k]) { m[alias[k]] ??= m[k]; delete m[k]; cambio = true; }
  };
  if (estado.seleccion) {
    for (const k of ['horquilla', 'amortiguador']) if (alias[estado.seleccion[k]]) { estado.seleccion[k] = nuevo(estado.seleccion[k]); cambio = true; }
  }
  migrarMapa(estado.offsets);
  migrarMapa(estado.resortes);
  for (const reg of estado.bitacora) {
    for (const k of ['horquilla', 'amortiguador']) if (alias[reg[k]]) { reg[k] = nuevo(reg[k]); cambio = true; }
  }
  return cambio;
}

function chipsActuales() {
  const g = datos.bike.geometria;
  const c = { ...g.baseline };
  for (const k of ['maestro', 'direccion', 'dropout']) if (g[k][estado.chips?.[k]]) c[k] = estado.chips[k];
  return c;
}

function calcular() {
  const sel = seleccionValida();
  ultima = recomendar({
    bike: datos.bike, components: datos.components, rules: datos.rules,
    seleccion: sel, inputs: estado.inputs,
    calibracion: calibrar(estado.bitacora, datos.rules),
    offsetUsuario: offsetActivo(sel),
    resorteInstalado: resorteInstalado(sel),
    chipsActuales: chipsActuales(),
  });
  return ultima;
}

function pintarMontado() {
  $('#montado').textContent = nombreMontado(datos.components, seleccionValida(), resorteInstalado());
}

const nombreComp = (id) => datos.components.horquillas[id]?.nombre ?? datos.components.amortiguadores[id]?.nombre ?? id ?? '–';

// ---------- Vista: Setup ----------

function slider({ id, min, max, valor, marcas, titulo }) {
  return `
    <div class="campo">
      <div class="campo-cab"><label for="${id}">${titulo}</label><output id="${id}-out"></output></div>
      <input type="range" id="${id}" min="${min}" max="${max}" step="1" value="${valor}">
      <div class="marcas" style="--n:${marcas.length}">${marcas.map((m, i) => `<button type="button" tabindex="-1" data-slider="${id}" data-valor="${min + i}">${m}</button>`).join('')}</div>
    </div>`;
}

function campoSag(clave, titulo, ayuda) {
  const v = estado.inputs[clave] ?? { valor: '', unidad: '%' };
  return `
    <div class="campo">
      <label for="${clave}">${titulo}</label>
      <div class="fila-sag">
        <input type="number" inputmode="decimal" id="${clave}" min="0" step="0.5" placeholder="–" value="${esc(v.valor)}">
        <div class="segmento" role="group" aria-label="Unidad">
          ${['%', 'mm'].map((u) => `<button type="button" data-unidad="${clave}" data-valor="${u}" class="${v.unidad === u ? 'activo' : ''}">${u}</button>`).join('')}
        </div>
      </div>
      <p class="ayuda">${ayuda}</p>
    </div>`;
}

function vistaSetup() {
  const i = estado.inputs;
  const sm = datos.rules.suspension_feel;
  const marcasFeel = [];
  for (let v = sm.min; v <= sm.max; v++) marcasFeel.push(v === sm.min ? 'Soft' : v === sm.max ? 'Firm' : v === 0 ? '0' : '·');
  $('#vista').innerHTML = `
    <section class="tarjeta">
      <div class="campo">
        <label for="peso">Peso con equipo completo</label>
        <div class="fila-peso">
          <button type="button" class="btn-paso" data-peso="-1" aria-label="Menos 1 kg">−</button>
          <div class="peso-caja"><input type="number" inputmode="decimal" id="peso" min="40" max="160" step="0.5" value="${esc(i.peso_kg)}"><span>kg</span></div>
          <button type="button" class="btn-paso" data-peso="1" aria-label="Más 1 kg">+</button>
        </div>
      </div>
    </section>

    <section class="tarjeta">
      <h2>Ride modifiers</h2>
      ${slider({ id: 'feel', min: sm.min, max: sm.max, valor: i.feel, marcas: marcasFeel, titulo: 'Suspension feel' })}
      ${slider({ id: 'grip', min: 0, max: 2, valor: GRIPS.indexOf(i.grip), marcas: GRIPS, titulo: 'Trail grip' })}
      ${slider({ id: 'tipo', min: 0, max: 2, valor: TIPOS.indexOf(i.tipo), marcas: TIPOS, titulo: 'Trail type' })}
      <label class="interruptor">
        <span><b>Saltos</b><small>Pista con saltos grandes o drops</small></span>
        <input type="checkbox" id="saltos" role="switch" ${i.saltos ? 'checked' : ''}>
        <span class="pista" aria-hidden="true"></span>
        <span class="si-no" id="saltos-out"></span>
      </label>
    </section>

    <details class="tarjeta" ${i.sag_atras?.valor || i.sag_adelante?.valor ? 'open' : ''}>
      <summary>Sag medido <small>opcional</small></summary>
      ${campoSag('sag_atras', 'Sag atrás', 'En el amortiguador (mm de vástago) o en %. Mídelo con 1 vuelta de precarga.')}
      ${campoSag('sag_adelante', 'Sag adelante', 'En la barra de la horquilla (mm) o en %.')}
      <div class="campo">
        <label for="presion_horquilla_actual">Presión actual de la horquilla</label>
        <div class="fila-sag"><input type="number" inputmode="decimal" id="presion_horquilla_actual" min="0" step="1" placeholder="–" value="${esc(i.presion_horquilla_actual)}"><span class="unidad-fija">psi</span></div>
        <p class="ayuda">La presión con la que mediste el sag de adelante.</p>
      </div>
    </details>

    <div id="resultado"></div>`;
  pintarResultado();
}

const etiquetaFeel = (v) => (v === 0 ? '0 · Neutro' : v > 0 ? `Firm +${v}` : `Soft −${Math.abs(v)}`);

function sinFabricante(r, nombre) {
  return r.sin_verificar_fabricante.filter((t) => t.includes(nombre)).map((t) => `<p class="discreto">⚠ ${esc(t)}.</p>`).join('');
}

function sinVerificarHtml(lista) {
  return lista.length ? `<p class="discreto">⚠ Sin verificar (valores provisorios): ${esc(lista.join(', '))}.</p>` : '';
}

function filaAjustador(a) {
  if (a.sin_datos) {
    return `<li class="aj"><div class="aj-cab"><div><b>${esc(a.nombre)}</b><small>${esc(a.descripcion)}</small></div><div class="aj-num sin">–</div></div><p class="porque">${esc(a.porque)}</p></li>`;
  }
  if (a.es_posicion) {
    const pctPos = ((a.click - a.minimo) / (a.clicks_totales - a.minimo)) * 100;
    return `
    <li class="aj">
      <div class="aj-cab">
        <div><b>${esc(a.nombre)}</b><small>${esc(a.descripcion)}${a.verificado ? '' : ' · sin verificar'}</small></div>
        <div class="aj-num" aria-label="${esc(a.texto)}"><strong>${a.click}</strong><small>posición<br>de ${a.minimo} a ${a.clicks_totales}</small></div>
      </div>
      <div class="regla" aria-hidden="true"><span>${a.minimo}</span><div class="regla-barra"><i style="left:${pctPos}%"></i></div><span>${a.clicks_totales}</span></div>
      <p class="porque">${esc(a.porque)}</p>
    </li>`;
  }
  const pct = (a.click / a.clicks_totales) * 100;
  const unidad = a.unidad === 'posiciones' ? 'posición' : a.click === 1 ? 'click' : 'clicks';
  return `
    <li class="aj">
      <div class="aj-cab">
        <div><b>${esc(a.nombre)}</b><small>${esc(a.descripcion)}${a.verificado ? '' : ' · sin verificar'}</small></div>
        <div class="aj-num" aria-label="${esc(a.texto)}"><strong>${a.click}</strong><small>${unidad} desde cerrado<br>de ${a.clicks_totales}${a.dial_texto != null ? ` · <b class="dial">dial ${esc(a.dial_texto)}</b>` : ''}</small></div>
      </div>
      <div class="regla" aria-hidden="true"><span>cerrado</span><div class="regla-barra"><i style="left:${pct}%"></i></div><span>abierto</span></div>
      <p class="porque">${esc(a.porque)}</p>
    </li>`;
}

function filaChip(titulo, c) {
  const valor = c.cambia
    ? `<span class="de-a"><s>${esc(c.actual)}</s><i aria-hidden="true">→</i><span class="visually-hidden"> cambia a </span>${esc(c.recomendado)}</span>`
    : esc(c.recomendado);
  return `<li class="dato chip"><div class="dato-cab"><span>${titulo}</span><strong>${valor}</strong></div>
    <p class="cambio ${c.cambia ? 'alerta' : 'ok'}">${c.cambia ? `Cambiar: ${esc(c.texto)}` : 'Sin cambios: ya está en la posición recomendada'}</p>
    <p class="porque">${esc(c.porque)}</p></li>`;
}

function filaDato(titulo, valor, porque, extra = '') {
  return `<li class="dato"><div class="dato-cab"><span>${titulo}</span><strong>${valor}</strong></div>${extra}${porque ? `<p class="porque">${esc(porque)}</p>` : ''}</li>`;
}

function pintarResultado() {
  const cont = $('#resultado');
  if (!cont) return;
  let r;
  try {
    r = calcular();
  } catch (e) {
    cont.innerHTML = `<section class="tarjeta error"><h2>No se pudo calcular</h2><p>${esc(e.message)}</p></section>`;
    return;
  }
  $('#feel-out').textContent = etiquetaFeel(r.inputs.feel);
  $('#grip-out').textContent = r.inputs.grip;
  $('#tipo-out').textContent = r.inputs.tipo;
  $('#saltos-out').textContent = r.inputs.saltos ? 'Sí' : 'No';
  for (const [id, v] of [['feel', r.inputs.feel], ['grip', GRIPS.indexOf(r.inputs.grip)], ['tipo', TIPOS.indexOf(r.inputs.tipo)]]) {
    $$(`[data-slider="${id}"]`).forEach((b) => b.classList.toggle('activo', +b.dataset.valor === v));
  }

  const g = r.geometria;
  const m = g.medidas;
  const h = r.horquilla;
  const a = r.amortiguador;
  const dOffset = m.delta_ejes_offset_mm;
  const GEO = [
    ['Ángulo de dirección', 'angulo_direccion', '°', 2], ['Ángulo de sillín', 'angulo_sillin', '°', 2],
    ['Reach', 'reach_mm', ' mm', 1], ['Stack', 'stack_mm', ' mm', 1], ['Trail', 'trail_mm', ' mm', 1],
    ['Distancia entre ejes', 'distancia_ejes_mm', ' mm', 1], ['Caída del pedalier', 'caida_pedalier_mm', ' mm', 1],
  ];
  const delta = (v, dec) => (Math.abs(v) < 0.5 / 10 ** dec ? '=' : `${v > 0 ? '+' : '−'}${f(Math.abs(v), dec)}`);
  const pr = h.presion;

  cont.innerHTML = `
    ${pr ? `<section class="tarjeta destacada" id="presion-activa">
      <span class="sobre">Horquilla activa · ${esc(h.nombre)}</span>
      <div class="gran-presion">${pr.psi != null ? `<strong>${pr.psi}</strong><span>psi${pr.provisoria ? '*' : ''}</span>` : '<strong class="sin">–</strong><span>psi: falta la tabla</span>'}</div>
      <p class="maximo">${pr.maximo_psi != null ? `Máximo de esta horquilla: <b>${pr.maximo_psi} psi</b>` : 'Máximo de esta horquilla: sin dato'}${pr.supera_maximo ? ' · el cálculo lo superaba y se limitó' : ''}${pr.provisoria && pr.psi != null ? ' · *dato sin verificar' : ''}</p>
    </section>` : ''}
    ${r.compatible ? '' : '<section class="tarjeta error"><h2>No calza en la Glory</h2><p>El amortiguador activo no es 225×75 trunnion.</p></section>'}
    <section class="tarjeta">
      <h2>Flip chips <small>actual → recomendado</small></h2>
      <ul class="lista">
        ${filaChip('Maestro', g.maestro)}
        ${filaChip('Headset (reach)', g.direccion)}
        ${filaChip('Dropout', g.dropout)}
      </ul>
      ${g.hay_cambios ? '<button type="button" class="btn-sec ancho" id="btn-aplique">Apliqué la recomendación</button>' : ''}
      <h3>Geometría resultante <small>Maestro ${esc(g.actuales.maestro)} · Headset ${esc(g.actuales.direccion)} · Dropout ${esc(g.actuales.dropout)} · offset ${f(m.offset_mm, 0)} mm · A2C ${f(m.a2c.a2c_mm)} mm</small></h3>
      <table class="tabla-geo">
        <thead><tr><th scope="col">Medida</th><th scope="col">Actual</th><th scope="col">vs Giant Mid</th></tr></thead>
        <tbody>${GEO.map(([n, k, u, dec]) => `<tr><th scope="row">${n}</th><td>${f(m[k], dec)}${u}</td><td class="${Math.abs(g.delta_giant_mid[k]) < 0.5 / 10 ** dec ? 'igual' : ''}">${delta(g.delta_giant_mid[k], dec)}</td></tr>`).join('')}</tbody>
      </table>
      <p class="porque">Combina, en orden: tabla de Giant para Maestro ${esc(g.actuales.maestro)}, chip de dirección (${m.reach_offset_mm >= 0 ? '+' : '−'}${Math.abs(m.reach_offset_mm)} mm de reach), offset de ${f(m.offset_mm, 0)} mm (tabla: 52) y altura de la horquilla (${m.a2c.delta_mm >= 0 ? '+' : '−'}${f(Math.abs(m.a2c.delta_mm))} mm de A2C). El dropout ${esc(g.actuales.dropout)} es cualitativo. La columna derecha compara con la tabla de Giant en Mid.</p>
    </section>

    <section class="tarjeta">
      <h2>Neumáticos</h2>
      <div class="duo">
        <div><span>Adelante</span><strong>${f(r.neumaticos.adelante.psi)}<small> psi</small></strong><em>${f(r.neumaticos.adelante.bar, 2)} bar</em></div>
        <div><span>Atrás</span><strong>${f(r.neumaticos.atras.psi)}<small> psi</small></strong><em>${f(r.neumaticos.atras.bar, 2)} bar</em></div>
      </div>
      <p class="porque"><b>Adelante:</b> ${esc(r.neumaticos.adelante.porque)}</p>
      <p class="porque"><b>Atrás:</b> ${esc(r.neumaticos.atras.porque)}</p>
    </section>

    <section class="tarjeta">
      <h2>Horquilla <small>${esc(h.nombre)}</small></h2>
      ${sinFabricante(r, h.nombre)}
      ${sinVerificarHtml(r.sin_verificar.horquilla)}
      ${(datos.components.horquillas[h.id].avisos ?? []).map((x) => `<p class="discreto">⚠ ${esc(x)}</p>`).join('')}
      <ul class="lista">
        ${filaDato('Sag objetivo', `${f(h.sag_objetivo.ideal)} %`, `Rango ${h.sag_objetivo.min}-${h.sag_objetivo.max} % de ${datos.components.horquillas[h.id].recorrido_mm} mm: unos ${f(h.sag_objetivo.mm, 0)} mm en la barra.`)}
        ${h.presion ? filaDato('Presión de partida', h.presion.psi != null ? `${h.presion.psi} psi${h.presion.provisoria ? '*' : ''}` : 'Falta dato', h.presion.porque, h.presion.psi != null ? `<em class="sub">${f(h.presion.bar, 1)} bar${h.presion.provisoria ? ' · *provisoria' : ''}</em>` : '') : ''}
        ${filaDato(esc(mayuscula(datos.components.horquillas[h.id].spacers?.nombre ?? 'tokens')), esc(h.tokens.texto), h.tokens.porque)}
      </ul>
      <h3>Clicks desde 100 % cerrado</h3>
      <ul class="lista">${h.ajustadores.map(filaAjustador).join('')}</ul>
    </section>

    <section class="tarjeta">
      <h2>Amortiguador <small>${esc(a.nombre)}</small></h2>
      ${sinFabricante(r, a.nombre)}
      ${sinVerificarHtml(r.sin_verificar.amortiguador)}
      ${a.es_coil ? `
      <div class="duo">
        <div><span>Resorte instalado</span><strong>${a.resorte.instalado_lb}<small> lb</small></strong></div>
        <div><span>Recomendado</span><strong>${a.resorte.recomendado_lb}<small> lb</small></strong><em>sag objetivo ${f(a.sag_objetivo.ideal)} %</em></div>
      </div>
      <p class="visually-hidden">${esc(a.resorte.linea)}</p>
      <p class="discreto">Resorte ideal exacto: ${f(a.resorte.ideal_exacto_lb, 0)} lb${a.resorte.tabla_fabricante ? ` · ${esc(a.resorte.tabla_fabricante.texto)} (referencia cruzada)` : ''}. El instalado se cambia en "Mi bici".</p>` : ''}
      <ul class="lista">
        ${filaDato(`Sag ${a.sag.medido ? 'medido' : 'predicho'}${a.es_coil ? ' con el resorte instalado' : ''}`, `${f(a.sag.pct_shock)} %`, `Son ${f(a.sag.shock_mm)} mm de shock y ${f(a.sag.rueda_mm, 0)} mm en la rueda. Objetivo ${a.sag_objetivo.min}-${a.sag_objetivo.max} % (${f(a.sag_objetivo.ideal)} % = ${f(a.sag_objetivo.mm, 0)} mm de shock).`)}
        ${a.es_coil ? filaDato('Precarga', `${f(a.precarga.vueltas)} vuelta${a.precarga.vueltas === 1 ? '' : 's'}`, a.precarga.porque, `<em class="sub">límites: ${f(a.precarga.minimo)} a ${f(a.precarga.maximo)} vueltas</em>`) : ''}
        ${a.es_coil ? `<li class="dato"><p class="cambio ${a.resorte.veredicto === 'cambiar' ? 'alerta' : 'ok'}">${esc(a.resorte.porque)}</p></li>` : filaDato('Resorte', a.presion_base != null ? `${f(a.presion_base, 0)} psi` : 'Aire', a.resorte.porque)}
      </ul>
      <h3>Clicks desde 100 % cerrado</h3>
      ${a.palanca || a.es_coil ? `<p class="discreto">${[a.palanca ? `${esc(a.palanca)}.` : '', a.es_coil ? `Clicks calculados con el resorte instalado de ${a.resorte_para_clicks_lb} lb.` : ''].filter(Boolean).join(' ')}</p>` : ''}
      <ul class="lista">${a.ajustadores.map(filaAjustador).join('')}</ul>
    </section>

    <section class="tarjeta">
      <h2>Balance adelante / atrás</h2>
      <div class="duo">
        <div><span>Sag horquilla${r.balance.sag_adelante_medido ? '' : ' (objetivo)'}</span><strong>${f(r.balance.sag_adelante_pct)}<small> %</small></strong></div>
        <div><span>Sag trasero</span><strong>${f(r.balance.sag_atras_pct)}<small> %</small></strong></div>
      </div>
      <p class="porque ${r.balance.ok ? 'ok' : 'alerta'}">${esc(r.balance.porque)}</p>
    </section>

    ${r.avisos.length ? `<section class="avisos">${r.avisos.map((x) => `<p class="discreto">⚠ ${esc(x)}</p>`).join('')}</section>` : ''}

    <details class="tarjeta calculo">
      <summary>Ver el cálculo</summary>
      ${r.calculo.map((b) => `<h3>${esc(b.titulo)}</h3><ul>${b.lineas.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`).join('')}
    </details>

    <button type="button" class="btn-principal" id="btn-guardar">Guardar salida en la bitácora</button>`;
}

function eventosSetup(e) {
  const t = e.target;
  const i = estado.inputs;
  if (e.type === 'click') {
    const paso = t.closest('[data-peso]');
    if (paso) {
      i.peso_kg = Math.min(160, Math.max(40, (Number(i.peso_kg) || 80) + Number(paso.dataset.peso)));
      $('#peso').value = i.peso_kg;
    } else if (t.dataset.slider) {
      const s = $(`#${t.dataset.slider}`);
      s.value = t.dataset.valor;
      s.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    } else if (t.dataset.unidad) {
      i[t.dataset.unidad] = { ...(i[t.dataset.unidad] ?? { valor: '' }), unidad: t.dataset.valor };
      $$(`[data-unidad="${t.dataset.unidad}"]`).forEach((b) => b.classList.toggle('activo', b === t));
    } else if (t.id === 'btn-guardar') {
      return dialogoGuardar();
    } else if (t.id === 'btn-aplique') {
      estado.chips = { ...ultima.geometria.recomendados };
      persistir('chips', estado.chips);
      toast('Posición actual de los flip chips actualizada.');
      return pintarResultado();
    } else return;
  } else {
    if (t.id === 'peso') i.peso_kg = t.value === '' ? '' : Number(t.value);
    else if (t.id === 'feel') i.feel = Number(t.value);
    else if (t.id === 'grip') i.grip = GRIPS[Number(t.value)];
    else if (t.id === 'tipo') i.tipo = TIPOS[Number(t.value)];
    else if (t.id === 'saltos') i.saltos = t.checked;
    else if (t.id === 'sag_atras' || t.id === 'sag_adelante') i[t.id] = { ...(i[t.id] ?? { unidad: '%' }), valor: t.value };
    else if (t.id === 'presion_horquilla_actual') i.presion_horquilla_actual = t.value;
    else return;
  }
  persistir('inputs', i);
  pintarResultado();
}

// ---------- Bitácora ----------

function instantanea(r) {
  const clicks = (lista) => lista.filter((x) => !x.sin_datos).map((x) => ({ etiqueta: x.etiqueta, click: x.click, total: x.clicks_totales }));
  return {
    chips: { ...r.geometria.recomendados }, // recomendados
    chips_actuales: { ...r.geometria.actuales },
    offset_mm: r.geometria.offset_mm,
    geometria: { reach_mm: r.geometria.medidas.reach_mm, trail_mm: r.geometria.medidas.trail_mm, distancia_ejes_mm: r.geometria.medidas.distancia_ejes_mm },
    neumaticos: { adelante_psi: r.neumaticos.adelante.psi, atras_psi: r.neumaticos.atras.psi },
    horquilla: {
      sag_objetivo_pct: r.horquilla.sag_objetivo.ideal,
      presion_psi: r.horquilla.presion?.psi ?? null,
      tokens: r.horquilla.tokens.texto,
      clicks: clicks(r.horquilla.ajustadores),
    },
    amortiguador: {
      sag_pct: r.amortiguador.sag.pct_shock,
      resorte_lb: r.amortiguador.resorte.instalado_lb, // instalado
      resorte_recomendado_lb: r.amortiguador.resorte.recomendado_lb,
      precarga_vueltas: r.amortiguador.es_coil ? r.amortiguador.precarga.vueltas : null,
      clicks: clicks(r.amortiguador.ajustadores),
    },
  };
}

function dialogoGuardar() {
  const r = ultima ?? calcular();
  const pistas = [...new Set(estado.bitacora.map((x) => x.pista))].filter(Boolean);
  const fb = datos.rules.calibracion.feedback;
  const d = dialogo(`
    <form method="dialog" id="form-bitacora" class="formulario">
      <h2>Guardar salida</h2>
      <p class="discreto">${esc(r.montado)} · se guarda el setup completo que ves en pantalla.</p>
      <label>Fecha<input type="date" name="fecha" value="${hoy()}" required></label>
      <label>Pista<input type="text" name="pista" list="pistas" placeholder="Nombre de la pista" required autocomplete="off"></label>
      <datalist id="pistas">${pistas.map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
      <fieldset>
        <legend>Nota</legend>
        <div class="notas">${[1, 2, 3, 4, 5].map((n) => `<label><input type="radio" name="nota" value="${n}" ${n === 4 ? 'checked' : ''}><span>${n}</span></label>`).join('')}</div>
      </fieldset>
      <fieldset>
        <legend>¿Pasó algo de esto? <small>Ajusta el modelo para la próxima</small></legend>
        <div class="chips">${Object.entries(fb).map(([k, v]) => `<label><input type="checkbox" name="avisos" value="${esc(k)}"><span>${esc(v.etiqueta)}</span></label>`).join('')}</div>
      </fieldset>
      <label>Comentario<textarea name="comentario" rows="3" placeholder="Cómo se sintió la bici"></textarea></label>
      <div class="acciones">
        <button type="button" class="btn-sec" data-cerrar>Cancelar</button>
        <button type="submit" class="btn-principal">Guardar</button>
      </div>
    </form>`);
  $('#form-bitacora', d).addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const reg = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      fecha: fd.get('fecha') || hoy(),
      pista: String(fd.get('pista')).trim(),
      nota: Number(fd.get('nota')),
      comentario: String(fd.get('comentario') ?? '').trim(),
      avisos: fd.getAll('avisos'),
      horquilla: r.seleccion.horquilla,
      amortiguador: r.seleccion.amortiguador,
      montado: r.montado,
      inputs: { ...r.inputs },
      medidas: { ...r.medidas_usuario },
      setup: instantanea(r),
    };
    estado.bitacora.push(reg);
    persistir('bitacora', estado.bitacora);
    cerrarDialogo();
    toast(reg.avisos.length ? 'Guardado. El modelo se recalibró con tus avisos.' : 'Salida guardada en la bitácora.');
    pintarResultado();
  });
}

const estrellas = (n) => `<span class="estrellas" aria-label="Nota ${n} de 5">${'★'.repeat(n)}<i>${'★'.repeat(5 - n)}</i></span>`;

// "Actual → Recomendado" de un chip guardado (los registros antiguos solo traen el recomendado).
function chipTxt(s, k) {
  const rec = s?.chips?.[k];
  const act = s?.chips_actuales?.[k];
  if (rec == null) return null;
  return act && act !== rec ? `${esc(act)} → ${esc(rec)}` : esc(rec);
}

function resumenSetup(s) {
  const cl = (lista) => lista.map((c) => `${esc(c.etiqueta.replace(/ (adelante|atrás)$/, ''))} <b>${c.click}</b>`).join(' · ');
  return `
    <dl class="mini">
      <div><dt>Chips</dt><dd>${[['Maestro', 'maestro'], ['Headset', 'direccion'], ['Dropout', 'dropout']].map(([n, k]) => `${n} ${chipTxt(s, k)}`).join(' · ')}</dd></div>
      <div><dt>Neumáticos</dt><dd>${f(s.neumaticos.adelante_psi)} / ${f(s.neumaticos.atras_psi)} psi</dd></div>
      <div><dt>Horquilla</dt><dd>${s.horquilla.presion_psi != null ? `${s.horquilla.presion_psi} psi · ` : ''}${cl(s.horquilla.clicks)}</dd></div>
      <div><dt>Amortiguador</dt><dd>${s.amortiguador.resorte_lb ? `${s.amortiguador.resorte_lb} lb · ` : ''}${cl(s.amortiguador.clicks)}</dd></div>
    </dl>`;
}

function vistaBitacora() {
  const fb = datos.rules.calibracion.feedback;
  const lista = [...estado.bitacora].sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)) || String(b.id).localeCompare(String(a.id)));
  const cal = resumenCalibracion(calibrar(estado.bitacora, datos.rules), datos.rules, datos.components);
  $('#vista').innerHTML = `
    <section class="tarjeta">
      <h2>Bitácora <small>${lista.length} salida${lista.length === 1 ? '' : 's'}</small></h2>
      <p class="discreto">Para registrar una salida, usa "Guardar salida en la bitácora" al final de la pestaña Setup.</p>
      <div class="acciones">
        <button type="button" class="btn-sec" id="btn-exportar">Exportar JSON</button>
        <button type="button" class="btn-sec" id="btn-importar">Importar JSON</button>
        <input type="file" id="archivo" accept="application/json,.json" hidden>
      </div>
    </section>
    ${cal.length ? `<section class="tarjeta"><h2>Calibración aprendida</h2><ul class="simple">${cal.map((l) => `<li>${esc(l)}</li>`).join('')}</ul><p class="discreto">Sale de los avisos de tus salidas. Si borras un registro, se deshace su efecto.</p></section>` : ''}
    ${lista.map((x) => `
      <article class="tarjeta registro">
        <header><div><b>${esc(x.pista)}</b><small>${fechaCorta(x.fecha)} · ${esc(x.montado ?? `${nombreComp(x.horquilla)} · ${nombreComp(x.amortiguador)}`)}</small></div>${estrellas(x.nota)}</header>
        <p class="mods">${esc(etiquetaFeel(x.inputs?.feel ?? 0))} · Grip ${esc(x.inputs?.grip)} · ${esc(x.inputs?.tipo)} · Saltos ${x.inputs?.saltos ? 'sí' : 'no'} · ${f(x.inputs?.peso_kg)} kg</p>
        ${x.setup ? resumenSetup(x.setup) : ''}
        ${x.avisos?.length ? `<p class="etiquetas">${x.avisos.map((k) => `<span>${esc(fb[k]?.etiqueta ?? k)}</span>`).join('')}</p>` : ''}
        ${x.comentario ? `<p class="comentario">${esc(x.comentario)}</p>` : ''}
        <button type="button" class="btn-texto" data-borrar="${esc(x.id)}">Borrar</button>
      </article>`).join('') || '<p class="vacio">Todavía no hay salidas registradas.</p>'}`;
}

function exportar() {
  const contenido = JSON.stringify({
    app: 'glory-setup', version: 1, exportado: new Date().toISOString(),
    seleccion: seleccionValida(), offsets: estado.offsets, resortes: estado.resortes, chips: chipsActuales(), inputs: estado.inputs, bitacora: estado.bitacora,
  }, null, 2);
  const url = URL.createObjectURL(new Blob([contenido], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `glory-setup-${hoy()}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importar(archivo) {
  try {
    const d = JSON.parse(await archivo.text());
    const entrantes = Array.isArray(d) ? d : d.bitacora;
    if (!Array.isArray(entrantes)) throw new Error('El archivo no trae una bitácora');
    const validos = entrantes.filter((x) => x && typeof x === 'object' && x.id && x.fecha && x.pista != null);
    const ids = new Set(estado.bitacora.map((x) => x.id));
    const nuevos = validos.filter((x) => !ids.has(x.id));
    estado.bitacora.push(...nuevos);
    migrarIds();
    persistir('bitacora', estado.bitacora);
    toast(`Importadas ${nuevos.length} salidas nuevas (${validos.length - nuevos.length} ya estaban).`);
    vistaBitacora();
  } catch (e) {
    toast(`No se pudo importar: ${e.message}`);
  }
}

function eventosBitacora(e) {
  const t = e.target;
  if (e.type === 'change' && t.id === 'archivo' && t.files[0]) return importar(t.files[0]);
  if (e.type !== 'click') return;
  if (t.id === 'btn-exportar') exportar();
  else if (t.id === 'btn-importar') $('#archivo').click();
  else if (t.dataset.borrar) {
    const reg = estado.bitacora.find((x) => x.id === t.dataset.borrar);
    const d = dialogo(`
      <div class="formulario">
        <h2>¿Borrar esta salida?</h2>
        <p>${esc(reg?.pista)} · ${fechaCorta(reg?.fecha)}. Se deshace también la calibración que aportó.</p>
        <div class="acciones"><button type="button" class="btn-sec" data-cerrar>Cancelar</button><button type="button" class="btn-principal peligro" id="si-borrar">Borrar</button></div>
      </div>`);
    $('#si-borrar', d).addEventListener('click', () => {
      estado.bitacora = estado.bitacora.filter((x) => x.id !== t.dataset.borrar);
      persistir('bitacora', estado.bitacora);
      cerrarDialogo();
      vistaBitacora();
    });
  }
}

// ---------- Comparar ----------

function vistaComparar() {
  const fl = estado.filtros;
  const pistas = [...new Set(estado.bitacora.map((x) => x.pista))].filter(Boolean).sort((a, b) => a.localeCompare(b));
  const usados = (clave) => [...new Set(estado.bitacora.map((x) => x[clave]))].filter(Boolean);
  if (fl.pista && !pistas.includes(fl.pista)) fl.pista = '';
  const lista = estado.bitacora
    .filter((x) => (!fl.pista || x.pista === fl.pista) && (!fl.horquilla || x.horquilla === fl.horquilla) && (!fl.amortiguador || x.amortiguador === fl.amortiguador))
    .sort((a, b) => b.nota - a.nota || String(b.fecha).localeCompare(String(a.fecha)));
  const opciones = (ids, actual, todas) => `<option value="">${todas}</option>${ids.map((id) => `<option value="${esc(id)}" ${id === actual ? 'selected' : ''}>${esc(nombreComp(id))}</option>`).join('')}`;

  const filas = [];
  const fila = (titulo, fn, clase = '') => filas.push(`<tr class="${clase}"><th scope="row">${titulo}</th>${lista.map((x) => `<td>${fn(x) ?? '–'}</td>`).join('')}</tr>`);
  if (lista.length) {
    const fb = datos.rules.calibracion.feedback;
    const mejor = lista[0].nota;
    fila('Nota', (x) => estrellas(x.nota));
    if (!fl.pista) fila('Pista', (x) => esc(x.pista));
    fila('Horquilla', (x) => esc(nombreComp(x.horquilla)));
    fila('Amortiguador', (x) => esc(nombreComp(x.amortiguador)));
    fila('Modifiers', (x) => `${esc(etiquetaFeel(x.inputs?.feel ?? 0))}<br>Grip ${esc(x.inputs?.grip)}<br>${esc(x.inputs?.tipo)}${x.inputs?.saltos ? '<br>Saltos' : ''}`);
    fila('Maestro', (x) => chipTxt(x.setup, 'maestro'));
    fila('Headset', (x) => chipTxt(x.setup, 'direccion'));
    fila('Dropout', (x) => chipTxt(x.setup, 'dropout'));
    fila('Neum. adelante', (x) => `${f(x.setup?.neumaticos.adelante_psi)} psi`);
    fila('Neum. atrás', (x) => `${f(x.setup?.neumaticos.atras_psi)} psi`);
    fila('Presión horquilla', (x) => (x.setup?.horquilla.presion_psi != null ? `${x.setup.horquilla.presion_psi} psi` : null));
    fila('Tokens', (x) => esc(x.setup?.horquilla.tokens));
    for (const lado of ['horquilla', 'amortiguador']) {
      const etiquetas = [...new Set(lista.flatMap((x) => (x.setup?.[lado].clicks ?? []).map((c) => c.etiqueta)))];
      for (const et of etiquetas) {
        fila(esc(et), (x) => {
          const c = x.setup?.[lado].clicks.find((k) => k.etiqueta === et);
          return c ? `<b>${c.click}</b><small> /${c.total}</small>` : null;
        }, 'click');
      }
    }
    fila('Resorte instalado', (x) => (x.setup?.amortiguador.resorte_lb ? `${x.setup.amortiguador.resorte_lb} lb` : null));
    fila('Resorte recomendado', (x) => (x.setup?.amortiguador.resorte_recomendado_lb ? `${x.setup.amortiguador.resorte_recomendado_lb} lb` : null));
    fila('Offset', (x) => (x.setup?.offset_mm != null ? `${x.setup.offset_mm} mm` : null));
    fila('Precarga', (x) => (x.setup?.amortiguador.precarga_vueltas != null ? `${x.setup.amortiguador.precarga_vueltas} v` : null));
    fila('Avisos', (x) => (x.avisos?.length ? x.avisos.map((k) => esc(fb[k]?.etiqueta ?? k)).join('<br>') : null));
    fila('Comentario', (x) => (x.comentario ? esc(x.comentario) : null), 'texto');
    filas.unshift(`<tr><th scope="col">Salida</th>${lista.map((x) => `<th scope="col" class="${x.nota === mejor ? 'mejor' : ''}">${fechaCorta(x.fecha)}${fl.pista ? '' : `<small>${esc(x.pista)}</small>`}</th>`).join('')}</tr>`);
  }

  $('#vista').innerHTML = `
    <section class="tarjeta">
      <h2>Comparar setups</h2>
      <div class="filtros">
        <label>Pista<select id="f-pista"><option value="">Todas</option>${pistas.map((p) => `<option ${p === fl.pista ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></label>
        <label>Horquilla<select id="f-horquilla">${opciones(usados('horquilla'), fl.horquilla, 'Todas')}</select></label>
        <label>Amortiguador<select id="f-amortiguador">${opciones(usados('amortiguador'), fl.amortiguador, 'Todos')}</select></label>
      </div>
    </section>
    ${lista.length
    ? `<section class="tarjeta tabla-caja"><p class="discreto">${lista.length} salida${lista.length === 1 ? '' : 's'}, la mejor nota primero. Desliza hacia el lado para ver más.</p><div class="tabla-scroll"><table class="comparar">${filas.join('')}</table></div></section>`
    : `<p class="vacio">${estado.bitacora.length ? 'Ninguna salida coincide con los filtros.' : 'Todavía no hay salidas para comparar.'}</p>`}`;
}

function eventosComparar(e) {
  if (e.type !== 'change') return;
  const m = { 'f-pista': 'pista', 'f-horquilla': 'horquilla', 'f-amortiguador': 'amortiguador' }[e.target.id];
  if (!m) return;
  estado.filtros[m] = e.target.value;
  vistaComparar();
}

// ---------- Mi bici ----------

function opcionesComponente(tipo, grupo, activo) {
  return Object.entries(grupo).map(([id, c]) => {
    const sv = camposSinVerificar(c);
    const calza = tipo !== 'amortiguador' || esCompatible(datos.bike, c);
    const detalle = [
      c.tipo_resorte === 'coil' ? `Coil${c.resorte_lb ? ` ${c.resorte_lb} lb` : ''}` : 'Aire',
      c.recorrido_mm ? `${c.recorrido_mm} mm` : c.carrera_mm ? `${c.carrera_mm} mm de carrera` : '',
      `${c.ajustadores?.length ?? 0} ajustadores`,
    ].filter(Boolean).join(' · ');
    return `
      <button type="button" class="opcion ${id === activo ? 'activo' : ''} ${calza ? '' : 'bloqueada'}" data-tipo="${tipo}" data-id="${esc(id)}" aria-pressed="${id === activo}" ${calza ? '' : 'disabled'}>
        <span class="radio" aria-hidden="true"></span>
        <span><b>${esc(c.nombre)}</b><small>${esc(c.nombre_largo ?? '')}</small><small>${esc(detalle)}</small>${calza ? '' : '<small class="no-calza">No calza en la Glory</small>'}${c.confianza === 'no_verificado' ? '<small class="discreto">⚠ datos sin verificar con el fabricante</small>' : sv.length ? '<small class="discreto">⚠ con valores pendientes</small>' : ''}</span>
      </button>`;
  }).join('');
}

function vistaBici() {
  const sel = seleccionValida();
  const b = datos.bike;
  const h = datos.components.horquillas[sel.horquilla];
  const a = datos.components.amortiguadores[sel.amortiguador];
  const cin = b.suspension_trasera.cinematica;
  const offsetsDisp = h.offsets_disponibles ?? (h.offset_mm != null ? [h.offset_mm] : [44, 48, 52, 56]);
  const offsetActual = offsetActivo(sel);
  const resortes = resortesDisponibles(a, datos.rules);
  const resorteActual = resorteInstalado(sel);
  const chips = chipsActuales();
  const g = b.geometria;
  const selectorChip = (clave, titulo, etiqueta) => `
    <div class="campo">
      <label>${titulo}</label>
      <div class="segmento ancho" role="group" aria-label="${titulo}">
        ${Object.keys(g[clave]).map((o) => `<button type="button" data-chip="${clave}" data-valor="${esc(o)}" class="${o === chips[clave] ? 'activo' : ''}" aria-pressed="${o === chips[clave]}">${esc(etiqueta(o))}</button>`).join('')}
      </div>
    </div>`;
  $('#vista').innerHTML = `
    <section class="tarjeta">
      <h2>Flip chips <small>cómo está montada hoy</small></h2>
      ${selectorChip('maestro', 'Maestro', (o) => o)}
      ${selectorChip('direccion', 'Headset (reach)', (o) => `${o} ${g.direccion[o].reach_mm > 0 ? '+' : g.direccion[o].reach_mm < 0 ? '−' : ''}${Math.abs(g.direccion[o].reach_mm)}`)}
      ${selectorChip('dropout', 'Dropout', (o) => o)}
      <p class="ayuda">La geometría de la pestaña Setup se calcula con esta posición y se compara con la recomendada.</p>
    </section>
    <section class="tarjeta">
      <h2>Horquilla</h2>
      <div class="opciones">${opcionesComponente('horquilla', datos.components.horquillas, sel.horquilla)}</div>
      <div class="campo">
        <label>Offset</label>
        <div class="segmento ancho" role="group" aria-label="Offset de la horquilla en mm">
          ${offsetsDisp.map((o) => `<button type="button" data-offset="${o}" class="${o === offsetActual ? 'activo' : ''}" aria-pressed="${o === offsetActual}">${o} mm</button>`).join('')}
        </div>
        <p class="ayuda">${offsetsDisp.length === 1 ? `${esc(h.nombre)} solo viene con ${offsetsDisp[0]} mm.` : `De serie: ${h.offset_mm ?? '–'} mm.`}${h.offset_nota ? ` ${esc(h.offset_nota)}` : ''} Altura (A2C): ${f(h.a2c_mm)} mm.</p>
      </div>
      ${h.confianza === 'no_verificado' ? `<p class="discreto">⚠ Datos de ${esc(h.nombre)} sin verificar con el fabricante.</p>` : ''}
      <p class="discreto">Fuente: ${esc(h.fuente ?? 'sin dato')}.</p>
      ${sinVerificarHtml(camposSinVerificar(h))}
      ${(h.avisos ?? []).map((x) => `<p class="discreto">⚠ ${esc(x)}</p>`).join('')}
      ${h.notas ? `<p class="discreto">${esc(h.notas)}</p>` : ''}
    </section>
    <section class="tarjeta">
      <h2>Amortiguador</h2>
      <div class="opciones">${opcionesComponente('amortiguador', datos.components.amortiguadores, sel.amortiguador)}</div>
      ${resortes.length ? `
      <div class="campo">
        <label for="resorte-instalado">Resorte instalado (lb/in)</label>
        <select id="resorte-instalado">${resortes.map((k) => `<option value="${k}" ${k === resorteActual ? 'selected' : ''}>${k} lb/in</option>`).join('')}</select>
        <p class="ayuda">Pasos de ${resortes[1] - resortes[0]} lb para ${esc(a.nombre)}. Sag, precarga y clicks se calculan con este resorte.</p>
      </div>` : ''}
      ${a.confianza === 'no_verificado' ? `<p class="discreto">⚠ Datos de ${esc(a.nombre)} sin verificar con el fabricante.</p>` : ''}
      <p class="discreto">Fuente: ${esc(a.fuente ?? 'sin dato')}.</p>
      ${sinVerificarHtml(camposSinVerificar(a))}
      ${a.notas ? `<p class="discreto">${esc(a.notas)}</p>` : ''}
    </section>
    <section class="tarjeta">
      <h2>${esc(b.nombre)} <small>${esc(b.talla)} · ${esc(b.ruedas.configuracion)} ${esc(b.ruedas.adelante)} / ${esc(b.ruedas.atras)}</small></h2>
      <dl class="geo">
        <div><dt>Tubo de dirección</dt><dd>${b.fijos.tubo_direccion_mm}<small> mm</small></dd></div>
        <div><dt>Manubrio</dt><dd>${b.fijos.manubrio_mm}<small> mm</small></dd></div>
        <div><dt>Potencia</dt><dd>${b.fijos.potencia_mm}<small> mm</small></dd></div>
        <div><dt>Bielas</dt><dd>${b.fijos.bielas_mm}<small> mm</small></dd></div>
        <div><dt>Recorrido trasero</dt><dd>${b.suspension_trasera.recorrido_mm}<small> mm</small></dd></div>
        <div><dt>Carrera</dt><dd>${b.suspension_trasera.carrera_mm}<small> mm</small></dd></div>
        <div><dt>Leverage</dt><dd>${f(cin.resumen.lr_inicio, 2)} → ${f(cin.resumen.lr_final, 2)}</dd></div>
        <div><dt>Progresión</dt><dd>${f(cin.resumen.progresion_pct)}<small> %</small></dd></div>
      </dl>
      <p class="discreto">Setup base: Maestro ${esc(b.geometria.baseline.maestro)}, dirección ${esc(b.geometria.baseline.direccion)}, dropout ${esc(b.geometria.baseline.dropout)}. Neumáticos: carcasa ${esc(b.neumaticos.carcasa.toLowerCase())}.</p>
      <p class="discreto">${esc(cin.forma)} Dato informativo, no se usa como regla: anti-squat ${cin.anti_squat.inicio_pct.join('-')} % al inicio y ${cin.anti_squat.sag_pct.join('-')} % en el sag (${esc(cin.anti_squat.fuente)}).</p>
      <p class="discreto">⚠ Curva de leverage: ${esc(cin.fuente)}. Verificar.</p>
    </section>`;
}

function eventosBici(e) {
  if (e.type === 'change' && e.target.id === 'resorte-instalado') {
    estado.resortes[seleccionValida().amortiguador] = Number(e.target.value);
    persistir('resortes', estado.resortes);
    pintarMontado();
    return vistaBici();
  }
  if (e.type !== 'click') return;
  const chip = e.target.closest('[data-chip]');
  if (chip) {
    estado.chips = { ...chipsActuales(), [chip.dataset.chip]: chip.dataset.valor };
    persistir('chips', estado.chips);
    return vistaBici();
  }
  const off = e.target.closest('[data-offset]');
  if (off) {
    estado.offsets[seleccionValida().horquilla] = Number(off.dataset.offset);
    persistir('offsets', estado.offsets);
    toast(`Offset ${off.dataset.offset} mm: geometría recalculada.`);
    return vistaBici();
  }
  const op = e.target.closest('.opcion');
  if (!op || op.disabled) return;
  const { tipo, id } = op.dataset;
  const sel = seleccionValida();
  if (sel[tipo] === id) return;
  const grupo = tipo === 'horquilla' ? datos.components.horquillas : datos.components.amortiguadores;
  const comp = grupo[id];
  const sv = camposSinVerificar(comp);
  const articulo = tipo === 'horquilla' ? 'la horquilla' : 'el amortiguador';
  const d = dialogo(`
    <div class="formulario">
      <h2>¿Cambiaste ${articulo} físicamente?</h2>
      <p>Desde ahora los clicks se calculan para <b>${esc(comp.nombre)}</b>.</p>
      ${sv.length ? `<p class="discreto">⚠ ${esc(comp.nombre)} tiene valores sin verificar (${esc(sv.join(', '))}): las recomendaciones son provisorias hasta cargar el manual.</p>` : ''}
      <div class="acciones"><button type="button" class="btn-sec" data-cerrar>No, cancelar</button><button type="button" class="btn-principal" id="si-cambiar">Sí, cambiar</button></div>
    </div>`);
  $('#si-cambiar', d).addEventListener('click', () => {
    let aviso = null;
    if (tipo === 'horquilla') {
      // El offset actual se mantiene si la horquilla nueva lo ofrece; si no, el más cercano.
      const anterior = offsetActivo(sel);
      const { offset, cambio } = offsetParaHorquilla(comp, anterior);
      if (offset != null) {
        estado.offsets[id] = offset;
        persistir('offsets', estado.offsets);
      }
      aviso = cambio
        ? `${comp.nombre} no tiene offset de ${anterior} mm: se eligió ${offset} mm, el más cercano.`
        : `${comp.nombre} montada con offset de ${offset} mm. Revisa la presión: cambia mucho entre horquillas.`;
    }
    estado.seleccion = { ...sel, [tipo]: id };
    persistir('seleccion', estado.seleccion);
    cerrarDialogo();
    pintarMontado();
    vistaBici();
    toast(aviso ?? `Montado: ${nombreMontado(datos.components, seleccionValida(), resorteInstalado())}`);
  });
}

// ---------- Navegación y arranque ----------

const VISTAS = {
  setup: [vistaSetup, eventosSetup],
  bitacora: [vistaBitacora, eventosBitacora],
  comparar: [vistaComparar, eventosComparar],
  bici: [vistaBici, eventosBici],
};

function irA(tab) {
  estado.tab = VISTAS[tab] ? tab : 'setup';
  $$('.tabs button').forEach((b) => {
    const activo = b.dataset.tab === estado.tab;
    b.classList.toggle('activo', activo);
    if (activo) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  VISTAS[estado.tab][0]();
  window.scrollTo(0, 0);
}

function aplicarTema(tema) {
  document.documentElement.dataset.tema = tema;
  $('#btn-tema').textContent = tema === 'sol' ? '☾' : '☀';
  $('meta[name="theme-color"]').content = tema === 'sol' ? '#ffffff' : '#0b0d10';
}

async function cargarJson(nombre) {
  const r = await fetch(`data/${nombre}`);
  if (!r.ok) throw new Error(`No se pudo cargar ${nombre} (${r.status})`);
  return r.json();
}

async function iniciar() {
  aplicarTema(leer('tema', 'oscuro'));
  $('#btn-tema').addEventListener('click', () => {
    const tema = document.documentElement.dataset.tema === 'sol' ? 'oscuro' : 'sol';
    aplicarTema(tema);
    guardar('tema', tema);
  });
  try {
    [datos.bike, datos.components, datos.rules] = await Promise.all(['bike.json', 'components.json', 'rules.json'].map(cargarJson));
  } catch (e) {
    $('#vista').innerHTML = `<section class="tarjeta error"><h2>No se pudieron cargar los datos</h2><p>${esc(e.message)}</p><p>Abre la app una vez con conexión para dejarla disponible sin señal.</p></section>`;
    return;
  }
  if (!Array.isArray(estado.bitacora)) estado.bitacora = [];
  if (migrarIds()) {
    persistir('seleccion', estado.seleccion);
    persistir('offsets', estado.offsets);
    persistir('resortes', estado.resortes);
    persistir('bitacora', estado.bitacora);
  }
  $('#pie').textContent = `Glory Setup v${self.GLORY_VERSION ?? '?'} · ${self.GLORY_FECHA ?? ''}`;
  pintarMontado();
  const vista = $('#vista');
  for (const tipo of ['click', 'input', 'change']) {
    vista.addEventListener(tipo, (e) => VISTAS[estado.tab][1](e));
  }
  $('.tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) irA(b.dataset.tab);
  });
  $('#dlg').addEventListener('click', (e) => {
    if (e.target.closest('[data-cerrar]') || e.target === e.currentTarget) cerrarDialogo();
  });
  irA('setup');
}

// ---------- Service worker y actualización ----------
// Una versión nueva se instala en segundo plano y queda esperando. Recién al
// tocar el aviso reemplaza a la anterior y la página se recarga una sola vez,
// así nunca se mezclan archivos de dos versiones ni queda la pantalla en blanco.

function vigilarActualizacion(reg) {
  const aviso = $('#aviso-version');
  let aceptada = false;
  const ofrecer = () => {
    if (reg.waiting && navigator.serviceWorker.controller) aviso.hidden = false;
  };
  ofrecer();
  reg.addEventListener('updatefound', () => {
    const nuevo = reg.installing;
    nuevo?.addEventListener('statechange', () => { if (nuevo.state === 'installed') ofrecer(); });
  });
  aviso.addEventListener('click', () => {
    if (!reg.waiting) return location.reload();
    aceptada = true;
    aviso.textContent = 'Actualizando…';
    aviso.disabled = true;
    reg.waiting.postMessage('SKIP_WAITING');
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!aceptada) return; // primera instalación: no hay nada que recargar
    aceptada = false;
    location.reload();
  });
  // En el iPhone la app instalada puede pasar días abierta: revisa al volver a ella.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reg.update().catch(() => {});
  });
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(vigilarActualizacion).catch(() => {});
  });
}

iniciar();
