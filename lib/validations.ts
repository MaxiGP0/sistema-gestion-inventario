import { z } from 'zod';
import { USER_ROLES } from './authz';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MAX_LENGTH_MESSAGE,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MIN_LENGTH_MESSAGE,
} from './password-policy';
import { ORDER_STATUSES } from './order-statuses';
import { POST_CONTROL_VALUES } from './order-post-control';
import { INVOICE_TYPES, PAYMENT_CONDITIONS } from './order-commercial';
import { MAX_CLIENT_REQUEST_ID_LENGTH } from './order-request-id';
import {
  MAX_PRICE_ADJUSTMENT_PERCENTAGE,
  MIN_PRICE_ADJUSTMENT_PERCENTAGE,
} from './product-pricing';
import { NOTIFICATION_TARGET_ROLES } from './types/notification';

export { NOTIFICATION_TARGET_ROLES } from './types/notification';
export type { NotificationTargetRole } from './types/notification';

const OBJECT_ID_REGEX = /^[0-9a-fA-F]{24}$/;
const DISCOUNT_RANGE_MESSAGE = 'El descuento debe estar entre 0 y 100';

/** Límites compartidos por los listados para que una URL no infle la consulta. */
export const MAX_LIST_SEARCH_LENGTH = 80;
export const MAX_LIST_PAGE = 100_000;
export const DEFAULT_ORDER_LIST_LIMIT = 100;
export const MAX_ORDER_LIST_LIMIT = 500;
export const DEFAULT_CATALOG_LIST_LIMIT = 50;
export const MAX_CATALOG_LIST_LIMIT = 200;

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|z|[+-]\d{2}:?\d{2})?$/;

export const objectIdSchema = z.string().regex(OBJECT_ID_REGEX, 'ID no válido');

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (year < 1000 || month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}

/**
 * Parsea una fecha de filtro (`YYYY-MM-DD` o ISO con hora). Devuelve `null` si
 * el formato o el día no existen, para que las rutas respondan 400 en lugar de
 * mandar un `Invalid Date` a Mongoose.
 */
export function parseDateFilterValue(value: string): Date | null {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(trimmed);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!isValidCalendarDate(year, month, day)) return null;

  if (DATE_ONLY_REGEX.test(trimmed)) {
    return new Date(Date.UTC(year, month - 1, day));
  }

  if (!ISO_DATE_TIME_REGEX.test(trimmed)) return null;

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function isDateFilterValue(value: string): boolean {
  return parseDateFilterValue(value) !== null;
}

/** Busca vacío se normaliza a `undefined`; el tope de 80 evita claves enormes. */
const listSearchParamSchema = z.preprocess(
  (value) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  },
  z
    .string()
    .max(
      MAX_LIST_SEARCH_LENGTH,
      `La búsqueda no puede superar los ${MAX_LIST_SEARCH_LENGTH} caracteres`,
    )
    .optional(),
);

function normalizeQueryInteger(value: unknown, fallback: number, min: number, max: number): number {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === null || raw === '') return fallback;

  const parsed = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed)) return fallback;

  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function queryIntegerSchema(fallback: number, min: number, max: number) {
  return z.preprocess(
    (value) => normalizeQueryInteger(value, fallback, min, max),
    z.number().int().min(min).max(max),
  );
}

const queryPageSchema = queryIntegerSchema(1, 1, MAX_LIST_PAGE);
const orderLimitSchema = queryIntegerSchema(DEFAULT_ORDER_LIST_LIMIT, 1, MAX_ORDER_LIST_LIMIT);
const catalogLimitSchema = queryIntegerSchema(
  DEFAULT_CATALOG_LIST_LIMIT,
  1,
  MAX_CATALOG_LIST_LIMIT,
);

export const dateFilterQuerySchema = z
  .string()
  .trim()
  .refine(isDateFilterValue, 'Rango de fechas inválido')
  .optional();

export const archivedQuerySchema = z
  .enum(['true', 'false', 'all'], {
    message: 'El filtro de archivados debe ser true, false o all',
  })
  .optional();

