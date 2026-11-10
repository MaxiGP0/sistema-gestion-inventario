import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { E2E_USERS, type E2EClient, type E2EUser } from './fixtures';

/** Usuario mínimo para operar el login, venga del seed o de un alta del test. */
export interface LoginUser {
  username: string;
  password: string;
  role: E2EUser['role'];
}

/** Títulos visibles del panel por rol (el encabezado cambia con la sesión). */
const PANEL_HEADINGS: Record<E2EUser['role'], string> = {
  admin: 'Panel administrador',
  vendedor: 'Panel vendedor',
  controlador: 'Panel de depósito',
  billing: 'Panel de facturación',
};

export function panelHeadingFor(user: Pick<LoginUser, 'role'>): string {
  return PANEL_HEADINGS[user.role];
}

/** Inicia sesión por la UI con un usuario del seed E2E o uno creado por el test. */
export async function loginAs(page: Page, user: LoginUser): Promise<void> {
  await page.context().clearCookies();
  await page.goto('/login');

  await expect(page.getByRole('heading', { name: 'Ingresar al sistema' })).toBeVisible();
  await page.getByPlaceholder('Ingrese su usuario').fill(user.username);
  await page.locator('input[type="password"]').fill(user.password);
  await page.getByRole('button', { name: 'Ingresar al Sistema' }).click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: panelHeadingFor(user) })).toBeVisible();
}

export interface OrderLineInput {
  code: string;
  quantity: number;
}

/** Id del cliente del seed, consultado con la sesión del navegador. */
export async function clientIdByCode(page: Page, code: string): Promise<string> {
  const response = await page.request.get(
    `/api/clients?search=${encodeURIComponent(code)}&limit=20`,
  );
  expect(response.status()).toBe(200);

  const payload = (await response.json()) as {
    clients: Array<{ _id: string; code: string }>;
  };
  const client = payload.clients.find((item) => item.code === code);

  if (!client) throw new Error(`No se encontró el cliente E2E ${code}`);

  return client._id;
}

/** Id del producto del seed, consultado con la sesión del navegador. */
export async function productIdByCode(page: Page, code: string): Promise<string> {
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

export interface OrderListItem {
  _id: string;
  status: string;
}

/** Pedidos de un cliente, sin importar estado ni archivado. */
export async function ordersForClient(page: Page, clientId: string): Promise<OrderListItem[]> {
  const response = await page.request.get(
    `/api/orders?clientId=${clientId}&archived=all&pagination=cursor&limit=50`,
  );
  expect(response.status()).toBe(200);

  const payload = (await response.json()) as { orders: OrderListItem[] };
  return payload.orders;
}

/**
 * Abre el alta y completa cliente, condición comercial y cantidades sin
 * guardar. La usan tanto el flujo online como el E2E offline.
 */
export async function fillOrderForm(
  page: Page,
  client: E2EClient,
  lines: OrderLineInput[],
): Promise<void> {
  await page.goto('/orders/new');
  await expect(page.getByRole('heading', { name: 'Nuevo pedido' })).toBeVisible();

  // El vendedor sale de la sesión y el campo es de solo lectura.

  const clientSearch = page.getByPlaceholder('Buscar cliente...');
  await clientSearch.click();
  await clientSearch.fill(client.code);
  await page.getByText(`${client.code} - ${client.name}`, { exact: true }).click();
  await expect(page.getByPlaceholder(`${client.code} - ${client.name}`)).toBeVisible();

  await page.getByLabel('Tipo de factura').filter({ visible: true }).selectOption('A');
  await page.getByLabel('Condición de pago').filter({ visible: true }).selectOption('contado');

  const productSearch = page.getByPlaceholder('Buscar producto por nombre o código...');

  for (const line of lines) {
    await productSearch.fill(line.code);

    const row = page.getByRole('row', { name: new RegExp(line.code) });
    await expect(row).toBeVisible();

    const quantity = row.getByRole('spinbutton', {
      name: /^Cantidad en el catálogo de/,
    });
    await quantity.fill(String(line.quantity));
    await expect(quantity).toHaveValue(String(line.quantity));
  }
}

/**
 * Alta de pedido desde la UI: elige el cliente del seed, carga cantidades y
 * guarda el borrador. Devuelve el id cuando la app ya abrió el detalle.
 */
export async function createOrder(
  page: Page,
  client: E2EClient,
  lines: OrderLineInput[],
): Promise<string> {
  await fillOrderForm(page, client, lines);

  const createResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/orders' && response.request().method() === 'POST',
  );

  await page.getByRole('button', { name: 'Guardar Pedido (Borrador)' }).click();

  const response = await createResponse;
  expect(response.status()).toBe(200);
  const payload = (await response.json()) as { order: { _id: string } };
  const orderId = payload.order._id;

  await expect(page.getByText('¡Pedido creado en estado Borrador exitosamente!')).toBeVisible();
  await page.waitForURL(new RegExp(`/orders/${orderId}$`));

  return orderId;
}

/** Tarjeta de una bandeja (depósito o facturación) para el cliente indicado. */
export function orderCard(page: Page, clientName: string): Locator {
  // El componente expone data-order-card y data-order-id para no depender de
  // clases de diseño (el sistema de superficies puede cambiar rounded/shadow).
  return page.locator('[data-order-card="true"]').filter({ hasText: clientName }).first();
}

/**
 * Espera a que React haya hidratado el elemento (tenga handlers asociados).
 * En WebKit, escribir antes de este punto deja el DOM con texto pero el estado
 * controlado vacío; el primer render posterior pisa el `fill`.
 */
export async function waitForReactHydration(page: Page, selector: string): Promise<void> {
  await page.waitForFunction(
    (target) => {
      const element = document.querySelector(target);
      if (!element) return false;

      return Object.keys(element).some((key) => key.startsWith('__reactProps$'));
    },
    selector,
    { timeout: 30_000 },
  );
}

