/**
 * Persistencia del borrador de pedido en localStorage.
 *
 * La lectura tolera drafts viejos o corruptos: siempre devuelve una estructura
 * válida (o `null`) y nunca lanza, para que un JSON roto no rompa el alta.
 */
import {
  getClientDiscounts,
  type DiscountMap,
  type OrderCatalogClient,
  type QuantityMap,
} from './order-catalog';
import {
  INVOICE_TYPES,
  PAYMENT_CONDITIONS,
  type InvoiceType,
  type PaymentCondition,
} from './order-commercial';

/**
 * Prefijo del borrador. La clave final incluye el id del usuario para que dos
 * cuentas que usan el mismo navegador nunca compartan el formulario a medias.
 */
export const ORDER_DRAFT_STORAGE_KEY = 'sgi_order_draft';

/**
 * Evento liviano para que la UI escuche los cambios del borrador sin polling.
 * Se dispara en `saveOrderDraft` y `clearOrderDraft` sobre `window`.
 */
export const ORDER_DRAFT_CHANGED_EVENT = 'sgi:order-draft-changed';

/** Un borrador de edición sin guardar deja de ofrecerse después de este tiempo (24 h). */
export const ORDER_DRAFT_EDIT_TTL_MS = 24 * 60 * 60 * 1000;

/** Margen para tolerar relojes adelantados sin aceptar fechas absurdas. */
const MAX_CLOCK_SKEW_MS = 60 * 1000;

/**
 * Clave de storage del borrador del usuario indicado. Cuando se pasa `orderId`
 * (edición de un borrador existente), usa una clave aislada por pedido para no
 * pisar nunca el borrador de alta nueva (`sgi_order_draft:${userId}`).
 */
export function getOrderDraftStorageKey(userId: string, orderId?: string | null): string {
  const normalizedUserId = userId.trim();
  const normalizedOrderId = typeof orderId === 'string' ? orderId.trim() : '';
  if (normalizedOrderId) {
    return `${ORDER_DRAFT_STORAGE_KEY}:${normalizedUserId}:edit:${normalizedOrderId}`;
  }
  return `${ORDER_DRAFT_STORAGE_KEY}:${normalizedUserId}`;
}

export interface OrderDraftScopeOptions {
  /** Pedido en edición (`mode="edit"`). Si se omite, opera sobre el alta nueva. */
  orderId?: string | null;
  /** Versión del borrador cuando se empezó a editar; en lectura exige coincidencia si se indica. */
  version?: number;
  /** Epoch ms de guardado (por defecto `Date.now()`). */
  savedAt?: number;
  /** Epoch ms actual para validar el TTL de 24 h en lectura. */
  now?: number;
  /** TTL del borrador de edición (por defecto `ORDER_DRAFT_EDIT_TTL_MS`). */
  ttlMs?: number;
}

const MAX_DISCOUNT = 100;
const MAX_PAYMENT_CONDITION_DETAIL = 120;

export interface OrderDraft {
  quantities: QuantityMap;
  selectedClient: OrderCatalogClient | null;
  salesperson: string;
  comment: string;
  itemDiscounts: DiscountMap;
  generalDiscount: number;
  brandDiscounts: DiscountMap;
  /** `''` representa el placeholder "Seleccionar…" del alta. */
  invoiceType: InvoiceType | '';
  /** `''` representa el placeholder "Seleccionar…" del alta. */
  paymentCondition: PaymentCondition | '';
  paymentConditionDetail: string;
}

