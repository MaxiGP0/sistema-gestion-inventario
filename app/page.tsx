import type { Metadata } from 'next';
import type { LucideIcon } from 'lucide-react';
import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  ClipboardCheck,
  ClipboardList,
  Clock,
  FileText,
  Package,
  ShieldCheck,
  ShoppingCart,
  UploadCloud,
  Users,
  Wallet,
} from 'lucide-react';
import Link from 'next/link';
import { Suspense } from 'react';
import AppShell from '@/components/app-shell/AppShell';
import InstallAppButton from '@/components/InstallAppButton';
import StatusBadge from '@/components/StatusBadge';
import Card from '@/components/ui/Card';
import EmptyState from '@/components/ui/EmptyState';
import { requireRolePage } from '@/lib/auth-page';
import { USER_ROLES, type UserRole } from '@/lib/authz';
import {
  DASHBOARD_STATUS_LABELS,
  DASHBOARD_TIME_ZONE,
  dashboardStatusesForRole,
  getDashboardMetrics,
  type DashboardMetrics,
  type DashboardOrder,
  type DashboardStatus,
} from '@/lib/dashboard';
import type { SessionPayload } from '@/lib/session';
import { formatOrderShortId } from '@/lib/order-short-id';
import { buildDashboardQueueHref } from '@/lib/orders-tray';

export const metadata: Metadata = {
  title: 'Panel operativo',
  description:
    'Resumen operativo de pedidos: colas por estado, pedidos del día y accesos directos por rol.',
};

const DEPOSIT_STATUSES = new Set<DashboardStatus>(['borrador', 'paralizado']);

interface StatusStyle {
  icon: LucideIcon;
  iconClass: string;
  barClass: string;
}

const STATUS_STYLES: Record<DashboardStatus, StatusStyle> = {
  borrador: {
    icon: ClipboardList,
    iconClass: 'bg-status-draft-soft text-status-draft',
    barClass: 'bg-status-draft-border',
  },
  paralizado: {
    icon: Clock,
    iconClass: 'bg-status-blocked-soft text-status-blocked',
    barClass: 'bg-status-blocked-border',
  },
  facturacion: {
    icon: FileText,
    iconClass: 'bg-status-ready-soft text-status-ready',
    barClass: 'bg-status-ready-border',
  },
  control_post_factura: {
    icon: ClipboardCheck,
    iconClass: 'bg-status-control-soft text-status-control',
    barClass: 'bg-status-control-border',
  },
  entregado: {
    icon: CheckCircle2,
    iconClass: 'bg-status-delivered-soft text-status-delivered',
    barClass: 'bg-status-delivered-border',
  },
};

const PANEL_TITLES: Record<UserRole, string> = {
  admin: 'Panel administrador',
  vendedor: 'Panel vendedor',
  controlador: 'Panel de depósito',
  billing: 'Panel de facturación',
};

const PANEL_DESCRIPTIONS: Record<UserRole, string> = {
  admin: 'Operación, catálogos y actividad reciente de todo el equipo.',
  vendedor: 'Tus pedidos, el catálogo y la actividad de tu cartera.',
  controlador: 'Picking, pedidos paralizados y actividad de depósito.',
  billing: 'Control post-factura y pedidos listos para despachar.',
};

interface AccessLink {
  href: string;
  label: string;
  description: string;
  icon: LucideIcon;
}

interface AccessGroup {
  title: string;
  icon: LucideIcon;
  links: AccessLink[];
}

const SALES_LINKS: AccessLink[] = [
  {
    href: '/orders/new',
    label: 'Nuevo Pedido',
    description: 'Crear un borrador con catálogo y descuentos.',
    icon: ShoppingCart,
  },
  {
    href: '/orders',
    label: 'Mis Pedidos',
    description: 'Estado, importes y detalle de tus pedidos.',
    icon: ClipboardList,
  },
];

const CATALOG_LINKS: AccessLink[] = [
  {
    href: '/catalog',
    label: 'Ver Catálogo',
    description: 'Productos, marcas y precios vigentes.',
    icon: BookOpen,
  },
  {
    href: '/catalog/clients',
    label: 'Ver Clientes',
    description: 'Consulta de clientes y descuentos configurados.',
    icon: Users,
  },
];

