# Glory Setup

PWA instalable y offline que recomienda el setup de **una sola bici**: Giant Glory Advanced, talla M/L, mullet (29" / 27,5"). Sin framework, sin backend, sin paso de build.

## Usarla

```bash
npm start        # sirve la app en http://localhost:8080
npm test         # tests unitarios del motor (node --test, sin dependencias)
npm run test:e2e # prueba en navegador: subcarpeta, offline y actualización (requiere Playwright)
```

Para el celular: publica la carpeta tal cual en cualquier hosting estático con HTTPS (por ejemplo GitHub Pages), ábrela una vez con señal y usa "Agregar a pantalla de inicio". Desde ahí funciona sin conexión.

Todas las rutas son relativas, así que funciona igual en la raíz o bajo `/glory-setup/` (GitHub Pages).

### Publicar una versión nueva

Sube `GLORY_VERSION` (y la fecha) en `version.js` en **cada** cambio que publiques. Es la única fuente de la versión: se muestra en el pie de la pantalla y nombra la caché del service worker. Con eso el celular detecta la versión nueva, la descarga en segundo plano y muestra "Hay una versión nueva, toca para actualizar"; al tocarlo, recarga con todo actualizado. Si no subes la versión, el código y los estilos no se renuevan en los teléfonos que ya la tienen instalada.

Los `.json` de `data/` son la excepción: se piden primero a la red, así que editarlos se nota al recargar con señal, sin subir la versión.

## Dónde está cada cosa

| Archivo | Qué contiene |
|---|---|
| `data/bike.json` | Todo lo propio del cuadro: geometría por flip chip, medidas fijas, curva de leverage, masas. |
| `data/components.json` | Catálogo de horquillas y amortiguadores, con sus ajustadores. |
| `data/rules.json` | Reglas de los ride modifiers, objetivos de sag, neumáticos, parámetros del modelo y de la calibración. |
| `js/engine/` | Motor puro (sin DOM): `fisica.js`, `geometria.js`, `spline.js`, `motor.js`, `calibracion.js`. |
| `js/app.js` | Interfaz. |
| `tests/motor.test.js` | Tests del motor de reglas, la geometría y el cálculo del resorte. |

## Convención de clicks

Todos los clicks se cuentan **desde 100 % cerrado** (horario hasta el tope): 0 = cerrado = máxima amortiguación. En `rules.json`, un `delta_clicks` negativo significa más amortiguación.

Los deltas de las reglas son "clicks de referencia" (`modelo.efecto_referencia_por_click`). El motor los pasa a amortiguación relativa y de ahí a clicks reales con el `efecto_por_click` de cada ajustador, así que un mismo objetivo mueve distinto un HSC de 4 posiciones que uno de 8 clicks. El resultado siempre queda entre 0 y `clicks_totales`.

## Agregar un componente (sin tocar código)

Agrega una entrada en `data/components.json`. Ejemplo: un amortiguador nuevo.

```json
"amortiguadores": {
  "dhx2_factory": { "...": "..." },
  "mi_amortiguador_nuevo": {
    "nombre": "Nombre corto",
    "nombre_largo": "Nombre completo para la pantalla Mi bici",
    "tipo_resorte": "coil",
    "carrera_mm": 75,
    "resorte_lb": 450,
    "referencia_base": { "peso_kg": 80, "resorte_lb": 450 },
    "precarga_mm_por_vuelta": 1.0,
    "ajustadores": [
      { "id": "lsc", "tipo": "LSC", "clicks_totales": 12, "base_desde_cerrado": 6, "efecto_por_click": 0.08, "verificado": true },
      { "id": "rebote", "tipo": "REBOTE_UNICO", "clicks_totales": 14, "base_desde_cerrado": 7, "efecto_por_click": 0.07, "verificado": true }
    ],
    "notas": "Texto libre"
  }
}
```

Aparece solo en el selector de "Mi bici". Notas sobre los campos:

- `tipo` ∈ `LSC`, `HSC`, `LSR`, `HSR`, `REBOTE_UNICO`. Cada componente declara su propia lista. Con `REBOTE_UNICO` se aplica el delta de LSR y el de HSR se ignora (la app lo explica). Si falta un tipo, ese ajuste no aparece.
- `efecto_por_click`: fracción del rango que cambia cada click (0-1). Puede ser un número (lineal) o una lista con el efecto de cada click, del cerrado hacia afuera, si el manual indica que no es lineal.
- `"unidad": "posiciones"` para ajustadores de posiciones.
- `sag_objetivo` (`min`, `max`, `ideal` en %): cada componente trae el suyo; el modelo y el balance adelante/atrás usan el del componente activo. La meta de balance de `rules.json` (7-10 puntos) vale para 22,5 % adelante y 30 % atrás, y se desplaza con el sag ideal de cada componente.
- Horquillas: además `recorrido_mm`, `offset_mm` (o `null` + `offset_opciones_mm` para elegirlo en la app), `spacers` y `presion_base`, que acepta `formula: { psi_fijo, psi_por_kg }` o `tabla_peso_psi: [[kg, psi], ...]` (interpolación lineal), más `maximo_psi` y `psi_por_punto_sag` (corrección con el sag medido).
- Base de los ajustadores, por prioridad:
  1. `rebote_base` del componente: `desde_presion: { psi_ref, clicks_ref, clicks_por_psi }` (BoXXer, datos de Trailhead) o `tabla_peso` por rangos de peso con `clicks_por_psi` (Fox 40). `tipos` dice a qué ajustadores aplica.
  2. `base_por_resorte.filas` (DHX2, tabla B): base de cada tipo según el resorte, como valor o rango `[min, max]`; se usa el menor. Si la app recomienda cambiar de resorte, usa la fila del resorte nuevo.
  3. `base_desde_cerrado` del ajustador.
  4. Si falta todo, la mitad del rango (provisoria).
