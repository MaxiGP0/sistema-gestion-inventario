/**
 * Identificador idempotente que genera el cliente para cada alta de pedido.
 *
 * El mismo valor viaja en el body del POST y se guarda junto al body en la
 * cola offline. Si la respuesta se pierde, el reintento reutiliza la clave y el
 * servidor devuelve el pedido ya creado en lugar de duplicarlo.
 *
 * Se usa `crypto.randomUUID()` cuando está disponible (contextos seguros y
 * Node 20+). El fallback mantiene el formato UUID v4 para que el contrato no
 * dependa de la plataforma.
 */

/** Mismo límite que valida `createOrderSchema` y el índice de Mongo. */
export const MAX_CLIENT_REQUEST_ID_LENGTH = 120;

function randomHex(bytes: number): string | null {
  const cryptoObject = globalThis.crypto;
  if (!cryptoObject || typeof cryptoObject.getRandomValues !== 'function') return null;

  const values = new Uint8Array(bytes);
  cryptoObject.getRandomValues(values);
  return Array.from(values, (value) => value.toString(16).padStart(2, '0')).join('');
}

/** UUID v4 estable para una operación de alta. */
export function createClientRequestId(): string {
  const cryptoObject = globalThis.crypto;

  if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
    return cryptoObject.randomUUID();
  }

  const hex = randomHex(16);
  if (hex) {
    // Marca de versión (4) y variante RFC 4122 (10xx).
    const versioned = `${hex.slice(0, 12)}4${hex.slice(13, 16)}`;
    const variantNibble = (parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8;
    const variant = `${variantNibble.toString(16)}${hex.slice(17)}`;

    return [
      versioned.slice(0, 8),
      versioned.slice(8, 12),
      versioned.slice(12, 16),
      variant.slice(0, 4),
      variant.slice(4, 16),
    ].join('-');
  }

  // Último recurso (navegadores muy viejos sin Web Crypto): no es un UUID
  // criptográfico, pero sigue siendo una clave única y acotada.
  return `order-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
