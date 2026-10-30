/**
 * Provisiona en Sentry los monitores y alertas del Sistema de Gestión de Inventario.
 *
 * Uso:
 *   npm run observability:alerts -- --dry-run
 *   SENTRY_AUTH_TOKEN=... SENTRY_ORG=... SENTRY_PROJECT=... npm run observability:alerts
 *
 * Variables:
 * - SENTRY_AUTH_TOKEN: token con scopes alerts:write / project:write.
 * - SENTRY_ORG, SENTRY_PROJECT: slugs de la organización y proyecto.
 * - SENTRY_URL: solo para Sentry self-hosted (default https://sentry.io).
 * - SENTRY_ALERT_TARGET: `user:<id>` o `team:<id>` (default: usuario dueño del token).
 * - SENTRY_SLACK_INTEGRATION_ID + SENTRY_SLACK_CHANNEL: acción Slack opcional.
 * - SENTRY_ALERT_ENVIRONMENT: entorno a evaluar (default SENTRY_ENVIRONMENT/VERCEL_ENV).
 *
 * Es idempotente por nombre: actualiza el monitor y la alerta si ya existen.
 * No imprime el token ni datos de usuarios.
 */

import {
  APP_MONITORS,
  buildEmailAction,
  buildMonitorPayload,
  buildSlackAction,
  buildWorkflowPayload,
  parseAlertTarget,
  workflowNameFor,
  type AlertTarget,
} from '../lib/observability/sentry-alerts';

const SENTRY_URL = (process.env.SENTRY_URL || 'https://sentry.io').replace(/\/+$/, '');
const API_BASE = `${SENTRY_URL}/api/0`;
const DRY_RUN = process.argv.includes('--dry-run');

interface SentryMonitor {
  id: string;
  name: string;
  workflowIds?: string[];
}

interface SentryWorkflow {
  id: string;
  name: string;
  detectorIds?: string[];
}

interface SentryUser {
  id: string | number;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Falta la variable ${name}. Ver docs/observabilidad.md.`);
  }
  return value;
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${requiredEnv('SENTRY_AUTH_TOKEN')}`,
    'Content-Type': 'application/json',
  };
}

async function sentryFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...authHeaders(),
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `${init.method ?? 'GET'} ${path} respondió ${response.status}${body ? `: ${body.slice(0, 500)}` : ''}`,
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function getCurrentUserId(): Promise<string> {
  const me = await sentryFetch<SentryUser>('/users/me/');
  if (!me?.id) throw new Error('No se pudo obtener el usuario dueño del token de Sentry');
  return String(me.id);
}

async function resolveActions(): Promise<Array<Record<string, unknown>>> {
  const explicitTarget = parseAlertTarget(process.env.SENTRY_ALERT_TARGET);
  const target: AlertTarget = explicitTarget ?? { type: 'user', id: await getCurrentUserId() };

  const actions: Array<Record<string, unknown>> = [buildEmailAction(target)];

  const slackIntegrationId = process.env.SENTRY_SLACK_INTEGRATION_ID?.trim();
  const slackChannel = process.env.SENTRY_SLACK_CHANNEL?.trim();
  if (slackIntegrationId && slackChannel) {
    actions.push(buildSlackAction(slackIntegrationId, slackChannel));
  }

  return actions;
}

async function listMonitors(org: string, project: string): Promise<SentryMonitor[]> {
  return sentryFetch<SentryMonitor[]>(
    `/organizations/${encodeURIComponent(org)}/detectors/?project=${encodeURIComponent(project)}&per_page=100`,
  );
}

async function listWorkflows(org: string, project: string): Promise<SentryWorkflow[]> {
  return sentryFetch<SentryWorkflow[]>(
    `/organizations/${encodeURIComponent(org)}/workflows/?project=${encodeURIComponent(project)}&per_page=100`,
  );
}

function environment(): string | undefined {
  return (
    process.env.SENTRY_ALERT_ENVIRONMENT?.trim() ||
    process.env.SENTRY_ENVIRONMENT?.trim() ||
    process.env.VERCEL_ENV?.trim() ||
    undefined
  );
}

