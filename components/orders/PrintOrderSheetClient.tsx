'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { ArrowLeft, Printer } from 'lucide-react';
import Button from '@/components/ui/Button';
import {
  controlSheetItemCode,
  controlSheetItemName,
  controlSheetLineStatus,
  groupOrderItemsByBrand,
  summarizeControlSheetTotals,
  type ControlSheetMode,
} from '@/lib/control-sheet';
import { ORDER_STATUS_LABELS } from '@/lib/order-status-labels';
import { DASHBOARD_TIME_ZONE } from '@/lib/dashboard-time';
import { formatBrandDiscount, formatDiscountPercentage } from '@/lib/billing-discounts';
import { formatInvoiceType, formatPaymentCondition } from '@/lib/order-commercial';
import type { OrderCommentDTO, OrderDTO } from '@/lib/types';

/** Formato compacto de la hoja: A4, 8 pt, tablas de 7,5 pt y filas de 6,5 mm. */
const CONTROL_SHEET_STYLES = `
@page {
  size: A4 portrait;
  margin: 8mm;
}

.print-shell {
  min-height: 100vh;
  padding: 8mm 4mm 12mm;
  background: #e5e7eb;
  color: #111827;
}

.print-toolbar {
  width: 194mm;
  max-width: 100%;
  margin: 0 auto 4mm;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4mm;
}

.print-toolbar-center {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: 3mm;
}

.print-toolbar-title {
  margin: 0;
  color: #4b5563;
  font-size: 10pt;
  font-weight: 600;
  letter-spacing: 0.01em;
  text-align: center;
}

.print-mode-switch {
  display: inline-flex;
  flex: 0 0 auto;
  gap: 0.4mm;
  padding: 0.5mm;
  border: 0.25mm solid #9ca3af;
  border-radius: 2mm;
  background: #f3f4f6;
}

.print-mode-option {
  min-height: 8mm;
  padding: 0 2.5mm;
  border: 0;
  border-radius: 1.5mm;
  background: transparent;
  color: #4b5563;
  font: inherit;
  font-size: 7.5pt;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
}

.print-mode-option[aria-pressed='true'] {
  background: #111827;
  color: #ffffff;
}

.print-mode-option:focus-visible {
  outline: 0.5mm solid #2563eb;
  outline-offset: 0.5mm;
}

.cs-sheet {
  box-sizing: border-box;
  width: 210mm;
  max-width: 100%;
  min-height: 297mm;
  margin: 0 auto;
  padding: 8mm;
  background: #ffffff;
  color: #111111;
  font-family: var(--font-inter), Arial, Helvetica, sans-serif;
  font-size: 8pt;
  line-height: 1.1;
  box-shadow: 0 2mm 8mm rgba(0, 0, 0, 0.18);
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

.cs-sheet *,
.cs-sheet *::before,
.cs-sheet *::after {
  box-sizing: border-box;
}

.cs-header {
  margin-bottom: 2.5mm;
}

.cs-topline {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 4mm;
  padding-bottom: 1.5mm;
  margin-bottom: 2mm;
  border-bottom: 0.3mm solid #111111;
}

.cs-logo {
  display: block;
  width: auto;
  height: 8mm;
}

.cs-doc {
  text-align: right;
}

.cs-doc-title {
  margin: 0;
  color: #111111;
  font-size: 11pt;
  font-weight: 700;
  letter-spacing: 0.04em;
  line-height: 1;
  text-transform: uppercase;
}

.cs-doc-subtitle {
  margin: 0.8mm 0 0;
  color: #4b5563;
  font-size: 7pt;
}

.cs-meta-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0.5mm 4mm;
  margin-bottom: 2.2mm;
}

.cs-data-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 6mm;
}

.cs-block {
  min-width: 0;
}

.cs-section-title {
  margin: 0 0 1mm;
  padding-bottom: 0.5mm;
  border-bottom: 0.2mm solid #9ca3af;
  font-size: 8pt;
  font-weight: 700;
  text-transform: uppercase;
}

.cs-fields {
  display: grid;
  gap: 0.5mm;
}

.cs-field {
  display: flex;
  gap: 1mm;
  min-width: 0;
}

.cs-label {
  flex: 0 0 auto;
  color: #4b5563;
}

.cs-value {
  min-width: 0;
  overflow-wrap: anywhere;
}

.cs-value--strong {
  font-weight: 700;
}

.cs-value--mono,
.cs-code {
  font-family: var(--font-ibm-plex-mono), ui-monospace, SFMono-Regular, Menlo, Consolas,
    monospace;
  font-size: 7pt;
  font-variant-numeric: tabular-nums;
}

.cs-brand {
  margin-top: 2.5mm;
}

.cs-brand--keep {
  break-inside: avoid;
  page-break-inside: avoid;
}

.cs-brand-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 3mm;
  break-after: avoid;
  page-break-after: avoid;
}

.cs-brand-name {
  margin: 0;
  font-size: 8pt;
  font-weight: 700;
  text-transform: uppercase;
}

.cs-brand-discount {
  color: #374151;
  font-size: 7.5pt;
  white-space: nowrap;
}

.cs-table {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  font-size: 7.5pt;
  line-height: 1.1;
}

.cs-table th,
.cs-table td {
  height: 6.5mm;
  min-height: 6mm;
  padding: 1mm 1.2mm;
  border-bottom: 0.2mm solid #9ca3af;
  vertical-align: middle;
}

.cs-table th {
  border-top: 0.3mm solid #111111;
  border-bottom: 0.3mm solid #111111;
  text-align: left;
  font-weight: 700;
}

.cs-table tbody tr {
  height: 6.5mm;
}

.cs-num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.cs-shortage {
  color: #991b1b;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.cs-sheet--error {
  display: flex;
  min-height: 120mm;
  align-items: center;
  justify-content: center;
  text-align: center;
}

.cs-error-title {
  margin: 0;
  color: #111111;
  font-size: 12pt;
  font-weight: 700;
}

.cs-error-text {
  margin: 2mm 0 0;
  color: #4b5563;
  font-size: 8pt;
}

.cs-error-hint {
  margin: 1mm 0 0;
  color: #6b7280;
  font-size: 7pt;
}

.cs-col-code {
  width: 23mm;
}

.cs-col-price {
  width: 21mm;
}

.cs-col-qty {
  width: 22mm;
}

.cs-col-alt {
  width: 27mm;
}

.cs-footer {
  margin-top: 3mm;
}

.cs-note {
  margin: 0;
  color: #374151;
  font-size: 7pt;
}

.cs-comments {
  margin-top: 2mm;
  padding-top: 1mm;
  border-top: 0.2mm solid #9ca3af;
}

.cs-comments-title {
  margin: 0 0 0.6mm;
  font-size: 7pt;
  font-weight: 700;
  text-transform: uppercase;
}

.cs-comment {
  margin: 0 0 0.4mm;
  font-size: 6.8pt;
  line-height: 1.1;
  orphans: 2;
  widows: 2;
}

.cs-comment-meta {
  color: #4b5563;
  font-weight: 600;
}

/* Previsualización en teléfonos: la hoja se ajusta al ancho disponible.
   El diseño A4 exacto de 210 mm queda intacto en @media print. */
@media screen and (max-width: 767px) {
  .print-shell {
    width: 100%;
    min-height: 100dvh;
    padding:
      calc(0.75rem + env(safe-area-inset-top))
      calc(0.75rem + env(safe-area-inset-right))
      calc(1.5rem + env(safe-area-inset-bottom))
      calc(0.75rem + env(safe-area-inset-left));
    overflow-x: hidden;
  }

  .print-toolbar {
    width: 100%;
    max-width: 100%;
    margin: 0 auto 0.75rem;
    gap: 0.5rem;
  }

  .print-toolbar-center {
    flex: 1;
    gap: 0;
  }

  .print-toolbar-title {
    display: none;
  }

  .print-mode-switch {
    max-width: 100%;
  }

  .print-mode-option {
    min-height: 2.75rem;
    padding: 0 2mm;
    font-size: 8pt;
  }

  .cs-logo {
    height: 7mm;
  }

  .cs-doc {
    text-align: left;
    margin-top: 1mm;
  }

  .cs-doc-title {
    font-size: 10pt;
  }

  .cs-sheet {
    width: 100%;
    max-width: 100%;
    min-height: 0;
    padding: 3mm;
    box-shadow: 0 1mm 4mm rgba(0, 0, 0, 0.16);
  }

  .cs-topline {
    flex-direction: column;
    align-items: flex-start;
    gap: 0.5mm;
  }

  .cs-meta-grid,
  .cs-data-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .cs-data-grid {
    gap: 2mm;
  }

  .cs-field,
  .cs-brand-heading {
    flex-wrap: wrap;
  }

  .cs-brand-heading {
    gap: 1mm;
  }

  .cs-table {
    font-size: 6.4pt;
  }

  .cs-table th,
  .cs-table td {
    height: auto;
    min-height: 0;
    padding: 0.6mm;
    overflow-wrap: anywhere;
  }

  .cs-col-code {
    width: 17mm;
  }

  .cs-col-price {
    width: 15mm;
  }

  .cs-col-qty {
    width: 13mm;
  }

  .cs-col-alt {
    width: 11mm;
  }

  .cs-code {
    font-size: 6pt;
  }

  .cs-sheet--error {
    min-height: 60mm;
  }

  .cs-num {
    white-space: normal;
  }
}

@media print {
  html,
  body {
    background: #ffffff !important;
  }

  .print-shell {
    min-height: 0;
    padding: 0;
    background: #ffffff;
  }

  .print-toolbar,
  .no-print {
    display: none !important;
  }

  .cs-sheet {
    width: auto;
    min-height: 0;
    margin: 0;
    padding: 0;
    box-shadow: none;
  }

  .cs-header {
    break-after: avoid;
    page-break-after: avoid;
  }

  .cs-footer {
    break-inside: avoid;
    page-break-inside: avoid;
  }

  .cs-table thead {
    display: table-header-group;
  }

  .cs-table tr {
    break-inside: avoid;
    page-break-inside: avoid;
  }
}
`;

