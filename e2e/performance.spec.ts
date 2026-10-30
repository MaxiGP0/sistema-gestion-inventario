import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { E2E_USERS, type E2EUser } from './fixtures';
import { loginAs } from './helpers';

/**
 * Presupuesto de rendimiento móvil con CPU 4x y Fast 3G.
 *
 * Mide LCP, INP (peor evento de una interacción), CLS, TBT y TTFB en un build
 * de producción, con caché HTTP limpia antes de cada navegación. El objetivo no
 * es replicar un dispositivo real al milímetro, sino detectar regresiones con
 * un entorno estable y comparable entre PRs.
 *
 * Presupuestos: `performance-budgets.json` (sección `playwright`). La línea
 * base y las instrucciones están en `docs/rendimiento-movil.md`.
 */

interface PerformanceBudget {
  lcpMs: number;
  inpMs: number;
  cls: number;
  tbtMs: number;
  ttfbMs: number;
}

interface PerformanceBudgets {
  runs: number;
  routes: Record<string, PerformanceBudget>;
}

const budgets = JSON.parse(readFileSync(join(process.cwd(), 'performance-budgets.json'), 'utf8'))
  .playwright as PerformanceBudgets;

const RUNS = Math.max(1, budgets.runs ?? 3);

interface PerfState {
  lcp: number;
  fcp: number;
  cls: number;
  longTasks: Array<{ start: number; duration: number }>;
  events: Array<{ duration: number; interactionId: number }>;
}

interface Measurement {
  lcpMs: number;
  inpMs: number;
  cls: number;
  tbtMs: number;
  ttfbMs: number;
  fcpMs: number;
}

interface RouteDefinition {
  /** Clave de presupuesto; las rutas dinámicas se normalizan a `[id]`. */
  key: string;
  label: string;
  path: string | ((page: Page) => Promise<string>);
  user: E2EUser | null;
  ready: (page: Page) => Promise<void>;
  interact?: (page: Page) => Promise<void>;
}

declare global {
  interface Window {
    __perf?: PerfState;
    __resetPerfEvents?: () => void;
  }
}

const FAST_3G = {
  offline: false,
  latency: 150,
  downloadThroughput: (1.6 * 1024 * 1024) / 8,
  uploadThroughput: (750 * 1024) / 8,
  connectionType: 'cellular3g',
} as const;

const UNTHROTTLED = {
  offline: false,
  latency: 0,
  downloadThroughput: -1,
  uploadThroughput: -1,
  connectionType: 'wifi',
} as const;

/**
 * Una sesión CDP por página. Es importante no desadjuntarla: al cerrar la
 * sesión se pierden el CPU throttling y la emulación de red.
 */
const cdpSessions = new WeakMap<Page, CDPSession>();

async function cdpFor(page: Page): Promise<CDPSession> {
  const existing = cdpSessions.get(page);
  if (existing) return existing;

  const session = await page.context().newCDPSession(page);
  cdpSessions.set(page, session);
  return session;
}

async function setThrottling(page: Page, throttled: boolean): Promise<void> {
  const session = await cdpFor(page);

  await session.send('Emulation.setCPUThrottlingRate', { rate: throttled ? 4 : 1 });
  await session.send('Network.enable');
  await session.send('Network.emulateNetworkConditions', throttled ? FAST_3G : UNTHROTTLED);
}

async function clearBrowserCache(page: Page): Promise<void> {
  const session = await cdpFor(page);
  await session.send('Network.clearBrowserCache');
}

/**
 * Observer instalado antes de cada navegación. Usa las APIs nativas para no
 * sumar dependencias al bundle ni al test.
 */
