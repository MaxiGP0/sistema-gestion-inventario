/**
 * Pruebas de validación y errores homogéneos de app/api/**:
 * - Todos los bodies pasan por Zod (marcas, productos, clientes, pedidos,
 *   notificaciones, login y el multipart de catalog/import).
 * - E11000 se traduce a 409 con un mensaje claro y ValidationError/CastError
 *   de Mongoose a 400, sin filtrar detalles internos.
 * - Las respuestas de error mantienen el formato { error }.
 *
 * No requiere base de datos: se deja una conexión mongoose cacheada falsa y se
 * stubbean las operaciones que cada handler intentaría ejecutar.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';

import { Brand } from '../models/Brand';
import { Client } from '../models/Client';
import { Notification } from '../models/Notification';
import { Product } from '../models/Product';
import { mapMongoError } from '../lib/api-errors';
import {
  brandSchema,
  catalogImportSchema,
  loginSchema,
  notificationCreateSchema,
  notificationUpdateSchema,
  productSchema,
  userNotificationsUpdateSchema,
} from '../lib/validations';
import { authRequest } from './test-auth-utils';

const oid = () => 'a'.repeat(24);

const duplicateKeyError = (keyPattern: Record<string, number>) =>
  Object.assign(new Error('E11000 duplicate key error'), {
    code: 11000,
    keyPattern,
    keyValue: Object.fromEntries(Object.keys(keyPattern).map((key) => [key, 'duplicado'])),
  });

const jsonRequest = (
  url: string,
  body: unknown,
  method = 'POST',
  role: 'admin' | 'vendedor' = 'admin',
) =>
  authRequest(
    url,
    {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    role,
  );

const withParams = (handler: any, id: string, request: Request) =>
  handler(request, { params: Promise.resolve({ id }) });

let H: any;

interface StubState {
  brandCreateError: unknown;
  brandFindByIdError: unknown;
  brandFindByIdResult: any;
  productUpsertError: unknown;
  productUpdateError: unknown;
  clientUpdateError: unknown;
  notificationCreateError: unknown;
  notificationCreateCalls: number;
  notificationUpdateManyCalls: number;
}

const state: StubState = {
  brandCreateError: null,
  brandFindByIdError: null,
  brandFindByIdResult: { _id: oid(), name: 'Marca' },
  productUpsertError: null,
  productUpdateError: null,
  clientUpdateError: null,
  notificationCreateError: null,
  notificationCreateCalls: 0,
  notificationUpdateManyCalls: 0,
};

function resetState() {
  state.brandCreateError = null;
  state.brandFindByIdError = null;
  state.brandFindByIdResult = { _id: oid(), name: 'Marca' };
  state.productUpsertError = null;
  state.productUpdateError = null;
  state.clientUpdateError = null;
  state.notificationCreateError = null;
  state.notificationCreateCalls = 0;
  state.notificationUpdateManyCalls = 0;
}

before(async () => {
  // dbConnect() encuentra una conexión cacheada y nunca toca MongoDB.
  process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/fake-test';
  (globalThis as any).mongoose = { conn: {}, promise: null };

  mock.method(Brand as any, 'findById', async () => {
    if (state.brandFindByIdError) throw state.brandFindByIdError;
    return state.brandFindByIdResult;
  });
  mock.method(Brand as any, 'create', async (doc: any) => {
    if (state.brandCreateError) throw state.brandCreateError;
    return doc;
  });
  mock.method(Product as any, 'findOneAndUpdate', async () => {
    if (state.productUpsertError) throw state.productUpsertError;
    return { _id: oid() };
  });
  mock.method(Product as any, 'findByIdAndUpdate', async () => {
    if (state.productUpdateError) throw state.productUpdateError;
    return { _id: oid() };
  });
  mock.method(Client as any, 'findByIdAndUpdate', async () => {
    if (state.clientUpdateError) throw state.clientUpdateError;
    return { _id: oid() };
  });
  mock.method(Notification as any, 'create', async (doc: any) => {
    state.notificationCreateCalls += 1;
    if (state.notificationCreateError) throw state.notificationCreateError;
    return doc;
  });
  mock.method(Notification as any, 'updateMany', async () => {
    state.notificationUpdateManyCalls += 1;
    return { acknowledged: true };
  });

  const [
    brandsRoute,
    brandIdRoute,
    productsRoute,
    productIdRoute,
    clientsIdRoute,
    notificationsRoute,
    catalogImportRoute,
    loginRoute,
  ] = await Promise.all([
    import('../app/api/brands/route'),
    import('../app/api/brands/[id]/route'),
    import('../app/api/products/route'),
    import('../app/api/products/[id]/route'),
    import('../app/api/clients/[id]/route'),
    import('../app/api/notifications/route'),
    import('../app/api/catalog/import/route'),
    import('../app/api/auth/login/route'),
  ]);

  H = {
    brandsPost: brandsRoute.POST,
    brandPut: brandIdRoute.PUT,
    productsPost: productsRoute.POST,
    productPut: productIdRoute.PUT,
    clientPut: clientsIdRoute.PUT,
    notificationsGet: notificationsRoute.GET,
    notificationsPost: notificationsRoute.POST,
    notificationsPut: notificationsRoute.PUT,
    notificationsDelete: notificationsRoute.DELETE,
    catalogImport: catalogImportRoute.POST,
    login: loginRoute.POST,
  };
});

after(() => mock.restoreAll());

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

test('brandSchema exige un nombre real y lo normaliza', () => {
  const parsed = brandSchema.safeParse({ name: '  Marca Norte  ', codePrefix: ' MN ' });
  assert.equal(parsed.success, true);
  if (parsed.success) assert.equal(parsed.data.name, 'Marca Norte');

  assert.equal(brandSchema.safeParse({ name: '   ' }).success, false);
  assert.equal(brandSchema.safeParse({ name: 123 }).success, false);
});

test('productSchema valida el brandId como ObjectId y los precios numéricos', () => {
  const valid = { brandId: oid(), code: ' P1 ', name: ' Producto ', price: 10 };
  const parsed = productSchema.safeParse(valid);
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.code, 'P1');
    assert.equal(parsed.data.name, 'Producto');
  }

  assert.equal(productSchema.safeParse({ ...valid, brandId: 'no-es-un-id' }).success, false);
  assert.equal(productSchema.safeParse({ ...valid, price: -1 }).success, false);
  assert.equal(productSchema.safeParse({ ...valid, price: '10' }).success, false);
});

test('notificationCreateSchema aplica targetRole all y rechaza roles/IDs inválidos', () => {
  const parsed = notificationCreateSchema.safeParse({ title: 'Título', message: 'Mensaje' });
  assert.equal(parsed.success, true);
  if (parsed.success) assert.equal(parsed.data.targetRole, 'all');

  assert.equal(
    notificationCreateSchema.safeParse({ title: 'T', message: 'M', targetRole: 'otro' }).success,
    false,
  );
  assert.equal(
    notificationCreateSchema.safeParse({ title: 'T', message: 'M', orderId: 'mal' }).success,
    false,
  );
  assert.equal(notificationCreateSchema.safeParse({ title: ' ', message: 'M' }).success, false);
});

test('notificationUpdateSchema rechaza un body vacío y valida id/rol', () => {
  assert.equal(notificationUpdateSchema.safeParse({}).success, false);
  assert.equal(notificationUpdateSchema.safeParse({ id: 'mal' }).success, false);
  assert.equal(notificationUpdateSchema.safeParse({ targetRole: 'otro' }).success, false);
  assert.equal(notificationUpdateSchema.safeParse({ id: oid() }).success, true);
  assert.equal(
    notificationUpdateSchema.safeParse({ read: true, targetRole: 'deposit' }).success,
    true,
  );
});

test('userNotificationsUpdateSchema exige un booleano', () => {
  assert.equal(
    userNotificationsUpdateSchema.safeParse({ notificationsEnabled: true }).success,
    true,
  );
  assert.equal(
    userNotificationsUpdateSchema.safeParse({ notificationsEnabled: false }).success,
    true,
  );
  assert.equal(
    userNotificationsUpdateSchema.safeParse({ notificationsEnabled: 'si' }).success,
    false,
  );
  assert.equal(userNotificationsUpdateSchema.safeParse({}).success, false);
});

test('loginSchema exige usuario y contraseña de tipo string', () => {
  assert.equal(loginSchema.safeParse({ username: 'admin', password: 'secreto' }).success, true);
  assert.equal(loginSchema.safeParse({ username: 'admin' }).success, false);
  assert.equal(loginSchema.safeParse({ username: 123, password: true }).success, false);
  assert.equal(loginSchema.safeParse({ username: 'admin', password: '' }).success, false);
});

test('catalogImportSchema valida el archivo, el tipo y el modo de actualización', () => {
  const file = new File(['contenido'], 'productos.xlsx');

  const absent = catalogImportSchema.safeParse({ file, type: 'products' });
  assert.equal(absent.success, true);
  if (absent.success) assert.equal(absent.data.updateMode, 'both', 'el modo por defecto es both');

  const empty = catalogImportSchema.safeParse({ file, type: 'products', updateMode: '' });
  assert.equal(empty.success, true);
  if (empty.success) assert.equal(empty.data.updateMode, 'both');

  const nullMode = catalogImportSchema.safeParse({ file, type: 'products', updateMode: null });
  assert.equal(nullMode.success, true);
  if (nullMode.success) assert.equal(nullMode.data.updateMode, 'both');

  for (const updateMode of ['name', 'price', 'both'] as const) {
    const parsed = catalogImportSchema.safeParse({ file, type: 'products', updateMode });
    assert.equal(parsed.success, true, `debía aceptar el modo ${updateMode}`);
    if (parsed.success) assert.equal(parsed.data.updateMode, updateMode);
  }

  assert.equal(catalogImportSchema.safeParse({ file, type: 'clients' }).success, true);
  assert.equal(
    catalogImportSchema.safeParse({ file, type: 'products', updateMode: 'otro' }).success,
    false,
  );
  assert.equal(catalogImportSchema.safeParse({ type: 'products' }).success, false);
  assert.equal(catalogImportSchema.safeParse({ file, type: 'otro' }).success, false);
});

// ---------------------------------------------------------------------------
// Mapeo de errores de Mongo/Mongoose
// ---------------------------------------------------------------------------

test('E11000 se mapea a 409 aunque el orden de los campos cambie', () => {
  const mapped = mapMongoError(duplicateKeyError({ code: 1, brandId: 1 }), {
    context: 'test',
    duplicateMessages: {
      'brandId+code': 'Ya existe un producto con ese código para la marca seleccionada',
    },
  });

  assert.deepEqual(mapped, {
    status: 409,
    message: 'Ya existe un producto con ese código para la marca seleccionada',
  });

  const specific = mapMongoError(duplicateKeyError({ brandId: 1, code: 1 }), {
    context: 'test',
    duplicateMessages: {
      code: 'mensaje genérico de código',
      'brandId+code': 'mensaje específico de producto',
    },
  });
  assert.equal(specific?.message, 'mensaje específico de producto');
});

test('ValidationError y CastError de Mongoose se mapean a 400', async () => {
  let validationError: unknown;
  try {
    await new Brand({}).validate();
  } catch (error) {
    validationError = error;
  }

  const validationMapped = mapMongoError(validationError, { context: 'test' });
  assert.equal(validationMapped?.status, 400);
  assert.match(validationMapped?.message ?? '', /^Datos inválidos:/);
  assert.match(validationMapped?.message ?? '', /name/);

  const castError = Object.assign(new Error('Cast to ObjectId failed'), { name: 'CastError' });
  assert.deepEqual(mapMongoError(castError, { context: 'test' }), {
    status: 400,
    message: 'ID o valor con formato inválido',
  });
});

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

test('POST /api/brands responde 409 con mensaje claro ante un nombre duplicado', async () => {
  resetState();
  state.brandCreateError = duplicateKeyError({ name: 1 });

  const response = await H.brandsPost(
    jsonRequest('http://localhost/api/brands', { name: 'Marca Test' }),
  );
  const payload: any = await response.json();

  assert.equal(response.status, 409);
  assert.deepEqual(payload, { error: 'Ya existe una marca con ese nombre' });
});

test('POST /api/brands responde 400 ante un ValidationError de Mongoose', async () => {
  resetState();
  try {
    await new Brand({}).validate();
  } catch (error) {
    state.brandCreateError = error;
  }

  const response = await H.brandsPost(
    jsonRequest('http://localhost/api/brands', { name: 'Marca Test' }),
  );
  const payload: any = await response.json();

  assert.equal(response.status, 400);
  assert.match(payload.error, /^Datos inválidos:/);
  assert.deepEqual(Object.keys(payload), ['error']);
});

test('PUT /api/brands/[id] valida el body y el id antes de escribir', async () => {
  resetState();

  const invalidBody = await withParams(
    H.brandPut,
    oid(),
    jsonRequest('http://localhost', { name: '   ' }, 'PUT'),
  );
  assert.equal(invalidBody.status, 400);
  assert.match((await invalidBody.json()).error, /nombre de la marca/);

  const invalidId = await withParams(
    H.brandPut,
    'id-invalido',
    jsonRequest('http://localhost', { name: 'Marca' }, 'PUT'),
  );
  assert.equal(invalidId.status, 400);
  assert.equal((await invalidId.json()).error, 'ID de marca inválido');
});

test('POST /api/products responde 409 ante un duplicado de marca+código', async () => {
  resetState();
  state.productUpsertError = duplicateKeyError({ brandId: 1, code: 1 });

  const response = await H.productsPost(
    jsonRequest('http://localhost/api/products', {
      brandId: oid(),
      code: 'P1',
      name: 'Producto',
      price: 10,
    }),
  );
  const payload: any = await response.json();

  assert.equal(response.status, 409);
  assert.deepEqual(payload, {
    error: 'Ya existe un producto con ese código para la marca seleccionada',
  });
});

test('PUT /api/products/[id] responde 400 con un brandId inválido sin tocar Mongo', async () => {
  resetState();
  let brandFindCalls = 0;
  const originalFindById = Brand.findById;
  (Brand as any).findById = async () => {
    brandFindCalls += 1;
    return state.brandFindByIdResult;
  };

  try {
    const response = await withParams(
      H.productPut,
      oid(),
      jsonRequest(
        'http://localhost',
        { brandId: 'no-es-un-id', code: 'P1', name: 'Producto', price: 10 },
        'PUT',
      ),
    );
    const payload: any = await response.json();

    assert.equal(response.status, 400);
    assert.match(payload.error, /brandId/);
    assert.equal(brandFindCalls, 0);
  } finally {
    (Brand as any).findById = originalFindById;
  }
});

test('PUT /api/products/[id] responde 409 ante un duplicado de la clave compuesta', async () => {
  resetState();
  state.productUpdateError = duplicateKeyError({ brandId: 1, code: 1 });

  const response = await withParams(
    H.productPut,
    oid(),
    jsonRequest(
      'http://localhost',
      { brandId: oid(), code: 'P1', name: 'Producto', price: 10 },
      'PUT',
    ),
  );
  const payload: any = await response.json();

  assert.equal(response.status, 409);
  assert.deepEqual(payload, {
    error: 'Ya existe un producto con ese código para la marca seleccionada',
  });
});

test('PUT /api/clients/[id] responde 409 ante un código duplicado', async () => {
  resetState();
  state.clientUpdateError = duplicateKeyError({ code: 1 });

  const response = await withParams(
    H.clientPut,
    oid(),
    jsonRequest('http://localhost', { code: 'C1', name: 'Cliente' }, 'PUT'),
  );
  const payload: any = await response.json();

  assert.equal(response.status, 409);
  assert.deepEqual(payload, { error: 'Ya existe un cliente con ese código' });
});

test('POST /api/notifications valida el body antes de escribir', async () => {
  resetState();

  const invalidRole = await H.notificationsPost(
    jsonRequest('http://localhost/api/notifications', {
      title: 'Título',
      message: 'Mensaje',
      targetRole: 'otro',
    }),
  );
  assert.equal(invalidRole.status, 400);
  assert.match((await invalidRole.json()).error, /Rol de notificación inválido/);
  assert.equal(state.notificationCreateCalls, 0);

  const invalidOrderId = await H.notificationsPost(
    jsonRequest('http://localhost/api/notifications', {
      title: 'Título',
      message: 'Mensaje',
      orderId: 'no-es-un-id',
    }),
  );
  assert.equal(invalidOrderId.status, 400);
  assert.match((await invalidOrderId.json()).error, /orderId/);
  assert.equal(state.notificationCreateCalls, 0);
});

test('POST /api/notifications devuelve 403 a un usuario no-admin', async () => {
  resetState();

  const response = await H.notificationsPost(
    jsonRequest(
      'http://localhost/api/notifications',
      { title: 'Título', message: 'Mensaje' },
      'POST',
      'vendedor',
    ),
  );

  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /no autorizado/i);
  assert.equal(state.notificationCreateCalls, 0);
});

test('PUT /api/notifications valida id, read y targetRole', async () => {
  resetState();

  for (const body of [{}, { id: 'mal' }, { targetRole: 'otro' }, { read: 'si' }]) {
    const response = await H.notificationsPut(
      jsonRequest('http://localhost/api/notifications', body, 'PUT'),
    );
    assert.equal(response.status, 400, `debía rechazar ${JSON.stringify(body)}`);
    const payload: any = await response.json();
    assert.equal(typeof payload.error, 'string');
    assert.deepEqual(Object.keys(payload), ['error']);
  }

  assert.equal(state.notificationUpdateManyCalls, 0);
});

test('GET/DELETE /api/notifications validan targetRole, cursor y límite de la query', async () => {
  resetState();

  const getResponse = await H.notificationsGet(
    authRequest('http://localhost/api/notifications?targetRole=otro'),
  );
  assert.equal(getResponse.status, 400);
  assert.match((await getResponse.json()).error, /Rol de notificación inválido/);

  for (const query of ['cursor=no-es-un-cursor', 'limit=0', 'limit=101', 'limit=abc']) {
    const response = await H.notificationsGet(
      authRequest(`http://localhost/api/notifications?${query}`),
    );
    assert.equal(response.status, 400, `debía rechazar ${query}`);
  }

  const deleteResponse = await H.notificationsDelete(
    authRequest('http://localhost/api/notifications?id=mal', { method: 'DELETE' }),
  );
  assert.equal(deleteResponse.status, 400);
  assert.match((await deleteResponse.json()).error, /id/);
});

test('POST /api/catalog/import valida el multipart con Zod', async () => {
  resetState();

  const missingFile = new FormData();
  missingFile.append('type', 'products');
  const missingResponse = await H.catalogImport(
    authRequest('http://localhost/api/catalog/import', { method: 'POST', body: missingFile }),
  );
  assert.equal(missingResponse.status, 400);
  assert.match((await missingResponse.json()).error, /archivo/);

  const invalidType = new FormData();
  invalidType.append('file', new File(['x'], 'productos.xlsx'));
  invalidType.append('type', 'otro');
  const typeResponse = await H.catalogImport(
    authRequest('http://localhost/api/catalog/import', { method: 'POST', body: invalidType }),
  );
  assert.equal(typeResponse.status, 400);
  assert.match((await typeResponse.json()).error, /Tipo de importación inválido/);

  const invalidMode = new FormData();
  invalidMode.append('file', new File(['x'], 'productos.xlsx'));
  invalidMode.append('type', 'products');
  invalidMode.append('updateMode', 'otro');
  const modeResponse = await H.catalogImport(
    authRequest('http://localhost/api/catalog/import', { method: 'POST', body: invalidMode }),
  );
  assert.equal(modeResponse.status, 400);
  assert.match((await modeResponse.json()).error, /Modo de actualización inválido/);
});

test('POST /api/auth/login valida el body con Zod y mantiene { error }', async () => {
  resetState();

  const missingPassword = await H.login(
    jsonRequest('http://localhost/api/auth/login', { username: 'admin' }),
  );
  const payload: any = await missingPassword.json();

  assert.equal(missingPassword.status, 400);
  assert.deepEqual(Object.keys(payload), ['error']);
  assert.match(payload.error, /Usuario y contraseña requeridos/);

  const wrongTypes = await H.login(
    jsonRequest('http://localhost/api/auth/login', { username: 123, password: true }),
  );
  assert.equal(wrongTypes.status, 400);
  assert.match((await wrongTypes.json()).error, /Usuario y contraseña requeridos/);
});
