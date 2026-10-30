import { expect, test, type Page } from '@playwright/test';
import { E2E_USERS } from './fixtures';
import { loginAs } from './helpers';

/**
 * Rendimiento de listas largas y consumo en segundo plano.
 *
 * - Simula 200/500 pedidos para medir el costo del DOM y confirmar que
 *   `content-visibility` está activo sin romper el scroll.
 * - Con 300 pedidos mide long tasks mientras se tipea en el buscador. Las
 *   tarjetas memoizadas deben evitar que cada tecla re-renderice la lista.
 * - Con el SSE caído comprueba que una pestaña oculta no dispara ni el
 *   polling de respaldo de 10 s ni reconexiones del EventSource.
 *
 * No usa una librería de virtualización: el objetivo es dejar una línea base
 * reproducible (ver docs/rendimiento-listas-largas.md).
 */

interface LongTaskEntry {
  start: number;
  duration: number;
}

declare global {
  interface Window {
    __longTasks?: LongTaskEntry[];
    __resetLongTasks?: () => void;
    __setDocumentHidden?: (hidden: boolean) => void;
  }
}

const LONG_TASK_BUDGET_MS = 200;
const HIDDEN_OBSERVATION_MS = 11_500;

function buildOrders(count: number): unknown[] {
  return Array.from({ length: count }, (_, index) => {
    const id = (index + 1).toString(16).padStart(24, '0');

    return {
      _id: id,
      clientId: {
        _id: id,
        code: `PERF-${String(index + 1).padStart(4, '0')}`,
        name: `Farmacia Perf ${index + 1}`,
        localidad: 'CABA',
        province: 'Buenos Aires',
      },
      clientName: `Farmacia Perf ${index + 1}`,
      clientCode: `PERF-${String(index + 1).padStart(4, '0')}`,
      status: 'borrador',
      finalTotal: 1000 + index,
      createdBy: E2E_USERS.seller.username,
      createdAt: new Date(Date.now() - index * 60_000).toISOString(),
      version: 1,
      archived: false,
      items: [{ _id: id }],
    };
  });
}

/**
 * Intercepta solo las búsquedas `perf-<cantidad>` de la bandeja y responde con
 * el mismo tamaño de página que la app (50). Así la medición reproduce la
 * acumulación real de "Cargar más" y no un único payload gigante.
 */
async function stubOrdersBySearch(page: Page): Promise<void> {
  await page.route('**/api/orders**', async (route) => {
    const url = new URL(route.request().url());

    if (url.pathname !== '/api/orders') {
      await route.continue();
      return;
    }

    const match = /^perf-(200|300|500)/.exec(url.searchParams.get('search') ?? '');
    if (!match) {
      await route.continue();
      return;
    }

    const total = Number(match[1]);
    const offset = Number(url.searchParams.get('cursor') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 50);
    const orders = buildOrders(total).slice(offset, offset + limit);
    const nextOffset = offset + orders.length;
    const hasMore = nextOffset < total;

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        orders,
        pagination: {
          mode: 'cursor',
          limit,
          hasMore,
          nextCursor: hasMore ? String(nextOffset) : null,
          ...(offset === 0 ? { total } : {}),
        },
      }),
    });
  });
}

function loadedOrders(page: Page): Promise<number> {
  return page
    .locator('[data-loaded-orders]')
    .getAttribute('data-loaded-orders')
    .then((value) => Number(value ?? 0));
}

/** Carga las páginas usando el "Cargar más" real, de a bloques de 50. */
async function loadCardsByPages(page: Page, count: number): Promise<void> {
  const input = page.getByPlaceholder(/Buscar por cliente/);
  await input.fill(`perf-${count}`);

  // La primera página reemplaza la búsqueda anterior.
  await expect.poll(() => loadedOrders(page), { timeout: 30_000 }).toBe(Math.min(50, count));

  while ((await loadedOrders(page)) < count) {
    const before = await loadedOrders(page);
    await page.getByRole('button', { name: /Cargar más pedidos/ }).click();
    await expect.poll(() => loadedOrders(page), { timeout: 15_000 }).toBeGreaterThan(before);
  }
}

async function instrumentPage(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__longTasks = [];
    window.__resetLongTasks = () => {
      window.__longTasks = [];
    };

    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__longTasks?.push({ start: entry.startTime, duration: entry.duration });
      }
    }).observe({ type: 'longtask', buffered: true });

    // Permite simular visibilitychange de forma determinista, sin depender de
    // que el runner abra otra pestaña.
    let hidden = false;
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => hidden,
    });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (hidden ? 'hidden' : 'visible'),
    });
    window.__setDocumentHidden = (value: boolean) => {
      hidden = value;
      document.dispatchEvent(new Event('visibilitychange'));
    };
  });
}

