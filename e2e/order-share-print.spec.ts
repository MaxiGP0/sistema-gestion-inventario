import { expect, test, type Page } from '@playwright/test';
import { E2E_CLIENTS, E2E_PRODUCTS, E2E_USERS } from './fixtures';
import { clientIdByCode, deleteOrderAsAdmin, loginAs } from './helpers';

/**
 * Handoff móvil del pedido:
 * - El detalle del vendedor copia el resumen al portapapeles y usa la hoja
 *   nativa de compartir (`navigator.share`).
 * - Facturación expone las mismas acciones sobre el pedido ya controlado.
 * - La hoja de control se renderiza desde el servidor y no desborda en 360 px.
 */

interface SharedFileSummary {
  name: string;
  type: string;
  size: number;
}

interface ShareTestState {
  copied: string[];
  shared: Array<{ title?: string; text?: string; files: SharedFileSummary[] }>;
}

interface WindowWithShareState extends Window {
  __orderShareTest?: ShareTestState;
}

interface E2EOrderDetail {
  _id: string;
  version?: number;
  finalTotal: number;
  items: Array<{
    _id: string;
    unitPrice: number;
    requestedQuantity: number;
    verifiedQuantity: number;
    isPending: boolean;
    itemDiscount: number;
  }>;
}

const money = (value: number): string =>
  `$ ${new Intl.NumberFormat('es-AR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)}`;

/**
 * Sustituye Clipboard API y Web Share API para poder verificar el contenido
 * exacto que reciben WhatsApp/Telegram (texto o archivos) sin depender de
 * permisos del navegador.
 */
async function stubShareApis(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state: {
      copied: string[];
      shared: Array<{
        title?: string;
        text?: string;
        files: Array<{ name: string; type: string; size: number }>;
      }>;
    } = {
      copied: [],
      shared: [],
    };
    (window as Window & { __orderShareTest?: typeof state }).__orderShareTest = state;

    const fakeClipboard = {
      writeText: async (text: string) => {
        state.copied.push(text);
      },
    };

    const fakeShare = async (data: ShareData) => {
      state.shared.push({
        title: data.title,
        text: data.text,
        files: Array.from(data.files ?? []).map((file) => ({
          name: file.name,
          type: file.type,
          size: file.size,
        })),
      });
    };

    const fakeCanShare = () => true;

    const define = (target: object, property: string, value: unknown): boolean => {
      try {
        Object.defineProperty(target, property, { configurable: true, value });
        return true;
      } catch {
        return false;
      }
    };

    if (!define(navigator, 'clipboard', fakeClipboard)) {
      define(Navigator.prototype, 'clipboard', fakeClipboard);
    }
    if (!define(navigator, 'share', fakeShare)) {
      define(Navigator.prototype, 'share', fakeShare);
    }
    if (!define(navigator, 'canShare', fakeCanShare)) {
      define(Navigator.prototype, 'canShare', fakeCanShare);
    }
  });
}