async function ensureMonitor(
  definition: (typeof APP_MONITORS)[number],
  existing: SentryMonitor | undefined,
  org: string,
  project: string,
): Promise<{ id: string; workflowIds: string[] }> {
  const payload = buildMonitorPayload(definition, { environment: environment() });

  if (existing) {
    const workflowIds = existing.workflowIds ?? [];
    const updated = await sentryFetch<SentryMonitor>(
      `/organizations/${encodeURIComponent(org)}/detectors/${encodeURIComponent(existing.id)}/`,
      {
        method: 'PUT',
        body: JSON.stringify({ ...payload, workflow_ids: workflowIds }),
      },
    );

    return { id: updated.id, workflowIds: updated.workflowIds ?? workflowIds };
  }

  const created = await sentryFetch<SentryMonitor>(
    `/organizations/${encodeURIComponent(org)}/projects/${encodeURIComponent(project)}/detectors/`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
  );

  return { id: created.id, workflowIds: created.workflowIds ?? [] };
}

async function ensureWorkflow(
  monitorName: string,
  detectorId: string,
  existing: SentryWorkflow | undefined,
  actions: Array<Record<string, unknown>>,
  org: string,
): Promise<string> {
  const name = workflowNameFor(monitorName);
  const payload = buildWorkflowPayload({
    name,
    detectorId,
    actions,
    environment: environment(),
  });

  if (existing) {
    await sentryFetch(
      `/organizations/${encodeURIComponent(org)}/workflows/${encodeURIComponent(existing.id)}/`,
      {
        method: 'PUT',
        body: JSON.stringify({
          ...payload,
          detector_ids: Array.from(new Set([...(existing.detectorIds ?? []), detectorId])),
        }),
      },
    );

    return existing.id;
  }

  const created = await sentryFetch<SentryWorkflow>(
    `/organizations/${encodeURIComponent(org)}/workflows/`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
  );

  return created.id;
}

function printDryRun(): void {
  const placeholderTarget = parseAlertTarget(process.env.SENTRY_ALERT_TARGET) ?? {
    type: 'user' as const,
    id: '000000',
  };
  const actions = [buildEmailAction(placeholderTarget)];

  console.log('Monitores que se crearían/actualizarían:');
  for (const definition of APP_MONITORS) {
    console.log(
      JSON.stringify(
        {
          key: definition.key,
          payload: buildMonitorPayload(definition, { environment: environment() }),
        },
        null,
        2,
      ),
    );
  }

  console.log('\nAlertas (workflows) que se crearían/actualizarían:');
  for (const definition of APP_MONITORS) {
    console.log(
      JSON.stringify(
        {
          key: definition.key,
          payload: buildWorkflowPayload({
            name: workflowNameFor(definition.name),
            detectorId: '<monitor-id>',
            actions,
            environment: environment(),
          }),
        },
        null,
        2,
      ),
    );
  }
}

async function main(): Promise<void> {
  if (DRY_RUN) {
    printDryRun();
    return;
  }

  const org = requiredEnv('SENTRY_ORG');
  const project = requiredEnv('SENTRY_PROJECT');
  requiredEnv('SENTRY_AUTH_TOKEN');

  const [monitors, workflows, actions] = await Promise.all([
    listMonitors(org, project),
    listWorkflows(org, project),
    resolveActions(),
  ]);

  console.log(`Sentry ${SENTRY_URL} · ${org}/${project}`);
  console.log(`Acciones: ${actions.map((action) => String(action.type)).join(', ')}`);

  for (const definition of APP_MONITORS) {
    const existingMonitor = monitors.find((monitor) => monitor.name === definition.name);
    const monitor = await ensureMonitor(definition, existingMonitor, org, project);

    const workflowName = workflowNameFor(definition.name);
    const existingWorkflow = workflows.find((workflow) => workflow.name === workflowName);
    const workflowId = await ensureWorkflow(
      definition.name,
      monitor.id,
      existingWorkflow,
      actions,
      org,
    );

    // Conecta la alerta al monitor (idempotente: no duplica ids).
    const workflowIds = Array.from(new Set([...monitor.workflowIds, workflowId]));
    await sentryFetch(
      `/organizations/${encodeURIComponent(org)}/detectors/${encodeURIComponent(monitor.id)}/`,
      {
        method: 'PUT',
        body: JSON.stringify({
          ...buildMonitorPayload(definition, { environment: environment() }),
          workflow_ids: workflowIds,
        }),
      },
    );

    console.log(
      `✓ ${definition.name} → monitor ${monitor.id}, alerta ${workflowId}${
        existingMonitor ? ' (actualizado)' : ' (creado)'
      }`,
    );
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`No se pudieron configurar las alertas: ${message}`);
  process.exitCode = 1;
});
