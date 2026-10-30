/**
 * Reglas puras del control de picking en depósito.
 *
 * El estado editable de cada línea (cantidad verificada, si está controlada y
 * su motivo) se mantiene en el cliente hasta guardar el pedido. Este módulo
 * concentra la derivación inicial, el contador de pendientes y la acción
 * masiva "marcar todo con la cantidad pedida", con snapshot para deshacer.
 *
 * No depende de React ni de Next para poder probarlo con `node:test`.
 */
import { PENDING_REASON_REMOVED } from './order-totals';

export interface PickingItemLike {
  _id?: string;
  productId?: { _id?: string } | null;
  productName?: string;
  productCode?: string;
  requestedQuantity: number;
  verifiedQuantity?: number | null;
  isPending?: boolean;
  pendingReason?: string;
}

export interface ItemControlState {
  verifiedQty: number;
  controlled: boolean;
  pendingReason: string;
}

/** Estado editable indexado por la clave estable de cada línea. */
export type PickingState = Record<string, ItemControlState>;

/** Motivo sugerido por el atajo "Sin stock" de la tarjeta móvil. */
export const PENDING_REASON_OUT_OF_STOCK = 'Sin stock en depósito';

/** Motivo de una línea que sigue en faltante (se descarta al controlarla completa). */
function retainedPartialReason(current: ItemControlState | undefined): string {
  const reason = current?.pendingReason.trim() ?? '';

  if (!reason || reason === PENDING_REASON_REMOVED || reason === PENDING_REASON_OUT_OF_STOCK) {
    return '';
  }

  return reason;
}

/** Clave estable de una línea aunque el producto ya no exista. */
export function pickingItemKey(item: PickingItemLike): string {
  return item._id || item.productId?._id || item.productName || item.productCode || '';
}

/** Estado inicial del picking derivado de las cantidades guardadas. */
export function buildPickingState(items: readonly PickingItemLike[]): PickingState {
  const state: PickingState = {};

  items.forEach((item) => {
    const defaultQty =
      item.verifiedQuantity !== undefined &&
      item.verifiedQuantity !== null &&
      item.verifiedQuantity > 0
        ? item.verifiedQuantity
        : item.requestedQuantity;

    // Una línea marcada pendiente no debe aparecer como controlada aunque
    // conserve una cantidad verificada de un picking anterior.
    const isControlled =
      !item.isPending &&
      item.verifiedQuantity !== undefined &&
      item.verifiedQuantity !== null &&
      item.verifiedQuantity > 0;

    state[pickingItemKey(item)] = {
      verifiedQty: defaultQty,
      controlled: isControlled,
      pendingReason: item.pendingReason ?? '',
    };
  });

  return state;
}

/** Una línea está pendiente mientras no haya sido controlada explícitamente. */
export function isPickingLinePending(state: ItemControlState | undefined): boolean {
  return !state?.controlled;
}

/**
 * Aplica una cantidad verificada (input o stepper) y confirma el control en el
 * mismo paso cuando hay unidades. Con 0 la línea vuelve a pendiente y conserva
 * un motivo claro para el faltante.
 */
export function setPickingLineQuantity(
  current: ItemControlState | undefined,
  quantity: number,
  requestedQuantity: number,
): ItemControlState {
  const verifiedQty = Math.max(0, Math.trunc(Number.isFinite(quantity) ? quantity : 0));

  if (verifiedQty === 0) {
    return {
      verifiedQty: 0,
      controlled: false,
      pendingReason: current?.pendingReason.trim() || PENDING_REASON_OUT_OF_STOCK,
    };
  }

  // Al alcanzar (o superar) lo pedido el faltante deja de existir. Si todavía
  // falta mercadería se conserva un motivo escrito por el operario, pero no la
  // sugerencia automática de "sin stock".
  const reachedRequested = verifiedQty >= requestedQuantity;

  return {
    verifiedQty,
    controlled: true,
    pendingReason: reachedRequested ? '' : retainedPartialReason(current),
  };
}

