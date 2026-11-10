/**
 * Lógica compartida de notificaciones por usuario.
 *
 * `Notification` sigue siendo la cola compartida por rol; el estado leído,
 * descartado y las preferencias son por usuario. Tanto `/api/notifications`
 * (contrato histórico) como `/api/users/notifications` (vista del usuario
 * autenticado) usan estas funciones para que la semántica no se duplique.
 */
import mongoose, { type Types } from 'mongoose';
import { Notification } from '../models/Notification';
import { NotificationRead } from '../models/NotificationRead';
import type { UserRole } from './authz';
import {
  buildNotificationCursorFilter,
  encodeNotificationCursor,
  type NotificationCursor,
} from './notification-cursor';
import { notificationInboxForRole } from './notification-inbox';
import { NOTIFICATION_PAGE_SIZE } from './types/notification';
import type { NotificationTargetRole } from './validations';

export { NOTIFICATION_PAGE_SIZE };

/** Tope de la página para que un cliente no pueda pedir la colección entera. */
export const NOTIFICATION_MAX_PAGE_SIZE = 100;

/**
 * Ventana de "marcar todas como leídas".
 *
 * La operación se resuelve en la base con un `$merge`, sin cargar ids en el
 * proceso. Para que el trabajo quede acotado aunque la colección crezca, solo
 * alcanza a las notificaciones de los últimos 90 días. Las más viejas se
 * pueden marcar individualmente o quedan fuera de la retención de 180 días.
 */
export const NOTIFICATION_MARK_ALL_WINDOW_DAYS = 90;

/**
 * Bandeja por defecto según el rol del usuario autenticado. El controlador
 * usa la bandeja histórica `deposit`; el vendedor, su bandeja privada
 * `vendor`. Los valores persistidos son `deposit | billing | vendor | all`.
 */
export function defaultNotificationInbox(role: UserRole): NotificationTargetRole {
  return notificationInboxForRole(role);
}

export interface NotificationViewer {
  userId: Types.ObjectId | string;
  role?: UserRole;
  username?: string;
}

/**
 * Filtro privado del vendedor.
 *
 * Solo ve alertas dirigidas a su usuario (`targetUserId` o, para pedidos
 * históricos, `targetUsername`) y globales que no estén asignadas a otro
 * vendedor. Nunca incluye las bandejas operativas `deposit`/`billing`.
 */
function vendorNotificationQuery(viewer: NotificationViewer): Record<string, unknown> {
  const userId = toObjectId(viewer.userId);
  const username = viewer.username?.trim();
  const branches: Record<string, unknown>[] = [{ targetRole: 'vendor', targetUserId: userId }];

  if (username) {
    branches.push({
      targetRole: 'vendor',
      targetUserId: { $exists: false },
      targetUsername: username,
    });
  }

  branches.push({
    targetRole: 'all',
    $and: [
      { $or: [{ targetUserId: { $exists: false } }, { targetUserId: userId }] },
      ...(username
        ? [{ $or: [{ targetUsername: { $exists: false } }, { targetUsername: username }] }]
        : []),
    ],
  });

  return { $or: branches };
}

/**
 * Filtro de `Notification` para una bandeja. `all` significa "sin filtro"
 * (todas las alertas), igual que el contrato histórico de `/api/notifications`.
 *
 * Con `viewer.role === 'vendedor'` la bandeja se fuerza a `vendor` y se aplica
 * el alcance individual, sin importar el `targetRole` que pida el cliente.
 */
export function notificationRoleQuery(
  targetRole?: NotificationTargetRole,
  viewer?: NotificationViewer,
): Record<string, unknown> {
  if (viewer?.role === 'vendedor') return vendorNotificationQuery(viewer);
  return targetRole && targetRole !== 'all' ? { targetRole: { $in: [targetRole, 'all'] } } : {};
}

export interface UserNotification extends Record<string, unknown> {
  _id: unknown;
  title: string;
  message: string;
  targetRole: NotificationTargetRole;
  createdAt: Date;
  read: boolean;
  readAt: Date | null;
}

export interface NotificationPage {
  notifications: UserNotification[];
  hasMore: boolean;
  nextCursor: string | null;
}

function toObjectId(value: Types.ObjectId | string): Types.ObjectId {
  if (value instanceof mongoose.Types.ObjectId) return value;
  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw new Error('userId inválido para notificaciones');
  }
  return new mongoose.Types.ObjectId(value);
}

