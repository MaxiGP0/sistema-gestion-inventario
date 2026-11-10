'use client';

import { useState } from 'react';
import { Check, Copy, MessageCircle, Share2 } from 'lucide-react';
import Button from '@/components/ui/Button';
import { cn } from '@/components/ui/cn';
import { useToast } from '@/context/ToastContext';
import { copyTextToClipboard } from '@/lib/clipboard';
import {
  buildOrderShareText,
  buildOrderShareTitle,
  type OrderShareOrderLike,
} from '@/lib/order-share';

interface OrderShareButtonsProps {
  order: OrderShareOrderLike;
  /** En cabeceras angostas muestra sólo los íconos en mobile. */
  hideLabelOnMobile?: boolean;
  className?: string;
}

/** Web Share API disponible y compatible con el payload de texto. */
function supportsNativeShare(payload: { title: string; text: string }): boolean {
  if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') return false;

  if (typeof navigator.canShare !== 'function') return true;

  try {
    return navigator.canShare(payload);
  } catch {
    return false;
  }
}

/**
 * Acciones de handoff del pedido: hoja nativa de compartir (Web Share API) y
 * copiado del resumen en texto plano. Si el navegador no soporta compartir,
 * "Compartir" cae al copiado para que la acción nunca quede muerta.
 */
export default function OrderShareButtons({
  order,
  hideLabelOnMobile = false,
  className,
}: OrderShareButtonsProps) {
  const { showToast } = useToast();
  const [copied, setCopied] = useState(false);
  const [sharing, setSharing] = useState(false);

  const labelClassName = hideLabelOnMobile ? 'hidden sm:inline' : undefined;
  const shareText = buildOrderShareText(order);
  const whatsappHref = `https://wa.me/?text=${encodeURIComponent(shareText)}`;

  const handleCopy = async (successMessage = 'Resumen copiado al portapapeles.') => {
    try {
      await copyTextToClipboard(shareText);
      setCopied(true);
      showToast(successMessage, 'success');
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      showToast('No se pudo copiar el resumen. Intentá de nuevo.', 'error');
    }
  };

  const handleShare = async () => {
    if (sharing) return;

    const payload = {
      title: buildOrderShareTitle(order),
      text: shareText,
    };

    const canUseNativeShare = supportsNativeShare(payload);

    if (!canUseNativeShare) {
      await handleCopy('Este navegador no permite compartir. El resumen se copió al portapapeles.');
      return;
    }

    try {
      setSharing(true);
      await navigator.share(payload);
    } catch (error) {
      // El usuario cerró la hoja nativa: no es un error para mostrar.
      if (error instanceof DOMException && error.name === 'AbortError') return;

      showToast('No se pudo abrir el menú para compartir.', 'error');
    } finally {
      setSharing(false);
    }
  };

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => void handleShare()}
        disabled={sharing}
        aria-label="Compartir resumen del pedido"
        data-testid="order-share-button"
      >
        <Share2 className="h-4 w-4" aria-hidden="true" />
        <span className={labelClassName}>Compartir</span>
      </Button>

      <a
        href={whatsappHref}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Enviar resumen por WhatsApp"
        data-testid="order-whatsapp-button"
        className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md border border-border-strong bg-surface px-3 text-xs font-semibold text-action-text transition-colors hover:bg-action-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface max-md:min-h-11 max-md:min-w-11"
      >
        <MessageCircle className="h-4 w-4" aria-hidden="true" />
        <span className={labelClassName}>WhatsApp</span>
      </a>

      <Button
        variant="secondary"
        size="sm"
        onClick={() => void handleCopy()}
        aria-label={copied ? 'Resumen copiado' : 'Copiar resumen del pedido'}
        data-testid="order-copy-summary-button"
      >
        {copied ? (
          <Check className="h-4 w-4 text-status-delivered" aria-hidden="true" />
        ) : (
          <Copy className="h-4 w-4" aria-hidden="true" />
        )}
        <span className={labelClassName}>{copied ? '¡Copiado!' : 'Copiar resumen'}</span>
      </Button>
    </div>
  );
}
