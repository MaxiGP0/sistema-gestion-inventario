/**
 * Resumen descargable de la vista previa de importación.
 *
 * Se genera en el cliente a partir de la respuesta `CatalogImportPreviewResponse`
 * para no volver a subir el archivo. No importa ExcelJS ni Mongoose.
 */

import type {
  CatalogImportPreviewResponse,
  CatalogImportType,
  CatalogImportUpdateMode,
} from './types';

const CSV_BOM = '\uFEFF';
const CSV_DELIMITER = ';';
const CSV_MIME = 'text/csv; charset=utf-8';

type SummaryCell = string | number;

function escapeCell(value: SummaryCell | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /["\r\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvRow(values: readonly SummaryCell[]): string {
  return values.map(escapeCell).join(CSV_DELIMITER);
}

const TYPE_LABELS: Record<CatalogImportType, string> = {
  products: 'Productos',
  clients: 'Clientes',
};

const FIELD_LABELS: Record<string, string> = {
  codigo: 'Código',
  nombre: 'Nombre',
  precio_sin_iva: 'Precio s/IVA',
  precio_con_iva: 'Precio c/IVA',
  descuento_general: 'Descuento general',
};

const UPDATE_MODE_LABELS: Record<CatalogImportUpdateMode, string> = {
  both: 'Nombre y precio',
  name: 'Solo nombre',
  price: 'Solo precio',
};

const ERROR_KIND_LABELS = {
  validation: 'Validación',
  duplicate: 'Duplicado',
  not_found: 'No encontrado',
} as const;

/** CSV de resumen + errores, con BOM para que Excel respete los acentos. */
export function buildCatalogImportSummaryCsv(preview: CatalogImportPreviewResponse): string {
  const lines: string[] = [
    csvRow(['Resumen de validación de importación']),
    csvRow(['Tipo', TYPE_LABELS[preview.type]]),
  ];

  if (preview.updateMode) {
    lines.push(
      csvRow(['Modo de actualización', UPDATE_MODE_LABELS[preview.updateMode]]),
      csvRow(['Productos existentes a actualizar', preview.updateCount ?? 0]),
      csvRow(['Productos nuevos a crear', preview.createCount ?? 0]),
    );
  }

  lines.push(
    csvRow(['Total de filas', preview.total]),
    csvRow(['Válidas', preview.valid]),
    csvRow(['Omitidas', preview.skipped]),
    csvRow(['Duplicadas en el archivo', preview.duplicates]),
    csvRow(['Errores detectados', preview.errorCount]),
    csvRow(['Errores incluidos en este archivo', preview.errors.length]),
  );

  if (preview.newBrands.length > 0) {
    lines.push(csvRow(['Marcas nuevas', preview.newBrands.join(', ')]));
  }

  lines.push('', csvRow(['Fila', 'Campo', 'Tipo', 'Motivo']));

  for (const error of preview.errors) {
    lines.push(
      csvRow([
        error.row,
        error.field ? (FIELD_LABELS[error.field] ?? error.field) : '',
        ERROR_KIND_LABELS[error.kind],
        error.reason,
      ]),
    );
  }

  if (preview.errorsTruncated) {
    lines.push(
      '',
      csvRow([
        `Se muestran los primeros ${preview.errors.length} de ${preview.errorCount} errores.`,
      ]),
    );
  }

  return CSV_BOM + lines.join('\r\n');
}

export function buildCatalogImportSummaryFilename(
  type: CatalogImportType,
  date: Date = new Date(),
): string {
  const day = Number.isNaN(date.getTime())
    ? new Date().toISOString().slice(0, 10)
    : date.toISOString().slice(0, 10);
  return `resumen-importacion-${type}-${day}.csv`;
}

export { CSV_MIME as CATALOG_IMPORT_SUMMARY_MIME };
