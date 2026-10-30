'use client';

import { AlertTriangle } from 'lucide-react';
import Button from '@/components/ui/Button';
import Card from '@/components/ui/Card';

interface OrderStaleVersionBannerProps {
  currentVersion: number;
  latestVersion: number;
  onLoadLatest: () => void;
}

/**
 * Aviso destacado para depósito/facturación: el pedido cambió en el servidor
 * mientras el operario tenía un picking o control sin guardar. Evita seguir
 * cargando sobre una versión vencida y terminar en un 409 tardío.
 */
export default function OrderStaleVersionBanner({
  currentVersion,
  latestVersion,
  onLoadLatest,
}: OrderStaleVersionBannerProps) {
  return (
    <Card
      data-testid="order-stale-version-banner"
      className="border-status-draft-border bg-status-draft-soft"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-status-draft" aria-hidden="true" />
          <div>
            <h3 className="text-sm font-semibold text-status-draft">
              Hay una versión más reciente del pedido
            </h3>
            <p className="mt-1 text-xs text-status-draft">
              Otro usuario guardó cambios (versión {latestVersion}; estás viendo la {currentVersion}
              ). Cargá la última versión antes de seguir para no perder tu trabajo ni recibir un
              conflicto al guardar.
            </p>
          </div>
        </div>
        <div className="flex shrink-0 justify-end">
          <Button variant="primary" size="sm" onClick={onLoadLatest}>
            Cargar última versión
          </Button>
        </div>
      </div>
    </Card>
  );
}
