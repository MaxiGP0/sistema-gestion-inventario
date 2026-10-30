import { NextResponse } from 'next/server';
import dbConnect from '@/lib/mongodb';
import { User } from '@/models/User';
import bcrypt from 'bcryptjs';
import { normalizeUserRole, resolveUserRole } from '@/lib/authz';
import { primeCurrentSessionCache } from '@/lib/current-session-cache';
import { buildSessionCookie, createSessionToken } from '@/lib/session';
import { loginSchema } from '@/lib/validations';
import { errorResponse, handleRouteError, parseJsonBody } from '@/lib/api-errors';
import {
  getClientIp,
  getRetryAfterSeconds,
  ipRateLimitKey,
  isRateLimited,
  recordFailedAttempt,
  resetAttempts,
  userRateLimitKey,
} from '@/lib/login-rate-limit';
import type { LoginResponse } from '@/lib/types';
import { withRouteLogging } from '@/lib/logger';
import { recordLoginAttempt } from '@/lib/observability/metrics';

/** Mismo mensaje para usuario inexistente y contraseña incorrecta (no filtra cuál falló). */
const INVALID_CREDENTIALS_ERROR = 'Credenciales inválidas';

export const POST = withRouteLogging(async (request: Request) => {
  try {
    const parsedBody = await parseJsonBody(request, loginSchema);
    if (!parsedBody.success) {
      recordLoginAttempt('validation_error');
      return parsedBody.response;
    }

    const { username, password } = parsedBody.data;

    // Antes de tocar la base: si la IP o el usuario agotaron sus intentos,
    // se corta acá y no se verifica nada.
    const ipKey = ipRateLimitKey(getClientIp(request));
    const userKey = userRateLimitKey(username);

    if (isRateLimited(ipKey) || isRateLimited(userKey)) {
      const retryAfterSeconds = Math.max(
        getRetryAfterSeconds(ipKey),
        getRetryAfterSeconds(userKey),
        1,
      );

      recordLoginAttempt('rate_limited');

      return NextResponse.json(
        { error: 'Demasiados intentos fallidos. Intente de nuevo más tarde.' },
        { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } },
      );
    }

    await dbConnect();

    const user = await User.findOne({ username });
    const isMatch = user ? await bcrypt.compare(password, user.passwordHash) : false;

    if (!user || !isMatch) {
      recordFailedAttempt(ipKey);
      recordFailedAttempt(userKey);
      recordLoginAttempt('invalid_credentials');
      return errorResponse(INVALID_CREDENTIALS_ERROR, 401);
    }

    // Un login exitoso limpia los contadores de esa IP y ese usuario.
    resetAttempts(ipKey);
    resetAttempts(userKey);

    // Usuario desactivado: las credenciales son válidas, pero no puede operar.
    if (user.active === false) {
      recordLoginAttempt('disabled');
      return errorResponse('Usuario desactivado. Contactá a un administrador.', 403);
    }

    // Migración suave: los usuarios existentes sin `role` reciben admin (el
    // histórico "admin") o vendedor; el rol legado `deposit` pasa a
    // `controlador`. El rol migrado queda persistido al iniciar sesión.
    const role = normalizeUserRole(user.role) ?? resolveUserRole(user.role, user.username);
    const sessionVersion =
      typeof user.sessionVersion === 'number' && Number.isInteger(user.sessionVersion)
        ? user.sessionVersion
        : 0;

    if (user.role !== role || user.sessionVersion !== sessionVersion) {
      user.role = role;
      user.sessionVersion = sessionVersion;
    }

    // lastLoginAt se persiste en cada login exitoso (también sirve de auditoría).
    const lastLoginAt = new Date();
    user.lastLoginAt = lastLoginAt;
    await user.save();

    const notificationsEnabled = user.notificationsEnabled !== false;

    // El login deja el caché de sesión actual listo para la primera escritura.
    primeCurrentSessionCache({
      userId: String(user._id),
      username: user.username,
      role,
      active: true,
      sessionVersion,
      notificationsEnabled,
    });

    const token = createSessionToken({
      userId: String(user._id),
      username: user.username,
      role,
      sessionVersion,
    });

    const responseBody: LoginResponse = {
      success: true,
      message: 'Autenticación exitosa',
      user: {
        id: String(user._id),
        username: user.username,
        role,
        notificationsEnabled,
      },
    };

    const response = NextResponse.json(responseBody);

    const cookie = buildSessionCookie(token);
    response.cookies.set(cookie.name, cookie.value, cookie.options);

    recordLoginAttempt('success');
    return response;
  } catch (error: unknown) {
    recordLoginAttempt('server_error');
    return handleRouteError(error, { context: 'Error en login:' });
  }
});
