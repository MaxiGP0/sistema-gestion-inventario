'use client';

import NextError from 'next/error';
import { useEffect } from 'react';
import { captureClientError } from '@/lib/observability/errors';

/**
 * Boundary raíz de la App Router. Next lo usa cuando falla el layout raíz, por
 * eso reemplaza el documento completo (html/body) y no puede depender de los
 * providers de `app/layout.tsx`.
 *
 * El error se reporta con `captureClientError`, que carga Sentry de forma
 * diferida: esta página forma parte del bundle inicial y no debe arrastrar el
 * SDK cuando la app no tiene DSN. `digest` permite correlacionarlo con el log
 * estructurado del servidor cuando el fallo ocurrió en un Server Component.
 */
export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
  retry?: () => void;
}) {
  useEffect(() => {
    captureClientError(error, {
      digest: error.digest,
      boundary: 'global-error',
      route: window.location.pathname,
    });
  }, [error]);

  return (
    <html lang="es">
      <body>
        <NextError statusCode={0} />
      </body>
    </html>
  );
}