/**
 * Espera a que el chunk del indicador global de sincronización esté cargado.
 * Sin esta señal, un `context.setOffline(true)` temprano hace fallar el import
 * dinámico y la cola offline no puede abrirse desde la UI.
 */
export async function waitForOfflineSyncReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.documentElement.dataset.offlineSyncReady === 'true',
    undefined,
    { timeout: 30_000 },
  );
}

/** Abre el detalle de un pedido desde la bandeja de depósito. */
export async function openDepositOrder(page: Page, clientName: string): Promise<string> {
  await page.goto('/deposit/orders');
  await expect(page.getByRole('heading', { name: 'Pedidos Pendientes de Picking' })).toBeVisible();

  const card = orderCard(page, clientName);
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Ver / Verificar Pedido' }).click();

  await expect(page).toHaveURL(/\/deposit\/orders\/[a-f0-9]{24}$/);
  await expect(
    page.getByRole('heading', { name: 'Listado de Productos a Controlar' }),
  ).toBeVisible();

  return orderIdFromUrl(page.url());
}

/** Marca todas las líneas del picking como controladas sin cambiar cantidades. */
export async function markAllDepositItemsControlled(page: Page): Promise<void> {
  const rows = page.locator('table tbody tr');
  await expect(rows.first()).toBeVisible();

  const count = await rows.count();

  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const toggle = row.getByRole('button', { name: 'Controlado', exact: true });

    if ((await toggle.count()) === 0) continue;

    await toggle.click();
    await expect(row.getByRole('button', { name: '✓ Controlado', exact: true })).toBeVisible();
  }
}

/** Aprueba el picking y espera a que el pedido pase a facturación. */
export async function approvePicking(page: Page): Promise<void> {
  const putResponse = page.waitForResponse(
    (response) =>
      /\/api\/orders\/[a-f0-9]{24}$/.test(new URL(response.url()).pathname) &&
      response.request().method() === 'PUT',
  );

  await page.getByRole('button', { name: 'Aprobar y Enviar a Facturación' }).click();

  const response = await putResponse;
  expect(response.status()).toBe(200);

  await expect(page.getByText(/¡Picking guardado! Estado actual: FACTURACION/)).toBeVisible();
  await expect(page).toHaveURL(/\/deposit\/orders$/);
}

/** Abre el detalle de facturación del pedido del cliente indicado. */
export async function openBillingOrder(page: Page, clientName: string): Promise<string> {
  await page.goto('/billing/orders');
  await expect(
    page.getByRole('heading', { name: 'Bandeja de Facturación y Cierre' }),
  ).toBeVisible();

  const card = orderCard(page, clientName);
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Ver Datos Estructurados' }).click();

  await expect(page).toHaveURL(/\/billing\/orders\/[a-f0-9]{24}$/);
  await expect(page.getByRole('heading', { name: /Datos Estructurados/ })).toBeVisible();

  return orderIdFromUrl(page.url());
}

/**
 * Marca cada línea como OK en el control post-factura. Espera el PATCH de cada
 * línea antes de seguir: la UI ignora clics mientras hay un guardado en curso.
 */
export async function markAllPostControlOk(page: Page): Promise<void> {
  const groups = page
    .locator('table')
    .getByRole('group', { name: 'Control post-factura de la línea' });

  await expect(groups.first()).toBeVisible();
  const count = await groups.count();

  for (let index = 0; index < count; index += 1) {
    await markPostControlLine(page, index);
  }

  await expect(page.getByText('Todas las líneas están controladas')).toBeVisible();
}

/** Marca una línea puntual como OK y espera el PATCH antes de continuar. */
export async function markPostControlLine(page: Page, index: number): Promise<void> {
  const group = page
    .locator('table')
    .getByRole('group', { name: 'Control post-factura de la línea' })
    .nth(index);

  await expect(group).toBeVisible();
  const okButton = group.getByRole('button', { name: 'OK', exact: true });

  if ((await okButton.getAttribute('aria-pressed')) === 'true') return;

  const patchResponse = page.waitForResponse(
    (response) =>
      response.url().includes('/post-control') && response.request().method() === 'PATCH',
  );

  await okButton.click();

  expect((await patchResponse).status()).toBe(200);
  await expect(okButton).toHaveAttribute('aria-pressed', 'true');
}

export function orderIdFromUrl(url: string): string {
  const orderId = url.split('/').filter(Boolean).pop();

  if (!orderId) throw new Error(`No se pudo extraer el ID del pedido de "${url}"`);

  return orderId;
}

export interface OrderApiSnapshot {
  status: string;
  version: number;
  items: Array<{
    requestedQuantity: number;
    verifiedQuantity: number;
    isPending: boolean;
  }>;
}

/** Lee el pedido con la sesión del navegador (mismas cookies que la UI). */
export async function fetchOrder(page: Page, orderId: string): Promise<OrderApiSnapshot> {
  const response = await page.request.get(`/api/orders/${orderId}`);
  expect(response.status()).toBe(200);

  const payload = (await response.json()) as { order: OrderApiSnapshot };

  return payload.order;
}

/**
 * Borra un pedido creado por un spec usando una sesión admin aislada.
 * Mantiene los conteos del panel deterministas aunque la suite se reordene.
 */
export async function deleteOrderAsAdmin(
  request: APIRequestContext,
  orderId: string,
): Promise<void> {
  const login = await request.post('/api/auth/login', { data: E2E_USERS.admin });
  expect(login.status()).toBe(200);

  const deletion = await request.delete(`/api/orders/${orderId}`);
  expect(deletion.status()).toBe(200);
}
