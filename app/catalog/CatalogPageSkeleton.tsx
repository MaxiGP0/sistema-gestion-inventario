/** Fallback mientras se resuelven la sesión y los datos del catálogo. */
export default function CatalogPageSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Cargando catálogo"
      className="flex min-h-dvh bg-background text-foreground"
    >
      <aside className="hidden w-60 shrink-0 border-r border-border bg-surface md:block" />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-16 items-center border-b border-border bg-surface px-4 sm:px-6">
          <div className="h-4 w-32 animate-pulse rounded bg-border" />
        </div>

        <main className="flex-1 px-4 pb-[calc(5.5rem+env(safe-area-inset-bottom))] pt-4 sm:px-6 md:px-8 md:pb-8">
          <div className="mx-auto w-full max-w-6xl animate-pulse">
            <div className="mb-6 h-10 w-56 rounded-lg bg-border" />
            <div className="h-96 rounded-lg border border-border bg-surface" />
          </div>
        </main>
      </div>
    </div>
  );
}
