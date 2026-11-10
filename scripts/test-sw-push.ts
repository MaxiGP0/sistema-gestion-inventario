/**
 * Pruebas de los manejadores `push` y `notificationclick` de public/sw.js.
 *
 * Ejecuta el service worker real en un contexto `node:vm` con stubs de
 * `self.registration` y `self.clients`, sin navegador:
 * - muestra la notificación con título, cuerpo y datos del pedido;
 * - resuelve el deep link de depósito/facturación y el panel para `all`;
 * - al hacer clic enfoca/navega una pestaña existente o abre una nueva;
 * - ignora URLs externas del payload (solo rutas internas).
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const swSource = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const ORDER_ID = '64b7f1c2e4b0a1d2f3a4b5c6';
const ORIGIN = 'https://sgi.test';

interface Harness {
  dispatch: (type: string, event: Record<string, unknown>) => Promise<void>;
  notifications: Array<{ title: string; options: any }>;
  openedWindows: string[];
  clients: Array<{
    url: string;
    focus?: () => Promise<void>;
    navigate?: (url: string) => Promise<void>;
  }>;
}

function createHarness(): Harness {
  const listeners = new Map<string, Array<(event: any) => void>>();
  const notifications: Harness['notifications'] = [];
  const openedWindows: string[] = [];
  const clients: Harness['clients'] = [];

  const self = {
    location: { href: `${ORIGIN}/sw.js?v=test`, origin: ORIGIN },
    addEventListener(type: string, handler: (event: any) => void) {
      const handlers = listeners.get(type) ?? [];
      handlers.push(handler);
      listeners.set(type, handlers);
    },
    registration: {
      async showNotification(title: string, options: any) {
        notifications.push({ title, options });
      },
    },
    clients: {
      async matchAll() {
        return clients;
      },
      async openWindow(url: string) {
        openedWindows.push(url);
        return null;
      },
      async claim() {},
    },
    async skipWaiting() {},
  };

  const context = vm.createContext({
    self,
    URL,
    console,
    setTimeout,
    clearTimeout,
    Request,
    Response,
    Headers,
    caches: {
      async open() {
        return { put: async () => {}, keys: async () => [], delete: async () => false };
      },
      async match() {
        return undefined;
      },
      async keys() {
        return [];
      },
      async delete() {
        return true;
      },
    },
    fetch: async () => new Response(null, { status: 204 }),
  });

  vm.runInContext(swSource, context, { filename: 'sw.js' });

  return {
    clients,
    notifications,
    openedWindows,
    async dispatch(type, event) {
      let pending: Promise<unknown> | undefined;
      const wrapped = {
        ...event,
        waitUntil(value: Promise<unknown>) {
          pending = value;
        },
      };

      for (const handler of listeners.get(type) ?? []) handler(wrapped);
      if (pending) await pending;
    },
  };
}

function setClients(harness: Harness, next: Harness['clients']) {
  harness.clients.splice(0, harness.clients.length, ...next);
}

test('push muestra la notificación y guarda el deep link de depósito', async () => {
  const harness = createHarness();

  await harness.dispatch('push', {
    data: {
      json: () => ({
        title: 'Nuevo pedido',
        body: 'Pedido #123 listo para picking',
        targetRole: 'deposit',
        orderId: ORDER_ID,
      }),
    },
  });

  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].title, 'Nuevo pedido');
  assert.equal(harness.notifications[0].options.body, 'Pedido #123 listo para picking');
  assert.equal(harness.notifications[0].options.data.url, `/deposit/orders/${ORDER_ID}`);
  assert.equal(harness.notifications[0].options.data.targetRole, 'deposit');
  assert.equal(harness.notifications[0].options.data.orderId, ORDER_ID);
  assert.equal(harness.notifications[0].options.tag, `sgi-order-${ORDER_ID}`);
});

test('push de facturación usa /billing/orders/:id y la bandeja sin pedido', async () => {
  const harness = createHarness();

  await harness.dispatch('push', {
    data: {
      json: () => ({
        title: 'Pedido verificado',
        body: 'Listo para facturar',
        targetRole: 'billing',
        orderId: ORDER_ID,
      }),
    },
  });
  await harness.dispatch('push', {
    data: {
      json: () => ({
        title: 'Facturación',
        body: 'Sin pedido',
        targetRole: 'billing',
      }),
    },
  });
  await harness.dispatch('push', {
    data: {
      json: () => ({
        title: 'Global',
        body: 'Alerta global',
        targetRole: 'all',
        orderId: ORDER_ID,
      }),
    },
  });

  assert.equal(harness.notifications[0].options.data.url, `/billing/orders/${ORDER_ID}`);
  assert.equal(harness.notifications[1].options.data.url, '/billing/orders');
  assert.equal(harness.notifications[2].options.data.url, '/');
});

test('push de vendedor usa /orders/:id y su bandeja sin pedido', async () => {
  const harness = createHarness();

  await harness.dispatch('push', {
    data: {
      json: () => ({
        title: 'Pedido Paralizado en Depósito',
        body: 'Tu pedido quedó paralizado',
        targetRole: 'vendor',
        orderId: ORDER_ID,
      }),
    },
  });
  await harness.dispatch('push', {
    data: {
      json: () => ({
        title: 'Pedido Entregado',
        body: 'Tu pedido fue entregado',
        targetRole: 'vendor',
      }),
    },
  });

  assert.equal(harness.notifications[0].options.data.url, `/orders/${ORDER_ID}`);
  assert.equal(harness.notifications[0].options.data.targetRole, 'vendor');
  assert.equal(harness.notifications[1].options.data.url, '/orders');
});

test('push tolera payload inválido y usa un título por defecto', async () => {
  const harness = createHarness();

  await harness.dispatch('push', {
    data: {
      json: () => {
        throw new Error('no es JSON');
      },
    },
  });

  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].title, 'Sistema de Gestión de Inventario');
  assert.equal(harness.notifications[0].options.body, '');
});

test('notificationclick abre una ventana nueva con la URL resuelta', async () => {
  const harness = createHarness();

  let closed = false;
  await harness.dispatch('notificationclick', {
    notification: {
      data: { targetRole: 'billing', orderId: ORDER_ID },
      close: () => {
        closed = true;
      },
    },
  });

  assert.equal(closed, true);
  assert.deepEqual(harness.openedWindows, [`${ORIGIN}/billing/orders/${ORDER_ID}`]);
});

test('notificationclick enfoca y navega una pestaña existente', async () => {
  const harness = createHarness();
  const events: string[] = [];

  setClients(harness, [
    {
      url: `${ORIGIN}/deposit/orders`,
      async focus() {
        events.push('focus');
      },
      async navigate(url: string) {
        events.push(`navigate:${url}`);
      },
    },
  ]);

  await harness.dispatch('notificationclick', {
    notification: {
      data: { url: `/deposit/orders/${ORDER_ID}` },
      close: () => {},
    },
  });

  assert.deepEqual(events, ['focus', `navigate:${ORIGIN}/deposit/orders/${ORDER_ID}`]);
  assert.equal(harness.openedWindows.length, 0);
});

test('notificationclick ignora URLs externas y abre el panel', async () => {
  const harness = createHarness();

  await harness.dispatch('notificationclick', {
    notification: {
      data: { url: 'https://evil.example/phishing', targetRole: 'all' },
      close: () => {},
    },
  });

  assert.deepEqual(harness.openedWindows, [`${ORIGIN}/`]);
});

test('notificationclick recurre a openWindow si focus y navigate fallan en segundo plano (Firefox móvil)', async () => {
  const harness = createHarness();

  setClients(harness, [
    {
      url: `${ORIGIN}/deposit/orders`,
      async focus() {
        throw new Error(' Pestaña en segundo plano en Firefox Android ');
      },
      async navigate() {
        throw new Error(' No se pudo navegar ');
      },
    },
  ]);

  await harness.dispatch('notificationclick', {
    notification: {
      data: { url: `/deposit/orders/${ORDER_ID}` },
      close: () => {},
    },
  });

  assert.deepEqual(harness.openedWindows, [`${ORIGIN}/deposit/orders/${ORDER_ID}`]);
});
