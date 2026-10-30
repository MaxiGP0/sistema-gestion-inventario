import type { ApiMessageResponse } from './common';

export type CatalogImportType = 'products' | 'clients';

/** Campos que se actualizan en un producto existente durante el import. */
export type CatalogImportUpdateMode = 'name' | 'price' | 'both';

/** Error de una fila del archivo devuelto por la vista previa. */
export interface CatalogImportRowError {
  /** Número de fila del archivo (el encabezado es la fila 1). */
  row: number;
  /** Campo que falló, si aplica (`codigo`, `precio_sin_iva`, ...). */
  field?: string;
  reason: string;
  /**
   * `duplicate` cuando la fila repite una clave ya presente en el archivo;
   * `not_found` cuando el producto no existe y el modo solo actualiza.
   */
  kind: 'validation' | 'duplicate' | 'not_found';
}

/** `POST /api/catalog/import` (importación real). */
export interface CatalogImportResponse extends ApiMessageResponse {
  count: number;
  skipped: number;
  /** Modo elegido (solo productos). */
  updateMode?: CatalogImportUpdateMode;
  /** Productos nuevos creados (solo productos). */
  created?: number;
  /** Productos existentes actualizados (solo productos). */
  updated?: number;
}

/**
 * `POST /api/catalog/import?dryRun=1` (o con el campo de formulario `dryRun`).
 * No escribe nada: solo informa qué se importaría y qué filas se omitirían.
 */
export interface CatalogImportPreviewResponse extends ApiMessageResponse {
  dryRun: true;
  type: CatalogImportType;
  /** Filas de datos leídas del archivo (sin contar el encabezado). */
  total: number;
  /** Filas únicas y válidas que se importarían. */
  valid: number;
  /** Filas omitidas por errores de validación o duplicados. */
  skipped: number;
  /** Filas descartadas por repetir una clave dentro del archivo. */
  duplicates: number;
  /** Cantidad total de errores detectados (puede superar a `errors.length`). */
  errorCount: number;
  /** Hasta 50 errores, ordenados por número de fila. */
  errors: CatalogImportRowError[];
  errorsTruncated: boolean;
  /** Marcas que se crearían al confirmar (solo productos). */
  newBrands: string[];
  /** Modo de actualización elegido (solo productos). */
  updateMode?: CatalogImportUpdateMode;
  /** Productos existentes que se actualizarían (solo productos). */
  updateCount?: number;
  /** Productos nuevos que se crearían; 0 en modos de un solo campo. */
  createCount?: number;
}
