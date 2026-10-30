import { expect, test, type Page } from '@playwright/test';
import { E2E_CLIENTS, E2E_USERS, type E2EUser } from './fixtures';
import { loginAs, panelHeadingFor } from './helpers';

const CLIENT_NAME = E2E_CLIENTS.dashboard.name;

const TRAYS: Array<{
  name: string;
  user: E2EUser;
  path: string;
  heading: string;
}> = [
  {
    name: 'Mis pedidos',
    user: E2E_USERS.seller,
    path: '/orders',
    heading: 'Historial de Mis Pedidos',
  },
  {
    name: 'Depósito',
    user: E2E_USERS.deposit,
    path: '/deposit/orders',
    heading: 'Pedidos Pendientes de Picking',
  },
  {
    name: 'Facturación',
    user: E2E_USERS.billing,
    path: '/billing/orders',
    heading: 'Bandeja de Facturación y Cierre',
  },
];

function collectOrderRequests(page: Page): string[] {
  const requests: string[] = [];

  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;

    if (pathname === '/api/orders' || /^\/api\/orders\/[a-f0-9]{24}$/.test(pathname)) {
      requests.push(pathname);
    }
  });

  return requests;
}

test.describe('Bandejas y detalles server-first', () => {
  test('el HTML inicial de cada bandeja ya contiene los pedidos', async ({ page }) => {
    for (const tray of TRAYS) {
      await loginAs(page, tray.user);

      const response = await page.request.get(tray.path);
      expect(response.status(), tray.name).toBe(200);

      const html = await response.text();
      expect(html, `${tray.name} debe traer el pedido en el primer HTML`).toContain(CLIENT_NAME);
    }
  });

  test('la primera pintura no llama /api/orders y muestra las tarjetas', async ({ page }) => {
    for (const tray of TRAYS) {
      await loginAs(page, tray.user);

      const requests = collectOrderRequests(page);
      await page.goto(tray.path);

      await expect(page.getByRole('heading', { name: tray.heading })).toBeVisible();
      await expect(page.getByText(CLIENT_NAME).first()).toBeVisible();

      // Margen para el viejo fetch de montaje (hoy eliminado).
      await page.waitForTimeout(1_000);
      expect(requests, `${tray.name} no debe pedir /api/orders al hidratar`).toEqual([]);
    }
  });

  test('los detalles abren sin spinner y sin GET de montaje', async ({ page }) => {
    // "Mis pedidos" (vendedor)
    await loginAs(page, E2E_USERS.seller);
    await page.goto('/orders');
    await expect(page.getByRole('heading', { name: 'Historial de Mis Pedidos' })).toBeVisible();

    let requests = collectOrderRequests(page);
    await page.getByRole('button', { name: 'Ver Detalle del Pedido' }).first().click();
    await expect(page.getByRole('heading', { name: /Pedido #[a-f0-9]{6}/ })).toBeVisible();
    await page.waitForTimeout(750);
    await expect(page.getByText('Cargando pedido...')).toHaveCount(0);
    expect(requests).toEqual([]);

    // Depósito
    await loginAs(page, E2E_USERS.deposit);
    await page.goto('/deposit/orders');
    await expect(
      page.getByRole('heading', { name: 'Pedidos Pendientes de Picking' }),
    ).toBeVisible();

    requests = collectOrderRequests(page);
    await page.getByRole('button', { name: 'Ver / Verificar Pedido' }).first().click();
    await expect(
      page.getByRole('heading', { name: 'Listado de Productos a Controlar' }),
    ).toBeVisible();
    await page.waitForTimeout(750);
    await expect(page.getByText('Cargando detalles...')).toHaveCount(0);
    await expect(page.getByTestId('picking-restore-banner')).toHaveCount(0);
    expect(requests).toEqual([]);

    // Facturación
    await loginAs(page, E2E_USERS.billing);
    await page.goto('/billing/orders');
    await expect(
      page.getByRole('heading', { name: 'Bandeja de Facturación y Cierre' }),
    ).toBeVisible();

    requests = collectOrderRequests(page);
    await page.getByRole('button', { name: 'Ver Datos Estructurados' }).first().click();
    await expect(page.getByRole('heading', { name: /Datos Estructurados/ })).toBeVisible();
    await page.waitForTimeout(750);
    await expect(page.getByText('Cargando datos estructurados...')).toHaveCount(0);
    expect(requests).toEqual([]);
  });

  test('cada rol sólo entra a sus bandejas y el admin a todas', async ({ page }) => {
    const forbidden = [
      { user: E2E_USERS.seller, paths: ['/deposit/orders', '/billing/orders'] },
      { user: E2E_USERS.deposit, paths: ['/orders', '/billing/orders'] },
      { user: E2E_USERS.billing, paths: ['/orders', '/deposit/orders'] },
    ];

    for (const entry of forbidden) {
      await loginAs(page, entry.user);

      for (const path of entry.paths) {
        await page.goto(path);
        await expect(page).toHaveURL(/\/$/);
        await expect(
          page.getByRole('heading', { name: panelHeadingFor(entry.user) }),
        ).toBeVisible();
      }
    }

    await loginAs(page, E2E_USERS.admin);

    for (const tray of TRAYS) {
      const response = await page.request.get(tray.path);
      expect(response.status(), `admin en ${tray.name}`).toBe(200);
      expect(await response.text()).toContain(CLIENT_NAME);
    }
  });

  test('mide TTFB y LCP de las bandejas server-first', async ({ page }, testInfo) => {
    await page.addInitScript(() => {
      const target = window as Window & { __lcpMs?: number };
      target.__lcpMs = 0;

      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) target.__lcpMs = entry.startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    });

    const measurements: Record<string, { ttfbMs: number; lcpMs: number }> = {};

    for (const tray of TRAYS) {
      await loginAs(page, tray.user);
      await page.goto(tray.path);
      await expect(page.getByRole('heading', { name: tray.heading })).toBeVisible();
      await page.waitForTimeout(1_000);

      measurements[tray.path] = await page.evaluate(() => {
        const navigation = performance.getEntriesByType('navigation')[0] as
          PerformanceNavigationTiming | undefined;
        const target = window as Window & { __lcpMs?: number };

        return {
          ttfbMs: Math.round(navigation?.responseStart ?? 0),
          lcpMs: Math.round(target.__lcpMs ?? 0),
        };
      });

      expect(measurements[tray.path].ttfbMs, `${tray.name} TTFB`).toBeGreaterThan(0);
      expect(measurements[tray.path].lcpMs, `${tray.name} LCP`).toBeGreaterThan(0);
      console.log(
        `[server-first] ${tray.path} → TTFB ${measurements[tray.path].ttfbMs} ms · LCP ${measurements[tray.path].lcpMs} ms`,
      );
    }

    await testInfo.attach('orders-web-vitals.json', {
      body: JSON.stringify(measurements, null, 2),
      contentType: 'application/json',
    });
  });
});
