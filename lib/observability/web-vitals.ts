/**
 * Normalización de Web Vitals para reportarlos sin PII.
 *
 * El navegador entrega un `Metric` de `next/web-vitals`; acá se decide qué se
 * envía: sólo LCP, INP, CLS y TTFB, con la ruta normalizada (sin query string),
 * la clase de dispositivo y el release del build. No se incluye `id`, URL
 * completa, user agent, usuario ni ningún otro dato de la sesión.
 */

import { normalizeRoute, routeFromUrl } from './routes';

export const WEB_VITAL_NAMES = ['LCP', 'INP', 'CLS', 'TTFB'] as const;

export type WebVitalName = (typeof WEB_VITAL_NAMES)[number];
export type DeviceClass = 'mobile' | 'tablet' | 'desktop';
export type WebVitalRating = 'good' | 'needs-improvement' | 'poor' | 'unknown';
export type WebVitalNavigationType =
  | 'navigate'
  | 'reload'
  | 'prerender'
  | 'back-forward'
  | 'back-forward-cache'
  | 'restore'
  | 'soft-navigation'
  | 'unknown';

export interface RawWebVitalMetric {
  name: string;
  value: number;
  rating?: string;
  navigationType?: string;
  navigationURL?: string;
}

export interface WebVitalContext {
  /** Ruta actual, usada cuando el metric no trae `navigationURL`. */
  pathname?: string;
  /** Ancho del viewport en CSS px; define mobile/tablet/desktop. */
  width?: number;
  /** Identificador del build desplegado (GITHUB_SHA o id local). */
  release: string;
}

export interface WebVitalReport {
  name: WebVitalName;
  value: number;
  rating: WebVitalRating;
  route: string;
  deviceClass: DeviceClass;
  release: string;
  navigationType: WebVitalNavigationType;
  unit: 'millisecond' | 'ratio';
}

const NAVIGATION_TYPES = new Set<WebVitalNavigationType>([
  'navigate',
  'reload',
  'prerender',
  'back-forward',
  'back-forward-cache',
  'restore',
  'soft-navigation',
]);

const RATINGS = new Set<WebVitalRating>(['good', 'needs-improvement', 'poor']);

/** Clase de dispositivo por ancho de viewport (sin user agent ni PII). */
export function deviceClassForWidth(width: number): DeviceClass {
  if (!Number.isFinite(width) || width < 768) return 'mobile';
  if (width < 1024) return 'tablet';
  return 'desktop';
}

function normalizeRating(rating: string | undefined): WebVitalRating {
  return RATINGS.has(rating as WebVitalRating) ? (rating as WebVitalRating) : 'unknown';
}

function normalizeNavigationType(navigationType: string | undefined): WebVitalNavigationType {
  return NAVIGATION_TYPES.has(navigationType as WebVitalNavigationType)
    ? (navigationType as WebVitalNavigationType)
    : 'unknown';
}

/**
 * Convierte el metric de Next en un reporte seguro. Devuelve `null` para
 * métricas que no forman parte del presupuesto (por ejemplo FCP) o valores
 * inválidos.
 */
export function toWebVitalReport(
  metric: RawWebVitalMetric,
  context: WebVitalContext,
): WebVitalReport | null {
  const name = metric.name.toUpperCase();

  if (!WEB_VITAL_NAMES.includes(name as WebVitalName)) return null;
  if (!Number.isFinite(metric.value) || metric.value < 0) return null;

  const vital = name as WebVitalName;
  const route = metric.navigationURL
    ? routeFromUrl(metric.navigationURL)
    : normalizeRoute(context.pathname ?? '/');
  const value =
    vital === 'CLS' ? Math.round(metric.value * 10_000) / 10_000 : Math.round(metric.value);

  return {
    name: vital,
    value,
    rating: normalizeRating(metric.rating),
    route,
    deviceClass: deviceClassForWidth(context.width ?? 0),
    release: context.release || 'unknown',
    navigationType: normalizeNavigationType(metric.navigationType),
    unit: vital === 'CLS' ? 'ratio' : 'millisecond',
  };
}
