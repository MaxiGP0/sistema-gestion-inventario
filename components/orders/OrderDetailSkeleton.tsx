export type OrderDetailSkeletonVariant = 'deposit' | 'billing' | 'vendor';

/**
 * Esqueleto de los detalles de pedido. Mantiene el marco de la app (sidebar,
 * top bar y tarjetas) mientras el Server Component resuelve sesión y pedido.
 */
export default function OrderDetailSkeleton({ variant }: { variant: OrderDetailSkeletonVariant }) {
  const label =
    variant === 'deposit'
      ? 'Cargando verificación de pedido'
      : variant === 'billing'
        ? 'Cargando datos estructurados del pedido'
        : 'Cargando detalle del pedido';

  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      className="flex min-h-dvh bg-background text-foreground"
    >
      <div className="hidden w-60 shrink-0 border-r border-border bg-surface md:block" />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-16 items-center gap-3 border-b border-border bg-surface px-4 sm:px-6">
          <div className="h-9 w-9 animate-pulse rounded-md bg-surface-muted motion-reduce:animate-none" />
          <div className="space-y-2">
            <div className="h-3.5 w-40 animate-pulse rounded bg-surface-muted motion-reduce:animate-none" />
            <div className="h-2.5 w-28 animate-pulse rounded bg-surface-muted motion-reduce:animate-none" />
          </div>
        </header>

        <main className="flex-1 px-4 py-4 sm:px-6 md:px-8">
          <div className="mx-auto w-full max-w-6xl space-y-4 sm:space-y-6">
            <div className="h-32 animate-pulse rounded-lg border border-border bg-surface p-6 motion-reduce:animate-none">
              <div className="space-y-3">
                <div className="h-5 w-64 max-w-full rounded bg-surface-muted" />
                <div className="h-3 w-80 max-w-full rounded bg-surface-muted" />
                <div className="h-3 w-40 rounded bg-surface-muted" />
              </div>
            </div>

            <div className="h-24 animate-pulse rounded-lg border border-border bg-surface p-6 motion-reduce:animate-none">
              <div className="h-4 w-48 rounded bg-surface-muted" />
            </div>

            <div className="h-96 animate-pulse rounded-lg border border-border bg-surface p-6 motion-reduce:animate-none">
              <div className="mb-6 h-5 w-56 rounded bg-surface-muted" />
              <div className="space-y-4">
                {Array.from({ length: 5 }, (_, index) => (
                  <div key={index} className="flex items-center gap-4">
                    <div className="h-4 w-20 rounded bg-surface-muted" />
                    <div className="h-4 flex-1 rounded bg-surface-muted" />
                    <div className="h-8 w-20 rounded bg-surface-muted" />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
