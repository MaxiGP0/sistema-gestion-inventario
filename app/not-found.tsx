import type { Metadata } from 'next';
import Link from 'next/link';
import { Compass, Home } from 'lucide-react';

/**
 * 404 de la aplicación (convención `not-found.tsx`). Cubre tanto el
 * `notFound()` lanzado por un segmento como las URLs que no matchean ninguna
 * ruta. Se renderiza dentro del layout raíz, así que respeta el tema activo.
 */
export const metadata: Metadata = {
  title: 'Página no encontrada',
  description: 'La dirección solicitada no existe en el Sistema de Gestión de Inventario.',
};

export default function NotFound() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-6 text-foreground transition-colors duration-200">
      <div className="w-full max-w-md rounded-lg border border-border bg-surface p-8 text-center shadow-elevation-1">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-lg bg-action-soft text-action-text">
          <Compass className="h-8 w-8" aria-hidden="true" />
        </div>
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-action-text">
          Error 404
        </p>
        <h1 className="mb-2 text-xl font-semibold">Página no encontrada</h1>
        <p className="mb-6 text-sm text-muted">
          La dirección a la que intentó acceder no existe o fue movida. Verifique el enlace o vuelva
          al panel principal.
        </p>
        <Link
          href="/"
          className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-action px-5 py-2.5 text-sm font-semibold text-action-fg shadow-elevation-1 transition-colors hover:bg-action-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
        >
          <Home className="h-4 w-4" aria-hidden="true" /> Volver al panel principal
        </Link>
      </div>
    </div>
  );
}
