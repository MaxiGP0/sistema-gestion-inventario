'use client';

import dynamic from 'next/dynamic';

const OfflineSyncIndicator = dynamic(
  () => import('@/components/OfflineSyncIndicator').catch(() => ({ default: () => null })),
  { ssr: false },
);
const AutoFullscreen = dynamic(
  () => import('@/components/AutoFullscreen').catch(() => ({ default: () => null })),
  { ssr: false },
);
const ServiceWorkerManager = dynamic(
  () => import('@/components/ServiceWorkerManager').catch(() => ({ default: () => null })),
  { ssr: false },
);

/**
 * Componentes globales sin contenido en la primera pintura. Se cargan después
 * de la hidratación para no sumar su código al bundle inicial de todas las
 * rutas (incluido login).
 */
export default function DeferredAppChrome() {
  return (
    <>
      <OfflineSyncIndicator />
      <AutoFullscreen />
      <ServiceWorkerManager />
    </>
  );
}