/**
 * Pipeline del listado paginado.
 *
 * El `$lookup` trae el estado del usuario y el `$match` posterior descarta las
 * notificaciones antes de aplicar `$limit`. Ése es el punto clave: si se
 * limitara primero, las descartadas de la primera página podrían tapar
 * notificaciones no leídas más viejas.
 *
 * El `$sort` va antes del `$lookup` para que MongoDB pueda resolverlo con los
 * índices `{ targetRole, createdAt, _id }` / `{ createdAt, _id }` y no bloquee
 * la consulta ordenando en memoria.
 */
export function buildNotificationListPipeline({
  userId,
  targetRole,
  role,
  username,
  limit = NOTIFICATION_PAGE_SIZE,
  cursor,
}: {
  userId: Types.ObjectId | string;
  targetRole?: NotificationTargetRole;
  role?: UserRole;
  username?: string;
  limit?: number;
  cursor?: NotificationCursor | null;
}): mongoose.PipelineStage[] {
  const roleQuery = notificationRoleQuery(targetRole, { userId, role, username });
  const cursorQuery = cursor ? buildNotificationCursorFilter(cursor) : null;
  // Un filtro de vendedor ya usa `$or`; el cursor se combina con `$and` para
  // no pisarlo (Object.assign reemplazaría la clave).
  const match: Record<string, unknown> = cursorQuery
    ? '$or' in roleQuery
      ? { $and: [roleQuery, cursorQuery] }
      : { ...roleQuery, ...cursorQuery }
    : roleQuery;

  return [
    { $match: match },
    { $sort: { createdAt: -1, _id: -1 } },
    {
      $lookup: {
        from: NotificationRead.collection.name,
        let: { notificationId: '$_id', stateUserId: { $literal: toObjectId(userId) } },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$notificationId', '$$notificationId'] },
                  { $eq: ['$userId', '$$stateUserId'] },
                ],
              },
            },
          },
          { $limit: 1 },
          { $project: { _id: 0, readAt: 1, dismissedAt: 1 } },
        ],
        as: 'readState',
      },
    },
    // Un estado vacío (sin fila) o con dismissedAt null es visible; una fecha
    // de descarte lo excluye. En aggregation, el dot notation sobre un array
    // vacío no matchea null, por eso se usa `$arrayElemAt` + `$ifNull`.
    {
      $match: {
        $expr: {
          $eq: [{ $ifNull: [{ $arrayElemAt: ['$readState.dismissedAt', 0] }, null] }, null],
        },
      },
    },
    { $limit: limit + 1 },
    {
      $project: {
        _id: 1,
        title: 1,
        message: 1,
        targetRole: 1,
        targetUserId: 1,
        targetUsername: 1,
        orderId: 1,
        createdAt: 1,
        readAt: {
          $ifNull: [{ $arrayElemAt: ['$readState.readAt', 0] }, null],
        },
        read: {
          $ne: [{ $ifNull: [{ $arrayElemAt: ['$readState.readAt', 0] }, null] }, null],
        },
      },
    },
  ];
}

/**
 * Notificaciones visibles para un usuario, con `read`/`readAt` calculados a
 * partir de `NotificationRead`. Las descartadas por ese usuario no se listan
 * y se excluyen antes del límite de la página.
 */
export async function listNotificationsForUser({
  userId,
  targetRole,
  role,
  username,
  limit = NOTIFICATION_PAGE_SIZE,
  cursor,
}: {
  userId: Types.ObjectId | string;
  targetRole?: NotificationTargetRole;
  role?: UserRole;
  username?: string;
  limit?: number;
  cursor?: NotificationCursor | null;
}): Promise<NotificationPage> {
  const pageSize = Math.min(
    Math.max(Number.isFinite(limit) ? Math.trunc(limit) : NOTIFICATION_PAGE_SIZE, 1),
    NOTIFICATION_MAX_PAGE_SIZE,
  );

  const documents = (await Notification.aggregate(
    buildNotificationListPipeline({
      userId,
      targetRole,
      role,
      username,
      limit: pageSize,
      cursor,
    }),
  )) as UserNotification[];

  const hasMore = documents.length > pageSize;
  const notifications = hasMore ? documents.slice(0, pageSize) : documents;
  const last = notifications[notifications.length - 1];
  const nextCursor = hasMore && last ? encodeNotificationCursor(last) : null;

  return { notifications, hasMore, nextCursor };
}

/** Marca/desmarca una notificación como leída para el usuario indicado. */
export async function setNotificationReadForUser({
  userId,
  notificationId,
  read,
}: {
  userId: Types.ObjectId | string;
  notificationId: Types.ObjectId | string;
  read: boolean;
}): Promise<void> {
  if (!read) {
    await NotificationRead.deleteMany({ userId, notificationId });
    return;
  }

  await NotificationRead.findOneAndUpdate(
    { userId, notificationId },
    { $set: { readAt: new Date() } },
    { upsert: true },
  );
}

