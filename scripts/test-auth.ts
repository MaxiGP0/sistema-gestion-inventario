/**
 * Pruebas de autenticación y autorización:
 * - Sesión firmada (lib/session.ts): round-trip, manipulación, vencimiento.
 * - Reglas de rol (lib/authz.ts): navegación y operaciones sobre pedidos.
 * - Proxy: exige sesión en páginas y /api/*, salvo públicos/estáticos.
 * - Route handlers: 401 sin cookie y 403 con rol incorrecto, antes de Mongo.
 *
 * No requieren base de datos: los rechazos 401/403 se resuelven con las
 * claims firmadas de la cookie.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NextRequest } from 'next/server';

import {
  USER_ROLE_LABELS,
  canAccessPage,
  canCreateClient,
  canCreateOrder,
  canDeleteOrder,
  canManageCatalog,
  canUpdateOrder,
  normalizeUserRole,
  resolveUserRole,
  type UserRole,
} from '../lib/authz';
import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  createSessionToken,
  verifySessionToken,
} from '../lib/session';
import { proxy } from '../proxy';
import { POST as createOrder } from '../app/api/orders/route';
import { DELETE as deleteOrder, PUT as updateOrder } from '../app/api/orders/[id]/route';
import { POST as createProduct } from '../app/api/products/route';
import { DELETE as deleteProduct, PUT as updateProduct } from '../app/api/products/[id]/route';
import { POST as createBrand } from '../app/api/brands/route';
import { DELETE as deleteBrand, PUT as updateBrand } from '../app/api/brands/[id]/route';
import { POST as createClient } from '../app/api/clients/route';
import { DELETE as deleteClient } from '../app/api/clients/[id]/route';
import { POST as importCatalog } from '../app/api/catalog/import/route';
import { GET as getSession } from '../app/api/auth/session/route';
import { POST as logout } from '../app/api/auth/logout/route';
import { authRequest, testSessionCookie, TEST_AUTH_SECRET } from './test-auth-utils';

const VALID_ID = 'a'.repeat(24);
const OTHER_ID = 'b'.repeat(24);
const ADMIN_CLAIMS = {
  userId: '000000000000000000000001',
  username: 'admin-test',
  role: 'admin' as const,
  sessionVersion: 0,
};

process.env.AUTH_SECRET = process.env.AUTH_SECRET || TEST_AUTH_SECRET;

const jsonBody = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// ---------------------------------------------------------------------------
// Sesión firmada
// ---------------------------------------------------------------------------

test('la sesión firmada hace round-trip y conserva las claims', () => {
  const token = createSessionToken(ADMIN_CLAIMS);
  const payload = verifySessionToken(token);

  assert.ok(payload, 'el token recién firmado debe ser válido');
  assert.equal(payload.userId, ADMIN_CLAIMS.userId);
  assert.equal(payload.username, ADMIN_CLAIMS.username);
  assert.equal(payload.role, 'admin');
  assert.equal(payload.sessionVersion, 0);
  assert.ok(payload.exp > payload.iat, 'exp debe ser posterior a iat');
});

test('una sesión legacy con rol deposit se normaliza a controlador', () => {
  const legacyToken = createSessionToken({
    ...ADMIN_CLAIMS,
    role: 'deposit' as unknown as UserRole,
  });

  const payload = verifySessionToken(legacyToken);
  assert.ok(payload, 'la sesión legacy debe seguir siendo válida');
  assert.equal(payload.role, 'controlador');
});

test('una sesión manipulada, corrupta o con firma inválida se rechaza', () => {
  const token = createSessionToken(ADMIN_CLAIMS);
  const [payloadPart, signaturePart] = token.split('.');

  // Firma cambiada (último carácter distinto).
  const tamperedSignature = signaturePart.slice(0, -1) + (signaturePart.endsWith('A') ? 'B' : 'A');
  assert.equal(verifySessionToken(`${payloadPart}.${tamperedSignature}`), null);

  // Payload cambiado: intenta escalar a admin sin volver a firmar.
  const forgedPayload = Buffer.from(
    JSON.stringify({ ...ADMIN_CLAIMS, role: 'admin', iat: 1, exp: 9999999999 }),
    'utf8',
  ).toString('base64url');
  assert.equal(verifySessionToken(`${forgedPayload}.${signaturePart}`), null);

  assert.equal(verifySessionToken(''), null);
  assert.equal(verifySessionToken('sin-firma'), null);
  assert.equal(verifySessionToken('a.b.c'), null);
  assert.equal(verifySessionToken(undefined), null);
});

test('la sesión vence cumplido el TTL', () => {
  // exp se firma en segundos enteros: alinear el reloj evita falsos negativos
  // por la fracción de milisegundo entre `now` y el `iat` truncado.
  const now = Math.floor(Date.now() / 1000) * 1000;
  const token = createSessionToken(ADMIN_CLAIMS, now);

  assert.ok(verifySessionToken(token, now + SESSION_TTL_SECONDS * 1000 - 1));
  assert.equal(verifySessionToken(token, now + SESSION_TTL_SECONDS * 1000), null);
});

test('resolveUserRole migra usuarios sin rol y el deposit legado', () => {
  for (const role of ['admin', 'vendedor', 'controlador', 'billing'] as const) {
    assert.equal(resolveUserRole(role, 'cualquiera'), role);
  }

  assert.equal(normalizeUserRole('deposit'), 'controlador');
  assert.equal(normalizeUserRole('controlador'), 'controlador');
  assert.equal(normalizeUserRole('rol-inventado'), null);
  assert.equal(resolveUserRole('deposit', 'cualquiera'), 'controlador');

  assert.equal(resolveUserRole(undefined, 'admin'), 'admin');
  assert.equal(resolveUserRole(undefined, '  Admin '), 'admin');
  assert.equal(resolveUserRole(undefined, 'vendedor1'), 'vendedor');
  assert.equal(resolveUserRole('rol-inventado', 'admin'), 'admin');
  assert.equal(resolveUserRole('rol-inventado', 'otro'), 'vendedor');
});

test('las etiquetas de rol cubren todos los roles', () => {
  assert.equal(USER_ROLE_LABELS.controlador, 'Controlador');
  assert.equal(USER_ROLE_LABELS.billing, 'Facturación');
});

// ---------------------------------------------------------------------------
// Reglas de autorización
// ---------------------------------------------------------------------------

test('canAccessPage separa las bandejas por rol', () => {
  assert.equal(canAccessPage('/deposit/orders', 'controlador'), true);
  assert.equal(canAccessPage('/deposit/orders', 'billing'), false);
  assert.equal(canAccessPage('/deposit/orders', 'vendedor'), false);
  assert.equal(canAccessPage('/deposit/orders', 'admin'), true);

  assert.equal(canAccessPage('/billing/orders', 'billing'), true);
  assert.equal(canAccessPage('/billing/orders', 'controlador'), false);

  assert.equal(canAccessPage('/orders/new', 'vendedor'), true);
  assert.equal(canAccessPage('/orders/new', 'billing'), false);
  assert.equal(canAccessPage('/orders/new', 'admin'), true);

  assert.equal(canAccessPage('/backoffice/products', 'admin'), true);
  assert.equal(canAccessPage('/backoffice/products', 'vendedor'), false);

  // Catálogo de solo lectura: admin, vendedor y controlador; no facturación.
  for (const role of ['admin', 'vendedor', 'controlador'] as const) {
    assert.equal(
      canAccessPage('/catalog', role),
      true,
      `${role} debe ver el catálogo de productos`,
    );
    assert.equal(
      canAccessPage('/catalog/clients', role),
      true,
      `${role} debe ver el catálogo de clientes`,
    );
  }
  assert.equal(canAccessPage('/catalog', 'billing'), false);
  assert.equal(canAccessPage('/catalog/clients', 'billing'), false);

  // Las preferencias personales y la seguridad de la cuenta no restringen por rol.
  for (const path of ['/settings/notifications', '/settings/security'] as const) {
    assert.equal(canAccessPage(path, 'vendedor'), true);
    assert.equal(canAccessPage(path, 'controlador'), true);
    assert.equal(canAccessPage(path, 'billing'), true);
  }

  assert.equal(canAccessPage('/', 'vendedor'), true);
});

test('canUpdateOrder: controlador hace picking pero no factura', () => {
  // Verificar ítems: solo controlador; el vendedor no hace picking.
  assert.equal(canUpdateOrder('controlador', { hasItems: true }), true);
  assert.equal(canUpdateOrder('vendedor', { hasItems: true }), false);
  assert.equal(canUpdateOrder('billing', { hasItems: true }), false);
  assert.equal(canUpdateOrder('admin', { hasItems: true }), true);

  // Verificar/paralizar/pasar a facturación: solo controlador.
  for (const targetStatus of ['paralizado', 'facturacion'] as const) {
    assert.equal(canUpdateOrder('controlador', { hasItems: false, targetStatus }), true);
    assert.equal(canUpdateOrder('vendedor', { hasItems: false, targetStatus }), false);
    assert.equal(canUpdateOrder('billing', { hasItems: false, targetStatus }), false);
  }

  // Control post-factura y entrega: solo facturación.
  assert.equal(
    canUpdateOrder('billing', { hasItems: false, targetStatus: 'control_post_factura' }),
    true,
  );
  assert.equal(canUpdateOrder('billing', { hasItems: false, targetStatus: 'entregado' }), true);
  assert.equal(
    canUpdateOrder('controlador', { hasItems: false, targetStatus: 'control_post_factura' }),
    false,
  );
  assert.equal(
    canUpdateOrder('controlador', { hasItems: false, targetStatus: 'entregado' }),
    false,
  );

  // Comentario/archivado: vendedor, controlador y facturación.
  assert.equal(canUpdateOrder('vendedor', { hasItems: false }), true);
  assert.equal(canUpdateOrder('controlador', { hasItems: false }), true);
  assert.equal(canUpdateOrder('billing', { hasItems: false }), true);

  assert.equal(canCreateOrder('vendedor'), true);
  assert.equal(canCreateOrder('controlador'), false);
  assert.equal(canDeleteOrder('controlador'), false);
  assert.equal(canManageCatalog('vendedor'), false);
  assert.equal(canManageCatalog('controlador'), false);
  assert.equal(canManageCatalog('admin'), true);
});

test('canCreateClient habilita el alta rápida a admin y vendedor', () => {
  assert.equal(canCreateClient('admin'), true);
  assert.equal(canCreateClient('vendedor'), true);
  assert.equal(canCreateClient('controlador'), false);
  assert.equal(canCreateClient('billing'), false);
});

test('canUpdateOrder: el vendedor titular edita sólo un borrador intacto', () => {
  const intact = { isOwner: true, status: 'borrador', isIntact: true };

  // El titular puede reemplazar ítems y ajustar datos comerciales.
  assert.equal(canUpdateOrder('vendedor', { hasItems: true, draftEdit: intact }), true);
  assert.equal(
    canUpdateOrder('vendedor', {
      hasItems: false,
      hasCommercialData: true,
      draftEdit: intact,
    }),
    true,
  );

  // Un borrador ajeno se rechaza (la API responde 403).
  assert.equal(
    canUpdateOrder('vendedor', {
      hasItems: true,
      draftEdit: { ...intact, isOwner: false },
    }),
    false,
  );

  // Si depósito lo tomó o cambió de estado, la API responde 409.
  for (const status of [
    'paralizado',
    'facturacion',
    'control_post_factura',
    'entregado',
  ] as const) {
    assert.equal(
      canUpdateOrder('vendedor', {
        hasItems: true,
        draftEdit: { ...intact, status },
      }),
      false,
      `"${status}" no debe habilitar la edición del borrador`,
    );
  }

  // Picking o control post-factura iniciado: tampoco se edita.
  assert.equal(
    canUpdateOrder('vendedor', {
      hasItems: true,
      draftEdit: { ...intact, isIntact: false },
    }),
    false,
  );

  // El admin también respeta el estado y la integridad del borrador.
  assert.equal(canUpdateOrder('admin', { hasItems: true, draftEdit: intact }), true);
  assert.equal(
    canUpdateOrder('admin', {
      hasItems: true,
      draftEdit: { ...intact, status: 'facturacion' },
    }),
    false,
  );
  assert.equal(
    canUpdateOrder('admin', {
      hasItems: true,
      draftEdit: { ...intact, isIntact: false },
    }),
    false,
  );

  // Sin el modo de edición, el vendedor sigue sin poder tocar ítems ni datos
  // comerciales (sólo comenta/archiva).
  assert.equal(canUpdateOrder('vendedor', { hasItems: true }), false);
  assert.equal(canUpdateOrder('vendedor', { hasItems: false, hasCommercialData: true }), false);
});

// ---------------------------------------------------------------------------
// Proxy
// ---------------------------------------------------------------------------

const proxyRequest = (url: string, cookie?: string) =>
  new NextRequest(`http://localhost${url}`, cookie ? { headers: { cookie } } : undefined);

test('el proxy exige sesión en páginas y APIs', () => {
  const page = proxy(proxyRequest('/orders/new'));
  assert.equal(page.status, 307);
  assert.equal(page.headers.get('location'), 'http://localhost/login');

  const api = proxy(proxyRequest('/api/orders'));
  assert.equal(api.status, 401);

  // Los públicos y estáticos pasan sin cookie.
  for (const path of ['/login', '/api/auth/login', '/logo.png', '/_next/static/chunk.js']) {
    const response = proxy(proxyRequest(path));
    assert.equal(response.status, 200, `${path} debe pasar sin sesión`);
    assert.equal(response.headers.get('x-middleware-next'), '1', `${path} debe hacer next()`);
  }

  // El SSE dejó de ser público: exige sesión ya en el proxy.
  const events = proxy(proxyRequest('/api/events'));
  assert.equal(events.status, 401, '/api/events debe exigir sesión');
});

test('el proxy respeta la bandeja del rol y acepta APIs con sesión válida', () => {
  const controladorNext = proxy(proxyRequest('/deposit/orders', testSessionCookie('controlador')));
  assert.equal(controladorNext.headers.get('x-middleware-next'), '1');

  const controladorCrossed = proxy(
    proxyRequest('/billing/orders', testSessionCookie('controlador')),
  );
  assert.equal(controladorCrossed.status, 307);
  assert.equal(controladorCrossed.headers.get('location'), 'http://localhost/');

  const billingCrossed = proxy(proxyRequest('/backoffice/products', testSessionCookie('billing')));
  assert.equal(billingCrossed.status, 307);
  assert.equal(billingCrossed.headers.get('location'), 'http://localhost/');

  const vendedorOk = proxy(proxyRequest('/orders/new', testSessionCookie('vendedor')));
  assert.equal(vendedorOk.headers.get('x-middleware-next'), '1');

  // El catálogo de solo lectura está habilitado para vendedor y controlador,
  // tanto en productos como en clientes; el backoffice sigue bloqueado.
  for (const role of ['vendedor', 'controlador'] as const) {
    const catalogOk = proxy(proxyRequest('/catalog', testSessionCookie(role)));
    assert.equal(catalogOk.headers.get('x-middleware-next'), '1', `${role} debe ver /catalog`);

    const clientsCatalogOk = proxy(proxyRequest('/catalog/clients', testSessionCookie(role)));
    assert.equal(
      clientsCatalogOk.headers.get('x-middleware-next'),
      '1',
      `${role} debe ver /catalog/clients`,
    );

    const backofficeBlocked = proxy(proxyRequest('/backoffice/products', testSessionCookie(role)));
    assert.equal(backofficeBlocked.status, 307, `${role} no debe entrar al backoffice`);
    assert.equal(backofficeBlocked.headers.get('location'), 'http://localhost/');

    const clientsBackofficeBlocked = proxy(
      proxyRequest('/backoffice/clients', testSessionCookie(role)),
    );
    assert.equal(clientsBackofficeBlocked.status, 307, `${role} no debe gestionar clientes`);
    assert.equal(clientsBackofficeBlocked.headers.get('location'), 'http://localhost/');
  }

  const billingCatalog = proxy(proxyRequest('/catalog', testSessionCookie('billing')));
  assert.equal(billingCatalog.status, 307);
  assert.equal(billingCatalog.headers.get('location'), 'http://localhost/');

  const billingClientsCatalog = proxy(
    proxyRequest('/catalog/clients', testSessionCookie('billing')),
  );
  assert.equal(billingClientsCatalog.status, 307);
  assert.equal(billingClientsCatalog.headers.get('location'), 'http://localhost/');

  // La API solo exige sesión en el proxy; el rol fino se chequea en cada handler.
  const apiWithSession = proxy(proxyRequest('/api/brands', testSessionCookie('billing')));
  assert.equal(apiWithSession.headers.get('x-middleware-next'), '1');
});

test('el proxy limpia cookies inválidas o vencidas', () => {
  const tampered = testSessionCookie('admin').slice(0, -1) + 'x';
  const response = proxy(proxyRequest('/deposit/orders', tampered));

  assert.equal(response.status, 307);
  const setCookie = response.headers.get('set-cookie') || '';
  assert.ok(setCookie.includes(`${SESSION_COOKIE_NAME}=`), 'debe borrar la cookie de sesión');
  assert.ok(/max-age=0/i.test(setCookie), 'la cookie se borra con Max-Age=0');

  const expiredToken = createSessionToken(
    ADMIN_CLAIMS,
    Date.now() - (SESSION_TTL_SECONDS + 60) * 1000,
  );
  const expired = proxy(proxyRequest('/api/orders', `${SESSION_COOKIE_NAME}=${expiredToken}`));
  assert.equal(expired.status, 401);
});

// ---------------------------------------------------------------------------
// Route handlers: 401 / 403
// ---------------------------------------------------------------------------

test('POST /api/orders responde 401 sin sesión y 403 a roles que no venden', async () => {
  const body = {
    clientId: VALID_ID,
    items: [{ productId: OTHER_ID, requestedQuantity: 1 }],
    createdBy: 'Vendedor Test',
    invoiceType: 'A',
    paymentCondition: 'contado',
  };

  const billingForbidden = await createOrder(
    authRequest('http://localhost/api/orders', jsonBody(body), 'billing'),
  );
  assert.equal(billingForbidden.status, 403);

  const noCookie = await createOrder(new Request('http://localhost/api/orders', jsonBody(body)));
  assert.equal(noCookie.status, 401);
  const noCookiePayload = await noCookie.json();
  assert.ok(noCookiePayload.error);
});

test('PUT /api/orders/[id]: controlador no entrega ni controla post-factura', async () => {
  const withItems = await updateOrder(
    authRequest(
      `http://localhost/api/orders/${VALID_ID}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [{ _id: VALID_ID, verifiedQuantity: 1, isPending: false }],
          version: 0,
        }),
      },
      'billing',
    ),
    { params: Promise.resolve({ id: VALID_ID }) },
  );
  assert.equal(withItems.status, 403, 'facturación no puede tocar ítems del picking');

  const toDelivered = await updateOrder(
    authRequest(
      `http://localhost/api/orders/${VALID_ID}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'entregado', version: 0 }),
      },
      'controlador',
    ),
    { params: Promise.resolve({ id: VALID_ID }) },
  );
  assert.equal(toDelivered.status, 403, 'controlador no puede entregar/facturar');

  const noCookie = await updateOrder(
    new Request(`http://localhost/api/orders/${VALID_ID}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'facturacion' }),
    }),
    { params: Promise.resolve({ id: VALID_ID }) },
  );
  assert.equal(noCookie.status, 401);
});

test('DELETE /api/orders/[id] queda reservado al admin', async () => {
  const response = await deleteOrder(
    authRequest(`http://localhost/api/orders/${VALID_ID}`, { method: 'DELETE' }, 'vendedor'),
    { params: Promise.resolve({ id: VALID_ID }) },
  );
  assert.equal(response.status, 403);
});

test('POST /api/clients rechaza roles sin alta y DELETE sigue siendo sólo admin', async () => {
  const clientBody = { code: 'CLI-TEST', name: 'Cliente Test' };

  for (const role of ['controlador', 'billing'] as const) {
    const response = await createClient(
      authRequest('http://localhost/api/clients', jsonBody(clientBody), role),
    );
    assert.equal(response.status, 403, `${role} no puede crear clientes`);
  }

  const anonymous = await createClient(
    new Request('http://localhost/api/clients', jsonBody(clientBody)),
  );
  assert.equal(anonymous.status, 401);

  const sellerDelete = await deleteClient(
    authRequest(`http://localhost/api/clients/${VALID_ID}`, { method: 'DELETE' }, 'vendedor'),
    { params: Promise.resolve({ id: VALID_ID }) },
  );
  assert.equal(sellerDelete.status, 403, 'el vendedor no puede eliminar clientes');
});

test('catálogo: marcas e importación requieren admin', async () => {
  const brandAnonymous = await createBrand(
    new Request('http://localhost/api/brands', jsonBody({ name: 'Marca Test' })),
  );
  assert.equal(brandAnonymous.status, 401);

  const brandVendedor = await createBrand(
    authRequest('http://localhost/api/brands', jsonBody({ name: 'Marca Test' }), 'vendedor'),
  );
  assert.equal(brandVendedor.status, 403);

  const importDeposit = await importCatalog(
    authRequest('http://localhost/api/catalog/import', { method: 'POST' }, 'controlador'),
  );
  assert.equal(importDeposit.status, 403);
});

test('catálogo: vendedor y controlador reciben 403 en mutaciones de productos y marcas', async () => {
  for (const role of ['vendedor', 'controlador'] as const) {
    const productCreate = await createProduct(
      authRequest('http://localhost/api/products', jsonBody({}), role),
    );
    assert.equal(productCreate.status, 403, `${role} no puede crear productos`);

    const productUpdate = await updateProduct(
      authRequest(
        `http://localhost/api/products/${VALID_ID}`,
        { ...jsonBody({}), method: 'PUT' },
        role,
      ),
      { params: Promise.resolve({ id: VALID_ID }) },
    );
    assert.equal(productUpdate.status, 403, `${role} no puede editar productos`);

    const productDelete = await deleteProduct(
      authRequest(`http://localhost/api/products/${VALID_ID}`, { method: 'DELETE' }, role),
      { params: Promise.resolve({ id: VALID_ID }) },
    );
    assert.equal(productDelete.status, 403, `${role} no puede dar de baja productos`);

    const brandCreate = await createBrand(
      authRequest('http://localhost/api/brands', jsonBody({}), role),
    );
    assert.equal(brandCreate.status, 403, `${role} no puede crear marcas`);

    const brandUpdate = await updateBrand(
      authRequest(
        `http://localhost/api/brands/${VALID_ID}`,
        { ...jsonBody({}), method: 'PUT' },
        role,
      ),
      { params: Promise.resolve({ id: VALID_ID }) },
    );
    assert.equal(brandUpdate.status, 403, `${role} no puede editar marcas`);

    const brandDelete = await deleteBrand(
      authRequest(`http://localhost/api/brands/${VALID_ID}`, { method: 'DELETE' }, role),
      { params: Promise.resolve({ id: VALID_ID }) },
    );
    assert.equal(brandDelete.status, 403, `${role} no puede eliminar marcas`);
  }
});

test('GET /api/auth/session responde 401 sin cookie (sin tocar Mongo)', async () => {
  const response = await getSession(new Request('http://localhost/api/auth/session'));
  assert.equal(response.status, 401);
});

test('POST /api/auth/logout borra la cookie de sesión', async () => {
  const response = await logout();
  assert.equal(response.status, 200);

  const payload = await response.json();
  assert.equal(payload.success, true);

  const setCookie = response.headers.get('set-cookie') || '';
  assert.ok(setCookie.includes(`${SESSION_COOKIE_NAME}=`), 'debe limpiar la cookie de sesión');
  assert.ok(/max-age=0/i.test(setCookie), 'la cookie se borra con Max-Age=0');
});
