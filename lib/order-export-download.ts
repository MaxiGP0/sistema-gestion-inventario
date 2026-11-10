/**
 * Entrega de la exportación desde la UI.
 *
 * El servidor transmite el archivo con `Content-Disposition`; el cliente usa
 * ese nombre (o el fallback local) para guardarlo o para compartirlo con la
 * hoja nativa del sistema. Se mantiene fuera del componente para poder probar
 * el parseo de errores, el nombre de archivo y el fallback descarga/compartir.
 */

import {
  buildOrderExportFilename,
  ORDER_EXPORT_CSV_MIME,
  ORDER_EXPORT_XLSX_MIME,
  parseContentDispositionFilename,
  type OrderExportFormat,
} from './order-export';
import { LONG_REQUEST_TIMEOUT_MS } from './api-client';
import { createRequestTimeout, raceWithAbort } from './request-timeout';

export type OrderExportDelivery = 'shared' | 'downloaded' | 'cancelled';

export interface OrderExportDownloadOptions {
  /**
   * Intenta compartir el archivo con la Web Share API. Si el navegador no
   * soporta compartir archivos, se descarga normalmente como fallback.
   */
  share?: boolean;
  /** Título de la hoja nativa; por defecto se usa el nombre del archivo. */
  title?: string;
}

export interface OrderExportDownloadResult {
  filename: string;
  delivery: OrderExportDelivery;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const payload: unknown = await response.json();
    if (isRecord(payload) && typeof payload.error === 'string' && payload.error.trim()) {
      return payload.error;
    }
  } catch {
    // La respuesta de error no era JSON; se usa el mensaje genérico.
  }

  return `Error del servidor (${response.status})`;
}

/** MIME real del archivo exportado, necesario para la hoja de compartir. */
export function orderExportMimeType(format: OrderExportFormat): string {
  return format === 'xlsx' ? ORDER_EXPORT_XLSX_MIME : ORDER_EXPORT_CSV_MIME;
}

function canShareFiles(files: File[]): boolean {
  if (
    typeof navigator === 'undefined' ||
    typeof navigator.share !== 'function' ||
    typeof navigator.canShare !== 'function'
  ) {
    return false;
  }

  try {
    return navigator.canShare({ files });
  } catch {
    return false;
  }
}

/**
 * ¿Este navegador puede compartir archivos del formato indicado?
 *
 * Se usa un `File` vacío para consultar `navigator.canShare`, que exige el
 * arreglo real de archivos. En SSR siempre devuelve `false`.
 */
export function canShareOrderExportFiles(format: OrderExportFormat = 'csv'): boolean {
  if (typeof File === 'undefined') return false;

  try {
    return canShareFiles([
      new File([], buildOrderExportFilename(format), { type: orderExportMimeType(format) }),
    ]);
  } catch {
    return false;
  }
}

/**
 * Intenta compartir el blob. Devuelve `unsupported` para que el llamador
 * descargue el archivo (navegador sin soporte o error de la hoja nativa).
 */
async function shareOrderExportFile(
  blob: Blob,
  filename: string,
  format: OrderExportFormat,
  title: string,
): Promise<'shared' | 'cancelled' | 'unsupported'> {
  if (typeof File === 'undefined') return 'unsupported';

  const mime = orderExportMimeType(format);
  const file = new File([blob], filename, { type: mime });

  if (!canShareFiles([file])) return 'unsupported';

  try {
    await navigator.share({ files: [file], title });
    return 'shared';
  } catch (error) {
    // Cerrar la hoja nativa no debe disparar una descarga inesperada.
    if (error instanceof Error && error.name === 'AbortError') return 'cancelled';

    return 'unsupported';
  }
}

/** Dispara la descarga del navegador liberando el blob en el siguiente tick. */
function downloadBlob(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = objectUrl;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();

  // Dar tiempo al navegador a iniciar la descarga antes de liberar el blob.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}

/**
 * Pide la exportación y la entrega al usuario.
 *
 * Con `options.share` en un navegador compatible abre la hoja nativa; si no
 * hay soporte (o la hoja falla) descarga el archivo. Si el usuario cierra la
 * hoja nativa no se fuerza una descarga. Lanza un Error con el mensaje de la
 * API si la exportación falla.
 */
export async function downloadOrderExport(
  url: string,
  format: OrderExportFormat,
  options: OrderExportDownloadOptions = {},
): Promise<OrderExportDownloadResult> {
  const timeout = createRequestTimeout(LONG_REQUEST_TIMEOUT_MS);
  const timeoutMessage =
    'La conexión tardó demasiado al exportar. Revisá tu señal e intentá de nuevo.';

  try {
    let response: Response;

    try {
      response = await raceWithAbort(
        fetch(url, {
          credentials: 'same-origin',
          signal: timeout.signal,
        }),
        timeout.signal,
      );
    } catch {
      throw new Error(timeout.timedOut() ? timeoutMessage : 'No se pudo conectar con el servidor');
    }

    if (!response.ok) {
      throw new Error(await errorMessage(response));
    }

    const filename =
      parseContentDispositionFilename(response.headers.get('content-disposition')) ??
      buildOrderExportFilename(format);

    let blob: Blob;
    try {
      blob = await response.blob();
    } catch {
      throw new Error(
        timeout.timedOut() ? timeoutMessage : 'No se pudo descargar el archivo exportado',
      );
    }

    // La descarga ya está en memoria: no se debe cortar la hoja nativa por el
    // timeout de red.
    timeout.cleanup();

    if (options.share) {
      const shared = await shareOrderExportFile(blob, filename, format, options.title ?? filename);

      if (shared === 'shared') return { filename, delivery: 'shared' };
      if (shared === 'cancelled') return { filename, delivery: 'cancelled' };
    }

    downloadBlob(blob, filename);
    return { filename, delivery: 'downloaded' };
  } finally {
    timeout.cleanup();
  }
}