/** Medidas del isotipo; la hoja las escala por CSS. */
const LOGO_WIDTH = 256;
const LOGO_HEIGHT = 256;

const MONEY_FORMATTER = new Intl.NumberFormat('es-AR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat('es-AR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: DASHBOARD_TIME_ZONE,
});

const formatMoney = (value: number): string =>
  `$ ${MONEY_FORMATTER.format(Number.isFinite(value) ? value : 0)}`;

const formatDateTime = (value?: string | Date | null): string => {
  if (!value) return '—';

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';

  return DATE_TIME_FORMATTER.format(date);
};

const valueOrDash = (value?: string | null): string => value?.trim() || '—';

function Field({
  label,
  value,
  strong = false,
  mono = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
  mono?: boolean;
}) {
  return (
    <div className="cs-field">
      <span className="cs-label">{label}:</span>
      <span
        className={`cs-value${strong ? ' cs-value--strong' : ''}${mono ? ' cs-value--mono' : ''}`}
      >
        {value}
      </span>
    </div>
  );
}

function CommentLine({ comment }: { comment: OrderCommentDTO }) {
  return (
    <p className="cs-comment">
      <span className="cs-comment-meta">
        {formatDateTime(comment.createdAt)} · {valueOrDash(comment.author)}
      </span>{' '}
      <span>{comment.text}</span>
    </p>
  );
}

