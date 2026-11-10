import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import dbConnect from '../lib/mongodb';
import { roundCurrency } from '../lib/money';
import { orderShortId } from '../lib/order-short-id';
import { buildOrderSearchFields, buildProductSearchFields } from '../lib/search-normalize';
import { parseSeedUsers, type SeedUser } from '../lib/seed-users';
import type { UserRole } from '../lib/authz';
import type { InvoiceType, PaymentCondition } from '../lib/order-commercial';
import type { PostControl } from '../lib/order-post-control';
import type { OrderStatus } from '../lib/order-statuses';
import { Brand, type IBrand } from '../models/Brand';
import { Client, type IClient } from '../models/Client';
import { Notification } from '../models/Notification';
import { NotificationRead } from '../models/NotificationRead';
import { Order, type IOrderItem } from '../models/Order';
import { Product, type IProduct } from '../models/Product';
import { User, type IUser } from '../models/User';

/**
 * Seed de demostración para el Sistema de Gestión de Inventario.
 *
 * Crea un entorno completo y realista con información ficticia para explorar
 * todos los módulos del sistema:
 * - Usuarios de demo para cada rol (`admin`, `vendedor`, `controlador`, `billing`)
 *   más soporte para usuarios adicionales vía `SEED_USERS`.
 * - 6 marcas ficticias del rubro salud, higiene y cuidado personal.
 * - 40 productos con códigos, precios sin/con IVA (21 %) y campos de búsqueda.
 * - 15 clientes con direcciones reales de referencia, descuentos generales y
 *   descuentos especiales por marca.
 * - 12 pedidos distribuidos en todos los estados del flujo (`borrador`,
 *   `paralizado`, `facturacion`, `control_post_factura`, `entregado`).
 * - 8 notificaciones operativas de muestra (por rol y privadas del vendedor).
 *
 * Seguro por defecto: sin `--reset` es idempotente (crea o completa lo que
 * falte sin borrar datos existentes). Con `--reset` limpia todas las
 * colecciones antes de sembrar desde cero.
 *
 * Ejecutar:
 *   npm run seed              → alta idempotente de datos de demo
 *   npm run seed -- --reset   → limpia la base y recrea todo desde cero
 */

const ADMIN_USERNAME = 'admin';
export const DEFAULT_DEMO_PASSWORD = 'demo2026';
const BCRYPT_ROUNDS = 10;

interface DemoUserSeed {
  username: string;
  role: UserRole;
  description: string;
}

export const DEMO_USERS: readonly DemoUserSeed[] = [
  {
    username: 'admin',
    role: 'admin',
    description: 'Administrador general (acceso total y backoffice)',
  },
  {
    username: 'vendedor',
    role: 'vendedor',
    description: 'Vendedor de calle principal (creación y seguimiento de pedidos)',
  },
  {
    username: 'ana.ventas',
    role: 'vendedor',
    description: 'Vendedora de calle secundaria (cartera zona norte/interior)',
  },
  {
    username: 'controlador',
    role: 'controlador',
    description: 'Operador de depósito principal (picking, ajustes y paralizados)',
  },
  {
    username: 'luis.deposito',
    role: 'controlador',
    description: 'Operador de depósito turno tarde',
  },
  {
    username: 'facturacion',
    role: 'billing',
    description: 'Facturista principal (datos estructurados y control post-factura)',
  },
  {
    username: 'carla.facturacion',
    role: 'billing',
    description: 'Facturista y control de despacho',
  },
] as const;

export const INITIAL_BRANDS = [
  { name: 'NovaFarma', codePrefix: 'NF' },
  { name: 'BioSalud', codePrefix: 'BS' },
  { name: 'DermaPlus', codePrefix: 'DP' },
  { name: 'VitaLab', codePrefix: 'VL' },
  { name: 'AlbaCare', codePrefix: 'AC' },
  { name: 'Línea General', codePrefix: 'LG' },
] as const;

interface DemoProductSeed {
  brandName: (typeof INITIAL_BRANDS)[number]['name'];
  code: string;
  name: string;
  price: number;
  imageUrl?: string;
}