function markAllCutoff(now: Date): Date {
  return new Date(now.getTime() - NOTIFICATION_MARK_ALL_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Pipeline de "marcar todas como leídas" con un único `$merge` en Mongo.
 *
 * No se traen ids al proceso: la base recorre las notificaciones de la ventana
 * y hace upsert del estado por usuario/notificación. En las filas existentes
 * solo actualiza `readAt`/`updatedAt`, preservando `dismissedAt` y `createdAt`.
 */
export function buildMarkAllNotificationsReadPipeline({
  userId,
  targetRole,
  role,
  username,
  now = new Date(),
}: {
  userId: Types.ObjectId | string;
  targetRole?: NotificationTargetRole;
  role?: UserRole;
  username?: string;
  now?: Date;
}): mongoose.PipelineStage[] {
  const cutoff = markAllCutoff(now);
  const stateUserId = toObjectId(userId);

  return [
    {
      $match: {
        ...notificationRoleQuery(targetRole, { userId, role, username }),
        createdAt: { $gte: cutoff },
      },
    },
    {
      $project: {
        _id: 0,
        userId: { $literal: stateUserId },
        notificationId: '$_id',
        readAt: { $literal: now },
        dismissedAt: { $literal: null },
        createdAt: { $literal: now },
        updatedAt: { $literal: now },
      },
    },
    {
      $merge: {
        into: NotificationRead.collection.name,
        on: ['userId', 'notificationId'],
        whenMatched: [{ $set: { readAt: '$$new.readAt', updatedAt: '$$new.updatedAt' } }],
        whenNotMatched: 'insert',
      },
    },
  ];
}

/**
 * Marca/desmarca todas las notificaciones de una bandeja para un usuario.
 *
 * Al marcar como leídas se limita la ventana a `NOTIFICATION_MARK_ALL_WINDOW_DAYS`
 * y se usa un `$merge` masivo, así el costo no depende de cuántos ids pueda
 * retener el proceso. Al desmarcar se reutiliza el mismo filtro acotado.
 */
export async function setAllNotificationsReadForUser({
  userId,
  targetRole,
  role,
  username,
  read,
}: {
  userId: Types.ObjectId | string;
  targetRole?: NotificationTargetRole;
  role?: UserRole;
  username?: string;
  read: boolean;
}): Promise<number> {
  const now = new Date();
  const query = {
    ...notificationRoleQuery(targetRole, { userId, role, username }),
    createdAt: { $gte: markAllCutoff(now) },
  };

  if (!read) {
    const notifications = await Notification.find(query).select('_id').lean();
    if (notifications.length === 0) return 0;

    const result = await NotificationRead.deleteMany({
      userId,
      notificationId: { $in: notifications.map((notification) => notification._id) },
    });
    return result.deletedCount ?? 0;
  }

  const count = await Notification.countDocuments(query);
  if (count === 0) return 0;

  await Notification.aggregate(
    buildMarkAllNotificationsReadPipeline({ userId, targetRole, role, username, now }),
  );

  return count;
}

/**
 * Descarta (oculta) una notificación solo para el usuario indicado. No borra
 * la notificación compartida ni el estado de lectura de otros usuarios.
 */
export async function dismissNotificationForUser({
  userId,
  notificationId,
}: {
  userId: Types.ObjectId | string;
  notificationId: Types.ObjectId | string;
}): Promise<void> {
  const now = new Date();
  await NotificationRead.findOneAndUpdate(
    { userId, notificationId },
    { $set: { readAt: now, dismissedAt: now } },
    { upsert: true },
  );
}

/**
 * "Limpiar leídas": descarta para el usuario las notificaciones ya leídas de
 * la bandeja solicitada. Sigue el mismo filtro por rol que el listado.
 */
export async function dismissReadNotificationsForUser({
  userId,
  targetRole,
  role,
  username,
}: {
  userId: Types.ObjectId | string;
  targetRole?: NotificationTargetRole;
  role?: UserRole;
  username?: string;
}): Promise<number> {
  const notifications = await Notification.find(
    notificationRoleQuery(targetRole, { userId, role, username }),
  )
    .select('_id')
    .lean();

  if (notifications.length === 0) return 0;

  const result = await NotificationRead.updateMany(
    {
      userId,
      notificationId: { $in: notifications.map((notification) => notification._id) },
      readAt: { $ne: null },
      dismissedAt: null,
    },
    { $set: { dismissedAt: new Date() } },
  );

  return result.modifiedCount ?? 0;
}
