import { expect, test } from '@playwright/test';
import { E2E_CLIENTS, E2E_PRODUCTS, E2E_USERS } from './fixtures';
import { expectNoSeriousA11yViolations } from './a11y';
import { createOrder, deleteOrderAsAdmin, loginAs, openDepositOrder } from './helpers';

test.describe('Accesibilidad (axe)', () => {
  test('login sin violaciones serious/critical', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Ingresar al sistema' })).toBeVisible();

    await expectNoSeriousA11yViolations(page, 'login');
  });

  test('alta de pedido sin violaciones serious/critical', async ({ page }) => {
    await loginAs(page, E2E_USERS.seller);
    await page.goto('/orders/new');
    await expect(page.getByRole('heading', { name: 'Nuevo pedido' })).toBeVisible();

    await expectNoSeriousA11yViolations(page, 'alta de pedido');
  });

  test('bandejas de vendedor, depósito y facturación', async ({ page }) => {
    await loginAs(page, E2E_USERS.seller);
    await page.goto('/orders');
    await expect(page.getByRole('heading', { name: 'Historial de Mis Pedidos' })).toBeVisible();
    await expectNoSeriousA11yViolations(page, 'bandeja de vendedor');

    await loginAs(page, E2E_USERS.deposit);
    await page.goto('/deposit/orders');
    await expect(
      page.getByRole('heading', { name: 'Pedidos Pendientes de Picking' }),
    ).toBeVisible();
    await expectNoSeriousA11yViolations(page, 'bandeja de depósito');

    await loginAs(page, E2E_USERS.billing);
    await page.goto('/billing/orders');
    await expect(
      page.getByRole('heading', { name: 'Bandeja de Facturación y Cierre' }),
    ).toBeVisible();
    await expectNoSeriousA11yViolations(page, 'bandeja de facturación');
  });

  test('modales de alta de producto y confirmación', async ({ page, request }) => {
    await loginAs(page, E2E_USERS.seller);
    await createOrder(page, E2E_CLIENTS.postControl, [
      { code: E2E_PRODUCTS.primary.code, quantity: 1 },
    ]);

    await loginAs(page, E2E_USERS.deposit);
    const orderId = await openDepositOrder(page, E2E_CLIENTS.postControl.name);

    try {
      await page.getByRole('button', { name: 'Agregar Producto' }).click();
      const addDialog = page.getByRole('dialog', { name: 'Agregar Producto al Pedido' });
      await expect(addDialog).toBeVisible();
      await expectNoSeriousA11yViolations(page, 'modal de agregar producto');

      await page.keyboard.press('Escape');
      await expect(addDialog).toBeHidden();

      await page.locator('table').getByTitle('Eliminar ítem').first().click();
      const confirmDialog = page.getByRole('dialog', {
        name: 'Eliminar producto del pedido',
      });
      await expect(confirmDialog).toBeVisible();
      await expectNoSeriousA11yViolations(page, 'modal de confirmación');

      await page.keyboard.press('Escape');
      await expect(confirmDialog).toBeHidden();
    } finally {
      await deleteOrderAsAdmin(request, orderId);
    }
  });
});