function ControlSheet({ order, mode }: { order: OrderDTO; mode: ControlSheetMode }) {
  const isVerified = mode === 'verified';
  const groups = groupOrderItemsByBrand(order.items, mode);
  const totals = summarizeControlSheetTotals(order.items, mode);
  const comments = order.comments ?? [];

  const clientCode = order.clientId?.code || order.clientCode;
  const clientName = order.clientId?.name || order.clientName;

  return (
    <article className="cs-sheet" data-sheet-mode={mode}>
      <header className="cs-header">
        <div className="cs-topline">
          <div style={{ display: 'flex', alignItems: 'center', gap: '2.5mm' }}>
            <Image
              className="cs-logo"
              src="/brand/logo.png"
              alt="Sistema de Gestión de Inventario"
              width={LOGO_WIDTH}
              height={LOGO_HEIGHT}
              loading="eager"
            />
            <div>
              <div
                style={{
                  fontSize: '9.5pt',
                  fontWeight: 700,
                  letterSpacing: '0.03em',
                  textTransform: 'uppercase',
                  lineHeight: 1.1,
                }}
              >
                Sistema de Gestión de Inventario
              </div>
              <div
                style={{
                  fontSize: '6.5pt',
                  color: '#4b5563',
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  marginTop: '0.4mm',
                }}
              >
                Control logístico y comercial
              </div>
            </div>
          </div>
          <div className="cs-doc">
            <h1 className="cs-doc-title">
              {isVerified ? 'Comprobante verificado' : 'Control de pedido'}
            </h1>
            <p className="cs-doc-subtitle">
              {isVerified ? 'Documento interno de facturación' : 'Documento interno de preparación'}
            </p>
          </div>
        </div>

        <div className="cs-meta-grid">
          <Field label="Pedido" value={`#${order._id.slice(-6)}`} strong mono />
          <Field label="Fecha y hora" value={formatDateTime(order.createdAt)} mono />
          <Field label="Vendedor" value={valueOrDash(order.createdBy)} mono />
          <Field label="Estado" value={ORDER_STATUS_LABELS[order.status] ?? order.status} strong />
        </div>

        <div className="cs-data-grid">
          <section className="cs-block">
            <h2 className="cs-section-title">Comprador</h2>
            <div className="cs-fields">
              <Field label="Código" value={valueOrDash(clientCode)} mono />
              <Field label="Nombre" value={valueOrDash(clientName)} strong />
              <Field label="Dirección" value={valueOrDash(order.clientId?.address)} />
              <Field label="Localidad" value={valueOrDash(order.clientId?.localidad)} />
              <Field label="Provincia" value={valueOrDash(order.clientId?.province)} />
            </div>
          </section>

          <section className="cs-block">
            <h2 className="cs-section-title">Comercial</h2>
            <div className="cs-fields">
              <Field
                label="Condición de pago"
                value={formatPaymentCondition(order.paymentCondition, order.paymentConditionDetail)}
              />
              <Field label="Tipo de factura" value={formatInvoiceType(order.invoiceType)} />
              <Field
                label="Descuento efectivo"
                value={`${formatDiscountPercentage(totals.effectiveDiscountPercentage)}%`}
              />
              <Field label="Subtotal" value={formatMoney(totals.subtotal)} />
              <Field label="Descuento total" value={`-${formatMoney(totals.totalDiscount)}`} />
              <Field label="Total final" value={formatMoney(totals.finalTotal)} strong />
            </div>
          </section>
        </div>
      </header>

      {groups.map((group) => (
        <section
          key={group.brandName}
          className={`cs-brand${group.items.length <= 10 ? ' cs-brand--keep' : ''}`}
        >
          <div className="cs-brand-heading">
            <h2 className="cs-brand-name">{group.brandName}</h2>
            <span className="cs-brand-discount">Descuento: {formatBrandDiscount(group)}</span>
          </div>

          <table className="cs-table">
            <colgroup>
              <col className="cs-col-code" />
              <col />
              <col className="cs-col-price" />
              <col className="cs-col-qty" />
              <col className="cs-col-alt" />
            </colgroup>
            <thead>
              <tr>
                <th>Código</th>
                <th>Descripción</th>
                <th className="cs-num">Precio unit.</th>
                <th className="cs-num">{isVerified ? 'Cant. verificada' : 'Cant. solicitada'}</th>
                <th>{isVerified ? 'Estado / faltante' : 'Cant. alterna'}</th>
              </tr>
            </thead>
            <tbody>
              {group.items.map((item, index) => {
                const lineStatus = controlSheetLineStatus(item);

                return (
                  <tr key={item._id ?? `${group.brandName}-${index}`}>
                    <td className="cs-code">{controlSheetItemCode(item) || '—'}</td>
                    <td>{controlSheetItemName(item) || '—'}</td>
                    <td className="cs-num">{formatMoney(item.unitPrice)}</td>
                    {isVerified ? (
                      <>
                        <td className="cs-num">{lineStatus.quantity}</td>
                        <td className={lineStatus.isShort ? 'cs-shortage' : undefined}>
                          {lineStatus.isShort
                            ? `Pedida: ${item.requestedQuantity} · ${lineStatus.label}`
                            : lineStatus.label}
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="cs-num">{item.requestedQuantity}</td>
                        <td />
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ))}

      <footer className="cs-footer">
        <p className="cs-note">
          {isVerified
            ? 'Importes sin IVA. Totales calculados sobre las cantidades verificadas en depósito.'
            : 'Importes sin IVA. Totales calculados sobre cantidades solicitadas.'}
        </p>

        {comments.length > 0 && (
          <section className="cs-comments">
            <h2 className="cs-comments-title">Comentarios</h2>
            {comments.map((comment, index) => (
              <CommentLine key={comment._id ?? `comment-${index}`} comment={comment} />
            ))}
          </section>
        )}
      </footer>
    </article>
  );
}

export interface PrintOrderSheetClientProps {
  orderId: string;
  /** Pedido resuelto en el servidor; no se repite el GET al hidratar. */
  initialOrder: OrderDTO | null;
  initialError: string | null;
  /**
   * Detalle desde el que se abrió la hoja. El toolbar vuelve ahí, de modo que
   * vendedor, depósito y facturación regresan a su propia bandeja.
   */
  backHref: string;
  /** Etapa inicial de la hoja; el usuario puede alternarla en el toolbar. */
  defaultMode?: ControlSheetMode;
}

const SHEET_MODES: ReadonlyArray<{ value: ControlSheetMode; label: string }> = [
  { value: 'requested', label: 'Solicitado' },
  { value: 'verified', label: 'Verificado' },
];

/**
 * Previsualización cliente de la hoja de control. Recibe el pedido ya resuelto
 * por el Server Component: no hay spinner ni fetch de montaje. El único trabajo
 * local es alternar la etapa y abrir la impresión del navegador.
 */
export default function PrintOrderSheetClient({
  orderId,
  initialOrder,
  initialError,
  backHref,
  defaultMode = 'requested',
}: PrintOrderSheetClientProps) {
  const router = useRouter();
  const [mode, setMode] = useState<ControlSheetMode>(defaultMode);

  return (
    <div className="print-shell">
      <style>{CONTROL_SHEET_STYLES}</style>

      <div className="print-toolbar no-print">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => router.push(backHref)}
          aria-label={`Volver al detalle del pedido ${orderId.slice(-6)}`}
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Volver
        </Button>

        <div className="print-toolbar-center">
          <p className="print-toolbar-title">
            {mode === 'verified' ? 'Comprobante verificado' : 'Control de pedido'} #
            {orderId.slice(-6)}
          </p>
          <div
            className="print-mode-switch"
            role="group"
            aria-label="Tipo de hoja"
            data-testid="print-sheet-mode-selector"
          >
            {SHEET_MODES.map((option) => (
              <button
                key={option.value}
                type="button"
                className="print-mode-option"
                aria-pressed={mode === option.value}
                onClick={() => setMode(option.value)}
                data-testid={`print-sheet-mode-${option.value}`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <Button variant="primary" size="sm" onClick={() => window.print()} disabled={!initialOrder}>
          <Printer className="h-4 w-4" aria-hidden="true" /> Imprimir
        </Button>
      </div>

      {initialOrder ? (
        <ControlSheet order={initialOrder} mode={mode} />
      ) : (
        <div className="cs-sheet cs-sheet--error">
          <div>
            <h1 className="cs-error-title">No pudimos abrir la hoja</h1>
            <p className="cs-error-text">{initialError ?? 'Pedido no encontrado.'}</p>
            <p className="cs-error-hint">Volvé al detalle e intentá de nuevo.</p>
          </div>
        </div>
      )}
    </div>
  );
}
