// Spline cúbica monótona (PCHIP, Fritsch–Carlson). No se pasa de los puntos ni
// inventa ondulaciones: si los datos son monótonos, la curva también lo es.

function pendienteExtremo(h0, h1, d0, d1) {
  let m = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
  if (Math.sign(m) !== Math.sign(d0)) m = 0;
  else if (Math.sign(d0) !== Math.sign(d1) && Math.abs(m) > 3 * Math.abs(d0)) m = 3 * d0;
  return m;
}

export function crearSplineMonotona(puntos) {
  const pts = [...puntos].sort((a, b) => a[0] - b[0]);
  const n = pts.length;
  if (n < 2) throw new Error('La curva necesita al menos 2 puntos');
  const x = pts.map((p) => p[0]);
  const y = pts.map((p) => p[1]);
  const h = [];
  const d = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(x[i + 1] - x[i]);
    if (h[i] <= 0) throw new Error('Los puntos de la curva deben tener x creciente');
    d.push((y[i + 1] - y[i]) / h[i]);
  }
  const m = new Array(n).fill(0);
  if (n === 2) {
    m[0] = m[1] = d[0];
  } else {
    for (let i = 1; i < n - 1; i++) {
      if (d[i - 1] * d[i] <= 0) m[i] = 0;
      else {
        const w1 = 2 * h[i] + h[i - 1];
        const w2 = h[i] + 2 * h[i - 1];
        m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
      }
    }
    m[0] = pendienteExtremo(h[0], h[1], d[0], d[1]);
    m[n - 1] = pendienteExtremo(h[n - 2], h[n - 3], d[n - 2], d[n - 3]);
  }
  return function f(xq) {
    if (xq <= x[0]) return y[0];
    if (xq >= x[n - 1]) return y[n - 1];
    let i = 0;
    while (xq > x[i + 1]) i++;
    const t = (xq - x[i]) / h[i];
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * y[i] +
      (t3 - 2 * t2 + t) * h[i] * m[i] +
      (-2 * t3 + 3 * t2) * y[i + 1] +
      (t3 - t2) * h[i] * m[i + 1]
    );
  };
}
