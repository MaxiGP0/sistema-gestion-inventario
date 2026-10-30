/**
 * Helpers comunes de las rutas API: parseo de cuerpos con Zod, formato único
 * de error `{ error }` y traducción de errores de Mongo/Mongoose.
 *
 * Los errores conocidos (duplicado, validación, cast) se responden como 400/409
 * con un mensaje para el usuario. Cualquier otro error se registra completo en
 * el log estructurado y sale como 500 genérico para no filtrar detalles internos.
 */
import { NextResponse } from 'next/server';
import type { z } from 'zod';
import { getRequestContext, logError } from './logger';
import { captureServerError } from './observability/errors-server';
import { formatZodIssues } from './validations';

export const GENERIC_ERROR_MESSAGE = 'Error interno del servidor';

type ErrorExtras = Record<string, unknown>;

/** Respuesta de error homogénea: siempre incluye `error` (y extras opcionales). */
export function errorResponse(message: string, status: number, extras?: ErrorExtras) {
  return NextResponse.json({ error: message, ...extras }, { status });
}

export function zodErrorResponse(error: z.ZodError, prefix = 'Datos inválidos') {
  return errorResponse(`${prefix}: ${formatZodIssues(error)}`, 400);
}

export type ParseResult<T> =
  { success: true; data: T } | { success: false; response: NextResponse };

/** Parsea el JSON del request y lo valida con el schema indicado. */
export async function parseJsonBody<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<ParseResult<z.infer<T>>> {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return {
      success: false,
      response: errorResponse('El cuerpo de la petición no es un JSON válido', 400),
    };
  }

  const result = schema.safeParse(body);
  if (!result.success) {
    return { success: false, response: zodErrorResponse(result.error) };
  }

  return { success: true, data: result.data };
}

/** Valida los query params con el schema indicado (los valores llegan como string). */
export function parseQueryParams<T extends z.ZodType>(
  request: Request,
  schema: T,
): ParseResult<z.infer<T>> {
  const values = Object.fromEntries(new URL(request.url).searchParams);
  const result = schema.safeParse(values);

  if (!result.success) {
    return { success: false, response: zodErrorResponse(result.error) };
  }

  return { success: true, data: result.data };
}

interface MongoWriteErrorLike {
  code?: number | string;
  keyPattern?: Record<string, unknown>;
  keyValue?: Record<string, unknown>;
  err?: {
    code?: number | string;
    keyPattern?: Record<string, unknown>;
    keyValue?: Record<string, unknown>;
  };
}

interface MongoErrorLike extends MongoWriteErrorLike {
  name?: string;
  message?: string;
  errors?: Record<string, { path?: string; message?: string }>;
  writeErrors?: MongoWriteErrorLike[];
}

export interface RouteErrorOptions {
  /** Texto que acompaña al error en console.error (solo para errores 500). */
  context: string;
  /**
   * Mensajes para duplicados por campo o combinación de campos. Las claves se
   * comparan sin importar el orden: "brandId+code" aplica a ambos órdenes.
   */
  duplicateMessages?: Record<string, string>;
  /** Prefijo de los mensajes de ValidationError de Mongoose. */
  validationPrefix?: string;
}

const FIELD_LABELS: Record<string, string> = {
  brandId: 'marca',
  code: 'código',
  name: 'nombre',
  username: 'nombre de usuario',
};

function firstWriteError(error: MongoErrorLike): MongoWriteErrorLike | undefined {
  return Array.isArray(error.writeErrors) ? error.writeErrors[0] : undefined;
}

function mongoErrorCode(error: MongoErrorLike): number {
  const first = firstWriteError(error);
  return Number(error.code ?? first?.err?.code ?? first?.code);
}

function duplicateFields(error: MongoErrorLike): string[] {
  const first = firstWriteError(error);
  const keyPattern = error.keyPattern ?? first?.err?.keyPattern ?? first?.keyPattern;

  if (keyPattern && typeof keyPattern === 'object') {
    return Object.keys(keyPattern);
  }

  const keyValue = error.keyValue ?? first?.err?.keyValue ?? first?.keyValue;
  if (keyValue && typeof keyValue === 'object') {
    return Object.keys(keyValue);
  }

  // Fallback: el nombre del índice en el mensaje ("index: name_1 dup key").
  const indexName = /index:\s+([A-Za-z0-9_.$-]+)/.exec(error.message ?? '')?.[1];
  if (indexName) {
    return indexName.split('_').filter((part) => part !== '1' && part !== '-1' && part !== '');
  }

  return [];
}

function duplicateMessage(error: MongoErrorLike, options: RouteErrorOptions): string {
  const fields = duplicateFields(error);
  const custom = options.duplicateMessages ?? {};

  // Las claves más específicas (más campos) ganan sobre las genéricas.
  const customEntries = Object.entries(custom).sort(
    ([a], [b]) => b.split('+').length - a.split('+').length,
  );

  for (const [key, message] of customEntries) {
    const keyFields = key.split('+');
    if (keyFields.length > 0 && keyFields.every((field) => fields.includes(field))) {
      return message;
    }
  }

  const labels = fields.map((field) => FIELD_LABELS[field] ?? field);

  if (labels.length === 1) {
    return `Ya existe un registro con ese ${labels[0]}`;
  }
  if (labels.length > 1) {
    return `Ya existe un registro con esa combinación de ${labels.join(' y ')}`;
  }

  return 'Ya existe un registro con esos datos';
}

function validationMessage(error: MongoErrorLike, prefix: string): string {
  const details = Object.entries(error.errors ?? {}).map(([path, detail]) => {
    const field = detail.path || path;
    return `${field}: ${detail.message || 'valor inválido'}`;
  });

  return details.length > 0 ? `${prefix}: ${details.join(', ')}` : prefix;
}

/** Traduce errores conocidos de Mongo/Mongoose a una respuesta 400/409. */
export function mapMongoError(
  error: unknown,
  options: RouteErrorOptions,
): { status: number; message: string } | null {
  if (!error || typeof error !== 'object') return null;

  const mongoError = error as MongoErrorLike;
  const validationPrefix = options.validationPrefix ?? 'Datos inválidos';

  if (mongoErrorCode(mongoError) === 11000) {
    return { status: 409, message: duplicateMessage(mongoError, options) };
  }

  if (mongoError.name === 'ValidationError') {
    return {
      status: 400,
      message: validationMessage(mongoError, validationPrefix),
    };
  }

  if (mongoError.name === 'CastError') {
    return { status: 400, message: 'ID o valor con formato inválido' };
  }

  return null;
}

/** Resuelve el catch de una ruta: errores conocidos o 500 genérico logueado. */
export function handleRouteError(error: unknown, options: RouteErrorOptions): NextResponse {
  const mapped = mapMongoError(error, options);
  if (mapped) {
    return errorResponse(mapped.message, mapped.status);
  }

  const requestContext = getRequestContext();

  logError(options.context, error);
  captureServerError(error, {
    requestId: requestContext?.requestId,
    route: requestContext?.path,
    method: requestContext?.method,
    status: 500,
    context: options.context,
    mongoOperation: 'route',
  });

  return errorResponse(GENERIC_ERROR_MESSAGE, 500);
}