/** Stepper móvil: aplica el delta sobre la cantidad actual (o la pedida). */
export function applyPickingQuantityDelta(
  current: ItemControlState | undefined,
  delta: number,
  requestedQuantity: number,
  fallbackQty: number = requestedQuantity,
): ItemControlState {
  const base = current?.verifiedQty ?? fallbackQty;
  const next = Number.isFinite(base) ? base + delta : delta;

  return setPickingLineQuantity(current, next, requestedQuantity);
}

/** Atajo "= Solicitado": fija la cantidad pedida y controla la línea. */
export function markPickingLineRequested(requestedQuantity: number): ItemControlState {
  return {
    verifiedQty: Math.max(0, Math.trunc(requestedQuantity) || 0),
    controlled: true,
    pendingReason: '',
  };
}

/** Atajo "Sin stock": deja la línea pendiente con 0 y un motivo sugerido. */
export function markPickingLineOutOfStock(): ItemControlState {
  return {
    verifiedQty: 0,
    controlled: false,
    pendingReason: PENDING_REASON_OUT_OF_STOCK,
  };
}

/**
 * Los atajos de 1 toque sólo aportan cuando la línea no coincide con lo pedido
 * o todavía no fue controlada.
 */
export function shouldShowPickingShortcuts(
  state: ItemControlState | undefined,
  requestedQuantity: number,
): boolean {
  if (!state?.controlled) return true;
  return state.verifiedQty !== requestedQuantity;
}

/** Cantidad de líneas que todavía falta controlar (para la barra fija). */
export function countPendingPickingLines(
  items: readonly PickingItemLike[],
  state: PickingState,
): number {
  return items.reduce(
    (count, item) => (isPickingLinePending(state[pickingItemKey(item)]) ? count + 1 : count),
    0,
  );
}

/**
 * Una línea eliminada en depósito queda como faltante a propósito: la acción
 * masiva no debe "resucitarla" con la cantidad pedida.
 */
function isQuickControlCandidate(
  item: PickingItemLike,
  state: ItemControlState | undefined,
): boolean {
  if (!isPickingLinePending(state)) return false;
  return state?.pendingReason !== PENDING_REASON_REMOVED;
}

/** Líneas que la acción masiva efectivamente va a marcar. */
export function countQuickControlCandidates(
  items: readonly PickingItemLike[],
  state: PickingState,
): number {
  return items.reduce(
    (count, item) =>
      isQuickControlCandidate(item, state[pickingItemKey(item)]) ? count + 1 : count,
    0,
  );
}

export interface QuickControlResult {
  /** Estado siguiente con las líneas pendientes controladas. */
  state: PickingState;
  /** Estado previo completo, para restaurar con "Deshacer". */
  snapshot: PickingState;
  /** Cantidad de líneas que cambiaron. */
  changed: number;
}

/**
 * Marca con la cantidad pedida todas las líneas que todavía no fueron
 * controladas. No toca las ya controladas ni las eliminadas intencionalmente.
 * Devuelve el snapshot del estado anterior para poder deshacer.
 */
export function markRemainingLinesRequested(
  items: readonly PickingItemLike[],
  state: PickingState,
): QuickControlResult {
  const next: PickingState = { ...state };
  const snapshot: PickingState = { ...state };
  let changed = 0;

  items.forEach((item) => {
    const key = pickingItemKey(item);
    const current = state[key];

    if (!isQuickControlCandidate(item, current)) return;

    next[key] = {
      verifiedQty: item.requestedQuantity,
      controlled: true,
      pendingReason: '',
    };
    changed += 1;
  });

  return { state: next, snapshot, changed };
}

/** Copia defensiva del snapshot antes de restaurarlo. */
export function restorePickingSnapshot(snapshot: PickingState): PickingState {
  const restored: PickingState = {};
  for (const [key, state] of Object.entries(snapshot)) {
    restored[key] = { ...state };
  }
  return restored;
}
