import { expect, test, type Page } from '@playwright/test';
import { E2E_CLIENTS, E2E_PRODUCTS, E2E_USERS, type E2EClient } from './fixtures';
import {
  clientIdByCode,
  deleteOrderAsAdmin,
  loginAs,
  waitForOfflineSyncReady,
  waitForReactHydration,
  type OrderLineInput,
} from './helpers';

/**
 * Escrituras móviles con red inestable.
 *
 * Un POST/PUT que nunca responde debe vencer por timeout y encolarse en
 * IndexedDB (nunca dejar la UI esperando indefinidamente). Los comentarios de
 * depósito que fallan por red se conservan en localStorage y se reenvían con
 * el próximo guardado del picking.
 */
test.describe('Escrituras móviles con red colgada', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('un POST colgado se encola en menos de 20 s y queda en IndexedDB', async ({ page }) => {
    const client = E2E_CLIENTS.offline;
    const routeControl: { release: () => void } = { release: () => {} };

    try {
      await loginAs(page, E2E_USERS.seller);
      await fillMobileOrderForm(page, client, {
        code: E2E_PRODUCTS.primary.code,
        quantity: 3,
      });

      const routeReleased = new Promise<void>((resolve) => {
        routeControl.release = resolve;
      });

      await page.route('**/api/orders', async (route) => {
        const request = route.request();
        if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/orders') {
          // Red colgada: no se responde hasta que el cliente vence por timeout.
          await routeReleased;
          await route.abort('failed').catch(() => {});
          return;
        }
        await route.continue();
      });

      const startedAt = Date.now();
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Guardar Pedido (Borrador)' })
        .click();

      const banner = page.getByTestId('offline-order-pending');
      await expect(banner).toBeVisible({ timeout: 20_000 });
      await expect(banner).toContainText('Pendiente de sincronizar');
      expect(Date.now() - startedAt).toBeLessThan(20_000);

      const entries = await page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('sgi-offline', 2);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });

        const records = await new Promise<unknown[]>((resolve, reject) => {
          const transaction = db.transaction('order-queue', 'readonly');
          const request = transaction.objectStore('order-queue').getAll();
          request.onsuccess = () => resolve(request.result as unknown[]);
          request.onerror = () => reject(request.error);
        });

        db.close();
        return records as Array<{
          kind: string;
          status: string;
          clientRequestId?: string;
        }>;
      });

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ kind: 'create', status: 'pending' });
      expect(entries[0].clientRequestId).toBeTruthy();
    } finally {
      routeControl.release();
    }
  });

  test('un comentario de depósito sin red se conserva al recargar y viaja en el próximo PUT', async ({
    page,
    request,
  }) => {
    const client = E2E_CLIENTS.offline;
    const comment = `Comentario offline ${Date.now()}`;
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
          clientRequestId: `e2e-offline-comment-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        },
      });
      expect(creation.status()).toBe(200);
      orderId = ((await creation.json()) as { order: { _id: string } }).order._id;

      await loginAs(page, E2E_USERS.deposit);
      await page.goto(`/deposit/orders/${orderId}`);
      await expect(
        page.getByRole('heading', { name: 'Listado de Productos a Controlar' }),
      ).toBeVisible();
      // El HTML server-first pinta antes de que React hidrate; escribir y
      // tocar el botón en ese lapso no dispara el handler.
      await waitForReactHydration(page, 'textarea');
      await waitForOfflineSyncReady(page);

      await page.context().setOffline(true);
      await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);

      const commentBox = page.getByPlaceholder('Escribe un comentario u observación...');
      await commentBox.fill(comment);
      const saveCommentButton = page.getByRole('button', { name: 'Guardar Comentario' });
      await expect(saveCommentButton).toBeEnabled();
      // La barra fija de acciones tapa el borde inferior: se deja el botón
      // arriba de ella antes de tocar.
      await saveCommentButton.evaluate((button) => {
        const rect = button.getBoundingClientRect();
        window.scrollBy(0, rect.bottom - window.innerHeight + 120);
      });
      await saveCommentButton.click();

      // El fallo de red no pierde el texto: queda en el autosave local.
      await expect(page.getByTestId('deposit-pending-comment')).toBeVisible();
      await expect(commentBox).toHaveValue(comment);

      // Al reconectar, la app reintenta el comentario automáticamente. Para
      // verificar que el texto sobrevive a la recarga, se aborta ese PUT hasta
      // después de comprobar el aviso local; luego se libera la ruta.
      const orderApiPattern = `**/api/orders/${orderId}`;
      await page.route(orderApiPattern, async (route) => {
        if (route.request().method() === 'PUT') {
          await route.abort('failed');
          return;
        }
        await route.continue();
      });

      await page.context().setOffline(false);
      await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);
      await page.reload();

      await expect(
        page.getByRole('heading', { name: 'Listado de Productos a Controlar' }),
      ).toBeVisible();
      await waitForReactHydration(page, 'textarea');
      await expect(page.getByTestId('deposit-pending-comment')).toBeVisible();
      await expect(page.getByPlaceholder('Escribe un comentario u observación...')).toHaveValue(
        comment,
      );

      await page.unroute(orderApiPattern);

      // El siguiente guardado del picking reenvía el comentario en el mismo PUT.
      const putRequestPromise = page.waitForRequest(
        (putRequest) =>
          putRequest.method() === 'PUT' &&
          new URL(putRequest.url()).pathname === `/api/orders/${orderId}`,
      );

      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page
        .getByTestId('deposit-action-bar')
        .getByRole('button', { name: 'Aprobar', exact: true })
        .click();

      const putRequest = await putRequestPromise;
      const body = putRequest.postDataJSON() as { comment?: string };
      expect(body.comment).toBe(comment);
    } finally {
      if (orderId) await deleteOrderAsAdmin(request, orderId);
    }
  });

  test('editar un borrador en /orders/[id]/edit sin red encola el PUT en OfflineSyncIndicator y lo sincroniza al volver online', async ({
    page,
    request,
  }) => {
    const client = E2E_CLIENTS.offline;
    const primary = E2E_PRODUCTS.primary;
    let orderId: string | null = null;

    await loginAs(page, E2E_USERS.seller);

    try {
      const clientId = await clientIdByCode(page, client.code);
      const productId = await productIdByCode(page, primary.code);

      const creation = await page.request.post('/api/orders', {
        data: {
          clientId,
          items: [{ productId, requestedQuantity: 2 }],
          invoiceType: 'A',
          paymentCondition: 'contado',
          clientRequestId: `e2e-offline-draft-edit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        },
      });
      expect(creation.status()).toBe(200);
      orderId = ((await creation.json()) as { order: { _id: string } }).order._id;

      await page.goto(`/orders/${orderId}/edit`);
      await expect(page.getByRole('heading', { name: 'Editar pedido' })).toBeVisible();
      await expect(page.getByTestId('selected-products-filter')).toHaveText('Seleccionados (1)');

      const editCommercialSummary = page.getByTestId('mobile-commercial-summary');
      await editCommercialSummary
        .getByRole('button', { name: 'Editar condición / descuentos' })
        .click();
      await page.getByLabel('Tipo de factura').filter({ visible: true }).selectOption('B');

      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.evaluate(() => document.querySelector('nextjs-portal')?.remove());
      await page.getByTestId('mobile-cart-button').click();

      const editSummary = page.getByRole('dialog');
      const primaryLine = editSummary
        .getByTestId('selected-order-item')
        .filter({ hasText: primary.code });
      const primaryQuantity = primaryLine.getByRole('spinbutton', {
        name: `Cantidad en el pedido de ${primary.name}`,
      });
      await expect(primaryQuantity).toHaveValue('2');
      await primaryLine
        .getByRole('button', { name: `Sumar una unidad del pedido para ${primary.name}` })
        .click();
      await expect(primaryQuantity).toHaveValue('3');

      // El autoguardado de edición usa la clave aislada `:edit:${orderId}`.
      await expect
        .poll(() =>
          page.evaluate((id) => {
            return Object.keys(window.localStorage).some(
              (key) => key.startsWith('sgi_order_draft:') && key.endsWith(`:edit:${id}`),
            );
          }, orderId),
        )
        .toBe(true);

      await waitForOfflineSyncReady(page);
      await page.context().setOffline(true);
      await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);

      await editSummary.getByRole('button', { name: 'Guardar Cambios' }).click();

      const indicator = page.getByTestId('offline-sync-indicator');
      await expect(indicator).toBeVisible();
      await expect(indicator).toContainText(/1 cambio pendiente/i);

      // Al encolarse se limpia el borrador de edición local.
      expect(
        await page.evaluate((id) => {
          return Object.keys(window.localStorage).some(
            (key) => key.startsWith('sgi_order_draft:') && key.endsWith(`:edit:${id}`),
          );
        }, orderId),
      ).toBe(false);

      await indicator.click();
      const queueDialog = page.getByRole('dialog', { name: 'Cola de sincronización' });
      await expect(queueDialog).toBeVisible();
      await expect(
        page.getByTestId('offline-queue-item').filter({ hasText: 'Edición de borrador #' }),
      ).toBeVisible();
      await queueDialog.getByRole('button', { name: 'Cerrar cola de sincronización' }).click();

      await page.context().setOffline(false);
      await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);

      await expect(indicator).toBeHidden({ timeout: 30_000 });
      await expect(page).toHaveURL(new RegExp(`/orders/${orderId}$`), { timeout: 30_000 });

      const updatedDetail = await page.request.get(`/api/orders/${orderId}`);
      expect(updatedDetail.status()).toBe(200);
      const updatedOrder = (await updatedDetail.json()) as {
        order: {
          status: string;
          invoiceType?: string;
          items: Array<{ requestedQuantity: number }>;
        };
      };
      expect(updatedOrder.order.status).toBe('borrador');
      expect(updatedOrder.order.invoiceType).toBe('B');
      expect(updatedOrder.order.items.map((item) => item.requestedQuantity)).toEqual([3]);
    } finally {
      await page
        .context()
        .setOffline(false)
        .catch(() => {});
      if (orderId) await deleteOrderAsAdmin(request, orderId);
    }
  });
});

