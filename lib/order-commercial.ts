/**
 * Datos comerciales del pedido.
 *
 * Módulo puro (sin dependencias de Node ni Next) compartido por el schema de
 * Mongoose, los schemas Zod, los servicios y la UI. La condición de pago y el
 * tipo de factura son obligatorios al crear un pedido; los pedidos históricos
 * pueden no tenerlos.
 */

export const INVOICE_TYPES = ['A', 'B'] as const;

export type InvoiceType = (typeof INVOICE_TYPES)[number];

export const INVOICE_TYPE_LABELS: Record<InvoiceType, string> = {
  A: 'Factura A',
  B: 'Factura B',
};

/** ¿El valor guardado es un tipo de factura válido? */
export function isInvoiceType(value: unknown): value is InvoiceType {
  return (INVOICE_TYPES as readonly unknown[]).includes(value);
}

/**
 * Texto para mostrar el tipo de factura. Los pedidos viejos no tienen el
 * campo y se muestran como "No informado".
 */
export function formatInvoiceType(type?: InvoiceType | string | null): string {
  return isInvoiceType(type) ? INVOICE_TYPE_LABELS[type] : 'No informado';
}

export const PAYMENT_CONDITIONS = ['contado', 'cuenta_corriente', 'otro'] as const;

export type PaymentCondition = (typeof PAYMENT_CONDITIONS)[number];

export const PAYMENT_CONDITION_LABELS: Record<PaymentCondition, string> = {
  contado: 'Contado',
  cuenta_corriente: 'Cuenta corriente',
  otro: 'Otro',
};

/** ¿El valor guardado es una condición de pago válida? */
export function isPaymentCondition(value: unknown): value is PaymentCondition {
  return (PAYMENT_CONDITIONS as readonly unknown[]).includes(value);
}

/**
 * Texto para mostrar la condición de pago. Los pedidos viejos no tienen el
 * campo y se muestran como "No informado"; el detalle solo aplica a "Otro".
 */
export function formatPaymentCondition(
  condition?: PaymentCondition | string | null,
  detail?: string | null,
): string {
  if (!isPaymentCondition(condition)) return 'No informado';

  if (condition !== 'otro') return PAYMENT_CONDITION_LABELS[condition];

  const trimmedDetail = detail?.trim();
  return trimmedDetail ? `${PAYMENT_CONDITION_LABELS.otro} — ${trimmedDetail}` : 'Otro';
}

/** Datos comerciales editables del alta. */
export interface CommercialSelection {
  invoiceType: InvoiceType | '';
  paymentCondition: PaymentCondition | '';
  paymentConditionDetail: string;
}

/** Campos comerciales que puede aportar el último pedido del cliente. */
export interface LastOrderCommercialSource {
  invoiceType?: unknown;
  paymentCondition?: unknown;
  paymentConditionDetail?: string | null;
}

/**
 * Completa factura y condición de pago con el último pedido del cliente.
 *
 * Sólo reemplaza campos vacíos que el vendedor todavía no tocó: una elección
 * manual (aunque después se haya limpiado) siempre gana. Devuelve `null` si no
 * hay nada que completar para evitar renders/autoguardados innecesarios.
 */
export function resolveCommercialDefaultsFromLastOrder({
  current,
  lastOrder,
  invoiceTypeTouched = false,
  paymentConditionTouched = false,
}: {
  current: CommercialSelection;
  lastOrder: LastOrderCommercialSource | null | undefined;
  invoiceTypeTouched?: boolean;
  paymentConditionTouched?: boolean;
}): CommercialSelection | null {
  if (!lastOrder) return null;

  let invoiceType = current.invoiceType;
  let paymentCondition = current.paymentCondition;
  let paymentConditionDetail = current.paymentConditionDetail;
  let changed = false;

  if (!invoiceTypeTouched && current.invoiceType === '' && isInvoiceType(lastOrder.invoiceType)) {
    invoiceType = lastOrder.invoiceType;
    changed = true;
  }

  if (
    !paymentConditionTouched &&
    current.paymentCondition === '' &&
    isPaymentCondition(lastOrder.paymentCondition)
  ) {
    paymentCondition = lastOrder.paymentCondition;
    changed = true;

    // "Otro" necesita el detalle para quedar completo; se arrastra sólo si el
    // pedido anterior lo tenía informado.
    if (paymentCondition === 'otro') {
      const detail = lastOrder.paymentConditionDetail?.trim();
      if (detail) paymentConditionDetail = detail;
    }
  }

  return changed ? { invoiceType, paymentCondition, paymentConditionDetail } : null;
}
