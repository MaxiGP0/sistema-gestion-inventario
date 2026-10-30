'use client';

export type StatusBadgeVariant = 'deposit' | 'billing' | 'vendor';

interface BadgeStyle {
  label: string;
  className: string;
}

const DEFAULT_CLASSNAME = 'border-action/30 bg-action-soft text-action-text';

const BADGE_STYLES: Record<StatusBadgeVariant, Record<string, BadgeStyle>> = {
  deposit: {
    borrador: {
      label: 'Borrador',
      className: 'border-status-draft-border bg-status-draft-soft text-status-draft',
    },
    paralizado: {
      label: 'Paralizado',
      className: 'border-status-blocked-border bg-status-blocked-soft text-status-blocked',
    },
  },
  billing: {
    facturacion: {
      label: 'Listo',
      className: 'border-status-ready-border bg-status-ready-soft text-status-ready',
    },
    control_post_factura: {
      label: 'Control Post-Factura',
      className: 'border-status-control-border bg-status-control-soft text-status-control',
    },
    entregado: {
      label: 'Entregado / Despachado',
      className: 'border-status-delivered-border bg-status-delivered-soft text-status-delivered',
    },
  },
  vendor: {
    borrador: {
      label: 'Borrador',
      className: 'border-status-draft-border bg-status-draft-soft text-status-draft',
    },
    paralizado: {
      label: 'Paralizado',
      className: 'border-status-blocked-border bg-status-blocked-soft text-status-blocked',
    },
    facturacion: {
      label: 'Listo para facturar',
      className: 'border-status-ready-border bg-status-ready-soft text-status-ready',
    },
    control_post_factura: {
      label: 'Control post-factura',
      className: 'border-status-control-border bg-status-control-soft text-status-control',
    },
    entregado: {
      label: 'Entregado',
      className: 'border-status-delivered-border bg-status-delivered-soft text-status-delivered',
    },
  },
};

interface StatusBadgeProps {
  status: string;
  variant: StatusBadgeVariant;
}

/**
 * Badge de estado compartido por las bandejas de depósito y facturación.
 * Los estados sin mapear se muestran crudos en el color de acción.
 */
export default function StatusBadge({ status, variant }: StatusBadgeProps) {
  const badge = BADGE_STYLES[variant][status] ?? { label: status, className: DEFAULT_CLASSNAME };

  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${badge.className}`}
    >
      {badge.label}
    </span>
  );
}