export interface OrderDraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface OrderDraftInput {
  quantities: QuantityMap;
  selectedClient: OrderCatalogClient | null;
  salesperson: string;
  comment: string;
  itemDiscounts: DiscountMap;
  generalDiscount: number;
  brandDiscounts: DiscountMap;
  invoiceType: InvoiceType | '';
  paymentCondition: PaymentCondition | '';
  paymentConditionDetail: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeQuantity(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

function sanitizeDiscount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(MAX_DISCOUNT, Math.max(0, value));
}

function sanitizeQuantityMap(value: unknown): QuantityMap {
  if (!isRecord(value)) return {};
  const result: QuantityMap = {};
  for (const [key, raw] of Object.entries(value)) {
    const quantity = sanitizeQuantity(raw);
    if (quantity !== null) result[key] = quantity;
  }
  return result;
}

function sanitizeDiscountMap(value: unknown): DiscountMap {
  if (!isRecord(value)) return {};
  const result: DiscountMap = {};
  for (const [key, raw] of Object.entries(value)) {
    const discount = sanitizeDiscount(raw);
    if (discount !== null) result[key] = discount;
  }
  return result;
}

function sanitizeClient(value: unknown): OrderCatalogClient | null {
  if (!isRecord(value)) return null;
  if (typeof value._id !== 'string' || !value._id) return null;
  if (typeof value.code !== 'string' || typeof value.name !== 'string') return null;

  const brandDiscounts = Array.isArray(value.brandDiscounts)
    ? value.brandDiscounts
        .filter(isRecord)
        .map((discount) => {
          const brandId = discount.brandId;
          const normalizedBrandId =
            typeof brandId === 'string'
              ? brandId
              : isRecord(brandId) && typeof brandId._id === 'string'
                ? brandId._id
                : '';
          return {
            brandId: normalizedBrandId,
            discountPercentage: sanitizeDiscount(discount.discountPercentage) ?? 0,
          };
        })
        .filter((discount) => discount.brandId !== '')
    : [];

  return {
    _id: value._id,
    code: value.code,
    name: value.name,
    address: typeof value.address === 'string' ? value.address : '',
    localidad: typeof value.localidad === 'string' ? value.localidad : '',
    province: typeof value.province === 'string' ? value.province : '',
    generalDiscount: sanitizeDiscount(value.generalDiscount) ?? 0,
    brandDiscounts,
  };
}

function sanitizeText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function sanitizeInvoiceType(value: unknown): InvoiceType | '' {
  return (INVOICE_TYPES as readonly unknown[]).includes(value) ? (value as InvoiceType) : '';
}

function sanitizePaymentCondition(value: unknown): PaymentCondition | '' {
  return (PAYMENT_CONDITIONS as readonly unknown[]).includes(value)
    ? (value as PaymentCondition)
    : '';
}

function sanitizePaymentConditionDetail(value: unknown): string {
  return sanitizeText(value).trim().slice(0, MAX_PAYMENT_CONDITION_DETAIL);
}

/** Convierte el estado del formulario en el objeto que se persiste. */
export function createOrderDraft(input: OrderDraftInput): OrderDraft {
  return {
    quantities: input.quantities,
    selectedClient: input.selectedClient,
    salesperson: input.salesperson,
    comment: input.comment,
    itemDiscounts: input.itemDiscounts,
    generalDiscount: input.generalDiscount,
    brandDiscounts: input.brandDiscounts,
    invoiceType: input.invoiceType,
    paymentCondition: input.paymentCondition,
    paymentConditionDetail: input.paymentCondition === 'otro' ? input.paymentConditionDetail : '',
  };
}

function normalizeDraftQuantity(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(Number(value)));
}

/**
 * Suma (o resta) unidades de un producto al borrador sin tocar el resto del
 * formulario. La usan atajos fuera del alta, como el botón "+ Pedido" del
 * catálogo, para que el vendedor pueda preparar el carrito mientras consulta
 * precios. Un resultado en 0 elimina la línea y su descuento manual.
 */
export function adjustOrderDraftProduct(
  draft: OrderDraft | null,
  productId: string,
  delta: number,
  options: { salesperson?: string } = {},
): OrderDraft {
  const base =
    draft ??
    createOrderDraft({
      quantities: {},
      selectedClient: null,
      salesperson: options.salesperson ?? '',
      comment: '',
      itemDiscounts: {},
      generalDiscount: 0,
      brandDiscounts: {},
      invoiceType: '',
      paymentCondition: '',
      paymentConditionDetail: '',
    });

  if (!productId.trim()) return base;

  const safeDelta = Number.isFinite(delta) ? Math.trunc(delta) : 0;
  const nextQuantity = Math.max(0, normalizeDraftQuantity(base.quantities[productId]) + safeDelta);
  const quantities = { ...base.quantities };
  const itemDiscounts = { ...base.itemDiscounts };

  if (nextQuantity > 0) {
    quantities[productId] = nextQuantity;
  } else {
    delete quantities[productId];
    delete itemDiscounts[productId];
  }

  return {
    ...base,
    quantities,
    itemDiscounts,
    salesperson: base.salesperson || options.salesperson?.trim() || '',
  };
}

