/**
 * Loading UI del segmento raíz (convención `loading.tsx`).
 *
 * En el árbol de componentes envuelve en un <Suspense> a `not-found`, `page` y
 * los `layout` anidados. Debe ser liviano: es lo primero que ve el usuario al
 * navegar a una sección que todavía resuelve sus datos (por ejemplo, las
 * páginas del backoffice que leen de Mongo).
 */
export default function Loading() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Cargando"
      className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background text-muted transition-colors duration-200"
    >
      <div
        aria-hidden="true"
        className="flex h-14 w-14 animate-pulse items-center justify-center rounded-lg bg-action text-xl font-semibold text-action-fg motion-reduce:animate-none"
      >
        M
      </div>
      <p className="flex items-center gap-2 text-sm font-medium">
        <span
          aria-hidden="true"
          className="h-4 w-4 animate-spin rounded-full border-2 border-border-strong border-t-action motion-reduce:animate-none"
        />
        Cargando…
      </p>
    </div>
  );
}
