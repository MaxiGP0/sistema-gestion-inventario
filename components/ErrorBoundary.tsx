'use client';

import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import Button from '@/components/ui/Button';
import { captureClientError } from '@/lib/observability/errors';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error caught by ErrorBoundary:', error, errorInfo);
    captureClientError(error, {
      componentStack: errorInfo.componentStack ?? undefined,
      boundary: 'error-boundary',
    });
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-dvh items-center justify-center bg-background p-6 text-foreground">
          <div className="w-full max-w-md rounded-lg border border-border bg-surface p-8 text-center shadow-elevation-1">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-lg bg-status-blocked-soft text-status-blocked">
              <AlertTriangle className="h-8 w-8" aria-hidden="true" />
            </div>
            <h2 className="mb-2 text-xl font-semibold">Algo salió mal</h2>
            <p className="mb-6 text-sm text-muted">
              Ocurrió un error inesperado en la aplicación. Nuestro equipo ha sido notificado
              automáticamente.
            </p>
            {this.state.error && (
              <div className="mb-6 max-h-32 overflow-x-auto rounded-md bg-surface-muted p-3 text-left font-mono text-xs text-status-blocked">
                {this.state.error.message}
              </div>
            )}
            <Button variant="primary" fullWidth onClick={() => window.location.reload()}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" /> Recargar Página
            </Button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