export const INITIAL_PRODUCTS: readonly DemoProductSeed[] = [
  // NovaFarma (8)
  {
    brandName: 'NovaFarma',
    code: 'NF-1001',
    name: 'Ibuprofeno 400mg x 20 comprimidos',
    price: 2850,
  },
  {
    brandName: 'NovaFarma',
    code: 'NF-1002',
    name: 'Ibuprofeno 600mg Acción Rápida x 20 comprimidos',
    price: 3600,
  },
  {
    brandName: 'NovaFarma',
    code: 'NF-1003',
    name: 'Paracetamol 500mg x 30 comprimidos',
    price: 2400,
  },
  {
    brandName: 'NovaFarma',
    code: 'NF-1004',
    name: 'Paracetamol 1g Forte x 16 comprimidos',
    price: 3100,
  },
  {
    brandName: 'NovaFarma',
    code: 'NF-1005',
    name: 'Omeprazol 20mg Protector Gástrico x 30 cápsulas',
    price: 4200,
  },
  {
    brandName: 'NovaFarma',
    code: 'NF-1006',
    name: 'Loratadina 10mg Antialérgico x 10 comprimidos',
    price: 1950,
  },
  {
    brandName: 'NovaFarma',
    code: 'NF-1007',
    name: 'Jarabe Expectorante Miel y Eucalipto 120ml',
    price: 5400,
  },
  {
    brandName: 'NovaFarma',
    code: 'NF-1008',
    name: 'Sales de Rehidratación Oral Neutras x 10 sobres',
    price: 3800,
  },

  // BioSalud (7)
  {
    brandName: 'BioSalud',
    code: 'BS-2001',
    name: 'Alcohol en Gel Antibacterial Neutro 250ml',
    price: 2150,
  },
  {
    brandName: 'BioSalud',
    code: 'BS-2002',
    name: 'Alcohol en Gel Antibacterial 500ml con dosificador',
    price: 3750,
  },
  {
    brandName: 'BioSalud',
    code: 'BS-2003',
    name: 'Alcohol Etílico Medicinal 96° 500ml',
    price: 2300,
  },
  {
    brandName: 'BioSalud',
    code: 'BS-2004',
    name: 'Agua Oxigenada 10 Volúmenes 250ml',
    price: 1250,
  },
  {
    brandName: 'BioSalud',
    code: 'BS-2005',
    name: 'Gasas Estériles Hidrófilas 10x10cm Caja x 10 sobres',
    price: 2900,
  },
  {
    brandName: 'BioSalud',
    code: 'BS-2006',
    name: 'Venda Elástica de Alta Compresión 7cm x 3m',
    price: 1850,
  },
  {
    brandName: 'BioSalud',
    code: 'BS-2007',
    name: 'Cinta Hipoalergénica Microporosa 2.5cm x 9m',
    price: 2100,
  },

  // DermaPlus (7)
  {
    brandName: 'DermaPlus',
    code: 'DP-3001',
    name: 'Protector Solar FPS 50+ Toque Seco 200ml',
    price: 11800,
  },
  {
    brandName: 'DermaPlus',
    code: 'DP-3002',
    name: 'Protector Solar FPS 30 Familiar Resistente al Agua 250ml',
    price: 9400,
  },
  {
    brandName: 'DermaPlus',
    code: 'DP-3003',
    name: 'Crema Hidratante Facial Ácido Hialurónico 50g',
    price: 8900,
  },
  {
    brandName: 'DermaPlus',
    code: 'DP-3004',
    name: 'Emulsión Corporal Nutritiva Avena y Karité 400ml',
    price: 6200,
  },
  {
    brandName: 'DermaPlus',
    code: 'DP-3005',
    name: 'Agua Micelar Desmaquillante Bifásica 400ml',
    price: 5500,
  },
  {
    brandName: 'DermaPlus',
    code: 'DP-3006',
    name: 'Gel Limpiador Facial Piel Sensible Sin Sulfatos 200ml',
    price: 6100,
  },
  {
    brandName: 'DermaPlus',
    code: 'DP-3007',
    name: 'Crema Reparadora Dérmica con Pantenol 5% 40g',
    price: 4950,
  },

  // VitaLab (6)
  {
    brandName: 'VitaLab',
    code: 'VL-4001',
    name: 'Multivitamínico Diario Complejo A-Z x 30 comprimidos',
    price: 7600,
  },
  {
    brandName: 'VitaLab',
    code: 'VL-4002',
    name: 'Vitamina C 1000mg + Zinc Efervescente x 30 comprimidos',
    price: 6400,
  },
  {
    brandName: 'VitaLab',
    code: 'VL-4003',
    name: 'Magnesio Quelado 400mg Alta Absorción x 60 cápsulas',
    price: 8200,
  },
  {
    brandName: 'VitaLab',
    code: 'VL-4004',
    name: 'Colágeno Hidrolizado + Vitamina C Sabor Cítrico 300g',
    price: 12500,
  },
  {
    brandName: 'VitaLab',
    code: 'VL-4005',
    name: 'Omega 3 Aceite de Pescado Purificado 1000mg x 60 cápsulas',
    price: 10900,
  },
  {
    brandName: 'VitaLab',
    code: 'VL-4006',
    name: 'Vitamina D3 2000 UI x 30 cápsulas blandas',
    price: 5100,
  },

  // AlbaCare (6)
  {
    brandName: 'AlbaCare',
    code: 'AC-5001',
    name: 'Shampoo Neutro Hipoalergénico Uso Diario 400ml',
    price: 3400,
  },
  {
    brandName: 'AlbaCare',
    code: 'AC-5002',
    name: 'Acondicionador Nutrición Intensa con Ceramidas 400ml',
    price: 3550,
  },
  {
    brandName: 'AlbaCare',
    code: 'AC-5003',
    name: 'Jabón Líquido Corporal Glicerina Natural 500ml',
    price: 2950,
  },
  {
    brandName: 'AlbaCare',
    code: 'AC-5004',
    name: 'Desodorante Roll-On Antitranspirante 48h 50ml',
    price: 2200,
  },
  {
    brandName: 'AlbaCare',
    code: 'AC-5005',
    name: 'Pasta Dental Triple Protección con Flúor Activo 90g',
    price: 1980,
  },
  {
    brandName: 'AlbaCare',
    code: 'AC-5006',
    name: 'Enjuague Bucal Menta Fresca Sin Alcohol 500ml',
    price: 3900,
  },

  // Línea General (6)
  {
    brandName: 'Línea General',
    code: 'LG-6001',
    name: 'Termómetro Digital Clínico Punta Flexible con Alarma',
    price: 6800,
  },
  {
    brandName: 'Línea General',
    code: 'LG-6002',
    name: 'Tensiómetro Digital de Brazo Automático con Memoria',
    price: 34500,
  },
  {
    brandName: 'Línea General',
    code: 'LG-6003',
    name: 'Oxímetro de Pulso Digital Portátil Pantalla OLED',
    price: 18900,
  },
  {
    brandName: 'Línea General',
    code: 'LG-6004',
    name: 'Barbijos Quirúrgicos Tricapa Termosellados Caja x 50 u.',
    price: 4600,
  },
  {
    brandName: 'Línea General',
    code: 'LG-6005',
    name: 'Guantes de Nitrilo Descartables Talle M Caja x 100 u.',
    price: 9800,
  },
  {
    brandName: 'Línea General',
    code: 'LG-6006',
    name: 'Botiquín Primeros Auxilios Gabinete Básico 15 Elementos',
    price: 14200,
  },
] as const;

interface DemoClientSeed {
  code: string;
  name: string;
  address: string;
  localidad: string;
  province: string;
  generalDiscount: number;
  brandDiscounts: ReadonlyArray<{
    brandName: (typeof INITIAL_BRANDS)[number]['name'];
    discountPercentage: number;
  }>;
}

