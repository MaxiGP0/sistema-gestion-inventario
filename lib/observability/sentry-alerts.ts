/**
 * Definiciones de alertas de Sentry como código.
 *
 * El script `scripts/configure-sentry-alerts.ts` las crea/actualiza vía API.
 * Se basan en eventos de error (no en traces) para que el sampling de
 * performance no las afecte:
 * - Cada 5xx se captura con `sampleRate: 1` y se etiqueta
 *   `http.response.status_class:5xx`.
 * - Cada fallo de Mongo se etiqueta `error.source:mongodb`.
 * - `/api/health` 503 se captura como mensaje agrupado por motivo.
 */

export interface AppMonitorDefinition {
  key: string;
  name: string;
  description: string;
  /** Query de Sentry sobre el dataset `events`. */
  query: string;
  timeWindowSeconds: number;
  /** Se abre un issue de prioridad alta al superar este valor. */
  highThreshold: number;
  /** Prioridad media opcional, antes del umbral alto. */
  mediumThreshold?: number;
}

export const APP_MONITORS: AppMonitorDefinition[] = [
  {
    key: 'health-503',
    name: 'Sistema de Gestión de Inventario · /api/health responde 503',
    description:
      'El probe de infraestructura no pudo confirmar MongoDB (connection-failed, ping-failed o not-connected). Revisar Mongo y los logs con el request-id del evento.',
    query: 'http.route:"/api/health" http.response.status_class:5xx',
    timeWindowSeconds: 300,
    highThreshold: 0,
  },
  {
    key: '5xx-spike',
    name: 'Sistema de Gestión de Inventario · Pico de respuestas 5xx',
    description:
      'Aumento de errores 5xx en cualquier ruta. Los eventos se capturan siempre (sampleRate 1) aunque tracesSampleRate sea 0.',
    query: 'http.response.status_class:5xx',
    timeWindowSeconds: 300,
    highThreshold: 5,
    mediumThreshold: 1,
  },
  {
    key: 'mongo-errors',
    name: 'Sistema de Gestión de Inventario · Errores de MongoDB',
    description:
      'Errores de conexión, timeout, selección de servidor o consultas de Mongo/Mongoose. Incluye el request-id para correlacionar con el log.',
    query: 'error.source:mongodb',
    timeWindowSeconds: 300,
    highThreshold: 0,
  },
];

export interface AlertTarget {
  type: 'user' | 'team';
  id: string;
}

/** Acepta `user:123` o `team:456`; cualquier otra forma se ignora. */
export function parseAlertTarget(value: string | undefined): AlertTarget | undefined {
  const match = /^(user|team):([A-Za-z0-9_-]+)$/.exec(value?.trim() ?? '');
  if (!match) return undefined;
  return { type: match[1] as 'user' | 'team', id: match[2] };
}

export interface MonitorPayloadOptions {
  environment?: string;
}

/** Payload para `POST /organizations/{org}/projects/{project}/detectors/`. */
export function buildMonitorPayload(
  definition: AppMonitorDefinition,
  options: MonitorPayloadOptions = {},
): Record<string, unknown> {
  const conditions: Array<Record<string, unknown>> = [
    { type: 'gt', comparison: definition.highThreshold, conditionResult: 75 },
  ];

  if (
    definition.mediumThreshold !== undefined &&
    definition.mediumThreshold < definition.highThreshold
  ) {
    conditions.push({ type: 'gt', comparison: definition.mediumThreshold, conditionResult: 50 });
  }

  conditions.push({
    type: 'lte',
    comparison: definition.mediumThreshold ?? definition.highThreshold,
    conditionResult: 0,
  });

  return {
    name: definition.name,
    type: 'metric_issue',
    description: definition.description,
    data_sources: [
      {
        aggregate: 'count()',
        dataset: 'events',
        eventTypes: ['error', 'default'],
        query: definition.query,
        queryType: 0,
        timeWindow: definition.timeWindowSeconds,
        ...(options.environment ? { environment: options.environment } : {}),
      },
    ],
    condition_group: {
      logicType: 'any',
      conditions,
    },
    config: { detectionType: 'static' },
    enabled: true,
  };
}

export interface WorkflowPayloadOptions {
  name: string;
  detectorId: string;
  actions: Array<Record<string, unknown>>;
  environment?: string;
  frequencyMinutes?: number;
}

/** Payload para `POST /organizations/{org}/workflows/`. */
export function buildWorkflowPayload(options: WorkflowPayloadOptions): Record<string, unknown> {
  return {
    name: options.name,
    enabled: true,
    config: { frequency: options.frequencyMinutes ?? 5 },
    triggers: {
      logicType: 'any-short',
      conditions: [
        { type: 'first_seen_event', comparison: true, conditionResult: true },
        { type: 'reappeared_event', comparison: true, conditionResult: true },
        { type: 'regression_event', comparison: true, conditionResult: true },
      ],
    },
    actionFilters: [
      {
        logicType: 'any',
        conditions: [],
        actions: options.actions,
      },
    ],
    detector_ids: [options.detectorId],
    ...(options.environment ? { environment: options.environment } : {}),
  };
}

export function buildEmailAction(target: AlertTarget): Record<string, unknown> {
  return {
    type: 'email',
    integrationId: null,
    data: {},
    config: {
      targetType: target.type,
      targetDisplay: null,
      targetIdentifier: target.id,
    },
    status: 'active',
  };
}

export function buildSlackAction(integrationId: string, channel: string): Record<string, unknown> {
  return {
    type: 'slack',
    integrationId,
    data: {},
    config: {
      targetType: 'specific',
      targetIdentifier: '',
      targetDisplay: channel,
    },
    status: 'active',
  };
}

export function workflowNameFor(monitorName: string): string {
  const prefix = 'Sistema de Gestión de Inventario · ';
  const label = monitorName.startsWith(prefix) ? monitorName.slice(prefix.length) : monitorName;
  return `Sistema de Gestión de Inventario · Alerta · ${label}`;
}
