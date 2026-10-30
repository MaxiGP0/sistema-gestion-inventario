/**
 * Tipos comunes de la API.
 *
 * Los DTO representan el JSON que cruza el límite HTTP (fechas como string,
 * ObjectId serializado como string), no los documentos de Mongoose.
 */

/** Respuesta exitosa que solo comunica un mensaje. */
export interface ApiMessageResponse {
  success: true;
  message: string;
}

/** Respuesta estándar de un DELETE. */
export type DeleteResponse = ApiMessageResponse;

/** Cuerpo de error homogéneo de las rutas (`lib/api-errors.ts`). */
export interface ApiErrorBody {
  error: string;
  [key: string]: unknown;
}

/** Resultado del chequeo de MongoDB en `/api/health`. */
export interface MongoHealthCheck {
  status: 'connected' | 'unavailable';
  /** `readyState` de mongoose: 0 desconectado, 1 conectado, 2/3 transición. */
  readyState: number;
  latencyMs: number;
  /** Motivo acotado; el detalle completo queda en los logs estructurados. */
  error?: 'connection-failed' | 'ping-failed' | 'not-connected';
}

/** Respuesta de `GET /api/health` (200 si todo está ok, 503 si no). */
export interface HealthResponse {
  status: 'ok' | 'degraded';
  timestamp: string;
  uptimeSeconds: number;
  checks: {
    mongodb: MongoHealthCheck;
  };
}

/** Paginación clásica por página (`page`/`limit`). */
export interface PagePagination {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/** Paginación por cursor opaco (pedidos). */
export interface CursorPagination {
  mode: 'cursor';
  limit: number;
  hasMore: boolean;
  nextCursor: string | null;
  /** Solo la primera página ejecuta el count. */
  total?: number;
}
