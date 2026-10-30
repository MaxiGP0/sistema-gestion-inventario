/** Escapa caracteres especiales de regex para búsquedas literales (ej: en MongoDB). */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
