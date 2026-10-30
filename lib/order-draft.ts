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

/** Clave de storage del borrador del usuario indicado. */
export function getOrderDraftStorageKey(userId: string): string {
  return `${ORDER_DRAFT_STORAGE_KEY}:${userId.trim()}`;
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

/**
 * Clave efectiva o `null` si no hay un usuario válido. Sin usuario no se lee
 * ni se escribe el borrador: así nunca se cae a una clave compartida.
 */
function resolveStorageKey(userId: string | null | undefined): string | null {
  if (typeof userId !== 'string' || !userId.trim()) return null;
  return getOrderDraftStorageKey(userId);
}

/** Lee el borrador del usuario indicado; un storage inaccesible cuenta como vacío. */
export function loadOrderDraft(
  storage: OrderDraftStorage | null | undefined,
  userId: string | null | undefined,
): OrderDraft | null {
  const key = resolveStorageKey(userId);
  if (!storage || !key) return null;
  try {
    return parseOrderDraft(storage.getItem(key));
  } catch {
    return null;
  }
}

/** Guarda el borrador del usuario. Devuelve `false` si el storage no está disponible. */
export function saveOrderDraft(
  storage: OrderDraftStorage | null | undefined,
  draft: OrderDraft,
  userId: string | null | undefined,
): boolean {
  const key = resolveStorageKey(userId);
  if (!storage || !key) return false;
  try {
    storage.setItem(key, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

/** Elimina el borrador del usuario; se usa al confirmar el pedido o cerrar sesión. */
export function clearOrderDraft(
  storage: OrderDraftStorage | null | undefined,
  userId: string | null | undefined,
): boolean {
  const key = resolveStorageKey(userId);
  if (!storage || !key) return false;
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
