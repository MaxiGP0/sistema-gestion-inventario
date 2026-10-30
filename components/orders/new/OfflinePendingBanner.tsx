'use client';

import { CloudUpload } from 'lucide-react';

interface OfflinePendingBannerProps {
  clientRequestId: string;
}

/** Aviso local mientras la entrada de esta alta sigue en la cola offline. */
export default function OfflinePendingBanner({ clientRequestId }: OfflinePendingBannerProps) {
  return (
    <div
      role="status"
      data-testid="offline-order-pending"
      data-client-request-id={clientRequestId}
      className="border-b border-status-draft-border bg-status-draft-soft px-6 py-3 text-status-draft"
    >
      <div className="mx-auto flex max-w-7xl items-start gap-2 text-sm">
        <CloudUpload className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <div>
          <p className="font-semibold">Pendiente de sincronizar</p>
          <p className="text-xs opacity-80">
            El pedido quedó guardado en este dispositivo. Se enviará al recuperar la conexión o al
            volver a esta pantalla.
          </p>
        </div>
      </div>
    </div>
  );
}