/** Alta móvil: hoja de cliente, datos comerciales, producto y resumen. */
async function fillMobileOrderForm(
  page: Page,
  client: E2EClient,
  line: OrderLineInput,
): Promise<void> {
  await page.goto('/orders/new');
  await expect(page.getByRole('heading', { name: /Nuevo pedido/ })).toBeVisible();

  await page.getByRole('button', { name: /Seleccionar cliente/ }).click();
  const clientDialog = page.getByRole('dialog');
  await expect(clientDialog.getByRole('heading', { name: 'Seleccionar Cliente' })).toBeVisible();
  await clientDialog.getByPlaceholder('Buscar por código, nombre o localidad...').fill(client.code);
  await clientDialog
    .getByRole('button', { name: new RegExp(`${client.code} - ${client.name}`) })
    .click();
  await expect(clientDialog).toBeHidden();

  const invoiceSelect = page.getByLabel('Tipo de factura').filter({ visible: true });
  const commercialSummary = page.getByTestId('mobile-commercial-summary');
  await expect(invoiceSelect.or(commercialSummary)).toBeVisible();

  if (!(await invoiceSelect.isVisible())) {
    await commercialSummary.getByRole('button', { name: 'Editar condición / descuentos' }).click();
  }

  await invoiceSelect.selectOption('A');
  await page.getByLabel('Condición de pago').filter({ visible: true }).selectOption('contado');

  const productSearch = page.getByPlaceholder('Buscar producto por nombre o código...');
  await productSearch.fill(line.code);

  const card = page.locator('.cv-product-card').filter({ hasText: line.code });
  await expect(card).toBeVisible();
  const quantity = card.getByRole('spinbutton', {
    name: /^Cantidad en el catálogo de/,
  });
  await quantity.fill(String(line.quantity));
  await expect(quantity).toHaveValue(String(line.quantity));

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  // El overlay de desarrollo de Next puede interceptar el toque en mobile.
  await page.evaluate(() => document.querySelector('nextjs-portal')?.remove());
  await page.getByTestId('mobile-cart-button').click();
  await expect(
    page.getByRole('dialog').getByRole('heading', { name: /Resumen y Guardar Pedido/ }),
  ).toBeVisible();
}

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