async function installPerformanceObserver(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state: PerfState = {
      lcp: 0,
      fcp: 0,
      cls: 0,
      longTasks: [],
      events: [],
    };

    window.__perf = state;
    window.__resetPerfEvents = () => {
      state.events.length = 0;
    };

    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) state.lcp = entry.startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    } catch {
      // Navegador sin soporte: el test fallará al leer un LCP de 0.
    }

    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.name === 'first-contentful-paint') state.fcp = entry.startTime;
        }
      }).observe({ type: 'paint', buffered: true });
    } catch {
      // Sin FCP el TBT cuenta todas las long tasks.
    }

    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & { hadRecentInput?: boolean; value?: number };

          if (!shift.hadRecentInput) state.cls += shift.value ?? 0;
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch {
      // Navegador sin layout-shift: CLS queda en 0.
    }

    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          state.longTasks.push({ start: entry.startTime, duration: entry.duration });
        }
      }).observe({ entryTypes: ['longtask'] });
    } catch {
      // Navegador sin longtask: TBT queda en 0.
    }

    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const event = entry as PerformanceEntry & { interactionId?: number };
          state.events.push({
            duration: entry.duration,
            interactionId: event.interactionId ?? 0,
          });
        }
      }).observe({
        type: 'event',
        buffered: true,
        durationThreshold: 16,
      } as PerformanceObserverInit & { durationThreshold: number });
    } catch {
      // Navegador sin Event Timing: INP queda en 0.
    }
  });
}

function readMeasurement(page: Page): Promise<Measurement> {
  return page.evaluate(() => {
    const state = window.__perf;
    const navigation = performance.getEntriesByType('navigation')[0] as
      PerformanceNavigationTiming | undefined;
    const fcp = state?.fcp ?? 0;
    const longTasks = state?.longTasks ?? [];
    const events = state?.events ?? [];
    const interactions = events.filter((event) => event.interactionId > 0);
    const candidates = interactions.length > 0 ? interactions : events;

    return {
      lcpMs: Math.round(state?.lcp ?? 0),
      inpMs: Math.round(candidates.reduce((max, event) => Math.max(max, event.duration), 0)),
      cls: Math.round((state?.cls ?? 0) * 10_000) / 10_000,
      tbtMs: Math.round(
        longTasks
          .filter((task) => task.start >= fcp)
          .reduce((total, task) => total + Math.max(0, task.duration - 50), 0),
      ),
      ttfbMs: Math.round(navigation?.responseStart ?? 0),
      fcpMs: Math.round(fcp),
    };
  });
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) return sorted[middle];

  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarize(samples: Measurement[]): Measurement {
  return {
    lcpMs: Math.round(median(samples.map((sample) => sample.lcpMs))),
    inpMs: Math.round(median(samples.map((sample) => sample.inpMs))),
    cls: Math.round(median(samples.map((sample) => sample.cls)) * 10_000) / 10_000,
    tbtMs: Math.round(median(samples.map((sample) => sample.tbtMs))),
    ttfbMs: Math.round(median(samples.map((sample) => sample.ttfbMs))),
    fcpMs: Math.round(median(samples.map((sample) => sample.fcpMs))),
  };
}

async function depositOrderPath(page: Page): Promise<string> {
  const response = await page.request.get(
    '/api/orders?status=borrador&archived=false&pagination=cursor&limit=1',
  );
  expect(response.status(), 'listar pedidos para el detalle').toBe(200);

  const payload = (await response.json()) as { orders: Array<{ _id: string }> };
  const order = payload.orders[0];

  if (!order) throw new Error('El seed E2E no tiene pedidos en borrador para medir el detalle.');

  return `/deposit/orders/${order._id}`;
}

const routes: RouteDefinition[] = [
  {
    key: '/login',
    label: 'login',
    path: '/login',
    user: null,
    ready: (page) =>
      expect(page.getByRole('heading', { name: 'Ingresar al sistema' })).toBeVisible(),
    interact: async (page) => {
      await page.getByPlaceholder('Ingrese su usuario').click();
      await page.keyboard.type('a');
    },
  },
  {
    key: '/',
    label: 'panel',
    path: '/',
    user: E2E_USERS.seller,
    ready: (page) => expect(page.getByRole('heading', { name: 'Panel vendedor' })).toBeVisible(),
    interact: (page) => page.getByRole('button', { name: 'Cambiar tema' }).click(),
  },
  {
    key: '/orders/new',
    label: 'alta',
    path: '/orders/new',
    user: E2E_USERS.seller,
    ready: (page) => expect(page.getByRole('heading', { name: /Nuevo pedido/ })).toBeVisible(),
    interact: async (page) => {
      const search = page.getByPlaceholder('Buscar producto por nombre o código...');
      await search.click();
      await page.keyboard.type('E2E');
    },
  },
  {
    key: '/deposit/orders',
    label: 'bandeja de depósito',
    path: '/deposit/orders',
    user: E2E_USERS.deposit,
    ready: (page) =>
      expect(page.getByRole('heading', { name: 'Pedidos Pendientes de Picking' })).toBeVisible(),
    interact: async (page) => {
      const search = page.getByPlaceholder(/Buscar por nombre de cliente/);
      await search.click();
      await page.keyboard.type('E2E');
    },
  },
  {
    key: '/deposit/orders/[id]',
    label: 'detalle de depósito',
    path: depositOrderPath,
    user: E2E_USERS.deposit,
    ready: (page) =>
      expect(page.getByRole('heading', { name: 'Listado de Productos a Controlar' })).toBeVisible(),
    interact: (page) => page.getByRole('button', { name: 'Cambiar tema' }).click(),
  },
];