export const INITIAL_CLIENTS: readonly DemoClientSeed[] = [
  {
    code: 'CLI-001',
    name: 'Farmacia San Martín',
    address: 'Av. San Martín 1420',
    localidad: 'Rosario',
    province: 'Santa Fe',
    generalDiscount: 5,
    brandDiscounts: [{ brandName: 'NovaFarma', discountPercentage: 10 }],
  },
  {
    code: 'CLI-002',
    name: 'Farmacia Del Pueblo',
    address: 'Bv. Oroño 845',
    localidad: 'Rosario',
    province: 'Santa Fe',
    generalDiscount: 8,
    brandDiscounts: [{ brandName: 'DermaPlus', discountPercentage: 12 }],
  },
  {
    code: 'CLI-003',
    name: 'Perfumería y Farmacia Avenida',
    address: 'Av. Pellegrini 2310',
    localidad: 'Rosario',
    province: 'Santa Fe',
    generalDiscount: 5,
    brandDiscounts: [{ brandName: 'AlbaCare', discountPercentage: 10 }],
  },
  {
    code: 'CLI-004',
    name: 'Droguería Litoral S.R.L.',
    address: 'San Lorenzo 1180',
    localidad: 'Santa Fe',
    province: 'Santa Fe',
    generalDiscount: 12,
    brandDiscounts: [
      { brandName: 'NovaFarma', discountPercentage: 15 },
      { brandName: 'BioSalud', discountPercentage: 15 },
    ],
  },
  {
    code: 'CLI-005',
    name: 'Farmacia Central Córdoba',
    address: 'Av. Colón 1560',
    localidad: 'Córdoba',
    province: 'Córdoba',
    generalDiscount: 6,
    brandDiscounts: [{ brandName: 'VitaLab', discountPercentage: 10 }],
  },
  {
    code: 'CLI-006',
    name: 'Autoservicio Mayorista El Sol',
    address: 'Ruta 9 Km 312',
    localidad: 'Roldán',
    province: 'Santa Fe',
    generalDiscount: 10,
    brandDiscounts: [{ brandName: 'AlbaCare', discountPercentage: 12 }],
  },
  {
    code: 'CLI-007',
    name: 'Farmacia Belgrano Salud',
    address: 'Av. Belgrano 640',
    localidad: 'Venado Tuerto',
    province: 'Santa Fe',
    generalDiscount: 5,
    brandDiscounts: [{ brandName: 'BioSalud', discountPercentage: 8 }],
  },
  {
    code: 'CLI-008',
    name: 'Centro Médico y Farmacia Mitre',
    address: 'Mitre 915',
    localidad: 'San Nicolás',
    province: 'Buenos Aires',
    generalDiscount: 7,
    brandDiscounts: [{ brandName: 'Línea General', discountPercentage: 10 }],
  },
  {
    code: 'CLI-009',
    name: 'Farmacia Nueva Esperanza',
    address: 'Urquiza 1740',
    localidad: 'Paraná',
    province: 'Entre Ríos',
    generalDiscount: 5,
    brandDiscounts: [{ brandName: 'DermaPlus', discountPercentage: 10 }],
  },
  {
    code: 'CLI-010',
    name: 'Distribuidora Sur Salud',
    address: 'Av. Savio 410',
    localidad: 'San Nicolás',
    province: 'Buenos Aires',
    generalDiscount: 10,
    brandDiscounts: [{ brandName: 'NovaFarma', discountPercentage: 12 }],
  },
  {
    code: 'CLI-011',
    name: 'Farmacia Santa Fe Norte',
    address: 'Av. Aristóbulo del Valle 4200',
    localidad: 'Santa Fe',
    province: 'Santa Fe',
    generalDiscount: 4,
    brandDiscounts: [{ brandName: 'VitaLab', discountPercentage: 8 }],
  },
  {
    code: 'CLI-012',
    name: 'Perfumería Brillos & Cuidado',
    address: 'Peatonal Córdoba 1290',
    localidad: 'Rosario',
    province: 'Santa Fe',
    generalDiscount: 6,
    brandDiscounts: [
      { brandName: 'DermaPlus', discountPercentage: 15 },
      { brandName: 'AlbaCare', discountPercentage: 10 },
    ],
  },
  {
    code: 'CLI-013',
    name: 'Clínica y Maternidad del Parque',
    address: 'Bv. Argentino 1520',
    localidad: 'Casilda',
    province: 'Santa Fe',
    generalDiscount: 8,
    brandDiscounts: [
      { brandName: 'BioSalud', discountPercentage: 12 },
      { brandName: 'Línea General', discountPercentage: 12 },
    ],
  },
  {
    code: 'CLI-014',
    name: 'Farmacia Los Álamos',
    address: 'Av. Libertad 780',
    localidad: 'Villa Gobernador Gálvez',
    province: 'Santa Fe',
    generalDiscount: 5,
    brandDiscounts: [],
  },
  {
    code: 'CLI-015',
    name: 'Supermercado y Farmacia Norte',
    address: 'Av. Alberdi 950',
    localidad: 'Rosario',
    province: 'Santa Fe',
    generalDiscount: 7,
    brandDiscounts: [{ brandName: 'NovaFarma', discountPercentage: 10 }],
  },
] as const;

interface DemoOrderLineSeed {
  productCode: string;
  requestedQuantity: number;
  verifiedQuantity: number;
  isPending?: boolean;
  pendingReason?: string;
  postControl?: PostControl;
}

interface DemoOrderSeed {
  clientRequestId: string;
  clientCode: string;
  createdBy: 'vendedor' | 'ana.ventas';
  status: OrderStatus;
  invoiceType: InvoiceType;
  paymentCondition: PaymentCondition;
  paymentConditionDetail?: string;
  hoursAgo: number;
  lines: readonly DemoOrderLineSeed[];
  comments: ReadonlyArray<{
    author: string;
    role: UserRole;
    text: string;
    minutesAfterCreation?: number;
  }>;
}