/** `status` acepta un CSV y valida cada token contra la whitelist de estados. */
export const orderStatusCsvSchema = z
  .string({ message: 'Estado de pedido inválido' })
  .trim()
  .min(1, 'Estado de pedido inválido')
  .superRefine((value, ctx) => {
    const tokens = value.split(',').map((token) => token.trim());
    if (tokens.some((token) => !token || !(ORDER_STATUSES as readonly string[]).includes(token))) {
      ctx.addIssue({
        code: 'custom',
        message: 'Estado de pedido inválido',
      });
    }
  })
  .transform((value) =>
    value
      .split(',')
      .map((token) => token.trim())
      .join(','),
  );

/** Query params de GET /api/orders y GET /api/orders/export. */
export const orderListQuerySchema = z.object({
  search: listSearchParamSchema,
  status: orderStatusCsvSchema.optional(),
  archived: archivedQuerySchema,
  startDate: dateFilterQuerySchema,
  endDate: dateFilterQuerySchema,
  clientId: objectIdSchema.optional(),
  page: queryPageSchema,
  limit: orderLimitSchema,
});

/** Query params de GET /api/clients (`q` es el alias histórico de `search`). */
export const clientListQuerySchema = z.object({
  search: listSearchParamSchema,
  q: listSearchParamSchema,
  page: queryPageSchema,
  limit: catalogLimitSchema,
});

/** Query params de GET /api/products. */
export const productListQuerySchema = z.object({
  search: listSearchParamSchema,
  page: queryPageSchema,
  limit: catalogLimitSchema,
});

/**
 * Los estados y sus transiciones viven en lib/order-statuses.ts (fuente única
 * compartida con el enum de models/Order.ts); se reexportan por compatibilidad.
 */
export {
  ORDER_STATUSES,
  ORDER_STATUS_TRANSITIONS,
  canTransitionOrderStatus,
  getOrderStatusTransitionError,
} from './order-statuses';
export type { OrderStatus } from './order-statuses';

export const orderStatusSchema = z.enum(ORDER_STATUSES, {
  message: 'Estado de pedido inválido',
});

export const postControlSchema = z.enum(POST_CONTROL_VALUES, {
  message: 'Estado de control post-factura inválido',
});

/** Versión leída por el cliente; obligatoria para evitar escrituras pisadas. */
const orderVersionSchema = z
  .number({ message: 'La versión del pedido es obligatoria' })
  .int('La versión del pedido debe ser un número entero')
  .nonnegative('La versión del pedido no puede ser negativa');

/** Formatea los errores de Zod con su ruta, para respuestas 400 claras. */
export function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join(', ');
}

const normalizeDiscountInput = (value: unknown) => {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    return Number(trimmed);
  }
  return value;
};

const strictDiscountPercentageSchema = z
  .number({ message: 'El descuento debe ser un número' })
  .min(0, DISCOUNT_RANGE_MESSAGE)
  .max(100, DISCOUNT_RANGE_MESSAGE);

/**
 * Porcentaje de descuento entre 0 y 100.
 * Acepta números (y strings numéricos heredados de la UI) y los normaliza a número.
 * `null` y `''` se interpretan como "sin descuento".
 */
export const discountPercentageSchema = z.preprocess(
  normalizeDiscountInput,
  strictDiscountPercentageSchema.optional(),
);

export const orderItemSchema = z.object({
  productId: objectIdSchema,
  requestedQuantity: z.number().int().positive('La cantidad pedida debe ser mayor a 0'),
  customDiscount: discountPercentageSchema,
});

