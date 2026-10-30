import { Suspense } from 'react';
import BackofficePageSkeleton from '@/components/BackofficePageSkeleton';
import { requireAdminPage } from '@/lib/auth-page';
import ImportLoader from './ImportLoader';

/** Página server: el formulario interactivo se carga como isla diferida. */
export default function ImportPage() {
  return (
    <Suspense fallback={<BackofficePageSkeleton />}>
      <ImportContent />
    </Suspense>
  );
}

/**
 * Fuerza que el contenido se resuelva en request-time, igual que el resto del
 * backoffice. Así el shell de la sección queda en el HTML estático y su chunk
 * cliente no se suma al bundle inicial de la importación.
 */
async function ImportContent() {
  await requireAdminPage();
  return <ImportLoader />;
}