export const INITIAL_ORDERS: readonly DemoOrderSeed[] = [
  // 1-3: BORRADOR (3 pedidos)
  {
    clientRequestId: 'demo-seed-order-01',
    clientCode: 'CLI-001',
    createdBy: 'vendedor',
    status: 'borrador',
    invoiceType: 'A',
    paymentCondition: 'cuenta_corriente',
    hoursAgo: 1,
    lines: [
      { productCode: 'NF-1001', requestedQuantity: 10, verifiedQuantity: 0 },
      { productCode: 'NF-1003', requestedQuantity: 8, verifiedQuantity: 0 },
      { productCode: 'BS-2002', requestedQuantity: 6, verifiedQuantity: 0 },
      { productCode: 'AC-5001', requestedQuantity: 4, verifiedQuantity: 0 },
    ],
    comments: [
      {
        author: 'vendedor',
        role: 'vendedor',
        text: 'Entregar por la mañana antes de las 12 hs en recepción de depósito.',
      },
    ],
  },
  {
    clientRequestId: 'demo-seed-order-02',
    clientCode: 'CLI-003',
    createdBy: 'vendedor',
    status: 'borrador',
    invoiceType: 'A',
    paymentCondition: 'contado',
    hoursAgo: 2,
    lines: [
      { productCode: 'DP-3001', requestedQuantity: 5, verifiedQuantity: 0 },
      { productCode: 'DP-3005', requestedQuantity: 6, verifiedQuantity: 0 },
      { productCode: 'AC-5003', requestedQuantity: 10, verifiedQuantity: 0 },
    ],
    comments: [],
  },
  {
    clientRequestId: 'demo-seed-order-03',
    clientCode: 'CLI-005',
    createdBy: 'ana.ventas',
    status: 'borrador',
    invoiceType: 'B',
    paymentCondition: 'otro',
    paymentConditionDetail: 'Transferencia bancaria al despachar',
    hoursAgo: 3,
    lines: [
      { productCode: 'VL-4001', requestedQuantity: 6, verifiedQuantity: 0 },
      { productCode: 'VL-4002', requestedQuantity: 8, verifiedQuantity: 0 },
      { productCode: 'VL-4004', requestedQuantity: 3, verifiedQuantity: 0 },
    ],
    comments: [
      {
        author: 'ana.ventas',
        role: 'vendedor',
        text: 'Cliente solicita envío de comprobante por WhatsApp al despachar.',
      },
    ],
  },

  // 4-5: PARALIZADO (2 pedidos)
  {
    clientRequestId: 'demo-seed-order-04',
    clientCode: 'CLI-002',
    createdBy: 'vendedor',
    status: 'paralizado',
    invoiceType: 'A',
    paymentCondition: 'cuenta_corriente',
    hoursAgo: 5,
    lines: [
      { productCode: 'DP-3003', requestedQuantity: 6, verifiedQuantity: 6 },
      {
        productCode: 'DP-3004',
        requestedQuantity: 8,
        verifiedQuantity: 4,
        isPending: true,
        pendingReason: 'Faltante: 4 de 8 controlados',
      },
      {
        productCode: 'LG-6001',
        requestedQuantity: 5,
        verifiedQuantity: 0,
        isPending: true,
        pendingReason: 'Sin stock en depósito — ingresa reposición mañana',
      },
    ],
    comments: [
      {
        author: 'controlador',
        role: 'controlador',
        text: 'Faltan 4 unidades de DP-3004 y sin stock de termómetro LG-6001. Se paraliza a la espera de confirmación.',
        minutesAfterCreation: 25,
      },
      {
        author: 'vendedor',
        role: 'vendedor',
        text: 'Hablé con la farmacia: esperan a mañana para despachar el pedido completo.',
        minutesAfterCreation: 45,
      },
    ],
  },
  {
    clientRequestId: 'demo-seed-order-05',
    clientCode: 'CLI-007',
    createdBy: 'ana.ventas',
    status: 'paralizado',
    invoiceType: 'A',
    paymentCondition: 'otro',
    paymentConditionDetail: 'Cheque a 30 días',
    hoursAgo: 8,
    lines: [
      { productCode: 'BS-2001', requestedQuantity: 12, verifiedQuantity: 12 },
      { productCode: 'BS-2005', requestedQuantity: 10, verifiedQuantity: 10 },
      {
        productCode: 'NF-1007',
        requestedQuantity: 6,
        verifiedQuantity: 2,
        isPending: true,
        pendingReason: 'Faltante: 2 de 6 controlados',
      },
    ],
    comments: [
      {
        author: 'luis.deposito',
        role: 'controlador',
        text: 'Sólo quedan 2 unidades del lote actual de Jarabe NF-1007.',
        minutesAfterCreation: 30,
      },
    ],
  },

  // 6-8: FACTURACION (3 pedidos)
  {
    clientRequestId: 'demo-seed-order-06',
    clientCode: 'CLI-004',
    createdBy: 'vendedor',
    status: 'facturacion',
    invoiceType: 'A',
    paymentCondition: 'cuenta_corriente',
    hoursAgo: 10,
    lines: [
      { productCode: 'NF-1002', requestedQuantity: 15, verifiedQuantity: 15 },
      { productCode: 'NF-1005', requestedQuantity: 10, verifiedQuantity: 10 },
      { productCode: 'BS-2003', requestedQuantity: 12, verifiedQuantity: 12 },
      { productCode: 'LG-6004', requestedQuantity: 6, verifiedQuantity: 6 },
    ],
    comments: [
      {
        author: 'controlador',
        role: 'controlador',
        text: 'Control completo en depósito. 4 bultos cerrados y rotulados en sector A-2.',
        minutesAfterCreation: 20,
      },
    ],
  },
  {
    clientRequestId: 'demo-seed-order-07',
    clientCode: 'CLI-006',
    createdBy: 'vendedor',
    status: 'facturacion',
    invoiceType: 'A',
    paymentCondition: 'otro',
    paymentConditionDetail: 'Transferencia bancaria al despachar',
    hoursAgo: 14,
    lines: [
      { productCode: 'AC-5001', requestedQuantity: 12, verifiedQuantity: 12 },
      { productCode: 'AC-5002', requestedQuantity: 12, verifiedQuantity: 12 },
      { productCode: 'AC-5005', requestedQuantity: 20, verifiedQuantity: 20 },
      { productCode: 'AC-5006', requestedQuantity: 8, verifiedQuantity: 8 },
    ],
    comments: [
      {
        author: 'luis.deposito',
        role: 'controlador',
        text: 'Mercadería verificada al 100 %, lista para emitir factura.',
        minutesAfterCreation: 35,
      },
    ],
  },
  {
    clientRequestId: 'demo-seed-order-08',
    clientCode: 'CLI-012',
    createdBy: 'ana.ventas',
    status: 'facturacion',
    invoiceType: 'B',
    paymentCondition: 'contado',
    hoursAgo: 18,
    lines: [
      { productCode: 'DP-3001', requestedQuantity: 4, verifiedQuantity: 4 },
      { productCode: 'DP-3002', requestedQuantity: 4, verifiedQuantity: 4 },
      { productCode: 'DP-3006', requestedQuantity: 6, verifiedQuantity: 6 },
    ],
    comments: [],
  },

  // 9-10: CONTROL POST-FACTURA (2 pedidos)
  {
    clientRequestId: 'demo-seed-order-09',
    clientCode: 'CLI-008',
    createdBy: 'vendedor',
    status: 'control_post_factura',
    invoiceType: 'A',
    paymentCondition: 'cuenta_corriente',
    hoursAgo: 22,
    lines: [
      {
        productCode: 'LG-6002',
        requestedQuantity: 2,
        verifiedQuantity: 2,
        postControl: 'ok',
      },
      {
        productCode: 'LG-6003',
        requestedQuantity: 3,
        verifiedQuantity: 3,
        postControl: 'ok',
      },
      {
        productCode: 'LG-6005',
        requestedQuantity: 5,
        verifiedQuantity: 5,
        postControl: 'ok',
      },
    ],
    comments: [
      {
        author: 'facturacion',
        role: 'billing',
        text: 'Factura A N° 0004-00018492 emitida. Todas las líneas punteadas sobre el duplicado, listo para despacho.',
        minutesAfterCreation: 50,
      },
    ],
  },
  {
    clientRequestId: 'demo-seed-order-10',
    clientCode: 'CLI-010',
    createdBy: 'ana.ventas',
    status: 'control_post_factura',
    invoiceType: 'A',
    paymentCondition: 'otro',
    paymentConditionDetail: 'Cuenta corriente a 30 días con transferencia',
    hoursAgo: 26,
    lines: [
      {
        productCode: 'NF-1001',
        requestedQuantity: 15,
        verifiedQuantity: 15,
        postControl: 'ok',
      },
      {
        productCode: 'NF-1004',
        requestedQuantity: 10,
        verifiedQuantity: 10,
        postControl: 'ok',
      },
      {
        productCode: 'VL-4003',
        requestedQuantity: 4,
        verifiedQuantity: 4,
        postControl: 'pendiente',
      },
    ],
    comments: [
      {
        author: 'carla.facturacion',
        role: 'billing',
        text: 'Verificando duplicado en mostrador de expedición (resta puntear línea VL-4003).',
        minutesAfterCreation: 40,
      },
    ],
  },

  // 11-12: ENTREGADO (2 pedidos)
  {
    clientRequestId: 'demo-seed-order-11',
    clientCode: 'CLI-013',
    createdBy: 'vendedor',
    status: 'entregado',
    invoiceType: 'A',
    paymentCondition: 'cuenta_corriente',
    hoursAgo: 36,
    lines: [
      {
        productCode: 'BS-2002',
        requestedQuantity: 10,
        verifiedQuantity: 10,
        postControl: 'ok',
      },
      {
        productCode: 'BS-2005',
        requestedQuantity: 15,
        verifiedQuantity: 15,
        postControl: 'ok',
      },
      {
        productCode: 'LG-6004',
        requestedQuantity: 8,
        verifiedQuantity: 8,
        postControl: 'ok',
      },
      {
        productCode: 'LG-6006',
        requestedQuantity: 2,
        verifiedQuantity: 2,
        postControl: 'ok',
      },
    ],
    comments: [
      {
        author: 'controlador',
        role: 'controlador',
        text: 'Preparado sin faltantes.',
        minutesAfterCreation: 20,
      },
      {
        author: 'facturacion',
        role: 'billing',
        text: 'Control post-factura completado y despachado con reparto zona sur.',
        minutesAfterCreation: 90,
      },
    ],
  },
  {
    clientRequestId: 'demo-seed-order-12',
    clientCode: 'CLI-015',
    createdBy: 'ana.ventas',
    status: 'entregado',
    invoiceType: 'A',
    paymentCondition: 'contado',
    hoursAgo: 48,
    lines: [
      {
        productCode: 'NF-1006',
        requestedQuantity: 12,
        verifiedQuantity: 12,
        postControl: 'ok',
      },
      {
        productCode: 'NF-1008',
        requestedQuantity: 6,
        verifiedQuantity: 6,
        postControl: 'ok',
      },
      {
        productCode: 'DP-3007',
        requestedQuantity: 5,
        verifiedQuantity: 5,
        postControl: 'ok',
      },
    ],
    comments: [
      {
        author: 'carla.facturacion',
        role: 'billing',
        text: 'Entregado y remito conformado por encargado de sucursal.',
        minutesAfterCreation: 110,
      },
    ],
  },
] as const;

