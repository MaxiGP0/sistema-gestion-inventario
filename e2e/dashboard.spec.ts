import { expect, test, type Locator, type Page } from '@playwright/test';
import { E2E_CLIENTS, E2E_DASHBOARD_TOTALS, E2E_USERS } from './fixtures';
import { loginAs } from './helpers';

/**
 * El panel se renderiza en el servidor: al aterrizar ya deben estar los KPIs,
 * las colas del rol y los últimos pedidos. Estos tests cubren el alcance por
 * rol (vendedor sólo ve lo propio y no ve importes) y los accesos directos.
 */

const countCard = (page: Page, status: string) => page.getByTestId(`dashboard-count-${status}`);

/** Posición vertical del elemento; falla si no está renderizado. */
async function topOf(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();

  expect(box).not.toBeNull();

  return box!.y;
}

test.describe('Panel operativo', () => {
  test('muestra "Accesos directos" antes que "Pulso de hoy"', async ({ page }) => {
    await loginAs(page, E2E_USERS.seller);

    const accessHeading = page.getByRole('heading', { level: 3, name: 'Accesos directos' });
    const todayHeading = page.getByRole('heading', { level: 3, name: 'Pulso de hoy' });
    const queuesHeading = page.getByRole('heading', { level: 3, name: 'Colas por estado' });

    await expect(accessHeading).toBeVisible();
    await expect(todayHeading).toBeVisible();
    await expect(queuesHeading).toBeVisible();

    // El orden visual debe respetar: accesos, pulso y colas.
    expect(await topOf(accessHeading)).toBeLessThan(await topOf(todayHeading));
    expect(await topOf(todayHeading)).toBeLessThan(await topOf(queuesHeading));
  });

  test('el header y el nombre del usuario abren Cuenta y ajustes', async ({ page }) => {
    await loginAs(page, E2E_USERS.seller);

    await expect(page.getByRole('link', { name: 'Ajustes y cuenta' })).toBeVisible();

    const profileLink = page.getByRole('link', { name: /e2e-vendedor/ });
    await expect(profileLink).toBeVisible();
    await profileLink.click();

    await expect(page).toHaveURL(/\/settings\/notifications$/);
    await expect(page.getByRole('heading', { name: 'Cuenta y ajustes' })).toBeVisible();
    await expect(page.getByTestId('settings-current-user')).toHaveText(E2E_USERS.seller.username);
    await expect(page.getByTestId('settings-current-role')).toHaveText('Vendedor');

    await page.getByTestId('settings-tab-security').click();
    await expect(page).toHaveURL(/\/settings\/security$/);
    await expect(page.getByRole('heading', { name: 'Cambiar contraseña' })).toBeVisible();
  });

  test('vendedor ve "Ventas" primero y "Catálogo" después', async ({ page }) => {
    await loginAs(page, E2E_USERS.seller);

    const access = page.locator('section[aria-labelledby="dashboard-access"]');

    await expect(access.getByRole('heading', { level: 3 })).toHaveText('Accesos directos');
    await expect(access.getByRole('heading', { level: 4 })).toHaveText(['Ventas', 'Catálogo']);

    const links = access.getByRole('link');

    await expect(links).toHaveCount(4);
    await expect(links.nth(0)).toHaveAccessibleName('Nuevo Pedido');
    await expect(links.nth(1)).toHaveAccessibleName('Mis Pedidos');
    await expect(links.nth(2)).toHaveAccessibleName('Ver Catálogo');
    await expect(links.nth(3)).toHaveAccessibleName('Ver Clientes');
  });

  test('admin ve primero "Operación de pedidos" y luego "Catálogos"', async ({ page }) => {
    await loginAs(page, E2E_USERS.admin);

    const access = page.locator('section[aria-labelledby="dashboard-access"]');

    await expect(access.getByRole('heading', { level: 4 })).toHaveText([
      'Operación de pedidos',
      'Catálogos',
    ]);

    expect(await topOf(access.getByRole('heading', { level: 3 }))).toBeLessThan(
      await topOf(page.getByRole('heading', { level: 3, name: 'Pulso de hoy' })),
    );
  });

  test('vendedor ve sus 5 colas, sus importes propios y sólo sus últimos pedidos', async ({
    page,
  }) => {
    await loginAs(page, E2E_USERS.seller);
    const access = page.locator('section[aria-labelledby="dashboard-access"]');

    for (const status of [
      'borrador',
      'paralizado',
      'facturacion',
      'control_post_factura',
      'entregado',
    ]) {
      await expect(countCard(page, status)).toContainText('1');
    }

    await expect(page.getByTestId('dashboard-kpi-today-orders')).toHaveText(
      String(E2E_DASHBOARD_TOTALS.sellerOrders),
    );
    await expect(page.getByTestId('dashboard-kpi-queue-total')).toHaveText(
      String(E2E_DASHBOARD_TOTALS.sellerOrders),
    );

    // El panel del vendedor expone sólo los importes de sus propios pedidos.
    await expect(page.getByTestId('dashboard-kpi-today-amount')).toContainText('1.500,00');
    await expect(page.getByTestId('dashboard-latest-orders')).toContainText('$');

    // El pedido paralizado propio se ofrece como acción rápida arriba del panel.
    const paralyzedBanner = page.getByTestId('dashboard-paralyzed-banner');
    await expect(paralyzedBanner).toBeVisible();
    await expect(paralyzedBanner).toContainText('Tenés 1 pedido(s) paralizado(s) por faltantes');
    await expect(paralyzedBanner).toHaveAttribute('href', '/orders?status=paralizado');

    const latest = page.getByTestId('dashboard-latest-orders');
    await expect(latest).toContainText(E2E_CLIENTS.dashboard.name);
    await expect(latest).not.toContainText('Farmacia E2E Dashboard Admin');

    await expect(access.getByRole('link', { name: 'Nuevo Pedido', exact: true })).toHaveAttribute(
      'href',
      '/orders/new',
    );

    await countCard(page, 'borrador').click();
    await expect(page).toHaveURL(/\/orders\?status=borrador$/);
    await expect(page.getByTestId('orders-tray-status-borrador')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('controlador ve sólo las colas de depósito y sus últimos pedidos', async ({ page }) => {
    await loginAs(page, E2E_USERS.deposit);
    const access = page.locator('section[aria-labelledby="dashboard-access"]');

    await expect(countCard(page, 'borrador')).toContainText('2');
    await expect(countCard(page, 'paralizado')).toContainText('1');
    await expect(page.getByTestId('dashboard-count-facturacion')).toHaveCount(0);
    await expect(page.getByTestId('dashboard-count-entregado')).toHaveCount(0);

    await expect(page.getByTestId('dashboard-paralyzed-banner')).toHaveAttribute(
      'href',
      '/deposit/orders?status=paralizado',
    );

    await expect(page.getByTestId('dashboard-kpi-today-orders')).toHaveText(
      String(E2E_DASHBOARD_TOTALS.adminOrders),
    );
    await expect(page.getByTestId('dashboard-kpi-today-amount')).toContainText('2.100,00');

    const latest = page.getByTestId('dashboard-latest-orders');
    await expect(latest).toContainText(E2E_CLIENTS.dashboard.name);
    await expect(latest).toContainText('Farmacia E2E Dashboard Admin');
    await expect(latest).not.toContainText('Entregado');

    await expect(
      access.getByRole('link', { name: 'Bandeja de Depósito', exact: true }),
    ).toHaveAttribute('href', '/deposit/orders');
    await expect(
      access.getByRole('link', { name: 'Bandeja de Facturación', exact: true }),
    ).toHaveCount(0);
  });

  test('billing ve las colas de facturación y el monto del día', async ({ page }) => {
    await loginAs(page, E2E_USERS.billing);
    const access = page.locator('section[aria-labelledby="dashboard-access"]');

    await expect(countCard(page, 'facturacion')).toContainText('1');
    await expect(countCard(page, 'control_post_factura')).toContainText('1');
    await expect(countCard(page, 'entregado')).toContainText('1');
    await expect(page.getByTestId('dashboard-count-borrador')).toHaveCount(0);
    await expect(page.getByTestId('dashboard-count-paralizado')).toHaveCount(0);

    await expect(page.getByTestId('dashboard-kpi-today-amount')).toContainText('2.100,00');

    const latest = page.getByTestId('dashboard-latest-orders');
    await expect(latest).toContainText('Listo para facturar');
    await expect(latest).toContainText('Control post-factura');
    await expect(latest).toContainText('Entregado');
    await expect(latest).not.toContainText('Borrador');
    await expect(latest).not.toContainText('Paralizado');

    await expect(
      access.getByRole('link', { name: 'Bandeja de Facturación', exact: true }),
    ).toHaveAttribute('href', '/billing/orders');
  });

  test('admin ve todas las colas, importes y accesos directos', async ({ page }) => {
    await loginAs(page, E2E_USERS.admin);
    const access = page.locator('section[aria-labelledby="dashboard-access"]');

    await expect(countCard(page, 'borrador')).toContainText('2');
    for (const status of ['paralizado', 'facturacion', 'control_post_factura', 'entregado']) {
      await expect(countCard(page, status)).toContainText('1');
    }

    await expect(page.getByTestId('dashboard-kpi-today-orders')).toHaveText(
      String(E2E_DASHBOARD_TOTALS.adminOrders),
    );
    await expect(page.getByTestId('dashboard-kpi-today-amount')).toContainText('2.100,00');
    await expect(page.getByTestId('dashboard-kpi-queue-total')).toHaveText(
      String(E2E_DASHBOARD_TOTALS.adminOrders),
    );

    const latest = page.getByTestId('dashboard-latest-orders');
    await expect(latest).toContainText(E2E_CLIENTS.dashboard.name);
    await expect(latest).toContainText('Farmacia E2E Dashboard Admin');

    await expect(access.getByText('Catálogos', { exact: true })).toBeVisible();
    await expect(access.getByRole('link', { name: 'Usuarios', exact: true })).toHaveAttribute(
      'href',
      '/backoffice/users',
    );
    await expect(
      access.getByRole('link', { name: 'Bandeja de Depósito', exact: true }),
    ).toHaveAttribute('href', '/deposit/orders');
    await expect(
      access.getByRole('link', { name: 'Bandeja de Facturación', exact: true }),
    ).toHaveAttribute('href', '/billing/orders');
  });
});
