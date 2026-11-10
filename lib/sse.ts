/**
 * Bus de eventos Server-Sent Events para GET /api/events.
 *
 * El registro de clientes vive en globalThis a propósito: en Next.js cada route
 * handler es un entrypoint independiente y puede quedarse con su propia copia
 * de este módulo, así que el Set tiene que ser un singleton de proceso para que
 * broadcastEvent() (p. ej. desde /api/orders) alcance a los clientes que se
 * registraron en /api/events. También sobrevive al HMR de `next dev`.
 *
 * Cada conexión conoce el usuario y la bandeja derivados de la sesión. El
 * servidor filtra por `targetRole` y asigna un id a cada evento para que
 * EventSource pueda reconectar con `Last-Event-ID`. El historial de replay es
 * acotado y local al proceso: en multi-instancia la fuente de verdad siguen
 * siendo las notificaciones persistidas (ver docs/sse-notificaciones.md).
 */

import { randomUUID } from 'node:crypto';
import type { NotificationEventPayload, NotificationTargetRole } from './types/notification';
import { notificationMatchesInbox } from './notification-inbox';

export type SseInbox = NotificationTargetRole;

export interface SseEvent {
  type: string;
  targetRole: SseInbox;
  /** Destinatario individual de la bandeja privada del vendedor. */
  targetUserId?: string;
  /** Fallback por usuario para pedidos históricos sin creador id. */
  targetUsername?: string;
  orderId?: string;
  eventId?: string;
  /**
   * Notificación persistida. Solo se envía a las conexiones de la bandeja
   * destinataria; el resto recibe el evento liviano para hacer un GET.
   */
  notification?: NotificationEventPayload;
}

/** Documento mínimo necesario para armar la carga útil SSE. */
export interface SseNotificationSource {
  id: unknown;
  title: string;
  message: string;
  createdAt?: Date | string | null;
  targetRole: NotificationTargetRole;
  orderId?: unknown;
}

/**
 * Convierte una notificación persistida al payload serializable del evento.
 * Se usa tanto en los flujos de pedidos como en el POST manual de admin.
 */
export function toSseNotificationPayload(source: SseNotificationSource): NotificationEventPayload {
  const createdAt = source.createdAt ? new Date(source.createdAt) : new Date();
  const validCreatedAt = Number.isNaN(createdAt.getTime()) ? new Date() : createdAt;

  return {
    id: String(source.id),
    title: source.title,
    message: source.message,
    createdAt: validCreatedAt.toISOString(),
    targetRole: source.targetRole,
    ...(source.orderId ? { orderId: String(source.orderId) } : {}),
  };
}

/** Estado del usuario que la conexión revalida en cada heartbeat. */
export interface SseSessionState {
  active: boolean;
  sessionVersion: number;
  inbox: SseInbox;
}

export interface CreateEventStreamOptions {
  userId: string;
  username?: string;
  inbox: SseInbox;
  /** IP resuelta por el proxy; `unknown` desactiva el límite por IP. */
  ip?: string;
  /** Último evento recibido por EventSource antes de reconectar. */
  lastEventId?: string | null;
  /** Versión firmada al abrir la conexión; el heartbeat la compara. */
  sessionVersion?: number;
  /**
   * Revalida el usuario cada SSE_HEARTBEAT_MS. Si devuelve `null` (usuario
   * eliminado/inactivo), la versión cambió o la bandeja ya no corresponde al
   * rol actual, la conexión se cierra con `session-expired`.
   */
  verifySession?: () => Promise<SseSessionState | null>;
}

interface SseConnection {
  controller: ReadableStreamDefaultController<Uint8Array>;
  userId: string;
  username: string;
  inbox: SseInbox;
  ip: string;
  sessionVersion?: number;
  verifySession?: () => Promise<SseSessionState | null>;
  connectedAt: number;
  close: (reason?: 'limit' | 'session-expired' | 'send-failed' | 'closed') => void;
}

interface SseHistoryEntry {
  id: string;
  event: SseEvent;
}

interface SseBusState {
  clients: Set<SseConnection>;
  history: SseHistoryEntry[];
}

declare global {
  var sgiSseBus: SseBusState | undefined;
}

const bus: SseBusState = global.sgiSseBus ?? {
  clients: new Set<SseConnection>(),
  history: [],
};
if (!global.sgiSseBus) {
  global.sgiSseBus = bus;
}

const clients = bus.clients;
const history = bus.history;

const encoder = new TextEncoder();

/** Intervalo del keep-alive: más corto que el timeout típico de los proxies (60 s). */
export const SSE_HEARTBEAT_MS = 25_000;

