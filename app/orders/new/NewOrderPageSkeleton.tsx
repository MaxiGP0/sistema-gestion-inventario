/**
 * Fallback del alta mientras se resuelven la sesión y el catálogo inicial.
 *
 * Mantiene la silueta del AppShell para que la navegación no salte y evita
 * mostrar controles que todavía no tienen datos detrás.
 */
export default function NewOrderPageSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Cargando alta de pedido"
      className="flex min-h-dvh bg-background text-foreground"
    >
      <aside className="hidden w-60 shrink-0 border-r border-border bg-surface md:block" />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-16 items-center border-b border-border bg-surface px-4 sm:px-6">
          <div className="h-4 w-32 animate-pulse rounded bg-border" />
        </div>

        <main className="flex-1 px-4 pb-[calc(5.5rem+env(safe-area-inset-bottom))] pt-4 sm:px-6 md:px-8 md:pb-8">
          <div className="mx-auto grid w-full max-w-7xl animate-pulse grid-cols-1 gap-6 lg:grid-cols-4 lg:gap-8">
            <div className="h-72 rounded-lg border border-border bg-surface lg:hidden" />
            <div className="hidden lg:col-span-1 lg:block">
              <div className="h-[36rem] rounded-lg border border-border bg-surface" />
            </div>
            <div className="space-y-6 lg:col-span-3">
              <div className="h-24 rounded-lg border border-border bg-surface" />
              <div className="h-[28rem] rounded-lg border border-border bg-surface" />
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
