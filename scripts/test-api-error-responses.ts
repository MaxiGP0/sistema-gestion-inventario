/**
 * Pruebas de las respuestas 500 de los route handlers (app/api/**):
 * ante un fallo interno el cliente debe recibir siempre el mensaje genérico
 * 'Error interno del servidor' —nunca error.message de Mongoose— y el detalle
 * debe quedar solo en console.error (mismo criterio que el login).
 *
 * No requiere base de datos: se deja una conexión mongoose cacheada falsa, se
 * stubbean la primera operación de Mongo de cada handler para que lance un error
 * con marca propia, y se intercepta console.error para comprobar que ahí sí
 * llegó el detalle. Cubre los 23 puntos que responden 500.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import ExcelJS from 'exceljs';

import { Brand } from '../models/Brand';
import { Client } from '../models/Client';
import { Notification } from '../models/Notification';
import { NotificationRead } from '../models/NotificationRead';
import { Order } from '../models/Order';
import { Product } from '../models/Product';
import { User } from '../models/User';
import { resetAllAttempts } from '../lib/login-rate-limit';
import { authRequest, withTestAuth } from './test-auth-utils';

const GENERIC_ERROR = 'Error interno del servidor';
const LEAK_MARKER = 'MONGOOSE_LEAK';

/** Error interno con pinta de los que lanza Mongoose (el que NO debe filtrarse). */
const leakError = (where: string) =>
  new Error(
    `${LEAK_MARKER} ${where}: Cast to ObjectId failed for value "no-es-un-id" at path "_id"`,
  );

const oid = () => 'a'.repeat(24);

let H: any;
let loggedErrors: unknown[][] = [];

type Case = {
  name: string;
  run: (handlers: any) => Promise<Response>;
};

const withParams = (handler: any, id: string, request: Request) =>
  handler(request, { params: Promise.resolve({ id }) });

const jsonRequest = (url: string, body: unknown, authenticated = true) => {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };

  return new Request(url, authenticated ? withTestAuth(init) : init);
};

const CASES: Case[] = [
  {
    name: 'GET /api/clients',
    run: (h) => h.clientsGet(authRequest('http://localhost/api/clients')),
  },
  {
    name: 'POST /api/clients',
    run: (h) =>
      h.clientsPost(
        jsonRequest('http://localhost/api/clients', { code: 'C1', name: 'Cliente Test' }),
      ),
  },
  {
    name: 'PUT /api/clients/[id]',
    run: (h) =>
      withParams(
        h.clientPut,
        oid(),
        jsonRequest('http://localhost', { code: 'C1', name: 'Cliente Test' }),
      ),
  },
  {
    name: 'DELETE /api/clients/[id]',
    run: (h) =>
      withParams(h.clientDelete, oid(), authRequest('http://localhost', { method: 'DELETE' })),
  },
  {
    name: 'GET /api/notifications',
    run: (h) => h.notificationsGet(authRequest('http://localhost/api/notifications')),
  },
  {
    name: 'POST /api/notifications',
    run: (h) =>
      h.notificationsPost(
        jsonRequest('http://localhost/api/notifications', { title: 'T', message: 'M' }),
      ),
  },
  {
    name: 'PUT /api/notifications',
    run: (h) =>
      h.notificationsPut(jsonRequest('http://localhost/api/notifications', { id: oid() })),
  },
  {
    name: 'DELETE /api/notifications',
    run: (h) =>
      h.notificationsDelete(
        authRequest(`http://localhost/api/notifications?id=${oid()}`, { method: 'DELETE' }),
      ),
  },
  {
    name: 'GET /api/users/notifications',
    run: (h) => h.userNotificationsGet(authRequest('http://localhost/api/users/notifications')),
  },
  {
    name: 'PUT /api/users/notifications',
    run: (h) =>
      h.userNotificationsPut(
        jsonRequest('http://localhost/api/users/notifications', { notificationsEnabled: false }),
      ),
  },
  {
    name: 'GET /api/products',
    run: (h) => h.productsGet(authRequest('http://localhost/api/products')),
  },
  {
    name: 'POST /api/products',
    run: (h) =>
      h.productsPost(
        jsonRequest('http://localhost/api/products', {
          brandId: oid(),
          code: 'P1',
          name: 'Producto',
          price: 10,
        }),
      ),
  },
  {
    name: 'PUT /api/products/[id]',
    run: (h) =>
      withParams(
        h.productPut,
        oid(),
        jsonRequest('http://localhost', {
          brandId: oid(),
          code: 'P1',
          name: 'Producto',
          price: 10,
        }),
      ),
  },
  {
    name: 'DELETE /api/products/[id]',
    run: (h) =>
      withParams(h.productDelete, oid(), authRequest('http://localhost', { method: 'DELETE' })),
  },
  { name: 'GET /api/brands', run: (h) => h.brandsGet(authRequest('http://localhost/api/brands')) },
  {
    name: 'POST /api/brands',
    run: (h) => h.brandsPost(jsonRequest('http://localhost/api/brands', { name: 'Marca Test' })),
  },
  {
    name: 'PUT /api/brands/[id]',
    run: (h) =>
      withParams(h.brandPut, oid(), jsonRequest('http://localhost', { name: 'Marca Test' })),
  },
  {
    name: 'DELETE /api/brands/[id]',
    run: (h) =>
      withParams(h.brandDelete, oid(), authRequest('http://localhost', { method: 'DELETE' })),
  },
  { name: 'POST /api/catalog/import', run: async (h) => h.catalogImport(await importRequest()) },
  {
    name: 'GET /api/orders',
    run: (h) => h.ordersGet(authRequest('http://localhost/api/orders?search=zzz')),
  },
  {
    name: 'POST /api/orders',
    run: (h) =>
      h.ordersPost(
        jsonRequest('http://localhost/api/orders', {
          clientId: oid(),
          items: [{ productId: oid(), requestedQuantity: 1 }],
          createdBy: 'Vendedor Test',
          invoiceType: 'A',
          paymentCondition: 'contado',
        }),
      ),
  },
  {
    name: 'GET /api/orders/[id]',
    run: (h) => withParams(h.orderGet, oid(), authRequest('http://localhost')),
  },
  {
    name: 'PUT /api/orders/[id]',
    run: (h) => withParams(h.orderPut, oid(), jsonRequest('http://localhost', { version: 0 })),
  },
  {
    name: 'DELETE /api/orders/[id]',
    run: (h) =>
      withParams(h.orderDelete, oid(), authRequest('http://localhost', { method: 'DELETE' })),
  },
  {
    // El login es público: sin cookie, como lo llama un cliente real.
    name: 'POST /api/auth/login',
    run: (h) =>
      h.login(
        jsonRequest(
          'http://localhost/api/auth/login',
          { username: 'usuario-test', password: 'x' },
          false,
        ),
      ),
  },
];

