'use client';

import {
  createContext,
  useContext,
  type HTMLAttributes,
  type ReactNode,
  type TdHTMLAttributes,
  type ThHTMLAttributes,
} from 'react';
import { cn } from '@/components/ui/cn';

type TableAlign = 'left' | 'center' | 'right';

export type TableDensity = 'comfortable' | 'compact';

const ALIGN_STYLES: Record<TableAlign, string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
};

const TableContext = createContext<{ density: TableDensity }>({ density: 'comfortable' });

export interface TableProps {
  children: ReactNode;
  /** Reduce el padding horizontal y vertical para listas largas. */
  dense?: boolean;
  /** Densidad explícita; `dense` se conserva por compatibilidad. */
  density?: TableDensity;
  className?: string;
}

/** Tabla base con scroll horizontal y estilos compartidos de cabecera/celdas. */
export function Table({ children, dense = false, density, className }: TableProps) {
  const resolvedDensity = density ?? (dense ? 'compact' : 'comfortable');

  return (
    <TableContext.Provider value={{ density: resolvedDensity }}>
      <div className="overflow-x-auto">
        <table className={cn('w-full border-collapse text-left', className)}>{children}</table>
      </div>
    </TableContext.Provider>
  );
}

export function TableHead({ children }: { children: ReactNode }) {
  return <thead>{children}</thead>;
}

export function TableBody({ children }: { children: ReactNode }) {
  return <tbody className="divide-y divide-border text-sm text-foreground">{children}</tbody>;
}

export interface TableRowProps extends HTMLAttributes<HTMLTableRowElement> {
  /** Aplica el hover estándar de fila. */
  hover?: boolean;
}

export function TableRow({ hover = false, className, ...props }: TableRowProps) {
  return (
    <tr className={cn(hover && 'transition-colors hover:bg-surface-muted', className)} {...props} />
  );
}

export function TableHeaderRow({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return <TableRow className={cn('border-b border-border text-subtle', className)} {...props} />;
}

export interface TableHeaderCellProps extends ThHTMLAttributes<HTMLTableCellElement> {
  align?: TableAlign;
}

export function TableHeaderCell({ align = 'left', className, ...props }: TableHeaderCellProps) {
  const { density } = useContext(TableContext);

  return (
    <th
      className={cn(
        'py-3 text-xs font-semibold uppercase tracking-wide',
        density === 'compact' ? 'px-3' : 'px-4',
        ALIGN_STYLES[align],
        className,
      )}
      {...props}
    />
  );
}

export interface TableCellProps extends TdHTMLAttributes<HTMLTableCellElement> {
  align?: TableAlign;
}

export function TableCell({ align = 'left', className, ...props }: TableCellProps) {
  const { density } = useContext(TableContext);

  return (
    <td
      className={cn(
        density === 'compact' ? 'px-3 py-2' : 'px-4 py-4',
        ALIGN_STYLES[align],
        className,
      )}
      {...props}
    />
  );
}

export function TableEmptyRow({
  colSpan,
  children,
  className,
}: {
  colSpan: number;
  children: ReactNode;
  className?: string;
}) {
  return (
    <tr>
      <td colSpan={colSpan} className={cn('py-10 text-center text-sm text-muted', className)}>
        {children}
      </td>
    </tr>
  );
}
