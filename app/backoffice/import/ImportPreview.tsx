'use client';

import { AlertTriangle, CheckCircle2, Download, Eye } from 'lucide-react';
import Button from '@/components/ui/Button';
import {
  buildCatalogImportSummaryCsv,
  buildCatalogImportSummaryFilename,
  CATALOG_IMPORT_SUMMARY_MIME,
} from '@/lib/catalog-import-report';
import type {
  CatalogImportPreviewResponse,
  CatalogImportRowError,
  CatalogImportUpdateMode,
} from '@/lib/types';

const FIELD_LABELS: Record<string, string> = {
  codigo: 'Código',
  nombre: 'Nombre',
  precio_sin_iva: 'Precio s/IVA',
  precio_con_iva: 'Precio c/IVA',
  descuento_general: 'Descuento general',
};

const TYPE_LABELS = {
  products: 'Productos',
  clients: 'Clientes',
} as const;

const UPDATE_MODE_LABELS: Record<CatalogImportUpdateMode, string> = {
  both: 'Nombre y precio',
  name: 'Solo nombre',
  price: 'Solo precio',
};

const ERROR_KIND_LABELS: Record<CatalogImportRowError['kind'], string> = {
  validation: 'Validación',
  duplicate: 'Duplicado',
  not_found: 'No encontrado',
};

const ERROR_KIND_CLASSES: Record<CatalogImportRowError['kind'], string> = {
  validation: 'bg-status-blocked-soft text-status-blocked',
  duplicate: 'bg-status-draft-soft text-status-draft',
  not_found: 'bg-status-control-soft text-status-control',
};

interface ImportPreviewProps {
  preview: CatalogImportPreviewResponse;
  importing: boolean;
  onConfirm: () => void;
  onDiscard: () => void;
}

/**
 * Resultado del dry-run de importación. Se carga sólo cuando el usuario ya
 * validó un archivo, para no sumar la tabla de errores al bundle inicial.
 */
