import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { Brand } from '../models/Brand';
import { Client } from '../models/Client';
import { Notification } from '../models/Notification';
import { NotificationRead } from '../models/NotificationRead';
import { Order } from '../models/Order';
import { Product } from '../models/Product';
import { User } from '../models/User';
import {
  E2E_BRAND,
  E2E_CLIENTS,
  E2E_DASHBOARD_ADMIN_ORDER,
  E2E_DASHBOARD_SELLER_ORDERS,
  E2E_OFFLINE_CATALOG,
  E2E_PASSWORD,
  E2E_PRODUCTS,
  E2E_SECONDARY_BRAND,
  E2E_USERS,
} from '../e2e/fixtures';

/**
 * Seed exclusivo de la base de prueba E2E.
 *
 * Limpia las colecciones que usan los tests y recrea usuarios por rol, marcas,
 * productos y clientes deterministas. Nunca se ejecuta contra una base cuyo
 * nombre no contenga "e2e" o "test".
 *
 * Lo usa `e2e/global-setup.ts` antes de cada corrida de Playwright. También se
 * puede ejecutar a mano contra un Mongo de prueba ya levantado:
 *
 *   E2E_MONGODB_URI=mongodb://127.0.0.1:27019/sgi-e2e npm run seed:e2e
 */

function databaseNameFromUri(uri: string): string {
  const withoutQuery = uri.split('?')[0] ?? '';
  const lastSlash = withoutQuery.lastIndexOf('/');
  return lastSlash >= 0 ? withoutQuery.slice(lastSlash + 1) : '';
}

/** Protección contra ejecuciones accidentales sobre una base real. */
export function assertE2EDatabase(uri: string): void {
  const databaseName = databaseNameFromUri(uri);

  if (!/(e2e|test)/i.test(databaseName)) {
    throw new Error(
      `El seed E2E se rechazó: la base "${databaseName || '(sin nombre)'}" no parece de prueba. ` +
        'Usá una MONGODB_URI cuyo nombre de base contenga "e2e" o "test".',
    );
  }
}

export async function seedE2EDatabase(uri: string): Promise<void> {
  assertE2EDatabase(uri);

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15_000 });

  try {
    await Promise.all([
      Order.deleteMany({}),
      Notification.deleteMany({}),
      NotificationRead.deleteMany({}),
      Product.deleteMany({}),
      Client.deleteMany({}),
      Brand.deleteMany({}),
      User.deleteMany({}),
    ]);

    const brand = await Brand.create({
      name: E2E_BRAND.name,
      codePrefix: E2E_BRAND.codePrefix,
    });

    const secondaryBrand = await Brand.create({
      name: E2E_SECONDARY_BRAND.name,
      codePrefix: E2E_SECONDARY_BRAND.codePrefix,
    });

    await Product.create([
      {
        brandId: brand._id,
        code: E2E_PRODUCTS.primary.code,
        name: E2E_PRODUCTS.primary.name,
        // Imagen local para que el E2E también ejercite /_next/image bajo CSP.
        imageUrl: '/icons/icon-192.png',
        price: E2E_PRODUCTS.primary.price,
        priceWithIva: Number((E2E_PRODUCTS.primary.price * 1.21).toFixed(2)),
        active: true,
      },
      {
        brandId: brand._id,
        code: E2E_PRODUCTS.secondary.code,
        name: E2E_PRODUCTS.secondary.name,
        price: E2E_PRODUCTS.secondary.price,
        priceWithIva: Number((E2E_PRODUCTS.secondary.price * 1.21).toFixed(2)),
        active: true,
      },
      {
        brandId: secondaryBrand._id,
        code: E2E_PRODUCTS.otherBrand.code,
        name: E2E_PRODUCTS.otherBrand.name,
        price: E2E_PRODUCTS.otherBrand.price,
        priceWithIva: Number((E2E_PRODUCTS.otherBrand.price * 1.21).toFixed(2)),
        active: true,
      },
    ]);

    // Más de 500 productos para verificar que el snapshot offline ya no se
    // queda con la primera página histórica. Van a la segunda marca para no
    // alterar el alcance de los ajustes masivos de E2E Laboratorio.
    await Product.insertMany(
      Array.from({ length: E2E_OFFLINE_CATALOG.productCount }, (_, index) => {
        const position = index + 1;
        const price = 100 + position;
        return {
          brandId: secondaryBrand._id,
          code: E2E_OFFLINE_CATALOG.codeFor(position),
          name: E2E_OFFLINE_CATALOG.nameFor(position),
          price,
          priceWithIva: Number((price * 1.21).toFixed(2)),
          active: true,
        };
      }),
    );

    const clients = await Client.create(
      Object.values(E2E_CLIENTS).map((client) => ({ ...client, brandDiscounts: [] })),
    );
    const dashboardClient = clients.find((client) => client.code === E2E_CLIENTS.dashboard.code)!;

    const passwordHash = await bcrypt.hash(E2E_PASSWORD, 10);

    const users = await User.create(
      Object.values(E2E_USERS).map((user) => ({
        username: user.username,
        passwordHash,
        role: user.role,
        active: true,
        lastLoginAt: null,
        sessionVersion: 0,
        notificationsEnabled: true,
      })),
    );
    const usersByUsername = new Map(users.map((user) => [user.username, user]));
    const seller = usersByUsername.get(E2E_USERS.seller.username)!;
    const admin = usersByUsername.get(E2E_USERS.admin.username)!;

    // Pedidos del panel: uno por estado del vendedor y un borrador ajeno del
    // admin. Se insertan con fecha de hoy para que los KPIs sean deterministas.
    const now = new Date();
    const baseOrder = {
      clientId: dashboardClient._id,
      clientName: dashboardClient.name,
      clientCode: dashboardClient.code,
      items: [],
      subtotal: 0,
      totalDiscount: 0,
      comments: [],
      archived: false,
      invoiceType: 'A',
      paymentCondition: 'contado',
      createdAt: now,
      updatedAt: now,
    };

    await Order.insertMany([
      ...E2E_DASHBOARD_SELLER_ORDERS.map((order) => ({
        ...baseOrder,
        status: order.status,
        finalTotal: order.finalTotal,
        subtotal: order.finalTotal,
        createdBy: seller.username,
        createdById: seller._id,
      })),
      {
        ...baseOrder,
        clientName: E2E_DASHBOARD_ADMIN_ORDER.clientName,
        status: E2E_DASHBOARD_ADMIN_ORDER.status,
        finalTotal: E2E_DASHBOARD_ADMIN_ORDER.finalTotal,
        subtotal: E2E_DASHBOARD_ADMIN_ORDER.finalTotal,
        createdBy: admin.username,
        createdById: admin._id,
      },
    ]);

    console.log(
      `[e2e] Seed listo en "${databaseNameFromUri(uri)}": ` +
        `${users.length} usuarios, ${clients.length} clientes, ` +
        `${3 + E2E_OFFLINE_CATALOG.productCount} productos y ` +
        `${E2E_DASHBOARD_SELLER_ORDERS.length + 1} pedidos del panel.`,
    );
  } finally {
    await mongoose.disconnect();
  }
}