/** Genera un .xlsx en memoria con una fila válida para llegar hasta el fetch de marcas. */
async function importRequest() {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Hoja1');
  worksheet.addRow(['Marca', 'Codigo', 'Nombre', 'Precio S/IVA']);
  worksheet.addRow(['General', 'P1', 'Producto Uno', 10]);
  const buffer = await workbook.xlsx.writeBuffer();

  const form = new FormData();
  form.append('file', new File([buffer], 'productos.xlsx'));
  form.append('type', 'products');
  return new Request(
    'http://localhost/api/catalog/import',
    withTestAuth({ method: 'POST', body: form }),
  );
}

before(async () => {
  // dbConnect() encuentra una conexión cacheada y nunca toca MongoDB.
  process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/fake-test';
  (globalThis as any).mongoose = { conn: {}, promise: null };

  // Cada stub reemplaza la primera operación de Mongo del handler por el error
  // marcado: lo que se prueba es la respuesta del catch, no la base.
  mock.method(User as any, 'findOne', () => {
    throw leakError('User.findOne');
  });
  mock.method(User as any, 'findById', () => {
    throw leakError('User.findById');
  });
  mock.method(User as any, 'findByIdAndUpdate', () => {
    throw leakError('User.findByIdAndUpdate');
  });
  mock.method(Client as any, 'find', () => {
    throw leakError('Client.find');
  });
  mock.method(Client as any, 'findById', () => {
    throw leakError('Client.findById');
  });
  mock.method(Client as any, 'findOneAndUpdate', () => {
    throw leakError('Client.findOneAndUpdate');
  });
  mock.method(Client as any, 'findByIdAndUpdate', () => {
    throw leakError('Client.findByIdAndUpdate');
  });
  mock.method(Client as any, 'findByIdAndDelete', () => {
    throw leakError('Client.findByIdAndDelete');
  });
  mock.method(Client as any, 'countDocuments', async () => 0);
  mock.method(Order as any, 'findById', () => {
    throw leakError('Order.findById');
  });
  mock.method(Order as any, 'find', () => {
    throw leakError('Order.find');
  });
  mock.method(Order as any, 'findByIdAndDelete', () => {
    throw leakError('Order.findByIdAndDelete');
  });
  // Los DELETE de clientes/marcas chequean asociaciones antes de borrar: sin saber qué hay, 0.
  mock.method(Order as any, 'countDocuments', async () => 0);
  mock.method(Notification as any, 'find', () => {
    throw leakError('Notification.find');
  });
  mock.method(Notification as any, 'aggregate', () => {
    throw leakError('Notification.aggregate');
  });
  mock.method(Notification as any, 'countDocuments', () => {
    throw leakError('Notification.countDocuments');
  });
  mock.method(Notification as any, 'create', () => {
    throw leakError('Notification.create');
  });
  mock.method(Notification as any, 'findByIdAndUpdate', () => {
    throw leakError('Notification.findByIdAndUpdate');
  });
  mock.method(Notification as any, 'findByIdAndDelete', () => {
    throw leakError('Notification.findByIdAndDelete');
  });
  mock.method(NotificationRead as any, 'findOneAndUpdate', () => {
    throw leakError('NotificationRead.findOneAndUpdate');
  });
  mock.method(Product as any, 'find', () => {
    throw leakError('Product.find');
  });
  mock.method(Product as any, 'countDocuments', async () => 0);
  mock.method(Product as any, 'findByIdAndUpdate', () => {
    throw leakError('Product.findByIdAndUpdate');
  });
  mock.method(Brand as any, 'find', () => {
    throw leakError('Brand.find');
  });
  mock.method(Brand as any, 'findById', () => {
    throw leakError('Brand.findById');
  });
  mock.method(Brand as any, 'create', () => {
    throw leakError('Brand.create');
  });
  mock.method(Brand as any, 'findByIdAndUpdate', () => {
    throw leakError('Brand.findByIdAndUpdate');
  });
  mock.method(Brand as any, 'findByIdAndDelete', () => {
    throw leakError('Brand.findByIdAndDelete');
  });

  // El detalle debe registrarse: se captura en vez de ensuciar la salida.
  mock.method(console, 'error', (...args: unknown[]) => {
    loggedErrors.push(args);
  });

  const [
    clientsRoute,
    clientIdRoute,
    notificationsRoute,
    userNotificationsRoute,
    productsRoute,
    productIdRoute,
    brandsRoute,
    brandIdRoute,
    catalogImportRoute,
    ordersRoute,
    orderIdRoute,
    loginRoute,
  ] = await Promise.all([
    import('../app/api/clients/route'),
    import('../app/api/clients/[id]/route'),
    import('../app/api/notifications/route'),
    import('../app/api/users/notifications/route'),
    import('../app/api/products/route'),
    import('../app/api/products/[id]/route'),
    import('../app/api/brands/route'),
    import('../app/api/brands/[id]/route'),
    import('../app/api/catalog/import/route'),
    import('../app/api/orders/route'),
    import('../app/api/orders/[id]/route'),
    import('../app/api/auth/login/route'),
  ]);

  H = {
    clientsGet: clientsRoute.GET,
    clientsPost: clientsRoute.POST,
    clientPut: clientIdRoute.PUT,
    clientDelete: clientIdRoute.DELETE,
    notificationsGet: notificationsRoute.GET,
    notificationsPost: notificationsRoute.POST,
    notificationsPut: notificationsRoute.PUT,
    notificationsDelete: notificationsRoute.DELETE,
    userNotificationsGet: userNotificationsRoute.GET,
    userNotificationsPut: userNotificationsRoute.PUT,
    productsGet: productsRoute.GET,
    productsPost: productsRoute.POST,
    productPut: productIdRoute.PUT,
    productDelete: productIdRoute.DELETE,
    brandsGet: brandsRoute.GET,
    brandsPost: brandsRoute.POST,
    brandPut: brandIdRoute.PUT,
    brandDelete: brandIdRoute.DELETE,
    catalogImport: catalogImportRoute.POST,
    ordersGet: ordersRoute.GET,
    ordersPost: ordersRoute.POST,
    orderGet: orderIdRoute.GET,
    orderPut: orderIdRoute.PUT,
    orderDelete: orderIdRoute.DELETE,
    login: loginRoute.POST,
  };
});

after(() => mock.restoreAll());

for (const testCase of CASES) {
  test(`500 sin filtraciones: ${testCase.name}`, async () => {
    resetAllAttempts();
    loggedErrors = [];

    const response = await testCase.run(H);
    const payload: any = await response.json();

    assert.equal(
      response.status,
      500,
      `se esperaba 500 y llegó ${response.status}: ${JSON.stringify(payload)}`,
    );
    assert.deepEqual(
      payload,
      { error: GENERIC_ERROR },
      'la respuesta 500 debe ser el mensaje genérico',
    );

    const serialized = JSON.stringify(payload);
    assert.ok(
      !serialized.includes(LEAK_MARKER),
      `la respuesta 500 no debe filtrar el error interno: ${serialized}`,
    );

    assert.ok(
      loggedErrors.some((args) =>
        args.some((arg) => {
          if (typeof arg === 'string') return arg.includes(LEAK_MARKER);
          return arg instanceof Error && arg.message.includes(LEAK_MARKER);
        }),
      ),
      'el detalle debe quedar registrado en console.error',
    );
  });
}
