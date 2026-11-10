'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Database, Loader2, RefreshCw } from 'lucide-react';
import Button from '@/components/ui/Button';
import Card from '@/components/ui/Card';
import { useToast } from '@/context/ToastContext';
import { useUser } from '@/context/UserContext';
import {
  OFFLINE_CATALOG_CHANGED_EVENT,
  readOfflineCatalogClients,
  readOfflineCatalogMetaRaw,
  readOfflineCatalogProducts,
  type OfflineCatalogMetaRecord,
} from '@/lib/offline-catalog';
import { syncOfflineCatalog, type OfflineCatalogSyncProgress } from '@/lib/offline-catalog-sync';

type OfflineCatalogStatus = 'Completo' | 'Parcial' | 'Vencido';

interface OfflineCatalogSummary {
  productCount: number;
  clientCount: number;
  lastSyncAt: number | null;
  status: OfflineCatalogStatus;
}

const EMPTY_SUMMARY: OfflineCatalogSummary = {
  productCount: 0,
  clientCount: 0,
  lastSyncAt: null,
  status: 'Parcial',
};

const STATUS_STYLES: Record<OfflineCatalogStatus, string> = {
  Completo: 'bg-status-delivered-soft text-status-delivered',
  Parcial: 'bg-status-draft-soft text-status-draft',
  Vencido: 'bg-status-blocked-soft text-status-blocked',
};

function statusFromSummary(input: {
  productCount: number;
  clientCount: number;
  expired: number;
  products?: OfflineCatalogMetaRecord;
  clients?: OfflineCatalogMetaRecord;
}): OfflineCatalogStatus {
  const hasData = input.productCount > 0 || input.clientCount > 0;
  if (!hasData && input.expired > 0) return 'Vencido';

  const complete =
    Boolean(input.products?.fullSyncAt && input.products.serverTime) &&
    Boolean(input.clients?.fullSyncAt && input.clients.serverTime) &&
    input.expired === 0;
  if (complete) return 'Completo';

  return 'Parcial';
}

function formatDateTime(value: number | null): string {
  if (!value || !Number.isFinite(value)) return 'Nunca';
  return new Intl.DateTimeFormat('es-AR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}

function percentageOf(progress: OfflineCatalogSyncProgress | null): number | null {
  if (!progress || progress.total <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((progress.loaded / progress.total) * 100)));
}

/**
 * Estado del snapshot local y actualización manual. El full sync inicial corre
 * en segundo plano en las pantallas operativas; esta tarjeta permite forzarlo
 * también con ahorro de datos o cuando el vendedor sospecha que está viejo.
 */
export default function OfflineCatalogCard() {
  const { user } = useUser();
  const { showToast } = useToast();
  const userId = user?.id ?? '';
  const [summary, setSummary] = useState<OfflineCatalogSummary>(EMPTY_SUMMARY);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [progress, setProgress] = useState<OfflineCatalogSyncProgress | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const refreshSummary = useCallback(async () => {
    if (!userId) {
      setSummary(EMPTY_SUMMARY);
      setLoading(false);
      return;
    }

    try {
      const [products, clients, meta] = await Promise.all([
        readOfflineCatalogProducts(userId),
        readOfflineCatalogClients(userId),
        readOfflineCatalogMetaRaw(userId),
      ]);

      const timestamps = [
        products.savedAt,
        clients.savedAt,
        meta.products?.savedAt ?? null,
        meta.clients?.savedAt ?? null,
      ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

      setSummary({
        productCount: products.items.length,
        clientCount: clients.items.length,
        lastSyncAt: timestamps.length > 0 ? Math.max(...timestamps) : null,
        status: statusFromSummary({
          productCount: products.items.length,
          clientCount: clients.items.length,
          expired: products.expired + clients.expired,
          products: meta.products,
          clients: meta.clients,
        }),
      });
    } catch (error) {
      console.warn('No se pudo leer el catálogo offline:', error);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void refreshSummary();
  }, [refreshSummary]);

  useEffect(() => {
    const handleChanged = () => void refreshSummary();
    window.addEventListener(OFFLINE_CATALOG_CHANGED_EVENT, handleChanged);
    return () => window.removeEventListener(OFFLINE_CATALOG_CHANGED_EVENT, handleChanged);
  }, [refreshSummary]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const handleSync = async () => {
    if (!userId || syncing) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setSyncing(true);
    setProgress(null);

    try {
      const result = await syncOfflineCatalog(userId, {
        force: true,
        signal: controller.signal,
        onProgress: setProgress,
      });

      if (result.skipped) {
        const message =
          result.reason === 'offline'
            ? 'Sin conexión: no se puede actualizar el catálogo.'
            : result.reason === 'aborted'
              ? 'Actualización cancelada.'
              : 'La actualización no se inició.';
        showToast(message, result.reason === 'aborted' ? 'info' : 'error');
        return;
      }

      await refreshSummary();
      showToast(
        result.fallback
          ? 'Catálogo actualizado con el método de respaldo.'
          : 'Catálogo offline actualizado.',
        'success',
      );
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
      showToast('No se pudo actualizar el catálogo offline.', 'error');
      console.error('Error sincronizando el catálogo offline:', error);
    } finally {
      setSyncing(false);
      setProgress(null);
      abortRef.current = null;
    }
  };

  const percentage = percentageOf(progress);

  return (
    <Card data-testid="offline-catalog-card">
      <div className="flex items-start justify-between gap-6">
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-action-soft text-action-text">
            <Database className="h-6 w-6" aria-hidden="true" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-foreground">Catálogo offline</h2>
            <p className="mt-1 text-sm text-muted">
              Copia local de productos y clientes para seguir cargando pedidos sin señal.
            </p>
          </div>
        </div>
        <span
          data-testid="offline-catalog-status"
          className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${STATUS_STYLES[summary.status]}`}
        >
          {loading ? 'Leyendo…' : summary.status}
        </span>
      </div>

      <dl className="mt-5 grid grid-cols-1 gap-3 rounded-lg bg-surface-muted px-4 py-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted">Productos guardados</dt>
          <dd className="font-semibold text-foreground" data-testid="offline-catalog-products">
            {summary.productCount}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Clientes guardados</dt>
          <dd className="font-semibold text-foreground" data-testid="offline-catalog-clients">
            {summary.clientCount}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Última sincronización</dt>
          <dd className="font-semibold text-foreground">{formatDateTime(summary.lastSyncAt)}</dd>
        </div>
      </dl>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-muted" aria-live="polite">
          {syncing
            ? `Actualizando catálogo…${percentage !== null ? ` ${percentage}%` : ''}`
            : 'La actualización manual también funciona con ahorro de datos.'}
        </span>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => void handleSync()}
          disabled={syncing || !userId}
          data-testid="offline-catalog-sync-button"
        >
          {syncing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {syncing ? 'Actualizando…' : 'Actualizar ahora'}
        </Button>
      </div>
    </Card>
  );
}