export const createOrderSchema = z
  .object({
    clientId: objectIdSchema,
    items: z.array(orderItemSchema).min(1, 'El pedido debe tener al menos un ítem'),
    /** El autor y el id del vendedor salen de la sesión, nunca del body. */
    comment: z.string().optional(),
    /** Obligatorio al crear; los pedidos históricos pueden no tenerlo. */
    invoiceType: z.enum(INVOICE_TYPES, {
      message: 'El tipo de factura es obligatorio',
    }),
    /** Obligatoria al crear; los pedidos históricos pueden no tenerla. */
    paymentCondition: z.enum(PAYMENT_CONDITIONS, {
      message: 'La condición de pago es obligatoria',
    }),
    paymentConditionDetail: z
      .string()
      .trim()
      .max(120, 'El detalle de la condición de pago no puede superar los 120 caracteres')
      .optional(),
    /**
     * Clave idempotente generada por el cliente para el alta. Si el mismo
     * usuario reintenta con la misma clave, la API devuelve el pedido ya
     * creado en lugar de insertar otro.
     */
    clientRequestId: z
      .string()
      .trim()
      .min(1, 'La clave de idempotencia no puede estar vacía')
      .max(
        MAX_CLIENT_REQUEST_ID_LENGTH,
        `La clave de idempotencia no puede superar los ${MAX_CLIENT_REQUEST_ID_LENGTH} caracteres`,
      )
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (data.paymentCondition === 'otro' && !data.paymentConditionDetail) {
      ctx.addIssue({
        code: 'custom',
        path: ['paymentConditionDetail'],
        message: 'Ingresá el detalle cuando la condición de pago es "Otro"',
      });
    }
  })
  .transform((data) => ({
    ...data,
    // Contado y cuenta corriente no llevan detalle: se descarta si vino.
    paymentConditionDetail:
      data.paymentCondition === 'otro' ? data.paymentConditionDetail : undefined,
  }));

export const brandDiscountSchema = z.object({
  brandId: objectIdSchema,
  discountPercentage: strictDiscountPercentageSchema,
});

export const clientSchema = z.object({
  code: z.string().trim().min(1, 'El código del cliente es obligatorio'),
  name: z.string().trim().min(1, 'El nombre del cliente es obligatorio'),
  address: z.string().optional(),
  localidad: z.string().optional(),
  province: z.string().optional(),
  generalDiscount: discountPercentageSchema,
  brandDiscounts: z.array(brandDiscountSchema).optional(),
});

/** Tope compartido por la API y la importación para no guardar URLs enormes. */
export const MAX_IMAGE_URL_LENGTH = 2048;

/**
 * Normaliza una URL de imagen escrita por un usuario.
 *
 * Acepta:
 * - vacío (`''`) para borrar la imagen;
 * - rutas locales servidas por la app (`/uploads/foto.jpg`);
 * - URLs absolutas `https:`.
 *
 * Rechaza esquemas ejecutables (`javascript:`, `data:`, `blob:`), credenciales
 * embebidas, rutas protocol-relative (`//host/...`) y textos de más de 2048
 * caracteres. Devuelve `null` cuando el valor no es válido.
 */
export function normalizeImageUrlInput(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length > MAX_IMAGE_URL_LENGTH) return null;
  if (trimmed === '') return '';

  if (trimmed.startsWith('/')) {
    // `//host` es una URL externa protocol-relative, no una ruta local.
    if (trimmed.startsWith('//')) return null;
    // Backslashes y caracteres de control pueden confundir a proxys/routers.
    if (/[\\\u0000-\u001f\u007f]/.test(trimmed)) return null;
    return trimmed;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.hostname === '') return null;

  return trimmed;
}

export const imageUrlSchema = z
  .string({ message: 'La URL de imagen debe ser un texto' })
  .trim()
  .max(
    MAX_IMAGE_URL_LENGTH,
    `La URL de imagen no puede superar los ${MAX_IMAGE_URL_LENGTH} caracteres`,
  )
  .refine(
    (value) => normalizeImageUrlInput(value) !== null,
    'La URL de imagen debe ser una ruta local o una URL HTTPS válida',
  )
  .optional();

export const productSchema = z.object({
  brandId: objectIdSchema,
  code: z.string().trim().min(1, 'El código del producto es obligatorio'),
  name: z.string().trim().min(1, 'El nombre del producto es obligatorio'),
  price: z
    .number({ message: 'El precio debe ser un número' })
    .nonnegative('El precio no puede ser negativo'),
  priceWithIva: z
    .number({ message: 'El precio con IVA debe ser un número' })
    .nonnegative('El precio con IVA no puede ser negativo')
    .optional(),
  imageUrl: imageUrlSchema,
});

export const brandSchema = z.object({
  name: z.string().trim().min(1, 'El nombre de la marca es obligatorio'),
  codePrefix: z.string().optional(),
});

const normalizePercentageInput = (value: unknown) => {
  if (typeof value !== 'string') return value;

  const trimmed = value.trim().replace(/%$/, '').replace(',', '.');
  if (trimmed === '') return value;

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : value;
};