/**
 * Aplica un cliente preseleccionado (por ejemplo `?clientId=`) a un borrador
 * existente sin perder el carrito ni los datos comerciales ya cargados.
 *
 * Sólo reemplaza la ficha del cliente y los descuentos base que trae su ficha:
 * las cantidades, los descuentos manuales por producto y el resto del
 * formulario se conservan tal cual estaban guardados.
 */
export function applyClientToOrderDraft(
  draft: OrderDraft | null,
  client: OrderCatalogClient,
): OrderDraft {
  const base =
    draft ??
    createOrderDraft({
      quantities: {},
      selectedClient: null,
      salesperson: '',
      comment: '',
      itemDiscounts: {},
      generalDiscount: 0,
      brandDiscounts: {},
      invoiceType: '',
      paymentCondition: '',
      paymentConditionDetail: '',
    });
  const discounts = getClientDiscounts(client);

  return {
    ...base,
    selectedClient: client,
    generalDiscount: discounts.general,
    brandDiscounts: discounts.brandDiscounts,
  };
}

/** Parsea y sanea un borrador guardado. Devuelve `null` si no es un objeto JSON. */
export function parseOrderDraft(raw: string | null): OrderDraft | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;

  const paymentCondition = sanitizePaymentCondition(parsed.paymentCondition);

  return {
    quantities: sanitizeQuantityMap(parsed.quantities),
    selectedClient: sanitizeClient(parsed.selectedClient),
    salesperson: sanitizeText(parsed.salesperson),
    comment: sanitizeText(parsed.comment),
    itemDiscounts: sanitizeDiscountMap(parsed.itemDiscounts),
    generalDiscount: sanitizeDiscount(parsed.generalDiscount) ?? 0,
    brandDiscounts: sanitizeDiscountMap(parsed.brandDiscounts),
    invoiceType: sanitizeInvoiceType(parsed.invoiceType),
    paymentCondition,
    // Un detalle huérfano (sin "Otro") no se restaura.
    paymentConditionDetail:
      paymentCondition === 'otro'
        ? sanitizePaymentConditionDetail(parsed.paymentConditionDetail)
        : '',
  };
}

function normalizeScopeOptions(
  scope?: string | OrderDraftScopeOptions | null,
): OrderDraftScopeOptions {
  if (!scope) return {};
  if (typeof scope === 'string') return { orderId: scope };
  return scope;
}

/**
 * Clave efectiva o `null` si no hay un usuario válido (o un `orderId` vacío
 * cuando se pidió explícitamente modo edición). Sin usuario no se lee ni se
 * escribe el borrador: así nunca se cae a una clave compartida.
 */
function resolveStorageKey(
  userId: string | null | undefined,
  scope?: string | OrderDraftScopeOptions | null,
): string | null {
  if (typeof userId !== 'string' || !userId.trim()) return null;
  const options = normalizeScopeOptions(scope);
  if (options.orderId !== undefined && options.orderId !== null) {
    if (typeof options.orderId !== 'string' || !options.orderId.trim()) return null;
    return getOrderDraftStorageKey(userId, options.orderId);
  }
  return getOrderDraftStorageKey(userId);
}

/** Avisa a la UI (p. ej. la barra móvil) que el borrador persistido cambió. */
function notifyOrderDraftChanged(): void {
  if (typeof window === 'undefined') return;

  window.dispatchEvent(new Event(ORDER_DRAFT_CHANGED_EVENT));
}

