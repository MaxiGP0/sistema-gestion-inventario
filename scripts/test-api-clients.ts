/**
 * Pruebas de autorización de la API de clientes:
 * - El vendedor puede dar de alta una ficha desde `/orders/new` (POST).
 * - Editar y eliminar siguen reservados al admin del backoffice.
 *
 * No requieren base de datos: se inyecta una conexión mongoose falsa y se
 * stubbean las operaciones que ejecutaría cada handler.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';

import { Client } from '../models/Client';
import { Order } from '../models/Order';
import { authRequest } from './test-auth-utils';

const oid = () => 'a'.repeat(24);

const SELLER_ID = '000000000000000000000011';
const ADMIN_ID = '000000000000000000000012';

let H: {
  post: typeof import('../app/api/clients/route').POST;
  put: typeof import('../app/api/clients/[id]/route').PUT;
  delete: typeof import('../app/api/clients/[id]/route').DELETE;
};

const state = {
  upsertCalls: 0,
  deleteCalls: 0,
  lastUpdate: null as Record<string, unknown> | null,
};

function resetState() {
  state.upsertCalls = 0;
  state.deleteCalls = 0;
  state.lastUpdate = null;
}

const jsonRequest = (
  url: string,
  body: unknown,
  role: 'admin' | 'vendedor' | 'controlador' | 'billing',
  method = 'POST',
) =>
  authRequest(
    url,
    {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    role,
    role === 'admin' ? ADMIN_ID : SELLER_ID,
  );

const withParams = (handler: typeof H.put | typeof H.delete, id: string, request: Request) =>
  handler(request, { params: Promise.resolve({ id }) });

before(async () => {
  // dbConnect() encuentra una conexión cacheada y nunca toca MongoDB.
  process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/fake-test';
  (globalThis as any).mongoose = { conn: {}, promise: null };

  mock.method(Client as any, 'findOneAndUpdate', async (_filter: unknown, update: any) => {
    state.upsertCalls += 1;
    state.lastUpdate = update;
    return { _id: oid(), createdAt: new Date(), updatedAt: new Date(), ...update };
  });
  mock.method(Client as any, 'findByIdAndDelete', async () => {
    state.deleteCalls += 1;
    return { _id: oid() };
  });
  mock.method(Order as any, 'countDocuments', async () => 0);

  const [clientsRoute, clientIdRoute] = await Promise.all([
    import('../app/api/clients/route'),
    import('../app/api/clients/[id]/route'),
  ]);

  H = {
    post: clientsRoute.POST,
    put: clientIdRoute.PUT,
    delete: clientIdRoute.DELETE,
  };
});

after(() => mock.restoreAll());

test('POST /api/clients permite crear un cliente a vendedor y admin', async () => {
  for (const role of ['vendedor', 'admin'] as const) {
    resetState();

    const response = await H.post(
      jsonRequest(
        'http://localhost/api/clients',
        {
          code: ' CLI-NUEVO ',
          name: ' Farmacia Nueva ',
          address: ' Av. Siempre Viva 123 ',
          localidad: ' Rosario ',
          province: ' Santa Fe ',
          generalDiscount: 7.5,
        },
        role,
      ),
    );

    assert.equal(response.status, 200, `${role} debe poder crear clientes`);
    const payload: any = await response.json();
    assert.equal(payload.success, true);
    assert.equal(payload.client.code, 'CLI-NUEVO');
    assert.equal(payload.client.name, 'Farmacia Nueva');
    assert.equal(state.upsertCalls, 1);
    assert.equal(state.lastUpdate?.generalDiscount, 7.5);
  }
});

test('POST /api/clients rechaza al controlador y a facturación sin escribir', async () => {
  for (const role of ['controlador', 'billing'] as const) {
    resetState();

    const response = await H.post(
      jsonRequest('http://localhost/api/clients', { code: 'CLI-X', name: 'Cliente X' }, role),
    );

    assert.equal(response.status, 403, `${role} no puede crear clientes`);
    assert.equal(state.upsertCalls, 0);
  }
});

test('POST /api/clients exige una sesión válida', async () => {
  resetState();

  const response = await H.post(
    new Request('http://localhost/api/clients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'CLI-X', name: 'Cliente X' }),
    }),
  );

  assert.equal(response.status, 401);
  assert.equal(state.upsertCalls, 0);
});

test('POST /api/clients valida el body antes de escribir', async () => {
  resetState();

  const response = await H.post(
    jsonRequest('http://localhost/api/clients', { code: ' ', name: '' }, 'vendedor'),
  );

  assert.equal(response.status, 400);
  assert.equal(state.upsertCalls, 0);
});

test('vendedor no puede editar ni eliminar clientes; admin sí elimina', async () => {
  resetState();
  const sellerPut = await withParams(
    H.put,
    oid(),
    jsonRequest(
      'http://localhost/api/clients',
      { code: 'CLI-X', name: 'Cliente X' },
      'vendedor',
      'PUT',
    ),
  );
  assert.equal(sellerPut.status, 403);

  const sellerDelete = await withParams(
    H.delete,
    oid(),
    authRequest(
      `http://localhost/api/clients/${oid()}`,
      { method: 'DELETE' },
      'vendedor',
      SELLER_ID,
    ),
  );
  assert.equal(sellerDelete.status, 403);
  assert.equal(state.deleteCalls, 0);

  const adminDelete = await withParams(
    H.delete,
    oid(),
    authRequest(`http://localhost/api/clients/${oid()}`, { method: 'DELETE' }, 'admin', ADMIN_ID),
  );
  assert.equal(adminDelete.status, 200);
  assert.equal(state.deleteCalls, 1);
});
