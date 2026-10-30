/**
 * Utilidades del alta rápida de clientes desde el flujo de pedidos.
 *
 * El vendedor puede no conocer el código interno del cliente. Estas funciones
 * deciden si el texto buscado parece un código (para precargarlo en ese campo)
 * y generan una sugerencia única con el prefijo `CLI-`.
 */

/** ¿El texto buscado parece un código y no el nombre del cliente? */
export function looksLikeClientCode(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed) && /\d/.test(trimmed);
}

/**
 * Código sugerido para un cliente nuevo. Combina la marca de tiempo con un
 * sufijo aleatorio para que dos altas seguidas no colisionen (el POST hace
 * upsert por código).
 */
export function buildClientCodeSuggestion(seed = Date.now(), random = Math.random()): string {
  const timestamp = Math.abs(Math.trunc(seed))
    .toString(36)
    .toUpperCase()
    .slice(-6)
    .padStart(6, '0');
  const suffix = Math.floor(Math.abs(random) * 36 ** 2)
    .toString(36)
    .toUpperCase()
    .padStart(2, '0');

  return `CLI-${timestamp}${suffix}`;
}