/** Máximo de conexiones simultáneas por usuario. */
export const SSE_MAX_CONNECTIONS_PER_USER = 3;

/** Máximo de conexiones simultáneas por IP (se omite si la IP es desconocida). */
export const SSE_MAX_CONNECTIONS_PER_IP = 3;

/** Cantidad de eventos recordados para replay tras una reconexión. */
export const SSE_REPLAY_BUFFER_SIZE = 100;

export const SSE_UNKNOWN_IP = 'unknown';

export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  // Evita que proxies tipo nginx retengan los chunks del stream.
  'X-Accel-Buffering': 'no',
} as const;

/** Cantidad de clientes SSE conectados (diagnóstico y tests). */
export function connectedSseClientCount(): number {
  return clients.size;
}

function encodeEvent(event: SseEvent): string {
  return `id: ${event.eventId}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Quita la carga útil de una conexión que no es la bandeja destinataria. El
 * evento sigue llegando (p. ej. al admin global) para que refresque su vista,
 * pero sin el contenido completo de una alerta ajena.
 */
function eventForInbox(event: SseEvent, inbox: SseInbox): SseEvent {
  if (!event.notification || inbox === event.targetRole) return event;
  return { ...event, notification: undefined };
}

/** Variante sin carga útil, para las conexiones que no son la destinataria. */
function eventWithoutNotification(event: SseEvent): SseEvent {
  if (!event.notification) return event;
  return { ...event, notification: undefined };
}

/**
 * ¿La conexión debe recibir este evento?
 *
 * Las alertas privadas de vendedor solo llegan a las conexiones de ese usuario
 * (por id o, en pedidos históricos, por username) y a los admins, que
 * supervisan todas las bandejas. Nunca se difunden a otros vendedores ni a
 * depósito/facturación.
 */
function eventMatchesConnection(connection: SseConnection, event: SseEvent): boolean {
  if (event.targetRole === 'vendor') {
    if (connection.inbox === 'all') return true;
    if (connection.inbox !== 'vendor') return false;
    if (event.targetUserId) return connection.userId === event.targetUserId;
    if (event.targetUsername) return connection.username === event.targetUsername;
    return false;
  }

  return notificationMatchesInbox(connection.inbox, event.targetRole);
}

/** Encola un chunk en una conexión; si ya no acepta escrituras, la cierra. */
function send(connection: SseConnection, chunk: string): boolean {
  try {
    connection.controller.enqueue(encoder.encode(chunk));
    return true;
  } catch {
    connection.close('send-failed');
    return false;
  }
}

function rememberEvent(event: SseEvent): void {
  if (!event.eventId) return;

  history.push({ id: event.eventId, event });
  if (history.length > SSE_REPLAY_BUFFER_SIZE) {
    history.splice(0, history.length - SSE_REPLAY_BUFFER_SIZE);
  }
}

/**
 * Envía lo que el cliente se perdió entre `lastEventId` y el presente.
 * Si el id ya no está en el buffer (proceso reiniciado o evento muy viejo),
 * no se inventa historial: el cliente hace una puesta al día al reconectar.
 */
function replayMissedEvents(connection: SseConnection, lastEventId: string): void {
  const index = history.findIndex((entry) => entry.id === lastEventId);
  if (index === -1) return;

  for (const entry of history.slice(index + 1)) {
    if (!eventMatchesConnection(connection, entry.event)) continue;
    if (!send(connection, encodeEvent(eventForInbox(entry.event, connection.inbox)))) return;
  }
}

/**
 * Cierra la conexión más vieja cuando se supera el límite por usuario o por IP.
 * Se excluye la conexión recién creada: el límite siempre desaloja a una vieja.
 */
function enforceConnectionLimits(newConnection: SseConnection): void {
  const closeOldestMatching = (matches: (connection: SseConnection) => boolean, max: number) => {
    const candidates = [...clients]
      .filter((connection) => connection !== newConnection && matches(connection))
      .sort((a, b) => a.connectedAt - b.connectedAt);

    while (candidates.length >= max) {
      const oldest = candidates.shift();
      oldest?.close('limit');
    }
  };

  if (newConnection.userId) {
    closeOldestMatching(
      (connection) => connection.userId === newConnection.userId,
      SSE_MAX_CONNECTIONS_PER_USER,
    );
  }

  if (newConnection.ip !== SSE_UNKNOWN_IP) {
    closeOldestMatching(
      (connection) => connection.ip === newConnection.ip,
      SSE_MAX_CONNECTIONS_PER_IP,
    );
  }
}

/**
 * Difunde un evento SSE solo a las bandejas que deben verlo.
 *
 * Devuelve el id del evento (también enviado en la línea `id:` para que
 * EventSource lo use como `Last-Event-ID` en la próxima reconexión).
 */
export function broadcastEvent(
  eventData: Omit<SseEvent, 'eventId'> & { eventId?: string },
): string {
  const eventId = eventData.eventId ?? randomUUID();
  const event: SseEvent = { ...eventData, eventId };

  rememberEvent(event);

  // Dos serializaciones por broadcast: la completa (bandeja destinataria) y
  // la liviana (admin/global y cualquier conexión que solo necesita refrescar).
  const fullChunk = encodeEvent(event);
  const lightChunk = event.notification ? encodeEvent(eventWithoutNotification(event)) : fullChunk;

  for (const connection of [...clients]) {
    if (!eventMatchesConnection(connection, event)) continue;
    const chunk =
      event.notification && connection.inbox !== event.targetRole ? lightChunk : fullChunk;
    send(connection, chunk);
  }

  return eventId;
}

/**
 * Crea el stream de un cliente y lo registra hasta que se desconecte.
 *
 * `cancel` recibe el motivo del cierre, no el controller: por eso el controller
 * guardado en `start` y el intervalo del heartbeat viven en este closure.
 */
export function createEventStream(options: CreateEventStreamOptions): ReadableStream<Uint8Array> {
  const userId = options.userId;
  const username = options.username?.trim() || '';
  const inbox = options.inbox;
  const ip = options.ip?.trim() || SSE_UNKNOWN_IP;
  const lastEventId = options.lastEventId?.trim() || null;
  const sessionVersion = options.sessionVersion;
  const verifySession = options.verifySession;

  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let connection: SseConnection | undefined;
  let closed = false;
  let checkingSession = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (connection) clients.delete(connection);
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
  };

  const close = (reason: 'limit' | 'session-expired' | 'send-failed' | 'closed' = 'closed') => {
    if (closed) return;

    if ((reason === 'limit' || reason === 'session-expired') && controllerRef) {
      // Un evento con nombre permite que el cliente desista de reconectar y
      // use el polling de seguridad, en vez de entrar en una guerra de
      // reconexiones entre pestañas que se desalojan mutuamente. En
      // `session-expired` el cliente debe volver al login: la cookie firmada
      // ya no representa al usuario/rol actual.
      const eventName = reason === 'limit' ? 'connection-limit' : 'session-expired';
      try {
        controllerRef.enqueue(
          encoder.encode(`retry: 30000\nevent: ${eventName}\ndata: {"reason":"${eventName}"}\n\n`),
        );
      } catch {
        // La conexión ya estaba cerrada.
      }
    }

    try {
      controllerRef?.close();
    } catch {
      // El stream ya estaba cerrado por el cliente.
    }

    cleanup();
  };

  /**
   * Keep-alive + revocación: cada SSE_HEARTBEAT_MS se revalida el usuario.
   * La consulta la resuelve el caller con la caché compartida de sesión, así
   * que una baja, un reset o un cambio de rol cierran la conexión a los 25 s
   * como máximo. Si la revalidación falla por un error transitorio, se deja la
   * conexión abierta y se reintenta en el próximo heartbeat.
   */
  const heartbeatTick = async () => {
    if (closed || !connection) return;

    if (verifySession && !checkingSession) {
      checkingSession = true;
      try {
        const state = await verifySession();
        if (closed || !connection) return;

        const versionChanged =
          typeof sessionVersion === 'number' && state?.sessionVersion !== sessionVersion;
        const inboxChanged = state?.inbox !== connection.inbox;

        if (!state || !state.active || versionChanged || inboxChanged) {
          close('session-expired');
          return;
        }
      } catch {
        // Error transitorio (Mongo, red): el próximo heartbeat reintenta.
        return;
      } finally {
        checkingSession = false;
      }
    }

    if (!send(connection, ': ping\n\n')) {
      cleanup();
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      connection = {
        controller,
        userId,
        username,
        inbox,
        ip,
        sessionVersion,
        verifySession,
        connectedAt: Date.now(),
        close,
      };
      clients.add(connection);
      enforceConnectionLimits(connection);

      // Comentario SSE: abre el stream sin disparar un 'message' en EventSource.
      send(connection, ': connected\n\n');

      if (lastEventId) {
        replayMissedEvents(connection, lastEventId);
      }

      heartbeat = setInterval(() => {
        void heartbeatTick();
      }, SSE_HEARTBEAT_MS);
    },
    cancel() {
      cleanup();
    },
  });
}