- Sin tabla del fabricante, el rebote base se escala por peso y resorte desde `referencia_base: { peso_kg, resorte_lb }`.
- `palanca.recomendada`: la app recuerda en qué posición dejar la palanca.
- `avisos`: textos que se muestran junto al componente.
- `fuente` y `confianza` (`oficial` o `no_verificado`): con `no_verificado` los datos se usan, pero la app avisa "Datos de X sin verificar con el fabricante".
- Horquillas: `offsets_disponibles` (lo que ofrece el selector de offset; `offset_mm` es el de serie) y `a2c_mm` (altura eje-corona, para corregir la geometría).
- Amortiguadores: `montaje` (si no coincide con `suspension_trasera.montaje_amortiguador` de `bike.json`, el selector lo bloquea con "No calza en la Glory"), `resortes: { min_lb, max_lb, paso_lb }` (opciones de "Resorte instalado"), `precarga_vueltas: { min, max }`, `resorte_por_peso` (referencia cruzada) y `rebote_por_resorte`.
- Dial numerado: `"tipo_escala": "numerado"` con `min`, `max`, `positivo_es_firme` y `base_dial`. La app sigue mostrando clicks desde cerrado (`max − dial`) y agrega el dial entre paréntesis.
- `"tipo": "ABO"` con `min`, `max` y `base`: se muestra como posición (no es compresión ni rebote); "Saltos" lo sube según `saltos.si.abo` de `rules.json`.
- `alias`: ids antiguos del componente, para no perder selección ni bitácora al renombrarlo.
- `resorte_lb` es el resorte por defecto; el instalado se elige en "Mi bici".

### Datos pendientes (TODO)

`null` marca un dato pendiente y `verificado: false` uno sin confirmar; la app muestra un aviso discreto. Mientras falten:

- `base_desde_cerrado: null` → se usa la mitad del rango.
- `efecto_por_click: null` → lineal, `1 / clicks_totales`.
- `clicks_totales: null` → el ajustador se muestra como "falta dato".
- `presion_base` sin tabla → la app pide inflar hasta el sag objetivo.

Pendientes hoy: `efecto_por_click` de todos los ajustadores; bases reales de compresión y tokens instalados de la BoXXer C2; rebote (total y base) de la BoXXer D2; conteo real de clicks del DHX2 2024 (LSC) y 2027 (todos); resorte de referencia del rebote del Vivid; `precarga_mm_por_vuelta` de los tres amortiguadores.

## Flip chips: actual y recomendado

En "Mi bici" se marca cómo está montada la bici hoy (Maestro, headset y dropout). La pestaña Setup calcula la geometría con esa posición y la compara con la recomendada: "Sin cambios" o una línea con lo que cambia. "Apliqué la recomendación" actualiza la posición actual. La bitácora guarda ambas.

## Geometría combinada

La geometría mostrada combina, en orden: tabla de Giant según el Maestro, chip de dirección (reach ±5 mm), offset de la horquilla (trail y distancia entre ejes, respecto de 52 mm) y altura de la horquilla (A2C, respecto de `geometria.a2c_referencia_mm` = 601,9 mm de la Fox 40 de serie). El dropout es cualitativo. La tabla "Geometría resultante" muestra además la diferencia con la tabla de Giant en Mid.

## Resorte instalado y recomendado

El resorte instalado se elige en "Mi bici", en los pasos del amortiguador. La app muestra el recomendado por el modelo, el sag predicho con el instalado y la precarga, dentro de los límites del amortiguador, que más lo acerca al objetivo; si no alcanza, avisa a qué resorte cambiar. Todos los clicks se calculan con el resorte instalado.

## Modelo físico

1. Carga trasera = (peso con equipo + `peso_bici_kg`) × `sesgo_trasero` (0,65 por defecto).
2. Sag: se resuelve `k · (s + precarga) / LR(x) = carga` sobre la curva de leverage (spline monótona por los puntos de `bike.json`; el desplazamiento del shock es la integral de 1/LR).
3. Wheel rate = `k / LR(x)²` en el sag, al 50 % y al 80 %.
4. Resorte ideal: el `k` que da el sag objetivo, redondeado a 25 lb. Con sag medido se calibra el sesgo y se recalcula todo.
5. Rebote base: de la tabla del fabricante si el componente la trae; si no, escalado por frecuencia natural × masa suspendida (`modelo.rebote.exponente_masa`; con 0 escala solo por frecuencia).
6. Balance: la trasera debe tener 7-10 puntos más de sag (con los sag de referencia). La presión de la horquilla sale de la tabla y solo se corrige con un sag medido; después vienen los clicks.
7. Saltos: un impacto de referencia (`modelo.impacto_referencia`) predice el uso de recorrido; solo si pasa de 90 % sube el HSC trasero.

La pantalla Setup muestra todo en "Ver el cálculo".

Para usar una curva de leverage medida, reemplaza `suspension_trasera.cinematica.curva_leverage.puntos` en `bike.json` por tus puntos `[recorrido_rueda_mm, LR]`.

## Bitácora y calibración

Cada salida guarda fecha, pista, componentes montados, setup completo, nota y comentario. Los avisos ("hizo tope", "rebota mucho", "se hunde en curvas") mueven parámetros del modelo según `rules.json → calibracion`: `sesgo_trasero`, el impacto de referencia, y por componente el `efecto_por_click` y un sesgo de amortiguación. Si guardas salidas con el sag de la horquilla medido y la presión usada, `psi_por_punto_sag` se calibra con esas mediciones. La calibración se recalcula desde la bitácora, así que borrar un registro deshace su efecto. Exporta e importa en JSON desde la pestaña Bitácora.
