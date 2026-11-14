# Glory Setup

PWA instalable y offline que recomienda el setup de **una sola bici**: Giant Glory Advanced, talla M/L, mullet (29" / 27,5"). Sin framework, sin backend, sin paso de build.

## Usarla

```bash
npm start        # sirve la app en http://localhost:8080
npm test         # tests unitarios del motor (node --test, sin dependencias)
```

Para el celular: publica la carpeta tal cual en cualquier hosting estático con HTTPS (por ejemplo GitHub Pages), ábrela una vez con señal y usa "Agregar a pantalla de inicio". Desde ahí funciona sin conexión.

Al publicar cambios de código, sube `VERSION` en `sw.js` para renovar la caché. Los `.json` de `data/` se piden primero a la red, así que editarlos se nota al recargar con señal.

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
- `referencia_base`: peso y resorte para los que vale `base_desde_cerrado`. El rebote base se escala desde ahí.
- Horquillas: además `recorrido_mm`, `offset_mm` (o `null` + `offset_opciones_mm` para elegirlo en la app), `presion_base` (`tabla_peso_psi: [[kg, psi], ...]` o `psi_por_kg`) y `spacers`.
- Si cambias el resorte, edita `resorte_lb`.

### Datos pendientes (TODO)

`null` marca un dato pendiente y `verificado: false` uno sin confirmar; la app muestra un aviso discreto. Mientras falten:

- `base_desde_cerrado: null` → se usa la mitad del rango.
- `efecto_por_click: null` → lineal, `1 / clicks_totales`.
- `clicks_totales: null` → el ajustador se muestra como "falta dato".
- `presion_base` sin tabla → la app pide inflar hasta el sag objetivo.

Hoy son provisorios: los `clicks_totales` de la Fox 40 2027 y del DHX2 (16 en baja velocidad y 8 en alta) y la tabla de presión de la BoXXer. Hay que reemplazarlos con los manuales.

## Modelo físico

1. Carga trasera = (peso con equipo + `peso_bici_kg`) × `sesgo_trasero` (0,65 por defecto).
2. Sag: se resuelve `k · (s + precarga) / LR(x) = carga` sobre la curva de leverage (spline monótona por los puntos de `bike.json`; el desplazamiento del shock es la integral de 1/LR).
3. Wheel rate = `k / LR(x)²` en el sag, al 50 % y al 80 %.
4. Resorte ideal: el `k` que da el sag objetivo, redondeado a 25 lb. Con sag medido se calibra el sesgo y se recalcula todo.
5. Rebote base escalado por frecuencia natural × masa suspendida (`modelo.rebote.exponente_masa`; con 0 escala solo por frecuencia).
6. Balance: la trasera debe tener 7-10 puntos más de sag; se corrige primero con presión y resorte, después con clicks.
7. Saltos: un impacto de referencia (`modelo.impacto_referencia`) predice el uso de recorrido; solo si pasa de 90 % sube el HSC trasero.

La pantalla Setup muestra todo en "Ver el cálculo".

Para usar una curva de leverage medida, reemplaza `suspension_trasera.cinematica.curva_leverage.puntos` en `bike.json` por tus puntos `[recorrido_rueda_mm, LR]`.

## Bitácora y calibración

Cada salida guarda fecha, pista, componentes montados, setup completo, nota y comentario. Los avisos ("hizo tope", "rebota mucho", "se hunde en curvas") mueven parámetros del modelo según `rules.json → calibracion`: `sesgo_trasero`, el impacto de referencia, y por componente el `efecto_por_click` y un sesgo de amortiguación. La calibración se recalcula desde la bitácora, así que borrar un registro deshace su efecto. Exporta e importa en JSON desde la pestaña Bitácora.
