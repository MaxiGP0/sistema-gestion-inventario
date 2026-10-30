/**
 * Sistema de Gestión de Inventario
 * @author MaxiGP0 (Máximo Gómez Pessoa)
 * @see https://github.com/MaxiGP0
 * @see https://www.linkedin.com/in/maximo-gomez-pessoa/
 * @license MIT
 */

import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Mono, Inter } from 'next/font/google';
import { Suspense, type ReactNode } from 'react';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ToastProvider } from '@/context/ToastContext';
import { UserProvider } from '@/context/UserContext';
import MobileBottomNav from '@/components/MobileBottomNav';
import NetworkStatus from '@/components/NetworkStatus';
import DeferredAppChrome from '@/components/app-shell/DeferredAppChrome';
import WebVitalsLoader from '@/components/observability/WebVitalsLoader';
import { getInitialSessionUserFast } from '@/lib/auth';
import { TITLE_TEMPLATE } from '@/lib/metadata';
import RootLoading from './loading';
import './globals.css';

// Inter para lectura y acciones; IBM Plex Mono para códigos, IDs e importes
// técnicos. Ambas se autohospedan y se precargan desde el layout raíz.
const inter = Inter({
  variable: '--font-inter',
  subsets: ['latin'],
  display: 'swap',
});

const ibmPlexMono = IBM_Plex_Mono({
  variable: '--font-ibm-plex-mono',
  subsets: ['latin'],
  weight: ['400', '600'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'Sistema de Gestión de Inventario — Gestión Integral de Pedidos',
    // Sufijo que reciben las secciones/páginas que exportan su propio `title`.
    template: TITLE_TEMPLATE,
  },
  description: 'Aplicación de gestión de inventario, pedidos, picking y facturación.',
  authors: [
    { name: 'MaxiGP0', url: 'https://github.com/MaxiGP0' },
    { name: 'Máximo Gómez Pessoa', url: 'https://www.linkedin.com/in/maximo-gomez-pessoa/' },
  ],
  creator: 'MaxiGP0',
  appleWebApp: {
    capable: true,
    title: 'Sistema de Gestión de Inventario',
    statusBarStyle: 'default',
  },
};

export const viewport: Viewport = {
  themeColor: '#0b0d9f',
  // Android Chrome achica el layout viewport al abrir el teclado; en iOS
  // Safari esta opción no aplica y el ajuste lo hace visualViewport (ver
  // hooks/useVisualViewport.ts). `cover` permite usar safe-area insets.
  viewportFit: 'cover',
  interactiveWidget: 'resizes-content',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es" data-theme="light" suppressHydrationWarning>
      <head>
        {/* Aplica el tema guardado antes del primer paint: las variantes
            `dark:` del CSS ya están presentes en el HTML del servidor. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{if(localStorage.getItem('sgi_theme')==='dark'){document.documentElement.setAttribute('data-theme','dark')}}catch(e){}})()`,
          }}
        />
      </head>
      <body className={`${inter.variable} ${ibmPlexMono.variable} font-sans antialiased`}>
        <ErrorBoundary>
          <ToastProvider>
            {/* Cache Components exige que la lectura de `cookies()` viva dentro
                de un Suspense. El fallback es el skeleton visible (nunca
                `null`) y la sesión se hidrata desde la cookie firmada + el
                caché en memoria, sin esperar a Mongo: el skeleton de cada
                ruta puede transmitirse en el primer chunk. */}
            <Suspense fallback={<RootLoading />}>
              <SessionUserProvider>{children}</SessionUserProvider>
            </Suspense>
          </ToastProvider>
        </ErrorBoundary>
        {/* Reporter diferido: no suma `next/web-vitals` al bundle inicial. */}
        <WebVitalsLoader />
      </body>
    </html>
  );
}

/**
 * Resuelve la sesión en el servidor sin tocar Mongo (firma de la cookie +
 * caché de sesión en memoria) y la entrega al `UserProvider` como valor
 * inicial. No redirige: el proxy ya exige sesión en todas las páginas.
 *
 * La validación completa (`active`, `sessionVersion`, rol actual contra la
 * base) sigue en `requireCurrentSession` para escrituras y en
 * `/api/auth/session`, que el `UserProvider` revalida al volver el foco.
 */
async function SessionUserProvider({ children }: { children: ReactNode }) {
  const initialUser = await getInitialSessionUserFast();

  return (
    <UserProvider initialUser={initialUser}>
      <NetworkStatus />
      <MobileBottomNav />
      <DeferredAppChrome />
      {children}
    </UserProvider>
  );
}
