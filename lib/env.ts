/**
 * Validación de variables de entorno del servidor.
 *
 * El schema se evalúa al arrancar Next (instrumentation.ts) para que una
 * configuración incompleta falle con un mensaje accionable en vez de romper
 * más tarde en la primera conexión o al firmar una sesión. Los módulos que
 * necesitan valores concretos (`lib/mongodb.ts`) vuelven a pedirlos por
 * `getEnv()`: la validación es barata y el cache evita repetirla.
 *
 * Nunca se imprimen los valores recibidos: solo el nombre de la variable y el
 * problema, para no filtrar secretos en los logs.
 */

import { z } from 'zod';

/** Mínimo compartido con lib/session.ts para no aceptar secretos triviales. */
export const AUTH_SECRET_MIN_LENGTH = 16;

/** Variables VAPID que habilitan Web Push. Las tres se configuran juntas o ninguna. */
export const VAPID_ENV_KEYS = ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'] as const;

const optionalEnvString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().min(1).optional(),
);

/**
 * Normaliza claves VAPID copiadas con comillas o en base64 estándar/con `=` al
 * formato base64url sin padding que exige `web-push`.
 */
const optionalVapidKeyString = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  const trimmed = value
    .trim()
    .replace(/^['"]+|['"]+$/g, '')
    .trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}, z.string().min(1).optional());

export const envSchema = z
  .object({
    MONGODB_URI: z
      .string({ error: 'MONGODB_URI es obligatoria' })
      .trim()
      .min(1, 'MONGODB_URI es obligatoria')
      .regex(/^mongodb(\+srv)?:\/\/.+/, 'MONGODB_URI debe empezar con mongodb:// o mongodb+srv://'),
    AUTH_SECRET: z
      .string({ error: 'AUTH_SECRET es obligatoria' })
      .trim()
      .min(
        AUTH_SECRET_MIN_LENGTH,
        `AUTH_SECRET debe tener al menos ${AUTH_SECRET_MIN_LENGTH} caracteres`,
      ),
    // Web Push es opcional: sin las tres claves la app funciona y el envío de
    // push queda deshabilitado. La validación exige configurarlas en bloque
    // para no arrancar con un push a medio configurar.
    VAPID_PUBLIC_KEY: optionalVapidKeyString,
    VAPID_PRIVATE_KEY: optionalVapidKeyString,
    VAPID_SUBJECT: optionalEnvString,
  })
  .superRefine((env, ctx) => {
    const configured = VAPID_ENV_KEYS.filter((key) => Boolean(env[key]));

    if (configured.length === 0) return;

    if (configured.length < VAPID_ENV_KEYS.length) {
      for (const key of VAPID_ENV_KEYS) {
        if (!env[key]) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `${key} es obligatoria cuando se configura Web Push`,
          });
        }
      }
      return;
    }

    if (!/^(mailto:|https:\/\/)/i.test(env.VAPID_SUBJECT ?? '')) {
      ctx.addIssue({
        code: 'custom',
        path: ['VAPID_SUBJECT'],
        message: 'VAPID_SUBJECT debe ser un mailto: o una URL https:',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Configuración VAPID lista para usar, o `null` cuando Web Push está apagado.
 * La clave privada nunca debe enviarse al cliente.
 */
export function getVapidConfig(): {
  publicKey: string;
  privateKey: string;
  subject: string;
} | null {
  const env = getEnv();

  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) {
    return null;
  }

  return {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT,
  };
}

type EnvSource = Record<string, string | undefined>;

/** Formatea los issues de Zod con la variable afectada, sin incluir valores. */
function formatEnvIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const key = issue.path.length > 0 ? issue.path.join('.') : 'entorno';
      return `  - ${key}: ${issue.message}`;
    })
    .join('\n');
}

/** Valida un conjunto de variables y devuelve el objeto tipado. */
export function parseEnv(source: EnvSource = process.env): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    throw new Error(
      `Configuración de entorno inválida:\n${formatEnvIssues(result.error)}\n` +
        'Revisá el archivo .env.local (ver README) y reiniciá el servidor.',
    );
  }

  return Object.freeze(result.data);
}

let cachedEnv: Env | null = null;

/**
 * Variables de entorno validadas. Cachea el resultado para que el arranque y
 * los módulos que las consultan compartan una única validación.
 */
export function getEnv(): Env {
  if (!cachedEnv) {
    cachedEnv = parseEnv();
  }

  return cachedEnv;
}

/** Solo para tests: permite revalidar después de cambiar process.env. */
export function resetEnvCache(): void {
  cachedEnv = null;
}