async function readShareState(page: Page): Promise<ShareTestState> {
  return page.evaluate(() => {
    const state = (window as WindowWithShareState).__orderShareTest;
    if (!state) throw new Error('El stub de compartir no está instalado');

    return state;
  });
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

/** Alta real por API con descuento general del cliente y una línea de 2 unidades. */
async function createOrderForSharing(page: Page): Promise<string> {
  await loginAs(page, E2E_USERS.seller);

  const [clientId, productId] = await Promise.all([
    clientIdByCode(page, E2E_CLIENTS.fullFlow.code),
    productIdByCode(page, E2E_PRODUCTS.primary.code),
  ]);

  const creation = await page.request.post('/api/orders', {
    data: {
      clientId,
      items: [{ productId, requestedQuantity: 2 }],
      invoiceType: 'A',
      paymentCondition: 'contado',
      clientRequestId: `e2e-share-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    },
  });
  expect(creation.status()).toBe(200);

  const payload = (await creation.json()) as { order: { _id: string } };
  return payload.order._id;
}

async function expectNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const metrics = await page.evaluate(() => {
    const viewportWidth = window.innerWidth;

    const offenders = Array.from(document.querySelectorAll<HTMLElement>('body *'))
      .filter((element) => {
        const rect = element.getBoundingClientRect();

        return rect.width > 0 && (rect.right > viewportWidth + 1 || rect.left < -1);
      })
      .slice(0, 5)
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        className: element.className?.toString().slice(0, 120) ?? '',
        right: Math.round(element.getBoundingClientRect().right),
      }));

    return {
      viewportWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      offenders,
    };
  });

  expect(
    metrics.documentScrollWidth,
    `${label}: document.scrollWidth (${metrics.documentScrollWidth}) > innerWidth (${metrics.viewportWidth}). Candidatos: ${JSON.stringify(metrics.offenders)}`,
  ).toBeLessThanOrEqual(metrics.viewportWidth);
  expect(
    metrics.bodyScrollWidth,
    `${label}: body.scrollWidth (${metrics.bodyScrollWidth}) > innerWidth (${metrics.viewportWidth}). Candidatos: ${JSON.stringify(metrics.offenders)}`,
  ).toBeLessThanOrEqual(metrics.viewportWidth);
}

test.use({ viewport: { width: 390, height: 844 } });

test.describe('Compartir resumen y hoja de control', () => {
  test('el vendedor copia y comparte el resumen del pedido', async ({ page, request }) => {
    await stubShareApis(page);
    const orderId = await createOrderForSharing(page);

    try {
      await page.goto(`/orders/${orderId}`);
      await expect(page.getByRole('heading', { name: /Pedido #/ })).toBeVisible();

      await page.getByRole('button', { name: 'Copiar resumen del pedido' }).click();
      await expect(page.getByText('Resumen copiado al portapapeles.')).toBeVisible();
      await expect.poll(async () => (await readShareState(page)).copied.length).toBe(1);

      const copied = (await readShareState(page)).copied[0];
      expect(copied).toContain('SISTEMA DE GESTIÓN DE INVENTARIO');
      expect(copied).toContain(`Pedido: #${orderId.slice(-6)}`);
      expect(copied).toContain(E2E_CLIENTS.fullFlow.name);
      expect(copied).toContain(E2E_PRODUCTS.primary.code);
      expect(copied).toContain('Condición de pago: Contado');
      expect(copied).toContain('TOTAL FINAL: $ 1.900,00');

      // Acción directa a WhatsApp aunque el navegador no soporte Web Share.
      const whatsapp = page.getByTestId('order-whatsapp-button');
      await expect(whatsapp).toHaveAttribute('target', '_blank');
      await expect(whatsapp).toHaveAttribute('rel', 'noopener noreferrer');
      await expect(whatsapp).toHaveAttribute(
        'href',
        `https://wa.me/?text=${encodeURIComponent(copied)}`,
      );

      await page.getByRole('button', { name: 'Compartir resumen del pedido' }).click();
      await expect.poll(async () => (await readShareState(page)).shared.length).toBe(1);

      const shared = (await readShareState(page)).shared[0];
      expect(shared.title).toContain(`Pedido #${orderId.slice(-6)}`);
      expect(shared.text).toBe(copied);

      for (const width of [360, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await expectNoHorizontalOverflow(page, `detalle del vendedor con acciones @ ${width}px`);
      }
    } finally {
      await deleteOrderAsAdmin(request, orderId);
    }
  });

  test('la bandeja comparte la exportación como archivo en móvil', async ({ page }) => {
    await stubShareApis(page);
    await loginAs(page, E2E_USERS.seller);
    await page.goto('/orders');
    await expect(page.getByRole('heading', { name: 'Historial de Mis Pedidos' })).toBeVisible();

    const shareExport = page.getByTestId('orders-tray-share-export');
    await expect(shareExport).toBeVisible();
    await expectNoHorizontalOverflow(page, 'bandeja del vendedor con compartir @390px');

    await shareExport.click();
    await expect.poll(async () => (await readShareState(page)).shared.length).toBe(1);

    const csvShare = (await readShareState(page)).shared[0];
    expect(csvShare.files).toHaveLength(1);
    expect(csvShare.files[0].name).toMatch(/^pedidos-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(csvShare.files[0].type).toBe('text/csv; charset=utf-8');
    expect(csvShare.files[0].size).toBeGreaterThan(0);

    // El mismo botón respeta el selector de formato: Excel viaja como XLSX.
    await page.getByLabel('Formato de exportación').selectOption('xlsx');
    await expect(shareExport).toBeVisible();
    await shareExport.click();
    await expect.poll(async () => (await readShareState(page)).shared.length).toBe(2);

    const xlsxShare = (await readShareState(page)).shared[1];
    expect(xlsxShare.files).toHaveLength(1);
    expect(xlsxShare.files[0].name).toMatch(/^pedidos-\d{4}-\d{2}-\d{2}\.xlsx$/);
    expect(xlsxShare.files[0].type).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  });

  test('facturación copia el mismo resumen desde el pedido', async ({ page }) => {
    await stubShareApis(page);
    await loginAs(page, E2E_USERS.billing);

    const list = await page.request.get(
      '/api/orders?status=facturacion&archived=all&pagination=cursor&limit=50',
    );
    expect(list.status()).toBe(200);

    const payload = (await list.json()) as {
      orders: Array<{ _id: string; clientName?: string }>;
    };
    const order = payload.orders.find(
      (candidate) => candidate.clientName === E2E_CLIENTS.dashboard.name,
    );
    expect(order, 'el seed debe mantener un pedido en facturación').toBeTruthy();

    await page.goto(`/billing/orders/${order!._id}`);
    await expect(page.getByRole('heading', { name: /Datos Estructurados/ })).toBeVisible();

    await page.getByRole('button', { name: 'Copiar resumen del pedido' }).click();
    await expect(page.getByText('Resumen copiado al portapapeles.')).toBeVisible();
    await expect.poll(async () => (await readShareState(page)).copied.length).toBe(1);

    const copied = (await readShareState(page)).copied[0];
    expect(copied).toContain('SISTEMA DE GESTIÓN DE INVENTARIO');
    expect(copied).toContain(`Pedido: #${order!._id.slice(-6)}`);
    expect(copied).toContain(E2E_CLIENTS.dashboard.name);
    expect(copied).toContain('TOTAL FINAL:');

    await page.getByRole('button', { name: 'Compartir resumen del pedido' }).click();
    await expect.poll(async () => (await readShareState(page)).shared.length).toBe(1);
    expect((await readShareState(page)).shared[0].text).toBe(copied);

    for (const width of [360, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await expectNoHorizontalOverflow(page, `detalle de facturación con acciones @ ${width}px`);
    }
  });

  test('la hoja de control llega renderizada del servidor y no desborda en móvil', async ({
    page,
    request,
  }) => {
    const orderId = await createOrderForSharing(page);

    try {
      await loginAs(page, E2E_USERS.deposit);
      const printPath = `/deposit/orders/${orderId}/print`;

      // HTML inicial: el pedido ya viene resuelto por el Server Component.
      const response = await page.request.get(printPath);
      expect(response.status()).toBe(200);

      const html = await response.text();
      expect(html).toContain(E2E_CLIENTS.fullFlow.name);
      expect(html).toContain(E2E_PRODUCTS.primary.code);
      expect(html).toContain(`#${orderId.slice(-6)}`);
      expect(html).not.toContain('Cargando pedido...');

      const clientOrderRequests: string[] = [];
      page.on('request', (requestEvent) => {
        const pathname = new URL(requestEvent.url()).pathname;
        if (pathname === `/api/orders/${orderId}`) clientOrderRequests.push(pathname);
      });

      for (const width of [360, 390, 430]) {
        await page.setViewportSize({ width, height: 844 });
        await page.goto(printPath);
        await expect(page.getByText(E2E_CLIENTS.fullFlow.name, { exact: false })).toBeVisible();
        await expect(page.getByText('Cargando pedido...')).toHaveCount(0);

        const sheet = await page.locator('.cs-sheet').boundingBox();
        const toolbar = await page.locator('.print-toolbar').boundingBox();
        expect(sheet?.width ?? 0).toBeLessThanOrEqual(width);
        expect(toolbar?.width ?? 0).toBeLessThanOrEqual(width);

        await expectNoHorizontalOverflow(page, `hoja de control @ ${width}px`);
      }

      // La previsualización nunca repite el GET que ya hizo el servidor.
      expect(clientOrderRequests).toEqual([]);
    } finally {
      await deleteOrderAsAdmin(request, orderId);
    }
  });

  test('vendedor y facturación abren la hoja de pedido desde su detalle sin overflow', async ({
    page,
    request,
  }) => {
    const orderId = await createOrderForSharing(page);

    try {
      // Vendedor: la ruta /orders/[id]/print vuelve a validar getOrderForSession.
      const vendorDetail = await page.goto(`/orders/${orderId}`);
      expect(vendorDetail?.status()).toBe(200);
      await expect(page.getByRole('heading', { name: /Pedido #/ })).toBeVisible();

      const vendorPrint = page.getByTestId('order-print-link');
      await expect(vendorPrint).toHaveAttribute('href', `/orders/${orderId}/print`);
      await vendorPrint.click();

      await expect(page).toHaveURL(new RegExp(`/orders/${orderId}/print$`));
      await expect(page.locator('.cs-sheet')).toContainText(E2E_CLIENTS.fullFlow.name);
      await expect(page.getByText('No tenés permiso para ver este pedido.')).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: /Volver al detalle del pedido/ }),
      ).toBeVisible();
      await expectNoHorizontalOverflow(page, 'hoja imprimible del vendedor @ 390px');

      await page.getByRole('button', { name: /Volver al detalle del pedido/ }).click();
      await expect(page).toHaveURL(new RegExp(`/orders/${orderId}$`));

      // Facturación: mismo componente y validación, pero ruta/backHref propios.
      await loginAs(page, E2E_USERS.billing);
      const billingDetail = await page.goto(`/billing/orders/${orderId}`);
      expect(billingDetail?.status()).toBe(200);
      await expect(page.getByRole('heading', { name: /Datos Estructurados/ })).toBeVisible();
      await expectNoHorizontalOverflow(page, 'detalle de facturación con imprimir @ 390px');

      const billingPrint = page.getByTestId('order-print-link');
      await expect(billingPrint).toHaveAttribute('href', `/billing/orders/${orderId}/print`);
      await billingPrint.click();

      await expect(page).toHaveURL(new RegExp(`/billing/orders/${orderId}/print$`));
      await expect(page.locator('.cs-sheet')).toContainText(E2E_CLIENTS.fullFlow.name);
      await expect(page.getByText('No tenés permiso para ver este pedido.')).toHaveCount(0);
      await expectNoHorizontalOverflow(page, 'hoja imprimible de facturación @ 390px');

      await page.getByRole('button', { name: /Volver al detalle del pedido/ }).click();
      await expect(page).toHaveURL(new RegExp(`/billing/orders/${orderId}$`));
    } finally {
      await deleteOrderAsAdmin(request, orderId);
    }
  });

  test('facturación imprime lo verificado en depósito y alterna con lo solicitado @390px', async ({
    page,
    request,
  }) => {
    const orderId = await createOrderForSharing(page);

    try {
      // Depósito controla 1 de las 2 unidades y deja el faltante documentado.
      await loginAs(page, E2E_USERS.deposit);
      const detailResponse = await page.request.get(`/api/orders/${orderId}`);
      expect(detailResponse.status()).toBe(200);
      const { order } = (await detailResponse.json()) as { order: E2EOrderDetail };

      const update = await page.request.put(`/api/orders/${orderId}`, {
        data: {
          version: order.version ?? 0,
          status: 'paralizado',
          items: order.items.map((item) => ({
            _id: item._id,
            requestedQuantity: item.requestedQuantity,
            verifiedQuantity: 1,
            isPending: true,
            pendingReason: 'Faltante: 1 de 2 controlados',
          })),
        },
      });
      expect(update.status()).toBe(200);

      const { order: controlled } = (await update.json()) as { order: E2EOrderDetail };
      const verifiedTotal = money(controlled.finalTotal);
      const requestedGross = controlled.items.reduce(
        (total, item) => total + item.unitPrice * item.requestedQuantity,
        0,
      );
      const requestedDiscount = controlled.items.reduce(
        (total, item) =>
          total + (item.unitPrice * item.requestedQuantity * item.itemDiscount) / 100,
        0,
      );
      const requestedTotal = money(requestedGross - requestedDiscount);

      await loginAs(page, E2E_USERS.billing);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`/billing/orders/${orderId}/print`);

      const sheet = page.locator('.cs-sheet');
      const totalField = sheet.locator('.cs-field').filter({ hasText: 'Total final' });
      await expect(sheet).toBeVisible();
      await expect(sheet).toHaveAttribute('data-sheet-mode', 'verified');
      await expect(sheet).toContainText('Comprobante verificado');
      await expect(sheet).toContainText('Cant. verificada');
      await expect(sheet).toContainText('Faltante: 1 de 2 controlados');
      await expect(totalField).toContainText(verifiedTotal);
      await expectNoHorizontalOverflow(page, 'comprobante verificado @390px');

      const requestedOption = page.getByTestId('print-sheet-mode-requested');
      const verifiedOption = page.getByTestId('print-sheet-mode-verified');
      await expect(verifiedOption).toHaveAttribute('aria-pressed', 'true');
      await expect(requestedOption).toHaveAttribute('aria-pressed', 'false');

      // El selector permite volver a la hoja de preparación sin recargar.
      await requestedOption.click();
      await expect(sheet).toHaveAttribute('data-sheet-mode', 'requested');
      await expect(sheet).toContainText('Cant. solicitada');
      await expect(totalField).toContainText(requestedTotal);
      await expect(requestedOption).toHaveAttribute('aria-pressed', 'true');
      await expectNoHorizontalOverflow(page, 'hoja solicitada @390px');

      await verifiedOption.click();
      await expect(sheet).toHaveAttribute('data-sheet-mode', 'verified');
      await expect(totalField).toContainText(verifiedTotal);
      await expectNoHorizontalOverflow(page, 'comprobante verificado restaurado @390px');
    } finally {
      await deleteOrderAsAdmin(request, orderId);
    }
  });
});