const ADMIN_GROUPS: AccessGroup[] = [
  {
    title: 'Operación de pedidos',
    icon: ClipboardList,
    links: [
      ...SALES_LINKS,
      {
        href: '/deposit/orders',
        label: 'Bandeja de Depósito',
        description: 'Verificación, picking y pedidos paralizados.',
        icon: ClipboardCheck,
      },
      {
        href: '/billing/orders',
        label: 'Bandeja de Facturación',
        description: 'Control post-factura y despacho.',
        icon: FileText,
      },
    ],
  },
  {
    title: 'Catálogos',
    icon: UploadCloud,
    links: [
      {
        href: '/backoffice/brands',
        label: 'Marcas',
        description: 'Alta, edición y baja lógica.',
        icon: UploadCloud,
      },
      {
        href: '/backoffice/clients',
        label: 'Clientes',
        description: 'Datos comerciales y descuentos.',
        icon: Users,
      },
      {
        href: '/backoffice/products',
        label: 'Productos',
        description: 'Catálogo, precios e imágenes.',
        icon: Package,
      },
      {
        href: '/backoffice/import',
        label: 'Excel',
        description: 'Importación masiva del catálogo.',
        icon: UploadCloud,
      },
      {
        href: '/backoffice/users',
        label: 'Usuarios',
        description: 'Roles, altas y reseteo de claves.',
        icon: ShieldCheck,
      },
    ],
  },
];

const ACCESS_GROUPS_BY_ROLE: Record<UserRole, AccessGroup[]> = {
  admin: ADMIN_GROUPS,
  vendedor: [
    { title: 'Ventas', icon: ShoppingCart, links: SALES_LINKS },
    { title: 'Catálogo', icon: BookOpen, links: CATALOG_LINKS },
  ],
  controlador: [
    {
      title: 'Depósito',
      icon: ClipboardCheck,
      links: [
        {
          href: '/deposit/orders',
          label: 'Bandeja de Depósito',
          description: 'Controlá el picking y gestioná faltantes.',
          icon: ClipboardCheck,
        },
      ],
    },
    { title: 'Catálogo', icon: BookOpen, links: CATALOG_LINKS },
  ],
  billing: [
    {
      title: 'Facturación',
      icon: FileText,
      links: [
        {
          href: '/billing/orders',
          label: 'Bandeja de Facturación',
          description: 'Control post-factura y entrega de pedidos.',
          icon: FileText,
        },
      ],
    },
  ],
};

