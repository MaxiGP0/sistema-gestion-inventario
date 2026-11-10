/**
 * Datos deterministas del seed E2E.
 *
 * Los nombres y códigos son exclusivos de la base de prueba para que los
 * selectores de Playwright no compitan con datos reales.
 */

export const E2E_PASSWORD = process.env.E2E_PASSWORD ?? 'InventarioE2E2026!';

/** Clave temporal usada por el E2E de cambio de contraseña (se restaura al final). */
export const E2E_CHANGED_PASSWORD =
  process.env.E2E_CHANGED_PASSWORD ?? 'InventarioE2E2026-Cambiada!';

export const E2E_USERS = {
  admin: { username: 'e2e-admin', password: E2E_PASSWORD, role: 'admin' },
  seller: { username: 'e2e-vendedor', password: E2E_PASSWORD, role: 'vendedor' },
  deposit: { username: 'e2e-deposito', password: E2E_PASSWORD, role: 'controlador' },
  billing: { username: 'e2e-facturacion', password: E2E_PASSWORD, role: 'billing' },
  account: { username: 'e2e-cuenta', password: E2E_PASSWORD, role: 'vendedor' },
} as const;

export type E2EUser = (typeof E2E_USERS)[keyof typeof E2E_USERS];

export const E2E_BRAND = {
  name: 'E2E Laboratorio',
  codePrefix: 'E2E',
} as const;

export const E2E_SECONDARY_BRAND = {
  name: 'E2E Segunda Marca',
  codePrefix: 'E2S',
} as const;

export const E2E_PRODUCTS = {
  primary: {
    code: 'E2E-PROD-001',
    name: 'Producto E2E Principal',
    price: 1000,
  },
  secondary: {
    code: 'E2E-PROD-002',
    name: 'Producto E2E Secundario',
    price: 500,
  },
  otherBrand: {
    code: 'E2E-PROD-003',
    name: 'Producto E2E Otra Marca',
    price: 750,
  },
} as const;

/**
 * Productos extra para el E2E de catálogo offline. Los nombres empiezan con "Z"
 * para no desplazar los productos deterministas de la primera página.
 */
export const E2E_OFFLINE_CATALOG = {
  productCount: 560,
  targetIndex: 550,
  codeFor: (index: number) => `E2E-OFFLINE-${String(index).padStart(4, '0')}`,
  nameFor: (index: number) => `Z Producto E2E Offline ${String(index).padStart(4, '0')}`,
} as const;

export const E2E_CLIENTS = {
  fullFlow: {
    code: 'E2E-CLI-001',
    name: 'Farmacia E2E Flujo Completo',
    address: 'Av. Corrientes 1234',
    localidad: 'CABA',
    province: 'Buenos Aires',
    generalDiscount: 5,
  },
  pending: {
    code: 'E2E-CLI-002',
    name: 'Farmacia E2E Pendientes',
    address: 'Av. Rivadavia 5678',
    localidad: 'CABA',
    province: 'Buenos Aires',
    generalDiscount: 0,
  },
  dashboard: {
    code: 'E2E-CLI-003',
    name: 'Farmacia E2E Dashboard',
    address: 'Av. Santa Fe 901',
    localidad: 'CABA',
    province: 'Buenos Aires',
    generalDiscount: 0,
  },
  offline: {
    code: 'E2E-CLI-004',
    name: 'Farmacia E2E Offline',
    address: 'Av. Callao 4321',
    localidad: 'CABA',
    province: 'Buenos Aires',
    generalDiscount: 0,
  },
  realtime: {
    code: 'E2E-CLI-005',
    name: 'Farmacia E2E Tiempo Real',
    address: 'Av. Belgrano 2468',
    localidad: 'CABA',
    province: 'Buenos Aires',
    generalDiscount: 0,
  },
  postControl: {
    code: 'E2E-CLI-006',
    name: 'Farmacia E2E Post-Control',
    address: 'Av. Independencia 1357',
    localidad: 'CABA',
    province: 'Buenos Aires',
    generalDiscount: 0,
  },
  mobileControl: {
    code: 'E2E-CLI-007',
    name: 'Farmacia E2E Mobile Control',
    address: 'Av. 9 de Julio 390',
    localidad: 'CABA',
    province: 'Buenos Aires',
    generalDiscount: 0,
  },
} as const;

export type E2EClient = (typeof E2E_CLIENTS)[keyof typeof E2E_CLIENTS];

/**
 * Pedidos deterministas del panel. Hay uno por estado creado por el vendedor
 * E2E y un borrador extra del admin: el vendedor debe ver 5 (los suyos) y el
 * admin 6, lo que permite verificar el filtrado por rol sin depender de otros
 * specs.
 */
export const E2E_DASHBOARD_SELLER_ORDERS = [
  { status: 'borrador', finalTotal: 100 },
  { status: 'paralizado', finalTotal: 200 },
  { status: 'facturacion', finalTotal: 300 },
  { status: 'control_post_factura', finalTotal: 400 },
  { status: 'entregado', finalTotal: 500 },
] as const;

export const E2E_DASHBOARD_ADMIN_ORDER = {
  status: 'borrador',
  finalTotal: 600,
  clientName: 'Farmacia E2E Dashboard Admin',
} as const;

export const E2E_DASHBOARD_TOTALS = {
  seller: 1500,
  admin: 2100,
  sellerOrders: E2E_DASHBOARD_SELLER_ORDERS.length,
  adminOrders: E2E_DASHBOARD_SELLER_ORDERS.length + 1,
} as const;
