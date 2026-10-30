import type { NextConfig } from 'next';
import bundleAnalyzer from '@next/bundle-analyzer';
import { withSentryConfig } from '@sentry/nextjs/config';
import { OPTIMIZABLE_IMAGE_REMOTE_PATTERNS } from './lib/image-sources';
import { buildSecurityHeaders } from './lib/security-headers';

/**
 * El plugin de Webpack se conserva para builds con `--webpack`; el build
 * estándar (Turbopack) se mide con `npm run analyze`, que usa el analizador
 * nativo de Next (`next analyze --output`).
 */
const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === 'true',
  analyzerMode: 'static',
  openAnalyzer: false,
});

/**
 * Identificador del build que versiona las cachés del service worker.
 *
 * Se inyecta en el bundle cliente como `NEXT_PUBLIC_BUILD_ID` y viaja en la
 * URL de registro (`/sw.js?v=...`). Así cada despliegue usa cachés nuevas y el
 * SW anterior puede detectarse como una actualización pendiente. En CI se
 * prefiere el SHA del commit; en local, un id por proceso de build/dev.
 */
function resolveBuildId(): string {
  const explicit = process.env.NEXT_PUBLIC_BUILD_ID?.trim();
  if (explicit) return explicit.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 64) || 'dev';

  const commit = (process.env.GITHUB_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA)?.trim();
  if (commit) return commit.slice(0, 12);

  return `dev-${Date.now().toString(36)}`;
}

const BUILD_ID = resolveBuildId();

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_BUILD_ID: BUILD_ID,
  },
  /* config options here */
  compress: true,
  poweredByHeader: false,
  cacheComponents: true,
  partialPrefetching: true,
  async headers() {
    // La CSP viaja como Content-Security-Policy-Report-Only (ver
    // lib/security-headers.ts). HSTS sólo se agrega en producción.
    return [
      {
        source: '/:path*',
        headers: buildSecurityHeaders(),
      },
      {
        // El SW debe revalidarse en cada visita: si el navegador lo sirve
        // desde su caché HTTP, una versión nueva puede tardar días en
        // detectarse. `Service-Worker-Allowed` mantiene el scope raíz.
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
      {
        // Shell estático sin datos de negocio que usa el SW cuando no hay red.
        source: '/offline',
        headers: [{ key: 'Cache-Control', value: 'no-cache' }],
      },
      {
        source: '/offline.html',
        headers: [{ key: 'Cache-Control', value: 'no-cache' }],
      },
    ];
  },
  async rewrites() {
    // `/offline` es un HTML estático de `public/`, no una página de Next: no
    // incluye la sesión ni el payload RSC del usuario y se puede precachear
    // sin riesgo de servir datos de una cuenta desde Cache Storage.
    return {
      beforeFiles: [{ source: '/offline', destination: '/offline.html' }],
    };
  },
  experimental: {
    // Mantiene el chequeo de seguridad de Next.js en las siguientes corridas
    // de `next dev`/`next build` sobre esta aplicación.
    agentUpgrade: 'security',
  },
  images: {
    // Sólo estos hosts pasan por /_next/image; el resto se renderiza con
    // `unoptimized` desde ProductThumbnail (ver lib/image-sources.ts).
    remotePatterns: [...OPTIMIZABLE_IMAGE_REMOTE_PATTERNS],
    qualities: [75],
  },
  turbopack: {
    rules: {
      '*.css': {
        loaders: ['@tailwindcss/turbopack'],
        as: '*.css',
      },
    },
  },
};

export default withSentryConfig(withBundleAnalyzer(nextConfig), {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,

  // Sin token/org/project no se intenta subir source maps: el build local o CI
  // sin Sentry sigue funcionando y no se generan artefactos innecesarios.
  sourcemaps: {
    disable: !(
      process.env.SENTRY_AUTH_TOKEN &&
      process.env.SENTRY_ORG &&
      process.env.SENTRY_PROJECT
    ),
  },
  widenClientFileUpload: false,
  telemetry: false,
  silent: !process.env.CI,
});
