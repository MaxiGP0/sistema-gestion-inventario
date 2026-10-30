'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import Button from '@/components/ui/Button';
import { captureClientError } from '@/lib/observability/errors';

/**
 * Error boundary de segmento (convención `error.tsx`).
 *
 * Reemplaza el fallback de Next cuando falla el renderizado de una página (o
 * de un layout anidado). En esta versión la prop estable para reintentar es
 * `retry` (vuelve a pedir y renderizar el segmento); `error.digest` permite
 * correlacionar el error con los logs del servidor en producción.
 *
 * No envuelve al layout raíz: para errores ahí existe `global-error.tsx`.
 */
export default function Error({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const router = useRouter();

  useEffect(() => {
    console.error('Error capturado por app/error.tsx:', error);
    captureClientError(error, {
      digest: error.digest,
      boundary: 'error',
      route: typeof window === 'undefined' ? undefined : window.location.pathname,
    });
  }, [error]);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-6 text-foreground transition-colors duration-200">
      <div className="w-full max-w-md rounded-lg border border-border bg-surface p-8 text-center shadow-elevation-1">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-lg bg-status-blocked-soft text-status-blocked">
          <AlertTriangle className="h-8 w-8" aria-hidden="true" />
        </div>
        <h1 className="mb-2 text-xl font-semibold">Algo salió mal</h1>
        <p className="mb-6 text-sm text-muted">
          Ocurrió un error inesperado al cargar esta sección. Puede reintentar la operación o volver
          al panel principal.
        </p>

        {/* En producción `error.message` es genérico; el detalle queda en los
            logs del servidor, identificado por `digest`. */}
        {process.env.NODE_ENV !== 'production' && error.message && (
          <pre className="mb-6 max-h-32 overflow-x-auto rounded-md bg-surface-muted p-3 text-left font-mono text-xs text-status-blocked">
            {error.message}
          </pre>
        )}

        {error.digest && (
          <p className="mb-6 font-mono text-xs text-subtle">Referencia: {error.digest}</p>
        )}

        <div className="flex flex-col gap-2">
          <Button variant="primary" onClick={() => retry()}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" /> Reintentar
          </Button>
          <Button variant="ghost" onClick={() => router.push('/')}>
            Volver al panel principal
          </Button>
        </div>
      </div>
    </div>
  );
}