const args = process.argv.slice(2);
const shouldReset = args.includes('--reset');
const unknownArgs = args.filter((arg) => arg !== '--reset');

function resolveAdminPassword(): string {
  const password = process.env.SEED_ADMIN_PASSWORD?.trim();
  if (password) {
    return password;
  }

  console.log(
    `ℹ️  SEED_ADMIN_PASSWORD no está definida: se usará la contraseña de demo ("${DEFAULT_DEMO_PASSWORD}").`,
  );
  return DEFAULT_DEMO_PASSWORD;
}

/**
 * Lee y valida SEED_USERS antes de tocar la base. Si hay errores, el seed
 * aborta sin escribir nada. Los mensajes del parser nunca incluyen contraseñas.
 */
function resolveSeedUsers(): SeedUser[] {
  const { users, errors } = parseSeedUsers(process.env.SEED_USERS);

  if (errors.length > 0) {
    throw new Error(
      'SEED_USERS contiene errores; no se modificó ningún dato:\n' +
        errors.map((error) => `  - ${error}`).join('\n'),
    );
  }

  if (users.some((user) => user.username.toLowerCase() === ADMIN_USERNAME)) {
    throw new Error(
      `SEED_USERS no puede incluir el usuario reservado "${ADMIN_USERNAME}"; ` +
        'ese usuario se administra con SEED_ADMIN_PASSWORD.',
    );
  }

  return users;
}

async function resetCollections(): Promise<void> {
  console.warn(
    '⚠️  --reset: se eliminarán TODOS los pedidos, notificaciones, productos, clientes, marcas y usuarios.',
  );
  const [orders, notifications, reads, products, clients, brands, users] = await Promise.all([
    Order.deleteMany({}),
    Notification.deleteMany({}),
    NotificationRead.deleteMany({}),
    Product.deleteMany({}),
    Client.deleteMany({}),
    Brand.deleteMany({}),
    User.deleteMany({}),
  ]);
  console.log(
    `Datos eliminados: ${orders.deletedCount} pedidos, ${notifications.deletedCount} notificaciones, ` +
      `${reads.deletedCount} lecturas, ${products.deletedCount} productos, ${clients.deletedCount} clientes, ` +
      `${brands.deletedCount} marcas, ${users.deletedCount} usuarios.`,
  );
}

/**
 * Migración del rol legado `deposit` al rol canónico `controlador`.
 */
async function migrateLegacyDepositRole(): Promise<void> {
  const result = await User.updateMany({ role: 'deposit' } as Record<string, unknown>, {
    $set: { role: 'controlador' },
  });
  const migrated = result.modifiedCount ?? 0;

  if (migrated > 0) {
    console.log(`Usuarios migrados de deposit a controlador: ${migrated}.`);
  }
}

