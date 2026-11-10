/**
 * Pruebas de administración de usuarios y sesiones actuales:
 * - /api/users exige admin en GET/POST/PATCH/DELETE y nunca expone passwordHash.
 * - Alta con bcrypt 10, cambio de rol, reset de contraseña y activación/baja.
 * - Un usuario desactivado no puede ejecutar escrituras (401 + cookie borrada).
 * - El cambio de rol rige en la siguiente petición, sin esperar las 8 h.
 * - No se puede desactivar/eliminar el propio usuario ni dejar el sistema sin
 *   administradores activos.
 * - El login persiste lastLoginAt y firma sessionVersion.
 *
 * No requiere base de datos: conexión mongoose falsa + modelo User en memoria.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, mock, test } from 'node:test';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

import { sessionCookieName, verifySessionToken } from '../lib/session';
import { authorizeCurrentPageSession } from '../lib/auth-page';
import type { UserRole } from '../lib/authz';

const ADMIN_ID = '000000000000000000000001';
const VENDEDOR_ID = '0000000000000000000000b2';
const TARGET_ID = '0000000000000000000000c3';
const LOGIN_ID = '0000000000000000000000d4';
const PASSWORD_ID = '0000000000000000000000e5';

const DEFAULT_PASSWORD = 'clave123';

interface UserRecord {
  _id: mongoose.Types.ObjectId;
  username: string;
  role: UserRole;
  active: boolean;
  sessionVersion: number;
  passwordHash: string;
  notificationsEnabled: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}

const users = new Map<string, UserRecord>();
let defaultPasswordHash = '';

let GET: (request: Request) => Promise<Response>;
let POST: (request: Request) => Promise<Response>;
let PATCH: (request: Request) => Promise<Response>;
let DELETE: (request: Request) => Promise<Response>;
let login: (request: Request) => Promise<Response>;
let changePassword: (request: Request) => Promise<Response>;
let getSession: (request: Request) => Promise<Response>;
let authRequest: typeof import('./test-auth-utils').authRequest;
let testSessionCookie: typeof import('./test-auth-utils').testSessionCookie;
let resetCurrentSessionCache: typeof import('../lib/current-session-cache').resetCurrentSessionCache;

const oid = (value: string) => new mongoose.Types.ObjectId(value);

function seedUser({
  id,
  username,
  role,
  active = true,
  sessionVersion = 0,
  passwordHash = defaultPasswordHash,
}: {
  id: string;
  username: string;
  role: UserRole;
  active?: boolean;
  sessionVersion?: number;
  passwordHash?: string;
}): UserRecord {
  const record: UserRecord = {
    _id: oid(id),
    username,
    role,
    active,
    sessionVersion,
    passwordHash,
    notificationsEnabled: true,
    lastLoginAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  users.set(id, record);
  return record;
}

function cloneRecord(record: UserRecord): Record<string, unknown> {
  return { ...record };
}

function matchesId(value: unknown, id: string): boolean {
  return String(value) === id;
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const cookieFromResponse = (response: Response): string => {
  const setCookie = response.headers.get('set-cookie') || '';
  const match = new RegExp(`${sessionCookieName()}=([^;]+)`).exec(setCookie);
  assert.ok(match, 'la respuesta debe incluir la cookie de sesión');
  return match[1];
};

before(async () => {
  defaultPasswordHash = await bcrypt.hash(DEFAULT_PASSWORD, 10);

  // dbConnect() encuentra una conexión cacheada y nunca toca MongoDB.
  process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/fake-test';
  (globalThis as any).mongoose = { conn: {}, promise: null };

  const { User } = await import('../models/User');

  mock.method(User as any, 'findById', (id: unknown) => {
    const record = users.get(String(id));
    const chain: any = {
      select: () => chain,
      lean: async () => (record ? cloneRecord(record) : null),
    };
    return chain;
  });

  mock.method(User as any, 'find', () => {
    const chain: any = {
      select: () => chain,
      sort: () => chain,
      lean: async () => Array.from(users.values()).map(cloneRecord),
    };
    return chain;
  });

  mock.method(User as any, 'findOne', async (query: { username?: string }) => {
    const record = Array.from(users.values()).find((user) => user.username === query.username);
    if (!record) return null;

    const document: any = cloneRecord(record);
    document.save = async () => {
      record.role = document.role;
      record.sessionVersion = document.sessionVersion;
      record.lastLoginAt = document.lastLoginAt;
      record.notificationsEnabled = document.notificationsEnabled;
      users.set(String(record._id), record);
    };

    return document;
  });

  mock.method(User as any, 'create', async (data: Record<string, unknown>) => {
    const id = new mongoose.Types.ObjectId().toString();
    const record = seedUser({
      id,
      username: String(data.username),
      role: data.role as UserRole,
      active: data.active !== false,
      sessionVersion: Number(data.sessionVersion) || 0,
      passwordHash: String(data.passwordHash),
    });
    record.notificationsEnabled = data.notificationsEnabled !== false;
    record.lastLoginAt = (data.lastLoginAt as Date | null) ?? null;

    return {
      ...cloneRecord(record),
      toObject: () => cloneRecord(record),
    };
  });

  mock.method(User as any, 'findByIdAndUpdate', (id: unknown, update: Record<string, any>) => {
    const key = String(id);
    const record = users.get(key);

    if (record) {
      const set = (update.$set ?? {}) as Partial<UserRecord>;
      Object.assign(record, set);
      if (typeof update.$inc?.sessionVersion === 'number') {
        record.sessionVersion += update.$inc.sessionVersion;
      }
    }

    const chain: any = {
      select: () => chain,
      lean: async () => (record ? cloneRecord(record) : null),
    };
    return chain;
  });

  mock.method(User as any, 'findByIdAndDelete', async (id: unknown) => {
    const key = String(id);
    const record = users.get(key);
    if (!record) return null;

    users.delete(key);
    return cloneRecord(record);
  });

  mock.method(User as any, 'countDocuments', async (query: Record<string, any>) => {
    const excludedId = query?._id?.$ne;

    return Array.from(users.values()).filter((user) => {
      if (query.role !== undefined && user.role !== query.role) return false;
      if (query.active?.$ne === false && user.active === false) return false;
      if (excludedId !== undefined && matchesId(excludedId, String(user._id))) return false;
      return true;
    }).length;
  });

  const usersRoute = await import('../app/api/users/route');
  ({ POST: login } = await import('../app/api/auth/login/route'));
  ({ POST: changePassword } = await import('../app/api/auth/change-password/route'));
  ({ GET: getSession } = await import('../app/api/auth/session/route'));

  GET = usersRoute.GET;
  POST = usersRoute.POST;
  PATCH = usersRoute.PATCH;
  DELETE = usersRoute.DELETE;

  ({ authRequest, testSessionCookie } = await import('./test-auth-utils'));
  ({ resetCurrentSessionCache } = await import('../lib/current-session-cache'));
});

beforeEach(() => {
  users.clear();
  resetCurrentSessionCache();
  seedUser({ id: ADMIN_ID, username: 'admin-test', role: 'admin' });
});

after(() => mock.restoreAll());

// ---------------------------------------------------------------------------
// Autorización y contrato
// ---------------------------------------------------------------------------

test('GET/POST/PATCH/DELETE /api/users responden 403 a un no-admin', async () => {
  const vendorId = VENDEDOR_ID;
  seedUser({ id: vendorId, username: 'vendedor-test', role: 'vendedor' });

  const list = await GET(authRequest('http://localhost/api/users', {}, 'vendedor', vendorId));
  assert.equal(list.status, 403);

  const create = await POST(
    authRequest(
      'http://localhost/api/users',
      jsonInit('POST', { username: 'nuevo', password: 'clave123', role: 'vendedor' }),
      'vendedor',
      vendorId,
    ),
  );
  assert.equal(create.status, 403);

  const patch = await PATCH(
    authRequest(
      'http://localhost/api/users',
      jsonInit('PATCH', { id: ADMIN_ID, role: 'vendedor' }),
      'vendedor',
      vendorId,
    ),
  );
  assert.equal(patch.status, 403);

  const remove = await DELETE(
    authRequest(
      `http://localhost/api/users?id=${ADMIN_ID}`,
      { method: 'DELETE' },
      'vendedor',
      vendorId,
    ),
  );
  assert.equal(remove.status, 403);
});

test('POST crea con bcrypt 10 y GET lista sin passwordHash', async () => {
  const password = 'secreta-123';
  const createResponse = await POST(
    authRequest(
      'http://localhost/api/users',
      jsonInit('POST', { username: 'nueva-vendedora', password, role: 'vendedor' }),
    ),
  );
  const createPayload: any = await createResponse.json();

  assert.equal(createResponse.status, 200);
  assert.equal(createPayload.success, true);
  assert.equal(createPayload.user.username, 'nueva-vendedora');
  assert.equal(createPayload.user.active, true);
  assert.equal(createPayload.user.lastLoginAt, null);
  assert.equal(createPayload.user.passwordHash, undefined);
  assert.ok(!JSON.stringify(createPayload).includes('passwordHash'));

  const created = Array.from(users.values()).find((user) => user.username === 'nueva-vendedora');
  assert.ok(created, 'el usuario debe quedar persistido');
  assert.ok(await bcrypt.compare(password, created.passwordHash));
  assert.notEqual(created.passwordHash, password);
  assert.equal(created.sessionVersion, 0);

  const listResponse = await GET(authRequest('http://localhost/api/users'));
  const listPayload: any = await listResponse.json();

  assert.equal(listResponse.status, 200);
  assert.ok(listPayload.users.length >= 2);
  for (const user of listPayload.users) {
    assert.equal(user.passwordHash, undefined);
    assert.ok(!JSON.stringify(user).includes('passwordHash'));
  }
});

test('PATCH cambia el rol e incrementa sessionVersion como una baja/reset', async () => {
  const target = seedUser({ id: TARGET_ID, username: 'objetivo', role: 'vendedor' });
  const oldCookie = testSessionCookie('vendedor', TARGET_ID, 0);

  const beforeRole = await GET(
    new Request('http://localhost/api/users', { headers: { cookie: oldCookie } }),
  );
  assert.equal(beforeRole.status, 403, 'con rol vendedor no puede listar usuarios');

  const promote = await PATCH(
    authRequest('http://localhost/api/users', jsonInit('PATCH', { id: TARGET_ID, role: 'admin' })),
  );
  assert.equal(promote.status, 200);
  assert.equal(target.role, 'admin');
  assert.equal(target.sessionVersion, 1, 'el cambio de rol debe incrementar sessionVersion');

  // La cookie anterior ya no representa al usuario: version 0 contra version 1.
  const staleAfterPromote = await GET(
    new Request('http://localhost/api/users', { headers: { cookie: oldCookie } }),
  );
  assert.equal(staleAfterPromote.status, 401, 'el cambio de rol invalida la cookie anterior');
  assert.match(staleAfterPromote.headers.get('set-cookie') || '', /Max-Age=0/i);

  // Un login nuevo sí trae el rol y la versión actuales.
  const promotedCookie = testSessionCookie('admin', TARGET_ID, 1);
  const afterPromote = await GET(
    new Request('http://localhost/api/users', { headers: { cookie: promotedCookie } }),
  );
  assert.equal(afterPromote.status, 200, 'el rol admin debe aplicar al reingresar');

  const demote = await PATCH(
    authRequest(
      'http://localhost/api/users',
      jsonInit('PATCH', { id: TARGET_ID, role: 'vendedor' }),
    ),
  );
  assert.equal(demote.status, 200);
  assert.equal(target.sessionVersion, 2);

  const afterDemote = await GET(
    new Request('http://localhost/api/users', { headers: { cookie: promotedCookie } }),
  );
  assert.equal(afterDemote.status, 401, 'la desjerarquización invalida la cookie de admin');

  // Aun con una cookie firmada que declare `admin`, la autorización usa el rol
  // de la base: si ya es vendedor, la API responde 403 y /backoffice redirige.
  const forgedAdminCookie = testSessionCookie('admin', TARGET_ID, 2);
  const currentRoleResponse = await GET(
    new Request('http://localhost/api/users', { headers: { cookie: forgedAdminCookie } }),
  );
  assert.equal(currentRoleResponse.status, 403);

  const signed = verifySessionToken(forgedAdminCookie.slice(forgedAdminCookie.indexOf('=') + 1));
  assert.ok(signed);
  const pageDecision = await authorizeCurrentPageSession(signed, ['admin']);
  assert.equal(pageDecision.status, 'forbidden', '/backoffice debe redirigir al panel');

  const reset = await PATCH(
    authRequest(
      'http://localhost/api/users',
      jsonInit('PATCH', { id: TARGET_ID, password: 'nueva-clave-456' }),
    ),
  );
  assert.equal(reset.status, 200);
  assert.equal(target.sessionVersion, 3);
  assert.ok(await bcrypt.compare('nueva-clave-456', target.passwordHash));

  const stale = await GET(
    new Request('http://localhost/api/users', { headers: { cookie: forgedAdminCookie } }),
  );
  assert.equal(stale.status, 401, 'el reset debe invalidar las sesiones viejas');
});

test('un usuario desactivado no puede leer la página ni listar usuarios', async () => {
  const target = seedUser({ id: TARGET_ID, username: 'admin-objetivo', role: 'admin' });
  const cookie = testSessionCookie('admin', TARGET_ID, 0);
  const signed = verifySessionToken(cookie.slice(cookie.indexOf('=') + 1));
  assert.ok(signed);

  const deactivate = await PATCH(
    authRequest('http://localhost/api/users', jsonInit('PATCH', { id: TARGET_ID, active: false })),
  );
  assert.equal(deactivate.status, 200);
  assert.equal(target.sessionVersion, 1);

  const decision = await authorizeCurrentPageSession(signed, ['admin']);
  assert.equal(decision.status, 'login', 'una baja debe mandar al login');

  const response = await GET(new Request('http://localhost/api/users', { headers: { cookie } }));
  assert.equal(response.status, 401);
});

test('un usuario desactivado no puede mutar y recibe 401 con cookie borrada', async () => {
  seedUser({ id: TARGET_ID, username: 'admin-objetivo', role: 'admin' });
  const staleRequest = authRequest(
    'http://localhost/api/users',
    jsonInit('POST', { username: 'no-debe-crearse', password: 'clave123', role: 'vendedor' }),
    'admin',
    TARGET_ID,
    0,
  );

  const deactivate = await PATCH(
    authRequest('http://localhost/api/users', jsonInit('PATCH', { id: TARGET_ID, active: false })),
  );
  assert.equal(deactivate.status, 200);

  const response = await POST(staleRequest);
  assert.equal(response.status, 401);
  assert.match(await response.text(), /Sesión inválida/i);
  assert.match(response.headers.get('set-cookie') || '', /Max-Age=0/i);
  assert.equal(
    Array.from(users.values()).some((user) => user.username === 'no-debe-crearse'),
    false,
  );
});

test('no se puede desactivar, eliminar ni desjerarquizar al último admin', async () => {
  const selfDeactivate = await PATCH(
    authRequest('http://localhost/api/users', jsonInit('PATCH', { id: ADMIN_ID, active: false })),
  );
  assert.equal(selfDeactivate.status, 400);
  assert.match((await selfDeactivate.json()).error, /desactivar tu propio usuario/);

  const selfDelete = await DELETE(
    authRequest(`http://localhost/api/users?id=${ADMIN_ID}`, { method: 'DELETE' }),
  );
  assert.equal(selfDelete.status, 400);
  assert.match((await selfDelete.json()).error, /eliminar tu propio usuario/);

  const lastAdminRole = await PATCH(
    authRequest(
      'http://localhost/api/users',
      jsonInit('PATCH', { id: ADMIN_ID, role: 'vendedor' }),
    ),
  );
  assert.equal(lastAdminRole.status, 400);
  assert.match((await lastAdminRole.json()).error, /último administrador activo/);
  assert.equal(users.get(ADMIN_ID)?.role, 'admin');
});

// ---------------------------------------------------------------------------
// Login y cambio de contraseña propio
// ---------------------------------------------------------------------------

test('el login exitoso actualiza lastLoginAt y firma la sessionVersion actual', async () => {
  const loginUser = seedUser({
    id: LOGIN_ID,
    username: 'login-test',
    role: 'vendedor',
    sessionVersion: 3,
  });

  const response = await login(
    new Request(
      'http://localhost/api/auth/login',
      jsonInit('POST', { username: 'login-test', password: DEFAULT_PASSWORD }),
    ),
  );

  assert.equal(response.status, 200);
  assert.ok(loginUser.lastLoginAt instanceof Date, 'lastLoginAt debe quedar persistido');
  assert.equal(loginUser.sessionVersion, 3);

  const token = cookieFromResponse(response);
  const payload = verifySessionToken(token);
  assert.ok(payload);
  assert.equal(payload.sessionVersion, 3);
  assert.equal(payload.role, 'vendedor');
});

test('el login emite __Host-sgi_session con Secure, Path=/ y sin Domain en producción', async (t) => {
  seedUser({
    id: LOGIN_ID,
    username: 'login-produccion',
    role: 'vendedor',
    sessionVersion: 1,
  });

  // `NODE_ENV` está tipado como readonly; el cast permite simular el deploy.
  const env = process.env as Record<string, string | undefined>;
  const previousNodeEnv = env.NODE_ENV;
  env.NODE_ENV = 'production';
  t.after(() => {
    if (previousNodeEnv === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = previousNodeEnv;
  });

  const response = await login(
    new Request(
      'http://localhost/api/auth/login',
      jsonInit('POST', { username: 'login-produccion', password: DEFAULT_PASSWORD }),
    ),
  );

  assert.equal(response.status, 200);

  const setCookie = response.headers.get('set-cookie') || '';
  assert.match(setCookie, /^__Host-sgi_session=/, 'debe usar el prefijo __Host-');
  assert.match(setCookie, /;\s*Secure/i);
  assert.match(setCookie, /;\s*Path=\//i);
  assert.doesNotMatch(setCookie, /;\s*Domain=/i);

  const payload = verifySessionToken(cookieFromResponse(response));
  assert.ok(payload);
  assert.equal(payload.username, 'login-produccion');
});

test('un usuario desactivado no puede iniciar sesión', async () => {
  const loginUser = seedUser({
    id: LOGIN_ID,
    username: 'login-inactivo',
    role: 'vendedor',
    active: false,
  });

  const response = await login(
    new Request(
      'http://localhost/api/auth/login',
      jsonInit('POST', { username: 'login-inactivo', password: DEFAULT_PASSWORD }),
    ),
  );

  assert.equal(response.status, 403);
  assert.equal(loginUser.lastLoginAt, null);
});

test('change-password verifica la actual, hashea la nueva y renueva la cookie', async () => {
  const user = seedUser({
    id: PASSWORD_ID,
    username: 'cambio-clave',
    role: 'vendedor',
  });
  const oldCookie = testSessionCookie('vendedor', PASSWORD_ID, 0);

  const response = await changePassword(
    new Request('http://localhost/api/auth/change-password', {
      ...jsonInit('POST', {
        currentPassword: DEFAULT_PASSWORD,
        newPassword: 'nueva-clave-789',
      }),
      headers: {
        'Content-Type': 'application/json',
        cookie: oldCookie,
      },
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(user.sessionVersion, 1);
  assert.ok(await bcrypt.compare('nueva-clave-789', user.passwordHash));

  const responsePayload = (await response.json()) as { success: boolean; message: string };
  assert.equal(responsePayload.success, true);
  assert.match(responsePayload.message, /contraseña actualizada/i);

  const renewedCookie = cookieFromResponse(response);
  const payload = verifySessionToken(renewedCookie);
  assert.ok(payload);
  assert.equal(payload.sessionVersion, 1);

  // La cookie renovada mantiene autenticado al dispositivo actual, mientras
  // que la cookie anterior (otra sesión) queda inválida.
  const currentSession = await getSession(
    new Request('http://localhost/api/auth/session', {
      headers: { cookie: `${sessionCookieName()}=${renewedCookie}` },
    }),
  );
  assert.equal(currentSession.status, 200);
  assert.equal(
    ((await currentSession.json()) as { user: { username: string } }).user.username,
    'cambio-clave',
  );

  const staleResponse = await changePassword(
    new Request('http://localhost/api/auth/change-password', {
      ...jsonInit('POST', {
        currentPassword: 'nueva-clave-789',
        newPassword: 'otra-clave-000',
      }),
      headers: {
        'Content-Type': 'application/json',
        cookie: oldCookie,
      },
    }),
  );
  assert.equal(staleResponse.status, 401);
});

test('change-password rechaza la contraseña actual incorrecta', async () => {
  seedUser({ id: PASSWORD_ID, username: 'clave-incorrecta', role: 'vendedor' });

  const response = await changePassword(
    authRequest(
      'http://localhost/api/auth/change-password',
      jsonInit('POST', {
        currentPassword: 'no-es-la-clave',
        newPassword: 'nueva-clave-789',
      }),
      'vendedor',
      PASSWORD_ID,
      0,
    ),
  );

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /contraseña actual es incorrecta/);
});
