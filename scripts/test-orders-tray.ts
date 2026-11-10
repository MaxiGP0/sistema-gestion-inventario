/**
 * Pruebas de la configuración compartida de las bandejas (lib/orders-tray.ts):
 * estados, rutas, textos y confirmaciones de depósito/facturación.
 *
 * Ejecutar con: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildArchiveConfirmation,
  buildDashboardQueueHref,
  buildOrdersListSearchParams,
  buildOrdersTrayFilterSearchParams,
  buildOrdersTrayHref,
  DELETE_CONFIRMATION,
  getOrdersTrayBackHref,
  getOrdersTrayStatusParam,
  ORDERS_TRAY_CONFIGS,
  ORDERS_TRAY_DATE_FILTERS,
  readOrdersTrayFilters,
  resolveOrdersTrayArchived,
  resolveOrdersTrayDatePreset,
  resolveOrdersTrayDateRange,
  resolveOrdersTrayInitialFilters,
  resolveOrdersTrayStatusFilter,
  saveOrdersTrayFilters,
} from '../lib/orders-tray';
import { buildOrderExportUrl } from '../lib/order-export';
import { isOrderInitialDataStale, ORDER_INITIAL_DATA_STALE_MS } from '../lib/order-initial-data';
import {
  consumeOrdersTrayRefresh,
  markOrdersTrayForRefresh,
  ORDERS_TRAY_REFRESH_TTL_MS,
} from '../lib/orders-tray-refresh';

test('cada bandeja conserva sus estados y su ruta de detalle', () => {
  assert.equal(ORDERS_TRAY_CONFIGS.deposit.status, 'borrador,paralizado');
  assert.equal(ORDERS_TRAY_CONFIGS.billing.status, 'facturacion,control_post_factura,entregado');
  assert.equal(
    ORDERS_TRAY_CONFIGS.vendor.status,
    'borrador,paralizado,facturacion,control_post_factura,entregado',
  );

  assert.equal(ORDERS_TRAY_CONFIGS.deposit.detailHref('abc'), '/deposit/orders/abc');
  assert.equal(ORDERS_TRAY_CONFIGS.billing.detailHref('abc'), '/billing/orders/abc');
  assert.equal(ORDERS_TRAY_CONFIGS.vendor.detailHref('abc'), '/orders/abc');
});

test('cada variante expone sólo los chips de sub-estado permitidos', () => {
  assert.deepEqual(
    ORDERS_TRAY_CONFIGS.deposit.statusFilters.map((filter) => filter.label),
    ['Todos', 'Borrador', 'Paralizado'],
  );
  assert.deepEqual(
    ORDERS_TRAY_CONFIGS.billing.statusFilters.map((filter) => filter.label),
    ['Todos', 'Para facturar', 'Post-control', 'Entregados'],
  );
  assert.deepEqual(
    ORDERS_TRAY_CONFIGS.vendor.statusFilters.map((filter) => filter.label),
    ['Todos', 'Borrador', 'Paralizado', 'En facturación', 'Post-control', 'Entregados'],
  );

  for (const config of Object.values(ORDERS_TRAY_CONFIGS)) {
    assert.equal(config.statusFilters[0]?.value, 'all');
    assert.ok(
      config.statusFilters.every(
        (filter) => filter.value === 'all' || config.status.split(',').includes(filter.value),
      ),
      `${config.variant} no debe ofrecer estados fuera de su whitelist`,
    );
  }
});

test('el filtro inicial acepta sólo estados de la variante', () => {
  const deposit = ORDERS_TRAY_CONFIGS.deposit;

  assert.equal(resolveOrdersTrayStatusFilter(deposit, 'paralizado').value, 'paralizado');
  assert.equal(
    resolveOrdersTrayStatusFilter(deposit, ['paralizado', 'borrador']).value,
    'paralizado',
    'con parámetros repetidos se usa el primero',
  );
  assert.equal(
    resolveOrdersTrayStatusFilter(deposit, 'falta-estado').value,
    'all',
    'un estado desconocido cae a Todos',
  );
  assert.equal(
    resolveOrdersTrayStatusFilter(deposit, 'entregado').value,
    'all',
    'un estado de otra bandeja no se filtra en depósito',
  );
  assert.equal(resolveOrdersTrayStatusFilter(deposit, undefined).value, 'all');
});

test('los filtros iniciales se resuelven desde los query params', () => {
  const deposit = ORDERS_TRAY_CONFIGS.deposit;

  assert.deepEqual(resolveOrdersTrayInitialFilters(deposit, {}), {
    status: 'all',
    datePreset: 'all',
    showArchived: false,
    search: '',
  });

  assert.deepEqual(
    resolveOrdersTrayInitialFilters(deposit, {
      status: 'paralizado',
      date: 'last7',
      archived: '1',
      search: '  Farmacia Demo  ',
    }),
    {
      status: 'paralizado',
      datePreset: 'last7',
      showArchived: true,
      search: 'Farmacia Demo',
    },
    'el término de búsqueda se recorta y sobrevive al primer render',
  );

  assert.deepEqual(
    resolveOrdersTrayInitialFilters(deposit, {
      status: 'entregado',
      date: 'mes-invalido',
      archived: '0',
    }),
    {
      status: 'all',
      datePreset: 'all',
      showArchived: false,
      search: '',
    },
    'un estado de otra bandeja y una fecha desconocida caen a sus defaults',
  );

  assert.equal(
    resolveOrdersTrayInitialFilters(deposit, { search: 'x'.repeat(120) }).search,
    'x'.repeat(80),
    'la búsqueda se acota a 80 caracteres',
  );
  assert.equal(
    resolveOrdersTrayInitialFilters(deposit, { search: ['primero', 'segundo'] }).search,
    'primero',
    'con parámetros repetidos se usa el primero',
  );

  assert.equal(resolveOrdersTrayDatePreset(['month', 'today']), 'month');
  assert.equal(resolveOrdersTrayDatePreset(undefined), 'all');
  assert.equal(resolveOrdersTrayArchived('true'), true);
  assert.equal(resolveOrdersTrayArchived('1'), true);
  assert.equal(resolveOrdersTrayArchived('false'), false);
  assert.equal(resolveOrdersTrayArchived(undefined), false);
});

test('la URL de la bandeja sólo conserva los filtros activos', () => {
  const current = new URLSearchParams(
    'foo=bar&status=entregado&date=today&archived=1&search=Anterior',
  );
  const cleared = buildOrdersTrayFilterSearchParams(
    { status: 'all', datePreset: 'all', showArchived: false, search: '   ' },
    current,
  );

  assert.equal(cleared.get('foo'), 'bar', 'los params ajenos a los filtros se preservan');
  assert.equal(cleared.has('status'), false);
  assert.equal(cleared.has('date'), false);
  assert.equal(cleared.has('archived'), false);
  assert.equal(cleared.has('search'), false, 'una búsqueda vacía no ensucia la URL');

  assert.equal(
    buildOrdersTrayFilterSearchParams({
      status: 'all',
      datePreset: 'all',
      showArchived: false,
      search: '  Cliente Demo  ',
    }).get('search'),
    'Cliente Demo',
    'el término se guarda recortado',
  );

  assert.equal(
    buildOrdersTrayHref('/orders', {
      status: 'borrador',
      datePreset: 'today',
      showArchived: true,
      search: 'Farmacia Demo',
    }),
    '/orders?status=borrador&date=today&archived=1&search=Farmacia+Demo',
  );
});

test('el backHref del detalle recupera los filtros guardados de la pestaña', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };

  assert.equal(getOrdersTrayBackHref('/orders', storage), '/orders');

  saveOrdersTrayFilters(
    '/orders/',
    {
      status: 'paralizado',
      datePreset: 'last7',
      showArchived: true,
      search: '  Farmacia Demo  ',
    },
    storage,
  );

  assert.deepEqual(readOrdersTrayFilters('/orders', storage), {
    status: 'paralizado',
    datePreset: 'last7',
    showArchived: true,
    search: 'Farmacia Demo',
  });
  assert.equal(
    getOrdersTrayBackHref('/orders', storage),
    '/orders?status=paralizado&date=last7&archived=1&search=Farmacia+Demo',
    'Volver conserva la búsqueda además de estado, fecha y archivados',
  );
  assert.equal(
    getOrdersTrayBackHref('/deposit/orders', storage),
    '/deposit/orders',
    'cada bandeja conserva su propio estado',
  );
});

test('el status enviado a la API respeta la whitelist de la variante', () => {
  const deposit = ORDERS_TRAY_CONFIGS.deposit;

  assert.equal(getOrdersTrayStatusParam(deposit, 'all'), 'borrador,paralizado');
  assert.equal(getOrdersTrayStatusParam(deposit, 'borrador'), 'borrador');
  assert.equal(getOrdersTrayStatusParam(deposit, 'paralizado'), 'paralizado');
  assert.equal(
    getOrdersTrayStatusParam(deposit, 'entregado'),
    'borrador,paralizado',
    'un valor ajeno no amplía el alcance de la bandeja',
  );
});

test('los presets de fecha se calculan en el día comercial argentino', () => {
  const now = new Date('2026-10-25T15:00:00.000Z'); // 12:00 en Argentina

  assert.deepEqual(
    ORDERS_TRAY_DATE_FILTERS.map((filter) => filter.label),
    ['Todas', 'Hoy', 'Últimos 7 días', 'Este mes'],
  );

  assert.deepEqual(resolveOrdersTrayDateRange('all', now), {
    startDate: null,
    endDate: null,
  });
  assert.deepEqual(resolveOrdersTrayDateRange('today', now), {
    startDate: '2026-10-25T03:00:00.000Z',
    endDate: '2026-10-26T02:59:59.999Z',
  });
  assert.deepEqual(resolveOrdersTrayDateRange('last7', now), {
    startDate: '2026-10-19T03:00:00.000Z',
    endDate: '2026-10-26T02:59:59.999Z',
  });
  assert.deepEqual(resolveOrdersTrayDateRange('month', now), {
    startDate: '2026-10-01T03:00:00.000Z',
    endDate: '2026-11-01T02:59:59.999Z',
  });

  // Diciembre no se desborda al mes 13.
  assert.deepEqual(resolveOrdersTrayDateRange('month', new Date('2026-12-15T15:00:00.000Z')), {
    startDate: '2026-12-01T03:00:00.000Z',
    endDate: '2027-01-01T02:59:59.999Z',
  });
});

test('la query del listado incluye sub-estado, fechas, búsqueda y cursor', () => {
  const params = buildOrdersListSearchParams({
    status: 'paralizado',
    archived: false,
    search: '  Cliente Demo  ',
    startDate: '2026-10-19T03:00:00.000Z',
    endDate: '2026-10-26T02:59:59.999Z',
    limit: 50,
    cursor: 'cursor-opaco',
  });

  assert.equal(params.get('status'), 'paralizado');
  assert.equal(params.get('archived'), 'false');
  assert.equal(params.get('search'), 'Cliente Demo');
  assert.equal(params.get('startDate'), '2026-10-19T03:00:00.000Z');
  assert.equal(params.get('endDate'), '2026-10-26T02:59:59.999Z');
  assert.equal(params.get('limit'), '50');
  assert.equal(params.get('pagination'), 'cursor');
  assert.equal(params.get('cursor'), 'cursor-opaco');

  const sinFiltros = buildOrdersListSearchParams({
    status: 'borrador,paralizado',
    archived: true,
    limit: 50,
  });
  assert.equal(sinFiltros.get('archived'), 'true');
  assert.equal(sinFiltros.has('startDate'), false);
  assert.equal(sinFiltros.has('endDate'), false);
  assert.equal(sinFiltros.has('search'), false);
});

test('la exportación conserva sub-estado y rango de fechas', () => {
  const range = resolveOrdersTrayDateRange('today', new Date('2026-10-25T15:00:00.000Z'));
  const url = buildOrderExportUrl('xlsx', {
    status: getOrdersTrayStatusParam(ORDERS_TRAY_CONFIGS.vendor, 'paralizado'),
    archived: 'false',
    search: '  Cliente Demo  ',
    ...range,
  });
  const parsed = new URL(url, 'http://localhost');

  assert.equal(parsed.pathname, '/api/orders/export');
  assert.equal(parsed.searchParams.get('format'), 'xlsx');
  assert.equal(parsed.searchParams.get('status'), 'paralizado');
  assert.equal(parsed.searchParams.get('archived'), 'false');
  assert.equal(parsed.searchParams.get('search'), 'Cliente Demo');
  assert.equal(parsed.searchParams.get('startDate'), '2026-10-25T03:00:00.000Z');
  assert.equal(parsed.searchParams.get('endDate'), '2026-10-26T02:59:59.999Z');
});

test('las tarjetas de colas del panel enlazan a la bandeja ya filtrada', () => {
  assert.equal(buildDashboardQueueHref('vendedor', 'paralizado'), '/orders?status=paralizado');
  assert.equal(
    buildDashboardQueueHref('vendedor', 'control_post_factura'),
    '/orders?status=control_post_factura',
  );
  assert.equal(buildDashboardQueueHref('admin', 'paralizado'), '/deposit/orders?status=paralizado');
  assert.equal(
    buildDashboardQueueHref('controlador', 'borrador'),
    '/deposit/orders?status=borrador',
  );
  assert.equal(
    buildDashboardQueueHref('billing', 'control_post_factura'),
    '/billing/orders?status=control_post_factura',
  );
  assert.equal(buildDashboardQueueHref('admin', 'entregado'), '/billing/orders?status=entregado');
});

test('la variante vendor muestra archivados, búsqueda y detalle de solo lectura', () => {
  const vendor = ORDERS_TRAY_CONFIGS.vendor;

  assert.equal(vendor.pageTitle, 'Mis Pedidos');
  assert.equal(vendor.heading, 'Historial de Mis Pedidos');
  assert.equal(vendor.clickable, true);
  assert.equal(vendor.notificationsRole, 'vendor');
  assert.match(vendor.searchPlaceholder, /cliente/i);
  assert.equal(vendor.emptyTitle(false), 'Todavía no creaste pedidos');
  assert.equal(vendor.emptyTitle(true), 'No hay pedidos archivados');
});

test('los textos, roles y acentos no se mezclan entre depósito y facturación', () => {
  assert.equal(ORDERS_TRAY_CONFIGS.deposit.pageTitle, 'Bandeja de Depósito');
  assert.equal(ORDERS_TRAY_CONFIGS.billing.pageTitle, 'Bandeja de Facturación');
  assert.equal(ORDERS_TRAY_CONFIGS.deposit.notificationsRole, 'deposit');
  assert.equal(ORDERS_TRAY_CONFIGS.billing.notificationsRole, 'billing');
  assert.equal(ORDERS_TRAY_CONFIGS.deposit.iconClassName, 'text-emerald-400');
  assert.equal(ORDERS_TRAY_CONFIGS.billing.iconClassName, 'text-purple-400');
  assert.equal(ORDERS_TRAY_CONFIGS.deposit.clickable, true);
  assert.equal(ORDERS_TRAY_CONFIGS.billing.clickable, true);
  assert.equal(ORDERS_TRAY_CONFIGS.vendor.clickable, true);
  assert.equal(ORDERS_TRAY_CONFIGS.deposit.archiveEntity, 'pedido');
  assert.equal(ORDERS_TRAY_CONFIGS.billing.archiveEntity, 'pedido/factura');
});

test('el estado vacío distingue activos y archivados por bandeja', () => {
  assert.equal(
    ORDERS_TRAY_CONFIGS.deposit.emptyTitle(false),
    'No hay pedidos pendientes en depósito',
  );
  assert.equal(ORDERS_TRAY_CONFIGS.deposit.emptyTitle(true), 'No hay pedidos archivados');
  assert.equal(
    ORDERS_TRAY_CONFIGS.billing.emptyTitle(false),
    'No hay pedidos pendientes de facturación',
  );
  assert.equal(ORDERS_TRAY_CONFIGS.billing.emptyTitle(true), 'No hay pedidos archivados');
});

test('buildArchiveConfirmation arma la confirmación de archivar/desarchivar', () => {
  assert.deepEqual(buildArchiveConfirmation('pedido', false), {
    title: 'Archivar pedido',
    message: '¿Estás seguro de archivar este pedido?',
    confirmLabel: 'Archivar',
    variant: 'primary',
  });

  assert.deepEqual(buildArchiveConfirmation('pedido', undefined), {
    title: 'Archivar pedido',
    message: '¿Estás seguro de archivar este pedido?',
    confirmLabel: 'Archivar',
    variant: 'primary',
  });

  assert.deepEqual(buildArchiveConfirmation('pedido', true), {
    title: 'Desarchivar pedido',
    message: '¿Estás seguro de desarchivar este pedido?',
    confirmLabel: 'Desarchivar',
    variant: 'primary',
  });

  assert.deepEqual(buildArchiveConfirmation('pedido/factura', false), {
    title: 'Archivar pedido/factura',
    message: '¿Estás seguro de archivar este pedido/factura?',
    confirmLabel: 'Archivar',
    variant: 'primary',
  });
});

test('la confirmación de eliminar es la misma para ambas bandejas', () => {
  assert.deepEqual(DELETE_CONFIRMATION, {
    title: 'Eliminar pedido',
    message: '¿Estás seguro de eliminar este pedido? Esta acción no se puede deshacer.',
    confirmLabel: 'Eliminar',
    variant: 'danger',
  });
});

test('la data inicial se refresca sólo cuando supera el TTL', () => {
  const now = Date.now();

  assert.equal(isOrderInitialDataStale(now - 5_000, now), false);
  assert.equal(
    isOrderInitialDataStale(now - ORDER_INITIAL_DATA_STALE_MS + 1, now),
    false,
    'justo antes del umbral sigue fresca',
  );
  assert.equal(
    isOrderInitialDataStale(now - ORDER_INITIAL_DATA_STALE_MS - 1, now),
    true,
    'al superar el umbral se revalida',
  );
  assert.equal(isOrderInitialDataStale(undefined, now), true);
  assert.equal(isOrderInitialDataStale(0, now), true);
  assert.equal(isOrderInitialDataStale(Number.NaN, now), true);
});

test('el marcador de refresco de bandeja se consume una sola vez y vence', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  const now = 1_000_000;

  markOrdersTrayForRefresh('/billing/orders', now, storage);

  assert.equal(consumeOrdersTrayRefresh('/deposit/orders', now, storage), false);
  assert.equal(consumeOrdersTrayRefresh('/billing/orders', now, storage), true);
  assert.equal(
    consumeOrdersTrayRefresh('/billing/orders', now, storage),
    false,
    'el marcador se descarta al consumirse',
  );

  markOrdersTrayForRefresh('/billing/orders', now - ORDERS_TRAY_REFRESH_TTL_MS - 1, storage);
  assert.equal(
    consumeOrdersTrayRefresh('/billing/orders', now, storage),
    false,
    'un marcador viejo no fuerza el refresh',
  );
});