/** `POST /api/products/bulk-price`: marca opcional y porcentaje de ajuste. */
export const bulkPriceAdjustmentSchema = z.object({
  brandId: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    objectIdSchema.optional(),
  ),
  percentage: z.preprocess(
    normalizePercentageInput,
    z
      .number({ message: 'El porcentaje debe ser un número' })
      .finite('El porcentaje debe ser un número finito')
      .min(
        MIN_PRICE_ADJUSTMENT_PERCENTAGE,
        `El porcentaje no puede ser menor a ${MIN_PRICE_ADJUSTMENT_PERCENTAGE}%`,
      )
      .max(
        MAX_PRICE_ADJUSTMENT_PERCENTAGE,
        `El porcentaje no puede superar ${MAX_PRICE_ADJUSTMENT_PERCENTAGE}%`,
      )
      .refine((value) => value !== 0, 'El porcentaje debe ser distinto de 0'),
  ),
});

export const notificationTargetRoleSchema = z.enum(NOTIFICATION_TARGET_ROLES, {
  message: 'Rol de notificación inválido',
});

export const notificationCreateSchema = z.object({
  title: z.string().trim().min(1, 'El título de la notificación es obligatorio'),
  message: z.string().trim().min(1, 'El mensaje de la notificación es obligatorio'),
  targetRole: notificationTargetRoleSchema.default('all'),
  /** Destinatario individual para la bandeja privada del vendedor. */
  targetUserId: objectIdSchema.optional(),
  targetUsername: z
    .string()
    .trim()
    .min(1, 'El usuario destinatario no puede estar vacío')
    .max(60, 'El usuario destinatario no puede superar los 60 caracteres')
    .optional(),
  orderId: objectIdSchema.optional(),
});

export const notificationUpdateSchema = z
  .object({
    id: objectIdSchema.optional(),
    read: z.boolean({ message: 'El estado de lectura debe ser booleano' }).optional(),
    targetRole: notificationTargetRoleSchema.optional(),
  })
  .refine(
    (data) => data.id !== undefined || data.read !== undefined || data.targetRole !== undefined,
    {
      message: 'Indicá una notificación o un rol para actualizar',
    },
  );

export const notificationQuerySchema = z.object({
  targetRole: notificationTargetRoleSchema.optional(),
  /** Cursor opaco de la página anterior (`createdAt` + `_id`). */
  cursor: z
    .string()
    .trim()
    .min(1, 'El cursor de paginación no puede estar vacío')
    .max(512, 'El cursor de paginación es demasiado largo')
    .optional(),
  limit: z.coerce
    .number({ message: 'El límite de la página debe ser un número' })
    .int('El límite de la página debe ser un entero')
    .min(1, 'El límite de la página debe ser mayor a 0')
    .max(100, 'El límite de la página no puede superar 100')
    .optional(),
});

export const notificationDeleteQuerySchema = z.object({
  id: objectIdSchema.optional(),
  targetRole: notificationTargetRoleSchema.optional(),
});

/** Preferencias de notificaciones del usuario autenticado. */
export const userNotificationsUpdateSchema = z.object({
  notificationsEnabled: z.boolean({
    message: 'La preferencia de notificaciones debe ser booleana',
  }),
});

/**
 * Endpoint de una suscripción Web Push. Los servicios push reales usan HTTPS;
 * se rechaza cualquier otro esquema antes de tocar la base.
 */
export const pushSubscriptionEndpointSchema = z
  .string({ message: 'El endpoint de la suscripción es obligatorio' })
  .trim()
  .min(1, 'El endpoint de la suscripción es obligatorio')
  .max(2048, 'El endpoint de la suscripción es demasiado largo')
  .refine((value) => {
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  }, 'El endpoint debe ser una URL HTTPS válida');