function parseStoredOrderDraftEnvelope(raw: string | null): {
  draft: OrderDraft;
  savedAt?: number;
  version?: number;
  invalidMetadata: boolean;
} | null {
  const draft = parseOrderDraft(raw);
  if (!draft || !raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  let savedAt: number | undefined;
  let version: number | undefined;
  let invalidMetadata = false;

  if (parsed.savedAt !== undefined) {
    if (typeof parsed.savedAt === 'number' && Number.isFinite(parsed.savedAt)) {
      savedAt = Math.floor(parsed.savedAt);
    } else {
      invalidMetadata = true;
    }
  }

  if (parsed.version !== undefined) {
    if (
      typeof parsed.version === 'number' &&
      Number.isFinite(parsed.version) &&
      parsed.version >= 0
    ) {
      version = Math.floor(parsed.version);
    } else {
      invalidMetadata = true;
    }
  }

  return { draft, savedAt, version, invalidMetadata };
}

/** Lee el borrador del usuario indicado; un storage inaccesible cuenta como vacío. */
export function loadOrderDraft(
  storage: OrderDraftStorage | null | undefined,
  userId: string | null | undefined,
  scope?: string | OrderDraftScopeOptions | null,
): OrderDraft | null {
  const options = normalizeScopeOptions(scope);
  const key = resolveStorageKey(userId, options);
  if (!storage || !key) return null;

  const isEditScope = Boolean(typeof options.orderId === 'string' && options.orderId.trim());

  try {
    const raw = storage.getItem(key);
    if (!isEditScope && options.version === undefined && options.ttlMs === undefined) {
      return parseOrderDraft(raw);
    }

    const envelope = parseStoredOrderDraftEnvelope(raw);
    if (!envelope || envelope.invalidMetadata) return null;

    if (options.version !== undefined) {
      if (
        typeof options.version !== 'number' ||
        !Number.isFinite(options.version) ||
        options.version < 0
      ) {
        return null;
      }
      if (envelope.version !== undefined && envelope.version !== Math.floor(options.version)) {
        return null;
      }
    }

    if (envelope.savedAt !== undefined) {
      const now = options.now ?? Date.now();
      const ttlMs = options.ttlMs ?? ORDER_DRAFT_EDIT_TTL_MS;
      if (envelope.savedAt > now + MAX_CLOCK_SKEW_MS) return null;
      if (now - envelope.savedAt >= ttlMs) return null;
    }

    return envelope.draft;
  } catch {
    return null;
  }
}

/** Guarda el borrador del usuario. Devuelve `false` si el storage no está disponible. */
export function saveOrderDraft(
  storage: OrderDraftStorage | null | undefined,
  draft: OrderDraft,
  userId: string | null | undefined,
  scope?: string | OrderDraftScopeOptions | null,
): boolean {
  const options = normalizeScopeOptions(scope);
  const key = resolveStorageKey(userId, options);
  if (!storage || !key || !isRecord(draft)) return false;

  const isEditScope = Boolean(typeof options.orderId === 'string' && options.orderId.trim());

  try {
    if (!isEditScope && options.version === undefined && options.savedAt === undefined) {
      storage.setItem(key, JSON.stringify(draft));
      notifyOrderDraftChanged();
      return true;
    }

    if (options.version !== undefined) {
      if (
        typeof options.version !== 'number' ||
        !Number.isFinite(options.version) ||
        options.version < 0
      ) {
        return false;
      }
      const existing = parseStoredOrderDraftEnvelope(storage.getItem(key));
      if (
        existing &&
        !existing.invalidMetadata &&
        existing.version !== undefined &&
        existing.version > Math.floor(options.version)
      ) {
        return false;
      }
    }

    const savedAt =
      typeof options.savedAt === 'number' && Number.isFinite(options.savedAt)
        ? Math.floor(options.savedAt)
        : typeof options.now === 'number' && Number.isFinite(options.now)
          ? Math.floor(options.now)
          : Date.now();

    const payload = {
      ...draft,
      savedAt,
      ...(options.version !== undefined ? { version: Math.floor(options.version) } : {}),
    };

    storage.setItem(key, JSON.stringify(payload));
    notifyOrderDraftChanged();
    return true;
  } catch {
    return false;
  }
}

/** Elimina el borrador del usuario; se usa al confirmar el pedido o cerrar sesión. */
export function clearOrderDraft(
  storage: OrderDraftStorage | null | undefined,
  userId: string | null | undefined,
  scope?: string | OrderDraftScopeOptions | null,
): boolean {
  const key = resolveStorageKey(userId, scope);
  if (!storage || !key) return false;
  try {
    storage.removeItem(key);
    notifyOrderDraftChanged();
    return true;
  } catch {
    return false;
  }
}