/**
 * Rellena los campos de sesión agregados después del alta histórica:
 * `active` (default true), `sessionVersion` (0) y `lastLoginAt` (null).
 */
async function migrateUserSessionFields(): Promise<void> {
  const [activeResult, versionResult, lastLoginResult] = await Promise.all([
    User.updateMany({ active: { $exists: false } }, { $set: { active: true } }),
    User.updateMany({ sessionVersion: { $exists: false } }, { $set: { sessionVersion: 0 } }),
    User.updateMany({ lastLoginAt: { $exists: false } }, { $set: { lastLoginAt: null } }),
  ]);

  const migrated =
    (activeResult.modifiedCount ?? 0) +
    (versionResult.modifiedCount ?? 0) +
    (lastLoginResult.modifiedCount ?? 0);

  if (migrated > 0) {
    console.log(`Campos de sesión completados en usuarios históricos: ${migrated} cambios.`);
  }
}

async function seedDemoUsers(adminPassword: string): Promise<Map<string, IUser>> {
  console.log('Creando/verificando usuarios de demostración por rol...');
  const demoPasswordHash = await bcrypt.hash(DEFAULT_DEMO_PASSWORD, BCRYPT_ROUNDS);
  const adminPasswordHash =
    adminPassword === DEFAULT_DEMO_PASSWORD
      ? demoPasswordHash
      : await bcrypt.hash(adminPassword, BCRYPT_ROUNDS);

  const usersByUsername = new Map<string, IUser>();
  let created = 0;
  let updated = 0;

  for (const demoUser of DEMO_USERS) {
    let user = await User.findOne({ username: demoUser.username });

    if (user) {
      if (user.role !== demoUser.role) {
        user.role = demoUser.role;
        await user.save();
        updated++;
      }
      usersByUsername.set(user.username, user);
      continue;
    }

    user = await User.create({
      username: demoUser.username,
      passwordHash: demoUser.username === ADMIN_USERNAME ? adminPasswordHash : demoPasswordHash,
      role: demoUser.role,
      active: true,
      lastLoginAt: null,
      sessionVersion: 0,
      notificationsEnabled: true,
    });
    created++;
    usersByUsername.set(user.username, user);
  }

  console.log(
    `Usuarios de demo: ${created} creados, ${updated} roles actualizados, ` +
      `${DEMO_USERS.length - created - updated} ya existían.`,
  );
  return usersByUsername;
}

async function seedManagedUsers(
  users: SeedUser[],
  usersByUsername: Map<string, IUser>,
): Promise<void> {
  if (users.length === 0) {
    return;
  }

  console.log(`Procesando ${users.length} usuario(s) adicionales de SEED_USERS...`);
  let created = 0;
  let rolesUpdated = 0;

  for (const seedUser of users) {
    const existing = await User.findOne({ username: seedUser.username });

    if (existing) {
      if (existing.role !== seedUser.role) {
        existing.role = seedUser.role;
        await existing.save();
        rolesUpdated++;
      }
      usersByUsername.set(existing.username, existing);
      continue;
    }

    const passwordHash = await bcrypt.hash(seedUser.password, BCRYPT_ROUNDS);
    const createdUser = await User.create({
      username: seedUser.username,
      passwordHash,
      role: seedUser.role,
      active: true,
      lastLoginAt: null,
      sessionVersion: 0,
      notificationsEnabled: true,
    });
    created++;
    usersByUsername.set(createdUser.username, createdUser);
  }

  console.log(`Usuarios de SEED_USERS: ${created} creados, ${rolesUpdated} roles actualizados.`);
}

async function seedBrands(): Promise<Map<string, IBrand>> {
  console.log('Sembrando marcas del catálogo...');
  const brandsByName = new Map<string, IBrand>();
  let created = 0;

  for (const item of INITIAL_BRANDS) {
    const result = await Brand.updateOne(
      { name: item.name },
      {
        $set: {
          name: item.name,
          codePrefix: item.codePrefix,
        },
      },
      { upsert: true },
    );

    if (result.upsertedCount > 0) {
      created++;
    }

    const doc = await Brand.findOne({ name: item.name });
    if (doc) {
      brandsByName.set(item.name, doc);
    }
  }

  console.log(
    `Marcas: ${created} creadas, ${INITIAL_BRANDS.length - created} ya existían (total: ${brandsByName.size}).`,
  );
  return brandsByName;
}

async function seedProducts(brandsByName: Map<string, IBrand>): Promise<Map<string, IProduct>> {
  console.log('Sembrando catálogo de productos...');
  const productsByCode = new Map<string, IProduct>();
  let created = 0;

  for (const item of INITIAL_PRODUCTS) {
    const brand = brandsByName.get(item.brandName);
    if (!brand) {
      throw new Error(`Marca no encontrada al sembrar producto ${item.code}: ${item.brandName}`);
    }

    const priceWithIva = roundCurrency(item.price * 1.21);
    const searchFields = buildProductSearchFields({
      code: item.code,
      name: item.name,
      brandName: brand.name,
    });

    const result = await Product.updateOne(
      { brandId: brand._id, code: item.code },
      {
        $setOnInsert: {
          brandId: brand._id,
          imageUrl: item.imageUrl ?? '/icons/icon-192.png',
          active: true,
        },
        $set: {
          code: item.code,
          name: item.name,
          price: item.price,
          priceWithIva,
          ...searchFields,
        },
      },
      { upsert: true },
    );

    if (result.upsertedCount > 0) {
      created++;
    }

    const doc = await Product.findOne({ brandId: brand._id, code: item.code });
    if (doc) {
      productsByCode.set(item.code, doc);
    }
  }

  console.log(
    `Productos: ${created} creados, ${INITIAL_PRODUCTS.length - created} actualizados (total: ${productsByCode.size}).`,
  );
  return productsByCode;
}