const normalizeBase64UrlKey = (value: unknown) => {
  if (typeof value !== 'string') return value;
  return value.trim().replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

export const pushSubscriptionKeysSchema = z.object({
  p256dh: z.preprocess(
    normalizeBase64UrlKey,
    z
      .string({ message: 'La clave p256dh es obligatoria' })
      .trim()
      .min(1, 'La clave p256dh es obligatoria')
      .max(512, 'La clave p256dh es demasiado larga'),
  ),
  auth: z.preprocess(
    normalizeBase64UrlKey,
    z
      .string({ message: 'La clave auth es obligatoria' })
      .trim()
      .min(1, 'La clave auth es obligatoria')
      .max(512, 'La clave auth es demasiado larga'),
  ),
});

/** Envío de una notificación Web Push de prueba al dispositivo actual (o todos los del usuario). */
export const pushSubscriptionTestSchema = z.object({
  endpoint: pushSubscriptionEndpointSchema.optional(),
});

/** Alta/renovación de la suscripción del dispositivo actual. */
export const pushSubscriptionCreateSchema = z.object({
  endpoint: pushSubscriptionEndpointSchema,
  keys: pushSubscriptionKeysSchema,
  userAgent: z
    .string()
    .trim()
    .max(500, 'El user agent no puede superar los 500 caracteres')
    .optional(),
});

/** Revocación por endpoint o de todos los dispositivos del usuario. */
export const pushSubscriptionDeleteSchema = z
  .object({
    endpoint: pushSubscriptionEndpointSchema.optional(),
    all: z.boolean({ message: 'El campo all debe ser booleano' }).optional(),
  })
  .refine((data) => data.endpoint !== undefined || data.all === true, {
    message: 'Indicá el endpoint a revocar o all=true para revocar todos los dispositivos',
  });

export const loginSchema = z.object({
  username: z
    .string({ message: 'Usuario y contraseña requeridos' })
    .min(1, 'Usuario y contraseña requeridos'),
  password: z
    .string({ message: 'Usuario y contraseña requeridos' })
    .min(1, 'Usuario y contraseña requeridos'),
});

/** Contraseñas nuevas: mínimo 6 caracteres (los hashes existentes no se revalidan). */
export const userPasswordSchema = z
  .string({ message: 'La contraseña es obligatoria' })
  .min(PASSWORD_MIN_LENGTH, PASSWORD_MIN_LENGTH_MESSAGE)
  .max(PASSWORD_MAX_LENGTH, PASSWORD_MAX_LENGTH_MESSAGE);

export const userRoleSchema = z.enum(USER_ROLES, { message: 'Rol de usuario inválido' });

/** Alta de usuario desde el backoffice (solo admin). */
export const createUserSchema = z.object({
  username: z
    .string({ message: 'El nombre de usuario es obligatorio' })
    .trim()
    .min(1, 'El nombre de usuario es obligatorio')
    .max(60, 'El nombre de usuario no puede superar los 60 caracteres'),
  password: userPasswordSchema,
  role: userRoleSchema.default('vendedor'),
  active: z.boolean({ message: 'El estado activo debe ser booleano' }).default(true),
});

/**
 * Actualización de un usuario: rol, activo y/o reset de contraseña.
 * El `id` viaja en el body porque el contrato es PATCH /api/users.
 */
export const updateUserSchema = z
  .object({
    id: objectIdSchema,
    role: userRoleSchema.optional(),
    active: z.boolean({ message: 'El estado activo debe ser booleano' }).optional(),
    password: userPasswordSchema.optional(),
  })
  .refine(
    (data) => data.role !== undefined || data.active !== undefined || data.password !== undefined,
    {
      message: 'Indicá al menos un cambio (rol, estado o contraseña)',
    },
  );

/** DELETE /api/users: `id` por query (`?id=`) o body `{ id }`. */
export const deleteUserSchema = z.object({
  id: objectIdSchema,
});

/** Cambio de contraseña del propio usuario autenticado. */
export const changePasswordSchema = z.object({
  currentPassword: z
    .string({ message: 'La contraseña actual es obligatoria' })
    .min(1, 'La contraseña actual es obligatoria'),
  newPassword: userPasswordSchema,
});

/**
 * El body de catalog/import es multipart: llega como FormData, no JSON.
 * `FormData.get()` devuelve null si el campo no existe; null y '' se
 * normalizan a 'both' antes de validar el enum.
 */
export const catalogImportSchema = z.object({
  file: z.custom<File>((value) => typeof File !== 'undefined' && value instanceof File, {
    message: 'No se ha proporcionado ningún archivo',
  }),
  type: z.enum(['products', 'clients'], {
    message: 'Tipo de importación inválido',
  }),
  updateMode: z.preprocess(
    (value) => (value === null || value === undefined || value === '' ? 'both' : value),
    z
      .enum(['name', 'price', 'both'], {
        message: 'Modo de actualización inválido',
      })
      .default('both'),
  ),
});

export const updateOrderItemSchema = z
  .object({
    _id: objectIdSchema.optional(),
    productId: objectIdSchema.optional(),
    requestedQuantity: z
      .number()
      .int('La cantidad pedida debe ser un número entero')
      .nonnegative('La cantidad pedida no puede ser negativa')
      .optional(),
    verifiedQuantity: z
      .number()
      .int('La cantidad verificada debe ser un número entero')
      .nonnegative('La cantidad verificada no puede ser negativa')
      .optional(),
    isPending: z.boolean().optional(),
    pendingReason: z
      .string()
      .trim()
      .max(200, 'El motivo pendiente no puede superar los 200 caracteres')
      .optional(),
    customDiscount: discountPercentageSchema,
  })
  .refine((item) => item._id !== undefined || item.productId !== undefined, {
    message: 'Cada ítem debe incluir _id o productId',
  });

export const updateOrderSchema = z
  .object({
    /**
     * Versión leída por el cliente. Es obligatoria para que dos operarios no se
     * pisen: el PUT responde 409 si el pedido ya cambió desde esa lectura.
     */
    version: orderVersionSchema,
    items: z.array(updateOrderItemSchema).min(1, 'Debe incluir al menos un ítem').optional(),
    status: orderStatusSchema.optional(),
    comment: z.string().optional(),
    /** `author`/`role` se ignoran si llegan: se firman con la sesión. */
    archived: z.boolean().optional(),
    /**
     * Edición integral de un borrador. Reemplaza los ítems y ajusta los datos
     * comerciales sin iniciar el picking.
     */
    mode: z.literal('draft-edit').optional(),
    invoiceType: z.enum(INVOICE_TYPES).optional(),
    paymentCondition: z.enum(PAYMENT_CONDITIONS).optional(),
    paymentConditionDetail: z
      .string()
      .trim()
      .max(120, 'El detalle de la condición de pago no puede superar los 120 caracteres')
      .optional(),
  })
  .superRefine((data, ctx) => {
    const isDraftEdit = data.mode === 'draft-edit';

    if (isDraftEdit) {
      if (!data.items || data.items.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['items'],
          message: 'La edición del borrador debe incluir al menos un ítem',
        });
      }

      data.items?.forEach((item, index) => {
        if (item.productId === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['items', index, 'productId'],
            message: 'Cada ítem de la edición debe incluir un productId',
          });
        }
      });

      if (data.status !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['status'],
          message: 'La edición de un borrador no puede cambiar el estado',
        });
      }

      if (data.archived !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['archived'],
          message: 'La edición de un borrador no puede archivarlo',
        });
      }

      if (data.invoiceType === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['invoiceType'],
          message: 'El tipo de factura es obligatorio al editar un borrador',
        });
      }

      if (data.paymentCondition === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['paymentCondition'],
          message: 'La condición de pago es obligatoria al editar un borrador',
        });
      }

      if (data.paymentCondition === 'otro' && !data.paymentConditionDetail) {
        ctx.addIssue({
          code: 'custom',
          path: ['paymentConditionDetail'],
          message: 'Ingresá el detalle cuando la condición de pago es "Otro"',
        });
      }

      return;
    }

    if (
      data.invoiceType !== undefined ||
      data.paymentCondition !== undefined ||
      data.paymentConditionDetail !== undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['mode'],
        message: 'Los datos comerciales sólo se editan en un borrador (mode: "draft-edit")',
      });
    }
  });

/**
 * Body del PATCH de control post-factura: una o más líneas con su nuevo estado.
 * Es independiente del PUT del pedido para que facturación no pueda tocar las
 * cantidades verificadas en depósito.
 */
export const updateOrderPostControlSchema = z.object({
  version: orderVersionSchema,
  items: z
    .array(
      z.object({
        _id: objectIdSchema,
        postControl: postControlSchema,
      }),
    )
    .min(1, 'Debe incluir al menos una línea para controlar'),
});