export default function ImportPreview({
  preview,
  importing,
  onConfirm,
  onDiscard,
}: ImportPreviewProps) {
  const handleDownloadSummary = () => {
    const blob = new Blob([buildCatalogImportSummaryCsv(preview)], {
      type: CATALOG_IMPORT_SUMMARY_MIME,
    });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');

    link.href = objectUrl;
    link.download = buildCatalogImportSummaryFilename(preview.type);
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();

    setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  };

  return (
    <div
      data-testid="catalog-import-preview"
      className="mt-8 rounded-lg border border-border bg-surface p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="rounded-md bg-action-soft p-2 text-action-text">
            <Eye className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <h3 className="text-base font-semibold">Vista previa de {TYPE_LABELS[preview.type]}</h3>
            <p className="text-xs text-muted">
              Todavía no se escribió nada. Revisá el resumen y confirmá la importación.
            </p>
          </div>
        </div>
        <Button type="button" variant="secondary" size="sm" onClick={handleDownloadSummary}>
          <Download className="h-4 w-4" aria-hidden="true" /> Descargar resumen
        </Button>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-lg border border-border bg-surface-muted p-3">
          <p className="text-[11px] uppercase text-muted">Total</p>
          <p data-testid="catalog-import-total" className="text-lg font-semibold">
            {preview.total}
          </p>
        </div>
        <div className="rounded-lg border border-status-delivered-border bg-status-delivered-soft p-3">
          <p className="text-[11px] uppercase text-status-delivered">Válidas</p>
          <p
            data-testid="catalog-import-valid"
            className="text-lg font-semibold text-status-delivered"
          >
            {preview.valid}
          </p>
        </div>
        <div className="rounded-lg border border-status-draft-border bg-status-draft-soft p-3">
          <p className="text-[11px] uppercase text-status-draft">Omitidas</p>
          <p
            data-testid="catalog-import-skipped"
            className="text-lg font-semibold text-status-draft"
          >
            {preview.skipped}
          </p>
        </div>
        <div className="rounded-lg border border-status-blocked-border bg-status-blocked-soft p-3">
          <p className="text-[11px] uppercase text-status-blocked">Duplicadas</p>
          <p
            data-testid="catalog-import-duplicates"
            className="text-lg font-semibold text-status-blocked"
          >
            {preview.duplicates}
          </p>
        </div>
      </div>

      {preview.updateMode && (
        <div className="mt-4 rounded-lg border border-border bg-surface-muted p-3">
          <p className="text-xs text-muted">
            Modo de actualización:{' '}
            <span
              data-testid="catalog-import-update-mode"
              className="font-semibold text-foreground"
            >
              {UPDATE_MODE_LABELS[preview.updateMode]}
            </span>
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <p
              data-testid="catalog-import-update-count"
              className="rounded-md bg-surface px-3 py-2 text-xs font-semibold text-status-delivered"
            >
              Se actualizarán {preview.updateCount ?? 0} producto(s) existente(s)
            </p>
            <p
              data-testid="catalog-import-create-count"
              className="rounded-md bg-surface px-3 py-2 text-xs font-semibold text-action-text"
            >
              {preview.updateMode === 'both'
                ? `Se crearán ${preview.createCount ?? 0} producto(s) nuevo(s)`
                : 'No se crearán productos nuevos'}
            </p>
          </div>
        </div>
      )}

      {preview.newBrands.length > 0 && (
        <p className="mt-4 text-xs text-muted">
          <span className="font-semibold">Marcas nuevas:</span> {preview.newBrands.join(', ')}
        </p>
      )}

      {preview.errors.length > 0 ? (
        <div className="mt-5">
          <p className="flex items-center gap-2 text-xs font-semibold text-status-blocked">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            {preview.errorCount} error(es) detectado(s). Se muestran hasta 50.
          </p>
          <div className="mt-2 max-h-72 overflow-auto rounded-lg border border-border">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-surface-muted text-muted">
                <tr>
                  <th className="px-3 py-2 font-semibold">Fila</th>
                  <th className="px-3 py-2 font-semibold">Campo</th>
                  <th className="px-3 py-2 font-semibold">Tipo</th>
                  <th className="px-3 py-2 font-semibold">Motivo</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border bg-surface">
                {preview.errors.map((error, index) => (
                  <tr key={`${error.row}-${index}`}>
                    <td className="px-3 py-2 font-semibold">{error.row}</td>
                    <td className="px-3 py-2">
                      {error.field ? (FIELD_LABELS[error.field] ?? error.field) : '—'}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded-full px-2 py-0.5 ${ERROR_KIND_CLASSES[error.kind]}`}
                      >
                        {ERROR_KIND_LABELS[error.kind]}
                      </span>
                    </td>
                    <td className="px-3 py-2">{error.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.errorsTruncated && (
            <p className="mt-2 text-[11px] text-muted">
              El resumen descargable también incluye solo los primeros {preview.errors.length}{' '}
              errores de {preview.errorCount}.
            </p>
          )}
        </div>
      ) : (
        <p className="mt-5 flex items-center gap-2 text-xs font-semibold text-status-delivered">
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> No se detectaron errores en el
          archivo.
        </p>
      )}

      <div className="mt-6 flex flex-wrap gap-3">
        <Button
          type="button"
          variant="primary"
          size="lg"
          onClick={onConfirm}
          disabled={importing || preview.valid === 0}
        >
          {importing
            ? 'Importando...'
            : `Confirmar importación (${preview.valid} registro${preview.valid === 1 ? '' : 's'})`}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="lg"
          onClick={onDiscard}
          disabled={importing}
        >
          Descartar vista previa
        </Button>
      </div>
      {preview.valid === 0 && (
        <p className="mt-3 text-xs text-status-draft">
          No hay filas válidas para importar. Corregí el archivo y volvé a previsualizarlo.
        </p>
      )}
    </div>
  );
}