async function seedClients(brandsByName: Map<string, IBrand>): Promise<Map<string, IClient>> {
  console.log('Sembrando cartera de clientes...');
  const clientsByCode = new Map<string, IClient>();
  let created = 0;

  for (const item of INITIAL_CLIENTS) {
    const brandDiscounts = item.brandDiscounts
      .map((entry) => {
        const brand = brandsByName.get(entry.brandName);
        return brand
          ? {
              brandId: brand._id as mongoose.Types.ObjectId,
              discountPercentage: entry.discountPercentage,
            }
          : null;
      })
      .filter((entry): entry is { brandId: mongoose.Types.ObjectId; discountPercentage: number } =>
        Boolean(entry),
      );

    const result = await Client.updateOne(
      { code: item.code },
      {
        $set: {
          code: item.code,
          name: item.name,
          address: item.address,
          localidad: item.localidad,
          province: item.province,
          generalDiscount: item.generalDiscount,
          brandDiscounts,
        },
      },
      { upsert: true },
    );

    if (result.upsertedCount > 0) {
      created++;
    }

    const doc = await Client.findOne({ code: item.code });
    if (doc) {
      clientsByCode.set(item.code, doc);
    }
  }

  console.log(
    `Clientes: ${created} creados, ${INITIAL_CLIENTS.length - created} actualizados (total: ${clientsByCode.size}).`,
  );
  return clientsByCode;
}

function resolveDiscountForClientAndBrand(
  client: IClient,
  brandId: mongoose.Types.ObjectId,
): number {
  const brandMatch = client.brandDiscounts.find(
    (entry) => String(entry.brandId) === String(brandId),
  );
  return brandMatch ? brandMatch.discountPercentage : client.generalDiscount;
}

async function seedOrders(
  usersByUsername: Map<string, IUser>,
  brandsByName: Map<string, IBrand>,
  productsByCode: Map<string, IProduct>,
  clientsByCode: Map<string, IClient>,
): Promise<Map<string, mongoose.Types.ObjectId>> {
  console.log('Sembrando pedidos en todos los estados del flujo...');
  const brandNameById = new Map<string, string>();
  for (const [name, brand] of brandsByName.entries()) {
    brandNameById.set(String(brand._id), name);
  }

  const orderIdsByRequestId = new Map<string, mongoose.Types.ObjectId>();
  const now = Date.now();
  let created = 0;

  for (const seedOrder of INITIAL_ORDERS) {
    const seller = usersByUsername.get(seedOrder.createdBy);
    const client = clientsByCode.get(seedOrder.clientCode);

    if (!seller || !client) {
      throw new Error(
        `Datos faltantes para el pedido ${seedOrder.clientRequestId}: seller=${seedOrder.createdBy}, client=${seedOrder.clientCode}`,
      );
    }

    const existing = await Order.findOne({
      createdById: seller._id,
      clientRequestId: seedOrder.clientRequestId,
    }).select('_id');

    if (existing) {
      orderIdsByRequestId.set(seedOrder.clientRequestId, existing._id as mongoose.Types.ObjectId);
      continue;
    }

    const isDraft = seedOrder.status === 'borrador';
    let subtotal = 0;
    let totalDiscount = 0;

    const items: IOrderItem[] = seedOrder.lines.map((line) => {
      const product = productsByCode.get(line.productCode);
      if (!product) {
        throw new Error(`Producto no encontrado en seed de pedidos: ${line.productCode}`);
      }

      const brandName = brandNameById.get(String(product.brandId)) ?? 'Sin marca';
      const itemDiscount = resolveDiscountForClientAndBrand(client, product.brandId);
      const effectiveQty = isDraft ? line.requestedQuantity : line.verifiedQuantity;
      const gross = roundCurrency(product.price * effectiveQty);
      const discountAmount = roundCurrency((gross * itemDiscount) / 100);
      const lineTotal = roundCurrency(gross - discountAmount);

      subtotal = roundCurrency(subtotal + gross);
      totalDiscount = roundCurrency(totalDiscount + discountAmount);

      return {
        productId: product._id as mongoose.Types.ObjectId,
        productCode: product.code,
        productName: product.name,
        brandName,
        unitPrice: product.price,
        requestedQuantity: line.requestedQuantity,
        verifiedQuantity: line.verifiedQuantity,
        isPending: Boolean(line.isPending),
        ...(line.pendingReason ? { pendingReason: line.pendingReason } : {}),
        postControl: line.postControl ?? 'pendiente',
        itemDiscount,
        lineTotal,
      };
    });

    const finalTotal = roundCurrency(subtotal - totalDiscount);
    const createdAt = new Date(now - seedOrder.hoursAgo * 60 * 60 * 1000);
    const updatedAt = new Date(createdAt.getTime() + 15 * 60 * 1000);
    const orderId = new mongoose.Types.ObjectId();
    const shortId = orderShortId(orderId);
    const searchFields = buildOrderSearchFields({
      clientName: client.name,
      clientCode: client.code,
      createdBy: seller.username,
      shortId,
      items,
    });

    const comments = seedOrder.comments.map((comment) => ({
      text: comment.text,
      author: comment.author,
      role: comment.role,
      createdAt: new Date(createdAt.getTime() + (comment.minutesAfterCreation ?? 5) * 60 * 1000),
    }));

    await Order.collection.insertOne({
      _id: orderId,
      clientId: client._id,
      clientName: client.name,
      clientCode: client.code,
      shortId,
      searchTokens: searchFields.searchTokens,
      status: seedOrder.status,
      items,
      subtotal,
      totalDiscount,
      finalTotal,
      createdBy: seller.username,
      createdById: seller._id,
      clientRequestId: seedOrder.clientRequestId,
      comments,
      archived: false,
      invoiceType: seedOrder.invoiceType,
      paymentCondition: seedOrder.paymentCondition,
      ...(seedOrder.paymentConditionDetail
        ? { paymentConditionDetail: seedOrder.paymentConditionDetail }
        : {}),
      version: isDraft ? 0 : 1,
      createdAt,
      updatedAt,
    });

    created++;
    orderIdsByRequestId.set(seedOrder.clientRequestId, orderId);
  }

  console.log(
    `Pedidos: ${created} creados, ${INITIAL_ORDERS.length - created} ya existían (total: ${orderIdsByRequestId.size}).`,
  );
  return orderIdsByRequestId;
}