const currencyFormatter = new Intl.NumberFormat('es-AR', {
  style: 'currency',
  currency: 'ARS',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const dateFormatter = new Intl.DateTimeFormat('es-AR', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: DASHBOARD_TIME_ZONE,
});

const todayFormatter = new Intl.DateTimeFormat('es-AR', {
  dateStyle: 'full',
  timeZone: DASHBOARD_TIME_ZONE,
});

const queueHrefFor = (role: UserRole, status: DashboardStatus): string =>
  buildDashboardQueueHref(role, status);

const queueActionFor = (role: UserRole, status: DashboardStatus): string => {
  if (role === 'vendedor') return 'Ver mis pedidos';
  return DEPOSIT_STATUSES.has(status) ? 'Abrir depósito' : 'Abrir facturación';
};

const latestOrderHref = (role: UserRole, order: DashboardOrder): string => {
  if (role === 'vendedor') return `/orders/${order.id}`;
  if (role === 'billing') return `/billing/orders/${order.id}`;
  if (role === 'controlador') return `/deposit/orders/${order.id}`;

  return DEPOSIT_STATUSES.has(order.status as DashboardStatus)
    ? `/deposit/orders/${order.id}`
    : `/billing/orders/${order.id}`;
};

const latestOrdersHref = (role: UserRole): string => {
  if (role === 'controlador') return '/deposit/orders';
  if (role === 'billing') return '/billing/orders';
  return '/orders';
};

const latestOrdersTitle = (role: UserRole): string => {
  if (role === 'vendedor') return 'Tus últimos pedidos';
  if (role === 'controlador') return 'Últimos pedidos en depósito';
  if (role === 'billing') return 'Últimos pedidos en facturación';
  return 'Últimos pedidos';
};

export default function DashboardPage() {
  return (
    <Suspense fallback={<DashboardSkeleton />}>
      <DashboardContent />
    </Suspense>
  );
}

async function DashboardContent() {
  const session = await requireRolePage(USER_ROLES);
  const now = new Date();
  const metrics = await getDashboardMetrics(session, now);

  return <DashboardView session={session} metrics={metrics} />;
}

function DashboardView({
  session,
  metrics,
}: {
  session: SessionPayload;
  metrics: DashboardMetrics;
}) {
  const role = session.role;
  const statuses = dashboardStatusesForRole(role);
  const showAmounts = metrics.todayAmount !== null;
  const queueTotal = statuses.reduce((total, status) => total + metrics.counts[status], 0);
  const paralyzedCount = metrics.counts.paralizado;
  const showParalyzedBanner = (role === 'vendedor' || role === 'controlador') && paralyzedCount > 0;

  return (
    <AppShell
      role={role}
      username={session.username}
      pageTitle="Panel operativo"
      pageDescription="Resumen del día"
    >
      <div className="mb-8 flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div>
          <h2 className="text-xl font-semibold text-foreground">{PANEL_TITLES[role]}</h2>
          <p className="mt-1 text-sm text-muted">{PANEL_DESCRIPTIONS[role]}</p>
        </div>
        <p className="text-xs font-medium text-subtle">
          {todayFormatter.format(metrics.generatedAt)}
        </p>
      </div>

      {showParalyzedBanner && (
        <Link
          href={queueHrefFor(role, 'paralizado')}
          data-testid="dashboard-paralyzed-banner"
          className="mb-8 flex items-center gap-3 rounded-lg border border-status-blocked-border bg-status-blocked-soft px-4 py-3 text-sm font-semibold text-status-blocked transition-colors hover:brightness-95"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface/70">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            Tenés {paralyzedCount} pedido(s) paralizado(s) por faltantes
          </span>
          <span className="flex shrink-0 items-center gap-1 text-xs font-semibold">
            · Revisar ahora
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
        </Link>
      )}

      <section aria-labelledby="dashboard-access" className="mb-8">
        <h3
          id="dashboard-access"
          className="mb-4 text-xs font-semibold uppercase tracking-wide text-subtle"
        >
          Accesos directos
        </h3>
        <InstallAppButton />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {ACCESS_GROUPS_BY_ROLE[role].map((group) => {
            const GroupIcon = group.icon;

            return (
              <Card key={group.title} className="flex flex-col">
                <div className="mb-4 flex items-center gap-2">
                  <span className="flex h-9 w-9 items-center justify-center rounded-md bg-surface-muted text-muted">
                    <GroupIcon className="h-4 w-4" />
                  </span>
                  <h4 className="text-sm font-semibold text-foreground">{group.title}</h4>
                </div>
                <div className="grid flex-1 grid-cols-1 gap-2 sm:grid-cols-2">
                  {group.links.map((link) => {
                    const Icon = link.icon;

                    return (
                      <Link
                        key={link.href}
                        href={link.href}
                        aria-label={link.label}
                        className="group flex items-start gap-3 rounded-md border border-border bg-surface-muted p-3 transition-colors hover:border-action/50 hover:bg-surface"
                      >
                        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface text-action-text ring-1 ring-border">
                          <Icon className="h-4 w-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-semibold text-foreground">
                            {link.label}
                          </span>
                          <span className="mt-0.5 block text-xs leading-snug text-muted">
                            {link.description}
                          </span>
                        </span>
                        <ArrowRight className="mt-1 h-3.5 w-3.5 shrink-0 text-subtle transition-transform group-hover:translate-x-0.5 group-hover:text-action-text" />
                      </Link>
                    );
                  })}
                </div>
              </Card>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="dashboard-today" className="mb-8">
        <h3
          id="dashboard-today"
          className="mb-4 text-xs font-semibold uppercase tracking-wide text-subtle"
        >
          Pulso de hoy
        </h3>
        <div
          className={`grid grid-cols-1 gap-4 sm:grid-cols-2 ${
            showAmounts ? 'lg:grid-cols-3' : 'lg:grid-cols-2'
          }`}
        >
          <Card className="flex items-center justify-between gap-4">
            <div>
              <p className="text-xs font-medium text-muted">Pedidos de hoy</p>
              <p
                data-testid="dashboard-kpi-today-orders"
                className="mt-2 text-3xl font-semibold tabular-nums text-foreground"
              >
                {metrics.todayOrders}
              </p>
            </div>
            <span className="flex h-12 w-12 items-center justify-center rounded-lg bg-action-soft text-action-text">
              <ShoppingCart className="h-6 w-6" aria-hidden="true" />
            </span>
          </Card>

          {metrics.todayAmount !== null && (
            <Card className="flex items-center justify-between gap-4">
              <div>
                <p className="text-xs font-medium text-muted">Monto de hoy</p>
                <p
                  data-testid="dashboard-kpi-today-amount"
                  className="mt-2 text-3xl font-semibold tabular-nums text-foreground"
                >
                  {currencyFormatter.format(metrics.todayAmount)}
                </p>
              </div>
              <span className="flex h-12 w-12 items-center justify-center rounded-lg bg-action-soft text-action-text">
                <Wallet className="h-6 w-6" aria-hidden="true" />
              </span>
            </Card>
          )}

          <Card className="flex items-center justify-between gap-4">
            <div>
              <p className="text-xs font-medium text-muted">En tus colas activas</p>
              <p
                data-testid="dashboard-kpi-queue-total"
                className="mt-2 text-3xl font-semibold tabular-nums text-foreground"
              >
                {queueTotal}
              </p>
            </div>
            <span className="flex h-12 w-12 items-center justify-center rounded-lg bg-action-soft text-action-text">
              <ClipboardList className="h-6 w-6" aria-hidden="true" />
            </span>
          </Card>
        </div>
      </section>

      <section aria-labelledby="dashboard-queues" className="mb-8">
        <h3
          id="dashboard-queues"
          className="mb-4 text-xs font-semibold uppercase tracking-wide text-subtle"
        >
          Colas por estado
        </h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {statuses.map((status) => {
            const style = STATUS_STYLES[status];
            const Icon = style.icon;

            return (
              <Link
                key={status}
                href={queueHrefFor(role, status)}
                data-testid={`dashboard-count-${status}`}
                className="group flex flex-col rounded-lg border border-border bg-surface p-4 transition-colors hover:border-action/50 hover:bg-surface-muted"
              >
                <div className="mb-3 flex items-start justify-between gap-2">
                  <span
                    className={`flex h-9 w-9 items-center justify-center rounded-md ${style.iconClass}`}
                  >
                    <Icon className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <span className={`h-1.5 w-8 rounded-full ${style.barClass}`} aria-hidden="true" />
                </div>
                <p className="text-xs font-medium text-muted">{DASHBOARD_STATUS_LABELS[status]}</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
                  {metrics.counts[status]}
                </p>
                <span className="mt-3 flex items-center gap-1 text-xs font-semibold text-action-text group-hover:underline">
                  {queueActionFor(role, status)}
                  <ArrowRight className="h-3 w-3" aria-hidden="true" />
                </span>
              </Link>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="dashboard-latest">
        <Card padding="none" className="overflow-hidden">
          <div className="flex flex-col justify-between gap-2 border-b border-border p-5 sm:flex-row sm:items-center">
            <div>
              <h3 id="dashboard-latest" className="text-base font-semibold text-foreground">
                {latestOrdersTitle(role)}
              </h3>
              <p className="mt-0.5 text-xs text-muted">
                {role === 'vendedor'
                  ? 'Solo se muestran los pedidos que creaste.'
                  : 'Filtrados por las etapas que gestiona tu rol.'}
              </p>
            </div>
            <Link
              href={latestOrdersHref(role)}
              className="inline-flex items-center gap-1 text-xs font-semibold text-action-text hover:underline"
            >
              Ver todos
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          </div>

          {metrics.latestOrders.length === 0 ? (
            <EmptyState
              className="rounded-none border-0"
              title="Todavía no hay pedidos"
              description="Cuando se cree un pedido, aparecerá en esta lista."
            />
          ) : (
            <div data-testid="dashboard-latest-orders">
              {/* Mobile: tarjetas sin scroll horizontal. */}
              <ul
                data-testid="dashboard-latest-orders-cards"
                className="divide-y divide-border sm:hidden"
              >
                {metrics.latestOrders.map((order) => {
                  const status = order.status as DashboardStatus;

                  return (
                    <li key={order.id} className="p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <Link
                            href={latestOrderHref(role, order)}
                            className="block truncate font-semibold text-foreground hover:text-action-text"
                          >
                            {order.clientName}
                          </Link>
                          {order.clientCode && (
                            <p className="mt-0.5 truncate font-mono text-xs text-subtle">
                              {order.clientCode}
                            </p>
                          )}
                          <p
                            data-testid="dashboard-order-short-id"
                            className="mt-0.5 font-mono text-xs tracking-wide text-muted"
                            title="Código corto del pedido"
                          >
                            {formatOrderShortId(order.id)}
                          </p>
                        </div>
                        <StatusBadge status={status} variant="vendor" />
                      </div>

                      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs text-muted">
                        <div className="min-w-0">
                          <dt className="text-[11px] uppercase tracking-wide text-subtle">Fecha</dt>
                          <dd className="mt-0.5">
                            {dateFormatter.format(new Date(order.createdAt))}
                          </dd>
                        </div>
                        <div className="min-w-0">
                          <dt className="text-[11px] uppercase tracking-wide text-subtle">
                            Vendedor
                          </dt>
                          <dd className="mt-0.5 truncate">{order.createdBy}</dd>
                        </div>
                      </dl>

                      {showAmounts && (
                        <div className="mt-3 flex items-center justify-between border-t border-border pt-3 text-sm">
                          <span className="text-xs font-medium text-muted">Total</span>
                          <span className="font-semibold tabular-nums text-foreground">
                            {currencyFormatter.format(order.finalTotal)}
                          </span>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>

              {/* Tablet/escritorio: tabla completa, sin ancho mínimo en mobile. */}
              <div
                data-testid="dashboard-latest-orders-table"
                className="hidden overflow-x-auto sm:block"
              >
                <table className="w-full text-left text-sm">
                  <thead className="bg-surface-muted text-xs uppercase tracking-wide text-subtle">
                    <tr>
                      <th className="px-5 py-3 font-semibold">Cliente</th>
                      <th className="px-5 py-3 font-semibold">Estado</th>
                      <th className="px-5 py-3 font-semibold">Fecha</th>
                      <th className="px-5 py-3 font-semibold">Vendedor</th>
                      {showAmounts && <th className="px-5 py-3 text-right font-semibold">Total</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {metrics.latestOrders.map((order) => {
                      const status = order.status as DashboardStatus;

                      return (
                        <tr key={order.id} className="transition-colors hover:bg-surface-muted">
                          <td className="px-5 py-3">
                            <Link
                              href={latestOrderHref(role, order)}
                              className="font-semibold text-foreground hover:text-action-text"
                            >
                              {order.clientName}
                            </Link>
                            {order.clientCode && (
                              <span className="ml-2 font-mono text-xs text-subtle">
                                {order.clientCode}
                              </span>
                            )}
                            <span
                              data-testid="dashboard-order-short-id"
                              className="ml-2 font-mono text-xs text-muted"
                              title="Código corto del pedido"
                            >
                              {formatOrderShortId(order.id)}
                            </span>
                          </td>
                          <td className="px-5 py-3">
                            <StatusBadge status={status} variant="vendor" />
                          </td>
                          <td className="px-5 py-3 text-xs text-muted">
                            {dateFormatter.format(new Date(order.createdAt))}
                          </td>
                          <td className="px-5 py-3 text-xs text-muted">{order.createdBy}</td>
                          {showAmounts && (
                            <td className="px-5 py-3 text-right text-sm font-semibold tabular-nums text-foreground">
                              {currencyFormatter.format(order.finalTotal)}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </Card>
      </section>
    </AppShell>
  );
}

function DashboardSkeleton() {
  return (
    <div className="flex min-h-dvh bg-background text-foreground">
      <aside className="hidden w-60 shrink-0 border-r border-border bg-surface md:block" />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-16 items-center border-b border-border bg-surface px-4 sm:px-6">
          <div className="h-4 w-32 animate-pulse rounded bg-border" />
        </div>
        <main className="flex-1 px-4 pb-[calc(5.5rem+env(safe-area-inset-bottom))] pt-4 sm:px-6 md:px-8 md:pb-8">
          <div className="mx-auto w-full max-w-6xl animate-pulse">
            <div className="mb-8">
              <div className="mb-3 h-7 w-56 rounded bg-border" />
              <div className="h-4 w-72 max-w-full rounded bg-border" />
            </div>
            <div className="mb-10 grid grid-cols-1 gap-6 lg:grid-cols-2">
              {[0, 1].map((item) => (
                <div key={item} className="h-40 rounded-lg border border-border bg-surface" />
              ))}
            </div>
            <div className="mb-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {[0, 1, 2].map((item) => (
                <div key={item} className="h-28 rounded-lg border border-border bg-surface" />
              ))}
            </div>
            <div className="mb-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
              {[0, 1, 2, 3, 4].map((item) => (
                <div key={item} className="h-36 rounded-lg border border-border bg-surface" />
              ))}
            </div>
            <div className="h-64 rounded-lg border border-border bg-surface" />
          </div>
        </main>
      </div>
    </div>
  );
}
