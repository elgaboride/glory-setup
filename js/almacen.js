// localStorage con try/catch: si falla (modo privado, cuota), la app sigue
// funcionando con una copia en memoria.
const PREFIJO = 'glory-setup:';
const memoria = new Map();

export function leer(clave, porDefecto) {
  try {
    const crudo = localStorage.getItem(PREFIJO + clave);
    if (crudo != null) return JSON.parse(crudo);
  } catch { /* sigue con la memoria */ }
  return memoria.has(clave) ? memoria.get(clave) : porDefecto;
}

export function guardar(clave, valor) {
  memoria.set(clave, valor);
  try {
    localStorage.setItem(PREFIJO + clave, JSON.stringify(valor));
    return true;
  } catch {
    return false;
  }
}