async function seedNotifications(
  usersByUsername: Map<string, IUser>,
  orderIdsByRequestId: Map<string, mongoose.Types.ObjectId>,
): Promise<void> {
  console.log('Sembrando notificaciones de muestra...');
  const vendedor = usersByUsername.get('vendedor');
  const ana = usersByUsername.get('ana.ventas');
  const controlador = usersByUsername.get('controlador');

  const now = Date.now();
  const samples = [
    {
      title: 'Nuevo Pedido (Borrador)',
      message:
        'El vendedor vendedor creó un pedido para Farmacia San Martín (CLI-001) listo para preparación en depósito.',
      targetRole: 'deposit' as const,
      orderId: orderIdsByRequestId.get('demo-seed-order-01'),
      createdAt: new Date(now - 55 * 60 * 1000),
      markReadFor: [] as IUser[],
    },
    {
      title: 'Nuevo Pedido (Borrador)',
      message: 'El vendedor vendedor creó un pedido para Perfumería y Farmacia Avenida (CLI-003).',
      targetRole: 'deposit' as const,
      orderId: orderIdsByRequestId.get('demo-seed-order-02'),
      createdAt: new Date(now - 115 * 60 * 1000),
      markReadFor: controlador ? [controlador] : [],
    },
    {
      title: 'Nuevo comentario en pedido',
      message:
        'El vendedor vendedor comentó el pedido de Farmacia Del Pueblo: Hablé con la farmacia: esperan a mañana para despachar el pedido completo.',
      targetRole: 'deposit' as const,
      orderId: orderIdsByRequestId.get('demo-seed-order-04'),
      createdAt: new Date(now - 4 * 60 * 60 * 1000),
      markReadFor: [] as IUser[],
    },
    {
      title: 'Pedido Paralizado en Depósito',
      message:
        'El pedido de Farmacia Del Pueblo quedó paralizado en depósito: Faltante: 4 de 8 controlados.',
      targetRole: 'vendor' as const,
      targetUserId: vendedor?._id as mongoose.Types.ObjectId | undefined,
      targetUsername: 'vendedor',
      orderId: orderIdsByRequestId.get('demo-seed-order-04'),
      createdAt: new Date(now - 4.5 * 60 * 60 * 1000),
      markReadFor: [] as IUser[],
    },
    {
      title: 'Pedido Paralizado en Depósito',
      message:
        'El pedido de Farmacia Belgrano Salud quedó paralizado en depósito: Sólo quedan 2 unidades del lote actual de Jarabe NF-1007.',
      targetRole: 'vendor' as const,
      targetUserId: ana?._id as mongoose.Types.ObjectId | undefined,
      targetUsername: 'ana.ventas',
      orderId: orderIdsByRequestId.get('demo-seed-order-05'),
      createdAt: new Date(now - 7.5 * 60 * 60 * 1000),
      markReadFor: [] as IUser[],
    },
    {
      title: 'Pedido Listo para Facturar',
      message:
        'El pedido de Droguería Litoral S.R.L. ha sido verificado en depósito y está listo para facturar.',
      targetRole: 'billing' as const,
      orderId: orderIdsByRequestId.get('demo-seed-order-06'),
      createdAt: new Date(now - 9 * 60 * 60 * 1000),
      markReadFor: [] as IUser[],
    },
    {
      title: 'Pedido Listo para Facturar',
      message:
        'El pedido de Autoservicio Mayorista El Sol ha sido verificado en depósito y está listo para facturar.',
      targetRole: 'billing' as const,
      orderId: orderIdsByRequestId.get('demo-seed-order-07'),
      createdAt: new Date(now - 13 * 60 * 60 * 1000),
      markReadFor: [] as IUser[],
    },
    {
      title: 'Pedido Entregado',
      message: 'El pedido de Clínica y Maternidad del Parque fue entregado.',
      targetRole: 'vendor' as const,
      targetUserId: vendedor?._id as mongoose.Types.ObjectId | undefined,
      targetUsername: 'vendedor',
      orderId: orderIdsByRequestId.get('demo-seed-order-11'),
      createdAt: new Date(now - 34 * 60 * 60 * 1000),
      markReadFor: vendedor ? [vendedor] : [],
    },
  ];

  let created = 0;

  for (const sample of samples) {
    const existing = await Notification.findOne({
      title: sample.title,
      message: sample.message,
      targetRole: sample.targetRole,
    });

    const notification =
      existing ??
      (await Notification.create({
        title: sample.title,
        message: sample.message,
        targetRole: sample.targetRole,
        ...(sample.targetUserId ? { targetUserId: sample.targetUserId } : {}),
        ...(sample.targetUsername ? { targetUsername: sample.targetUsername } : {}),
        ...(sample.orderId ? { orderId: sample.orderId } : {}),
        createdAt: sample.createdAt,
      }));

    if (!existing) {
      created++;
    }

    for (const reader of sample.markReadFor) {
      await NotificationRead.updateOne(
        { userId: reader._id, notificationId: notification._id },
        {
          $setOnInsert: {
            userId: reader._id,
            notificationId: notification._id,
            readAt: new Date(),
          },
        },
        { upsert: true },
      );
    }
  }

  console.log(
    `Notificaciones: ${created} creadas, ${samples.length - created} ya existían (total: ${samples.length}).`,
  );
}

async function seed() {
  try {
    const managedUsers = resolveSeedUsers();
    const adminPassword = resolveAdminPassword();

    if (unknownArgs.length > 0) {
      console.warn(
        `Argumentos desconocidos ignorados: ${unknownArgs.join(', ')}. Sólo se admite --reset.`,
      );
    }

    console.log('Conectando a MongoDB...');
    await dbConnect();
    console.log('¡Conectado exitosamente!');

    if (shouldReset) {
      await resetCollections();
    } else {
      console.log(
        'Modo seguro (sin --reset): se agregan o actualizan los datos de demo sin borrar.',
      );
      console.log('Para limpiar toda la base y recrear desde cero: npm run seed -- --reset');
    }

    await migrateLegacyDepositRole();
    await migrateUserSessionFields();

    const usersByUsername = await seedDemoUsers(adminPassword);
    await seedManagedUsers(managedUsers, usersByUsername);

    const brandsByName = await seedBrands();
    const productsByCode = await seedProducts(brandsByName);
    const clientsByCode = await seedClients(brandsByName);
    const orderIdsByRequestId = await seedOrders(
      usersByUsername,
      brandsByName,
      productsByCode,
      clientsByCode,
    );
    await seedNotifications(usersByUsername, orderIdsByRequestId);

    console.log('\n✅ ¡Seed del Sistema de Gestión de Inventario completado exitosamente!');
    console.log('   Usuarios de demo disponibles (contraseña por defecto: "demo2026"):');
    for (const user of DEMO_USERS) {
      console.log(`   - ${user.username.padEnd(18)} [${user.role}] — ${user.description}`);
    }
    process.exit(0);
  } catch (error) {
    console.error('Error durante el seed:', error);
    process.exit(1);
  }
}

seed();