async function readListMetrics(page: Page, expectedCards: number) {
  await loadCardsByPages(page, expectedCards);
  await page.waitForTimeout(500);

  return page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-order-card]'));
    const scrolling = document.scrollingElement ?? document.documentElement;
    const longTasks = window.__longTasks ?? [];
    const durations = longTasks.map((task) => task.duration);

    return {
      cards: cards.length,
      loadedOrders: Number(
        document.querySelector('[data-loaded-orders]')?.getAttribute('data-loaded-orders') ?? 0,
      ),
      domNodes: document.querySelectorAll('*').length,
      scrollHeight: scrolling.scrollHeight,
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      scrollbarGutter: getComputedStyle(document.documentElement).scrollbarGutter,
      contentVisibility: Array.from(
        new Set(cards.slice(0, 25).map((card) => getComputedStyle(card).contentVisibility)),
      ),
      longTaskCount: durations.length,
      maxLongTaskMs: durations.length === 0 ? 0 : Math.round(Math.max(...durations)),
    };
  });
}

test.describe('Rendimiento de listas largas', () => {
  test('200 y 500 tarjetas: DOM, content-visibility y scroll estable', async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);

    await instrumentPage(page);
    await stubOrdersBySearch(page);
    await loginAs(page, E2E_USERS.seller);
    await page.goto('/orders');
    await expect(page.getByRole('heading', { name: 'Historial de Mis Pedidos' })).toBeVisible();

    const results: Record<string, Awaited<ReturnType<typeof readListMetrics>>> = {};

    for (const count of [200, 500] as const) {
      await page.evaluate(() => window.__resetLongTasks?.());

      const metrics = await readListMetrics(page, count);

      expect(metrics.loadedOrders, `${count} pedidos cargados`).toBe(count);
      expect(metrics.cards, `${count}: ventana de DOM acotada`).toBe(Math.min(count, 200));
      expect(metrics.scrollWidth, `${count}: sin overflow horizontal`).toBeLessThanOrEqual(
        metrics.viewportWidth,
      );
      expect(metrics.scrollbarGutter, `${count}: gutter estable`).toBe('stable');
      expect(metrics.contentVisibility, `${count}: content-visibility`).toEqual(['auto']);
      expect(
        metrics.maxLongTaskMs,
        `${count}: la acumulación acotada no debe bloquear el hilo principal`,
      ).toBeLessThan(LONG_TASK_BUDGET_MS);

      // El scroll llega al final y se mantiene allí: el alto estimado de las
      // tarjetas no cambia debajo del usuario.
      const scrollState = await page.evaluate(async () => {
        const scrolling = document.scrollingElement ?? document.documentElement;
        scrolling.scrollTop = scrolling.scrollHeight;
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
        return {
          y: window.scrollY,
          maxY: scrolling.scrollHeight - window.innerHeight,
          height: scrolling.scrollHeight,
        };
      });

      expect(scrollState.height, `${count}: alto del documento`).toBeGreaterThan(0);
      expect(scrollState.y, `${count}: llega al final del scroll`).toBeGreaterThan(0);
      expect(
        Math.abs(scrollState.y - scrollState.maxY),
        `${count}: el scroll no salta al pintar tarjetas fuera de pantalla`,
      ).toBeLessThanOrEqual(4);

      results[String(count)] = { ...metrics, ...scrollState };
    }

    console.log('[perf-listas]', JSON.stringify(results, null, 2));
    await testInfo.attach('lists-200-500.json', {
      body: JSON.stringify(results, null, 2),
      contentType: 'application/json',
    });
  });

  test('el catálogo aplica content-visibility en fila y tarjeta', async ({ page }) => {
    await loginAs(page, E2E_USERS.seller);
    await page.goto('/orders/new');
    await expect(page.getByRole('heading', { name: 'Nuevo pedido' })).toBeVisible();

    const search = page.getByPlaceholder('Buscar producto por nombre o código...');
    await search.fill('E2E-PROD-001');

    const row = page.locator('tr.cv-table-row').first();
    await expect(row).toBeVisible();
    await expect
      .poll(() => row.evaluate((element) => getComputedStyle(element).contentVisibility))
      .toBe('auto');

    await page.setViewportSize({ width: 390, height: 844 });
    const card = page.locator('div.cv-product-card').first();
    await expect(card).toBeVisible();
    await expect
      .poll(() => card.evaluate((element) => getComputedStyle(element).contentVisibility))
      .toBe('auto');
  });

  test('tipear con 300 pedidos no bloquea la UI', async ({ page }, testInfo) => {
    test.setTimeout(120_000);

    await instrumentPage(page);
    await stubOrdersBySearch(page);
    await loginAs(page, E2E_USERS.seller);
    await page.goto('/orders');
    await expect(page.getByRole('heading', { name: 'Historial de Mis Pedidos' })).toBeVisible();

    await loadCardsByPages(page, 300);
    await page.waitForTimeout(500);

    const loadedBeforeTyping = await loadedOrders(page);
    const renderedBeforeTyping = await page.locator('[data-order-card]').count();

    // Se mide la ventana de tipeo, antes de que el debounce de 300 ms dispare
    // la búsqueda: lo que se evalúa es la respuesta de las teclas, no el
    // reemplazo de resultados.
    await page.evaluate(() => window.__resetLongTasks?.());
    const input = page.getByPlaceholder(/Buscar por cliente/);
    await input.click();
    await input.pressSequentially('abc', { delay: 25 });
    await expect(input).toHaveValue('perf-300abc');
    await page.waitForTimeout(200);

    const typingMetrics = await page.evaluate(() => {
      const longTasks = window.__longTasks ?? [];
      const durations = longTasks.map((task) => task.duration);

      return {
        cards: document.querySelectorAll('[data-order-card]').length,
        longTaskCount: durations.length,
        maxLongTaskMs: durations.length === 0 ? 0 : Math.round(Math.max(...durations)),
        totalLongTaskMs: Math.round(durations.reduce((total, duration) => total + duration, 0)),
      };
    });

    // La búsqueda real (50 resultados) se pinta después del debounce.
    await page.waitForTimeout(700);
    const searchMetrics = await page.evaluate(() => {
      const longTasks = window.__longTasks ?? [];
      const durations = longTasks.map((task) => task.duration);

      return {
        cards: document.querySelectorAll('[data-order-card]').length,
        maxLongTaskMs: durations.length === 0 ? 0 : Math.round(Math.max(...durations)),
      };
    });

    const metrics = {
      loadedBeforeTyping,
      renderedBeforeTyping,
      typing: typingMetrics,
      searchResponse: searchMetrics,
    };
    console.log('[perf-tipeo-300]', JSON.stringify(metrics, null, 2));
    await testInfo.attach('typing-300-orders.json', {
      body: JSON.stringify(metrics, null, 2),
      contentType: 'application/json',
    });

    expect(loadedBeforeTyping).toBe(300);
    expect(renderedBeforeTyping).toBe(200);
    expect(typingMetrics.cards).toBeLessThanOrEqual(200);
    expect(
      typingMetrics.maxLongTaskMs,
      'ninguna tecla debe generar una long task mayor al presupuesto de INP',
    ).toBeLessThan(LONG_TASK_BUDGET_MS);
  });

  test('al volver a primer plano reabre el SSE', async ({ page }) => {
    test.setTimeout(60_000);

    await instrumentPage(page);

    const sseRequests: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/events') sseRequests.push(request.url());
    });

    await loginAs(page, E2E_USERS.deposit);
    await page.goto('/deposit/orders');
    await expect(
      page.getByRole('heading', { name: 'Pedidos Pendientes de Picking' }),
    ).toBeVisible();
    await expect.poll(() => sseRequests.length, { timeout: 15_000 }).toBeGreaterThan(0);

    await page.evaluate(() => window.__setDocumentHidden?.(true));
    await page.waitForTimeout(500);
    const beforeReopen = sseRequests.length;

    await page.evaluate(() => window.__setDocumentHidden?.(false));

    await expect.poll(() => sseRequests.length, { timeout: 10_000 }).toBeGreaterThan(beforeReopen);
  });

  test('la pestaña oculta no consulta notificaciones ni reconecta SSE', async ({ page }) => {
    test.setTimeout(90_000);

    await instrumentPage(page);
    // Fuerza el peor caso: sin SSE el respaldo rápido es de 10 s.
    await page.route('**/api/events', (route) => route.abort());

    const requests: string[] = [];

    page.on('request', (request) => {
      const pathname = new URL(request.url()).pathname;
      if (pathname === '/api/events' || pathname.includes('notifications')) {
        requests.push(pathname);
      }
    });

    await loginAs(page, E2E_USERS.deposit);
    await page.goto('/deposit/orders');
    await expect(
      page.getByRole('heading', { name: 'Pedidos Pendientes de Picking' }),
    ).toBeVisible();

    // La campana hace su primera consulta y el SSE falla (ruta abortada).
    await expect
      .poll(() => requests.filter((pathname) => pathname === '/api/users/notifications').length, {
        timeout: 20_000,
      })
      .toBeGreaterThan(0);
    await page.waitForTimeout(1_000);

    await page.evaluate(() => window.__setDocumentHidden?.(true));
    requests.length = 0;

    await page.waitForTimeout(HIDDEN_OBSERVATION_MS);

    expect(requests, 'con la pestaña oculta no debe haber requests de notificaciones/SSE').toEqual(
      [],
    );

    await page.evaluate(() => window.__setDocumentHidden?.(false));

    await expect
      .poll(() => requests.filter((pathname) => pathname === '/api/users/notifications').length, {
        timeout: 10_000,
      })
      .toBeGreaterThan(0);
  });
});
