import { expect, test, type Page } from '@playwright/test';
import { E2E_CLIENTS, E2E_PRODUCTS, E2E_USERS } from './fixtures';
import { clientIdByCode, deleteOrderAsAdmin, loginAs, waitForReactHydration } from './helpers';

/**
 * Progreso que no debe perderse cuando la red móvil se corta justo después de
 * una escritura: control post-factura por línea y comentarios del vendedor.
 * Ambos se guardan en localStorage y se reintentan al recuperar conexión.
 */
test.describe('Pendientes offline de control y comentarios', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('el control post-factura sin red conserva el OK y se sincroniza al volver online', async ({
    page,
    request,
    context,
  }) => {
    const client = E2E_CLIENTS.offline;
    let orderId: string | null = null;

    await loginAs(page, E2E_USERS.seller);

    try {
      const clientId = await clientIdByCode(page, client.code);
      const productId = await productIdByCode(page, E2E_PRODUCTS.primary.code);

      const creation = await page.request.post('/api/orders', {
        data: {
          clientId,
          items: [{ productId, requestedQuantity: 2 }],
          invoiceType: 'A',
          paymentCondition: 'contado',
          clientRequestId: `e2e-pending-post-control-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        },
      });
      expect(creation.status()).toBe(200);
      orderId = ((await creation.json()) as { order: { _id: string } }).order._id;

      // Depósito controla la línea y envía el pedido a facturación por API.
      await loginAs(page, E2E_USERS.deposit);
      const detail = await page.request.get(`/api/orders/${orderId}`);
      expect(detail.status()).toBe(200);
      const { order } = (await detail.json()) as {
        order: {
          version?: number;
          items: Array<{
            _id: string;
            productId?: { _id?: string } | string;
            requestedQuantity: number;
          }>;
        };
      };

      const approval = await page.request.put(`/api/orders/${orderId}`, {
        data: {
          version: order.version ?? 0,
          status: 'facturacion',
          items: order.items.map((item) => ({
            _id: item._id,
            productId: typeof item.productId === 'string' ? item.productId : item.productId?._id,
            requestedQuantity: item.requestedQuantity,
            verifiedQuantity: item.requestedQuantity,
            isPending: false,
          })),
        },
      });
      expect(approval.status()).toBe(200);

      await loginAs(page, E2E_USERS.billing);
      await page.goto(`/billing/orders/${orderId}`);

      const group = page.getByRole('group', { name: 'Control post-factura de la línea' }).first();
      await expect(group).toBeVisible();
      const okButton = group.getByRole('button', { name: 'OK', exact: true });
      await expect(okButton).toBeVisible();

      await context.setOffline(true);
      await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);

      await okButton.click();

      // El microcorte no revierte la línea: queda OK y aparece el aviso local.
      await expect(okButton).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('billing-pending-post-control')).toBeVisible();
      expect(
        await page.evaluate(() =>
          Object.keys(window.localStorage).some((key) =>
            key.startsWith('sgi_post_control_pending:'),
          ),
        ),
      ).toBe(true);

      await context.setOffline(false);
      await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);

      await expect(page.getByTestId('billing-pending-post-control')).toBeHidden({
        timeout: 30_000,
      });
      await expect(okButton).toHaveAttribute('aria-pressed', 'true');

      const persisted = await page.request.get(`/api/orders/${orderId}`);
      expect(persisted.status()).toBe(200);
      const persistedOrder = (await persisted.json()) as {
        order: { items: Array<{ postControl?: string }> };
      };
      expect(persistedOrder.order.items[0].postControl).toBe('ok');
    } finally {
      await context.setOffline(false).catch(() => {});
      if (orderId) await deleteOrderAsAdmin(request, orderId);
    }
  });

  test('el comentario del vendedor sin red sobrevive la recarga y se sincroniza al reconectar', async ({
    page,
    request,
    context,
  }) => {
    const client = E2E_CLIENTS.offline;
    const comment = `Comentario vendedor offline ${Date.now()}`;
    let orderId: string | null = null;

    await loginAs(page, E2E_USERS.seller);

    try {
      const clientId = await clientIdByCode(page, client.code);
      const productId = await productIdByCode(page, E2E_PRODUCTS.primary.code);

      const creation = await page.request.post('/api/orders', {
        data: {
          clientId,
          items: [{ productId, requestedQuantity: 1 }],
          invoiceType: 'A',
          paymentCondition: 'contado',
          clientRequestId: `e2e-offline-vendor-comment-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        },
      });
      expect(creation.status()).toBe(200);
      orderId = ((await creation.json()) as { order: { _id: string } }).order._id;

      await page.goto(`/orders/${orderId}`);
      await expect(page.getByRole('heading', { name: /Pedido #/ })).toBeVisible();
      await waitForReactHydration(page, 'textarea');

      // Se simula un corte de red sólo para las escrituras del pedido: la
      // navegación y la recarga siguen funcionando.
      const orderApiPattern = `**/api/orders/${orderId}`;
      await page.route(orderApiPattern, async (route) => {
        if (route.request().method() === 'PUT') {
          await route.abort('failed');
          return;
        }
        await route.continue();
      });

      const commentBox = page.getByPlaceholder('Escribe un comentario u observación...');
      await commentBox.fill(comment);
      await page.getByRole('button', { name: 'Guardar Comentario' }).click();

      await expect(page.getByTestId('vendor-pending-comment')).toBeVisible();
      await expect(commentBox).toHaveValue(comment);
      expect(
        await page.evaluate(() =>
          Object.keys(window.localStorage).some((key) =>
            key.startsWith('sgi_pending_order_comment:'),
          ),
        ),
      ).toBe(true);

      // Al recargar, el texto y el aviso se restauran desde localStorage.
      await page.reload();
      await expect(page.getByRole('heading', { name: /Pedido #/ })).toBeVisible();
      await waitForReactHydration(page, 'textarea');
      await expect(page.getByTestId('vendor-pending-comment')).toBeVisible();
      await expect(commentBox).toHaveValue(comment);

      // Vuelve la red real: el evento `online` dispara el reintento.
      await page.unroute(orderApiPattern);
      await context.setOffline(true);
      await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
      await context.setOffline(false);
      await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);

      await expect(page.getByTestId('vendor-pending-comment')).toBeHidden({
        timeout: 30_000,
      });

      const persisted = await page.request.get(`/api/orders/${orderId}`);
      expect(persisted.status()).toBe(200);
      const persistedOrder = (await persisted.json()) as {
        order: { comments?: Array<{ text: string }> };
      };
      expect((persistedOrder.order.comments ?? []).some((entry) => entry.text === comment)).toBe(
        true,
      );
    } finally {
      await context.setOffline(false).catch(() => {});
      if (orderId) await deleteOrderAsAdmin(request, orderId);
    }
  });
});

async function productIdByCode(page: Page, code: string): Promise<string> {
  const response = await page.request.get(
    `/api/products?search=${encodeURIComponent(code)}&limit=20`,
  );
  expect(response.status()).toBe(200);

  const payload = (await response.json()) as {
    products: Array<{ _id: string; code: string }>;
  };
  const product = payload.products.find((item) => item.code === code);

  if (!product) throw new Error(`No se encontró el producto E2E ${code}`);

  return product._id;
}
