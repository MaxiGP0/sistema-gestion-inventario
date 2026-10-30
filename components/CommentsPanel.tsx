'use client';

import { MessageSquare } from 'lucide-react';
import Button from '@/components/ui/Button';
import Card from '@/components/ui/Card';
import { controlClasses } from '@/components/ui/Field';
import { cn } from '@/components/ui/cn';
import { DASHBOARD_TIME_ZONE } from '@/lib/dashboard-time';
import type { OrderCommentDTO } from '@/lib/types';

/** Comentario de una etapa del pedido (DTO compartido con la API). */
export type OrderComment = OrderCommentDTO;

export type CommentsPanelVariant = 'vendor' | 'deposit' | 'billing';

interface PanelStyle {
  label: string;
  /** Respuestas rápidas de 1 toque; vacío desactiva los chips. */
  quickReplies: readonly string[];
}

const PANEL_STYLES: Record<CommentsPanelVariant, PanelStyle> = {
  vendor: {
    label: 'Agregar Comentario u Observación (Vendedor):',
    quickReplies: ['Enviar lo disponible', 'Cliente espera faltante', 'Urgente'],
  },
  deposit: {
    label: 'Agregar Comentario u Observación (Depósito):',
    quickReplies: ['Sin stock temporal', 'Pendiente de ingreso'],
  },
  billing: {
    label: 'Agregar Comentario u Observación (Facturación / Control):',
    quickReplies: [],
  },
};

const COMMENT_DATE_FORMATTER = new Intl.DateTimeFormat('es-AR', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: DASHBOARD_TIME_ZONE,
});

interface CommentsPanelProps {
  comments?: OrderComment[];
  value: string;
  onChange: (value: string) => void;
  variant: CommentsPanelVariant;
  /** Si se pasa, muestra el botón "Guardar Comentario". */
  onSubmit?: () => void;
  /** Deshabilita el botón mientras la acción está en curso. */
  submitting?: boolean;
}

/**
 * Panel de comentarios y observaciones compartido por los detalles de pedido.
 * Vendedor, Depósito y Facturación pueden guardar solo el comentario sin
 * cerrar la etapa ni abandonar la pantalla.
 */
export default function CommentsPanel({
  comments,
  value,
  onChange,
  variant,
  onSubmit,
  submitting = false,
}: CommentsPanelProps) {
  const styles = PANEL_STYLES[variant];

  const label = (
    <label className="mb-1 block text-xs font-semibold text-foreground">{styles.label}</label>
  );

  // Un toque agrega la respuesta rápida al final del texto ya escrito; nunca
  // reemplaza lo que el usuario venía redactando.
  const insertQuickReply = (reply: string) => {
    const current = value.trimEnd();
    onChange(current ? `${current} ${reply}` : reply);
  };

  const quickReplies =
    styles.quickReplies.length > 0 ? (
      <div className="mb-2 flex flex-wrap gap-2" data-testid="comment-quick-replies">
        {styles.quickReplies.map((reply) => (
          <Button
            key={reply}
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => insertQuickReply(reply)}
            className="rounded-full"
          >
            {reply}
          </Button>
        ))}
      </div>
    ) : null;

  const textarea = (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Escribe un comentario u observación..."
      rows={2}
      className={cn(controlClasses, 'min-h-20 resize-none')}
    />
  );

  return (
    <Card className="space-y-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <MessageSquare className="h-4 w-4 text-action-text" aria-hidden="true" />
        Comentarios y Observaciones del Pedido
      </h3>

      {comments && comments.length > 0 ? (
        <div className="max-h-48 space-y-3 overflow-y-auto pr-1" data-testid="order-comments-list">
          {comments.map((c, idx) => (
            <div
              key={idx}
              data-testid="order-comment"
              className="space-y-1 rounded-md border border-border bg-surface-muted p-3 text-xs text-foreground"
            >
              <div className="flex items-center justify-between text-[11px] text-subtle">
                <span>
                  <strong className="text-foreground">{c.author || 'Usuario'}</strong> (
                  {c.role || 'etapa'})
                </span>
                <span>{COMMENT_DATE_FORMATTER.format(new Date(c.createdAt))}</span>
              </div>
              <p className="whitespace-pre-wrap">{c.text}</p>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs italic text-muted">No hay comentarios previos en este pedido.</p>
      )}

      {onSubmit ? (
        <div className="flex flex-col items-end gap-3 pt-2 sm:flex-row">
          <div className="w-full flex-1">
            {label}
            {quickReplies}
            {textarea}
          </div>
          <Button
            variant="primary"
            onClick={onSubmit}
            disabled={submitting || !value.trim()}
            className="whitespace-nowrap px-5 py-2.5 text-xs"
          >
            Guardar Comentario
          </Button>
        </div>
      ) : (
        <div className="pt-2">
          {label}
          {quickReplies}
          {textarea}
        </div>
      )}
    </Card>
  );
}
