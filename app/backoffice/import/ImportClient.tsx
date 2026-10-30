'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { UploadCloud, FileSpreadsheet } from 'lucide-react';
import Button from '@/components/ui/Button';
import Card from '@/components/ui/Card';
import Radio from '@/components/ui/Radio';
import { useToast } from '@/context/ToastContext';
import { api } from '@/lib/api-client';
import { invalidateCatalogCache } from '@/lib/catalog-query-cache';
import type {
  CatalogImportPreviewResponse,
  CatalogImportResponse,
  CatalogImportUpdateMode,
} from '@/lib/types';

const ImportPreview = dynamic(() => import('./ImportPreview'), {
  ssr: false,
  loading: () => (
    <div className="mt-8 h-48 animate-pulse rounded-lg border border-border bg-surface motion-reduce:animate-none" />
  ),
});

const ImportHelp = dynamic(() => import('./ImportHelp'), {
  ssr: false,
  loading: () => (
    <div className="mt-8 h-28 animate-pulse rounded-lg border border-border bg-surface-muted motion-reduce:animate-none" />
  ),
});

const UPDATE_MODES: Array<{
  value: CatalogImportUpdateMode;
  label: string;
  help: string;
}> = [
  {
    value: 'both',
    label: 'Nombre y precio',
    help: 'Actualiza nombre y precio de los productos existentes. También crea productos nuevos.',
  },
  {
    value: 'name',
    label: 'Solo nombre',
    help: 'Actualiza solo el nombre de productos existentes. El precio se ignora. No crea productos nuevos.',
  },
  {
    value: 'price',
    label: 'Solo precio',
    help: 'Actualiza solo el precio de productos existentes. El nombre se ignora. No crea productos nuevos.',
  },
];

export default function ImportClient() {
  const [file, setFile] = useState<File | null>(null);
  const [type, setType] = useState<'products' | 'clients'>('products');
  const [updateMode, setUpdateMode] = useState<CatalogImportUpdateMode>('both');
  const [preview, setPreview] = useState<CatalogImportPreviewResponse | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { showToast } = useToast();
  const router = useRouter();

  const loading = previewing || importing;
  const selectedMode = UPDATE_MODES.find((mode) => mode.value === updateMode) ?? UPDATE_MODES[0];

  const resetSelection = () => {
    setFile(null);
    setPreview(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handlePreview = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;

    setPreviewing(true);
    setPreview(null);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('type', type);
    formData.append('dryRun', 'true');
    if (type === 'products') formData.append('updateMode', updateMode);

    try {
      const data = await api.post<CatalogImportPreviewResponse>('/api/catalog/import', formData);
      setPreview(data);
    } catch (err: unknown) {
      const error = err as Error;
      showToast(error.message, 'error');
    } finally {
      setPreviewing(false);
    }
  };

  const handleConfirm = async () => {
    if (!file || !preview) return;

    setImporting(true);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('type', type);
    formData.append('dryRun', 'false');
    if (type === 'products') formData.append('updateMode', updateMode);

    try {
      const data = await api.post<CatalogImportResponse>('/api/catalog/import', formData);
      showToast(data.message || 'Importación completada exitosamente', 'success');
      invalidateCatalogCache('products', 'brands', 'clients');
      resetSelection();
      router.refresh();
    } catch (err: unknown) {
      const error = err as Error;
      showToast(error.message, 'error');
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-4xl">
      <Card padding="lg">
        <div className="mb-6 flex items-center gap-3">
          <div className="rounded-md bg-action-soft p-3 text-action-text">
            <FileSpreadsheet className="h-8 w-8" aria-hidden="true" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-foreground">Importación masiva</h2>
            <p className="text-xs text-muted">
              Actualice el catálogo de productos o la cartera de clientes de forma masiva.
            </p>
          </div>
        </div>

        <form onSubmit={handlePreview} className="space-y-6 mt-6">
          <div>
            <label className="mb-2 block text-xs font-semibold text-foreground">
              Tipo de Datos a Importar
            </label>
            <div className="grid grid-cols-2 gap-4">
              <Button
                type="button"
                variant={type === 'products' ? 'primary' : 'secondary'}
                fullWidth
                disabled={loading}
                onClick={() => {
                  setType('products');
                  setPreview(null);
                }}
                className="py-3 text-sm"
              >
                Catálogo de Productos
              </Button>
              <Button
                type="button"
                variant={type === 'clients' ? 'primary' : 'secondary'}
                fullWidth
                disabled={loading}
                onClick={() => {
                  setType('clients');
                  setPreview(null);
                }}
                className="py-3 text-sm"
              >
                Cartera de Clientes
              </Button>
            </div>
          </div>

          {type === 'products' && (
            <fieldset className="space-y-2" disabled={loading}>
              <legend className="mb-2 block text-xs font-semibold text-foreground">
                Campos a actualizar
              </legend>
              <div className="grid gap-4 rounded-lg border border-border bg-surface-muted p-4 sm:grid-cols-3">
                {UPDATE_MODES.map((mode) => (
                  <Radio
                    key={mode.value}
                    name="update-mode"
                    value={mode.value}
                    label={mode.label}
                    checked={updateMode === mode.value}
                    disabled={loading}
                    onChange={() => {
                      setUpdateMode(mode.value);
                      setPreview(null);
                    }}
                  />
                ))}
              </div>
              <p data-testid="catalog-import-mode-help" className="text-xs text-muted">
                {selectedMode.help}
              </p>
            </fieldset>
          )}

          <div>
            <label className="mb-2 block text-xs font-semibold text-foreground">
              Seleccionar Archivo Excel
            </label>
            <div className="rounded-lg border-2 border-dashed border-border-strong bg-surface-muted p-8 text-center transition-colors hover:border-action/50">
              <UploadCloud className="mx-auto mb-3 h-12 w-12 text-action-text" aria-hidden="true" />
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx, .csv"
                onChange={(e) => {
                  setFile(e.target.files?.[0] || null);
                  setPreview(null);
                }}
                className="hidden"
                id="excel-file-input"
              />
              <label
                htmlFor="excel-file-input"
                className="inline-flex min-h-11 cursor-pointer items-center justify-center rounded-md border border-border-strong bg-surface px-4 py-2 text-xs font-semibold text-action-text transition-colors hover:bg-action-soft"
              >
                {file ? file.name : 'Examinar Archivo'}
              </label>
              <p className="mt-2 text-xs text-muted">
                {file
                  ? `Archivo seleccionado: ${file.size ? (file.size / 1024).toFixed(1) + ' KB' : ''}`
                  : 'Soporta formato Excel (.xlsx) o CSV (.csv)'}
              </p>
            </div>
          </div>

          <Button
            type="submit"
            variant="primary"
            size="lg"
            fullWidth
            disabled={!file || loading}
            className="py-3"
          >
            {previewing
              ? 'Validando archivo...'
              : preview
                ? 'Volver a previsualizar'
                : 'Previsualizar y validar archivo'}
          </Button>
        </form>

        {preview && (
          <ImportPreview
            preview={preview}
            importing={importing}
            onConfirm={handleConfirm}
            onDiscard={() => setPreview(null)}
          />
        )}

        <ImportHelp />
      </Card>
    </div>
  );
}