test('performance móvil: login, panel, alta, bandeja y detalle', async ({ page }, testInfo) => {
  test.setTimeout(300_000);

  page.setDefaultNavigationTimeout(90_000);
  page.setDefaultTimeout(30_000);
  await setThrottling(page, true);
  await installPerformanceObserver(page);

  let currentUsername: string | null = null;
  const results: Record<string, Measurement> = {};

  for (const route of routes) {
    if (route.user === null) {
      await page.context().clearCookies();
      currentUsername = null;
    } else if (currentUsername !== route.user.username) {
      await loginAs(page, route.user);
      currentUsername = route.user.username;
    }

    const path = typeof route.path === 'string' ? route.path : await route.path(page);
    const samples: Measurement[] = [];

    for (let run = 1; run <= RUNS; run += 1) {
      await clearBrowserCache(page);
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      await route.ready(page);
      await page.waitForLoadState('load').catch(() => {});
      await page.waitForTimeout(1_500);

      await page.evaluate(() => window.__resetPerfEvents?.());
      await route.interact?.(page);
      await page.waitForTimeout(500);

      const sample = await readMeasurement(page);
      samples.push(sample);
      console.log(
        `[perf] ${route.label} run ${run}/${RUNS}: LCP ${sample.lcpMs} ms · INP ${sample.inpMs} ms · CLS ${sample.cls} · TBT ${sample.tbtMs} ms · TTFB ${sample.ttfbMs} ms`,
      );
    }

    results[route.key] = summarize(samples);
  }

  const summary = Object.entries(results)
    .map(
      ([route, measurement]) =>
        `${route}: LCP ${measurement.lcpMs} ms · INP ${measurement.inpMs} ms · CLS ${measurement.cls} · TBT ${measurement.tbtMs} ms · TTFB ${measurement.ttfbMs} ms`,
    )
    .join('\n');

  console.log(`\n[perf] Mediana de ${RUNS} corridas con CPU 4x y Fast 3G:\n${summary}`);
  await testInfo.attach('mobile-performance.json', {
    body: JSON.stringify({ runs: RUNS, routes: results }, null, 2),
    contentType: 'application/json',
  });

  for (const route of routes) {
    const measurement = results[route.key];
    const budget = budgets.routes[route.key];

    expect(budget, `Falta el presupuesto de ${route.key}`).toBeDefined();
    expect(measurement.lcpMs, `${route.label}: LCP ${measurement.lcpMs} ms`).toBeLessThanOrEqual(
      budget.lcpMs,
    );
    expect(measurement.inpMs, `${route.label}: INP ${measurement.inpMs} ms`).toBeLessThanOrEqual(
      budget.inpMs,
    );
    expect(measurement.cls, `${route.label}: CLS ${measurement.cls}`).toBeLessThanOrEqual(
      budget.cls,
    );
    expect(measurement.tbtMs, `${route.label}: TBT ${measurement.tbtMs} ms`).toBeLessThanOrEqual(
      budget.tbtMs,
    );
    expect(measurement.ttfbMs, `${route.label}: TTFB ${measurement.ttfbMs} ms`).toBeLessThanOrEqual(
      budget.ttfbMs,
    );
  }
});
