'use client';

import { Copy } from 'lucide-react';
import Button from '@/components/ui/Button';
import { DASHBOARD_TIME_ZONE } from '@/lib/dashboard-time';
import type { OrderSummaryDTO } from '@/lib/types';

const DATE_FORMATTER = new Intl.DateTimeFormat('es-AR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: DASHBOARD_TIME_ZONE,
});

interface RepeatLastOrderPanelProps {
  loading: boolean;
  lastOrder: OrderSummaryDTO | null;
  onRepeat: () => void;
}

/** Acción para clonar el último pedido del cliente seleccionado. */
export default function RepeatLastOrderPanel({
  loading,
  lastOrder,
  onRepeat,
}: RepeatLastOrderPanelProps) {
  return (
    <div className="mt-3 rounded-lg border border-border p-3">
      <p className="text-[11px] font-semibold text-foreground">Repetir pedido</p>
      {loading ? (
        <p className="mt-1 text-[11px] text-muted">Buscando el último pedido...</p>
      ) : lastOrder ? (
        <>
          <p className="mt-1 text-[11px] text-muted">
            Último pedido: {DATE_FORMATTER.format(new Date(lastOrder.createdAt))} ·{' '}
            {lastOrder.items.length} ítem(s) · ${lastOrder.finalTotal.toFixed(2)}
          </p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            fullWidth
            onClick={onRepeat}
            className="mt-2"
          >
            <Copy className="h-3.5 w-3.5" aria-hidden="true" /> Repetir último pedido
          </Button>
        </>
      ) : (
        <p className="mt-1 text-[11px] text-muted">Este cliente todavía no tiene pedidos.</p>
      )}
    </div>
  );
}
