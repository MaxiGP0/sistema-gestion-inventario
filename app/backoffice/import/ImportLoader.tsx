'use client';

import dynamic from 'next/dynamic';

const ImportClient = dynamic(() => import('./ImportClient'), {
  ssr: false,
  loading: () => (
    <div className="mx-auto w-full max-w-4xl">
      <div className="h-[32rem] animate-pulse rounded-lg border border-border bg-surface motion-reduce:animate-none" />
    </div>
  ),
});

/** Carga el formulario de importación fuera del chunk inicial del backoffice. */
export default function ImportLoader() {
  return <ImportClient />;
}
