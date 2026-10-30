/**
 * Fallback compartido por las páginas server-side del backoffice mientras se
 * resuelven la sesión y los datos. El AppShell vive en el layout, así que el
 * esqueleto sólo replica la grilla de contenido para evitar saltos.
 */
export default function BackofficePageSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Cargando datos del catálogo"
      className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:gap-8"
    >
      <div className="h-96 animate-pulse rounded-lg border border-border bg-surface motion-reduce:animate-none" />
      <div className="h-96 animate-pulse rounded-lg border border-border bg-surface motion-reduce:animate-none lg:col-span-2" />
    </div>
  );
}
