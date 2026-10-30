'use client';

import React, { useEffect } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/components/ui/cn';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

interface ToastStyle {
  icon: LucideIcon;
  className: string;
}

const TOAST_STYLES: Record<ToastType, ToastStyle> = {
  success: {
    icon: CheckCircle2,
    className: 'border-status-delivered-border bg-status-delivered-soft text-status-delivered',
  },
  error: {
    icon: AlertCircle,
    className: 'border-status-blocked-border bg-status-blocked-soft text-status-blocked',
  },
  warning: {
    icon: AlertTriangle,
    className: 'border-status-draft-border bg-status-draft-soft text-status-draft',
  },
  info: {
    icon: Info,
    className: 'border-action/30 bg-action-soft text-action-text',
  },
};

interface ToastProps {
  message?: string | null;
  type?: ToastType;
  onClose: () => void;
  duration?: number;
}

export default function Toast({ message, type = 'success', onClose, duration = 4000 }: ToastProps) {
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => {
      onClose();
    }, duration);
    return () => clearTimeout(timer);
  }, [message, duration, onClose]);

  if (!message) return null;

  const style = TOAST_STYLES[type];
  const Icon = style.icon;

  return (
    <div
      className="fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+var(--mobile-toast-clearance))] z-50 animate-toast-in sm:inset-x-auto sm:right-6 sm:bottom-6"
      role={type === 'error' ? 'alert' : 'status'}
      aria-live={type === 'error' ? 'assertive' : 'polite'}
      aria-atomic="true"
    >
      <div
        data-toast-type={type}
        className={cn(
          'flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-sm font-medium shadow-elevation-2 sm:w-auto sm:max-w-md',
          style.className,
        )}
      >
        <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 break-words">{message}</span>
        <button
          type="button"
          onClick={onClose}
          className="ml-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-current opacity-70 transition-colors hover:bg-black/5 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface max-md:h-11 max-md:w-11"
          aria-label="Cerrar notificación"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
