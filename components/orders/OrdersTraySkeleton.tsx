import { ORDERS_TRAY_CONFIGS, type OrdersTrayVariant } from '@/lib/orders-tray';

/**
 * Esqueleto de las bandejas de pedidos.
 *
 * Se usa como fallback de `loading.tsx` y del Suspense de cada segmento para
 * que la navegación muestre la estructura de la bandeja en vez de un spinner
 * global. No incluye los títulos reales: así los E2E no confunden el esqueleto
 * con la bandeja ya resuelta.
 */
export default function OrdersTraySkeleton({ variant }: { variant: OrdersTrayVariant }) {
  const config = ORDERS_TRAY_CONFIGS[variant];

  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={`Cargando ${config.pageTitle}`}
      className="flex min-h-dvh bg-background text-foreground"
    >
      <div className="hidden w-60 shrink-0 border-r border-border bg-surface md:block" />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-16 items-center gap-3 border-b border-border bg-surface px-4 sm:px-6">
          <div className="h-9 w-9 animate-pulse rounded-md bg-surface-muted motion-reduce:animate-none md:hidden" />
          <div className="space-y-2">
            <div className="h-3.5 w-36 animate-pulse rounded bg-surface-muted motion-reduce:animate-none sm:w-48" />
            <div className="h-2.5 w-28 animate-pulse rounded bg-surface-muted motion-reduce:animate-none" />
          </div>
        </header>

        <main className="flex-1 px-4 pb-[calc(5.5rem+env(safe-area-inset-bottom))] pt-4 sm:px-6 md:px-8 md:pb-8">
          <div className="mx-auto w-full max-w-6xl">
            <div className="mb-4 flex flex-col items-start justify-between gap-4 sm:mb-6 sm:flex-row sm:items-center">
              <div className="space-y-2">
                <div className="h-6 w-64 animate-pulse rounded bg-surface-muted motion-reduce:animate-none" />
                <div className="h-3 w-80 max-w-full animate-pulse rounded bg-surface-muted motion-reduce:animate-none" />
              </div>
              <div className="flex gap-3">
                <div className="h-9 w-28 animate-pulse rounded-md bg-surface-muted motion-reduce:animate-none" />
                <div className="h-9 w-24 animate-pulse rounded-md bg-surface-muted motion-reduce:animate-none" />
                <div className="h-9 w-24 animate-pulse rounded-md bg-surface-muted motion-reduce:animate-none" />
              </div>
            </div>

            <div className="mb-4 h-12 animate-pulse rounded-md border border-border bg-surface motion-reduce:animate-none sm:mb-6" />

            <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 6 }, (_, index) => (
                <div
                  key={index}
                  className="h-56 animate-pulse rounded-lg border border-border bg-surface p-5 motion-reduce:animate-none"
                >
                  <div className="mb-4 flex items-start justify-between gap-3">
                    <div className="space-y-2">
                      <div className="h-4 w-40 rounded bg-surface-muted" />
                      <div className="h-3 w-24 rounded bg-surface-muted" />
                    </div>
                    <div className="h-6 w-20 rounded-full bg-surface-muted" />
                  </div>
                  <div className="space-y-2">
                    <div className="h-3 w-full rounded bg-surface-muted" />
                    <div className="h-3 w-2/3 rounded bg-surface-muted" />
                  </div>
                  <div className="mt-6 flex items-center justify-between border-t border-border pt-4">
                    <div className="h-5 w-24 rounded bg-surface-muted" />
                    <div className="h-8 w-28 rounded-md bg-surface-muted" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
