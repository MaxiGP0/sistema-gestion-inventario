import { expect, test } from '@playwright/test';
import { E2E_CLIENTS, E2E_PRODUCTS, E2E_USERS } from './fixtures';
import {
  approvePicking,
  createOrder,
  deleteOrderAsAdmin,
  fetchOrder,
  loginAs,
  markAllDepositItemsControlled,
  markAllPostControlOk,
  markPostControlLine,
  openBillingOrder,
  openDepositOrder,
  orderCard,
} from './helpers';

test.describe('Flujo operativo de pedidos', () => {
  test('login → alta → picking en depósito → facturación → entrega', async ({ page }) => {
    const client = E2E_CLIENTS.fullFlow;

    // 1. Vendedor: alta del pedido en estado borrador.
    await loginAs(page, E2E_USERS.seller);
    await createOrder(page, client, [
      { code: E2E_PRODUCTS.primary.code, quantity: 3 },
      { code: E2E_PRODUCTS.secondary.code, quantity: 2 },
    ]);

    // 2. Depósito: controla todas las líneas y lo envía a facturación.
    await loginAs(page, E2E_USERS.deposit);
    const orderId = await openDepositOrder(page, client.name);

    await markAllDepositItemsControlled(page);
    await approvePicking(page);

    const afterPicking = await fetchOrder(page, orderId);
    expect(afterPicking.status).toBe('facturacion');
    expect(afterPicking.items.every((item) => item.isPending === false)).toBe(true);

    // 3. Facturación: control post-factura por línea y entrega.
    await loginAs(page, E2E_USERS.billing);
    await openBillingOrder(page, client.name);

    await markAllPostControlOk(page);

    const deliverResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/orders/${orderId}` &&
        response.request().method() === 'PUT',
    );

    await page.getByRole('button', { name: 'Confirmar Despacho (Marcar como Entregado)' }).click();

    expect((await deliverResponse).status()).toBe(200);
    await expect(page.getByText('¡Estado actualizado a: ENTREGADO!')).toBeVisible();
    await expect(page).toHaveURL(/\/billing\/orders$/);

    const delivered = await fetchOrder(page, orderId);
    expect(delivered.status).toBe('entregado');

    const card = orderCard(page, client.name);
    await expect(card).toBeVisible();
    await expect(card.getByText('Entregado / Despachado', { exact: true })).toBeVisible();
  });

  test('los ítems pendientes bloquean el paso a facturación', async ({ page }) => {
    const client = E2E_CLIENTS.pending;

    // 1. Vendedor: alta de un pedido que depósito dejará pendiente.
    await loginAs(page, E2E_USERS.seller);
    await createOrder(page, client, [{ code: E2E_PRODUCTS.primary.code, quantity: 2 }]);

    // 2. Depósito: intenta enviarlo a facturación sin controlar la línea.
    await loginAs(page, E2E_USERS.deposit);
    const orderId = await openDepositOrder(page, client.name);

    await page.getByRole('button', { name: 'Aprobar y Enviar a Facturación' }).click();

    await expect(
      page.getByText(
        'No se puede pasar el pedido a facturación: hay ítems pendientes o cantidades sin verificar.',
      ),
    ).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/deposit/orders/${orderId}$`));

    // El rechazo del servidor no debe persistir el cambio de estado ni la línea.
    const blocked = await fetchOrder(page, orderId);
    expect(blocked.status).toBe('borrador');
    expect(blocked.items[0]).toMatchObject({
      requestedQuantity: 2,
      verifiedQuantity: 0,
      isPending: false,
    });

    // 3. El pedido sí puede paralizarse y queda visible en la bandeja de depósito.
    await page
      .getByRole('button', { name: 'Paralizar Pedido (Faltantes / Esperar Stock)' })
      .click();

    await expect(page.getByText(/¡Picking guardado! Estado actual: PARALIZADO/)).toBeVisible();
    await expect(page).toHaveURL(/\/deposit\/orders$/);

    const paralized = await fetchOrder(page, orderId);
    expect(paralized.status).toBe('paralizado');
    expect(paralized.items[0]).toMatchObject({
      verifiedQuantity: 0,
      isPending: true,
    });

    const card = orderCard(page, client.name);
    await expect(card).toBeVisible();
    await expect(card.getByText('Paralizado', { exact: true })).toBeVisible();
  });

  test('el control post-factura bloquea la entrega hasta controlar todas las líneas', async ({
    page,
    request,
  }) => {
    const client = E2E_CLIENTS.postControl;

    // 1. Alta con dos líneas y picking completo en depósito.
    await loginAs(page, E2E_USERS.seller);
    await createOrder(page, client, [
      { code: E2E_PRODUCTS.primary.code, quantity: 2 },
      { code: E2E_PRODUCTS.secondary.code, quantity: 1 },
    ]);

    await loginAs(page, E2E_USERS.deposit);
    const orderId = await openDepositOrder(page, client.name);
    await markAllDepositItemsControlled(page);
    await approvePicking(page);

    // 2. Facturación: la entrega está deshabilitada mientras queden líneas.
    await loginAs(page, E2E_USERS.billing);
    await openBillingOrder(page, client.name);

    const deliverButton = page.getByRole('button', {
      name: 'Confirmar Despacho (Marcar como Entregado)',
    });

    await expect(page.getByText(/Quedan 2 líneas sin controlar/)).toBeVisible();
    await expect(deliverButton).toBeDisabled();

    await markPostControlLine(page, 0);
    await expect(page.getByText(/Quedan 1 línea sin controlar/)).toBeVisible();
    await expect(deliverButton).toBeDisabled();

    // 3. El servidor también rechaza la entrega parcial, aunque se llame por API.
    const beforeAttempt = await fetchOrder(page, orderId);
    const blocked = await page.request.put(`/api/orders/${orderId}`, {
      data: { status: 'entregado', version: beforeAttempt.version },
    });
    expect(blocked.status()).toBe(409);
    const blockedPayload = (await blocked.json()) as { error: string };
    expect(blockedPayload.error).toMatch(/control post-factura/i);

    const stillPending = await fetchOrder(page, orderId);
    expect(stillPending.status).toBe('facturacion');

    // 4. Al controlar la línea restante se habilita el despacho.
    await markAllPostControlOk(page);
    await expect(page.getByText('Todas las líneas están controladas')).toBeVisible();
    await expect(deliverButton).toBeEnabled();

    const deliverResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/orders/${orderId}` &&
        response.request().method() === 'PUT',
    );

    await deliverButton.click();

    expect((await deliverResponse).status()).toBe(200);
    await expect(page.getByText('¡Estado actualizado a: ENTREGADO!')).toBeVisible();
    await expect(page).toHaveURL(/\/billing\/orders$/);

    const delivered = await fetchOrder(page, orderId);
    expect(delivered.status).toBe('entregado');

    await deleteOrderAsAdmin(request, orderId);
  });
});
