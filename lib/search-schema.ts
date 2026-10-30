/**
 * Middleware común para mantener sincronizados los campos `search*`.
 *
 * `save()` recalcula siempre (pre-validate). Las actualizaciones atómicas
 * (`findOneAndUpdate`, `updateOne`, `updateMany`) sólo recalculan cuando el
 * update incluye alguno de los campos de origen; un cambio de precio o de
 * descuentos no toca la clave de búsqueda. `bulkWrite()` no ejecuta middleware,
 * por eso la importación masiva setea los campos explícitamente.
 *
 * `searchTokens` combina varios campos de origen. Si un update parcial (por
 * ejemplo, sólo `name`) no trae todos los orígenes, el hook lee el documento
 * actual para recalcular el array completo y no perder las palabras del resto
 * de la ficha.
 */

type SearchFieldValues = Record<string, string | string[]>;
type SearchFieldComputer = (document: Record<string, any>) => SearchFieldValues;

type UpdateTarget = Record<string, any>;

function isRecord(value: unknown): value is UpdateTarget {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Calcula y asigna los campos de búsqueda sobre un documento plano o de
 * Mongoose. Se comparte con `Order`, que necesita recalcular `searchTokens`
 * fuera de los hooks (`applyOrderUpdatePlan`) y en `insertMany`.
 */
export function applySearchFields<T extends Record<string, any>>(
  document: T,
  compute: SearchFieldComputer,
): T {
  Object.assign(document, compute(document));
  return document;
}

function updateTargets(update: UpdateTarget): UpdateTarget[] {
  const set = isRecord(update.$set) ? update.$set : null;
  const setOnInsert = isRecord(update.$setOnInsert) ? update.$setOnInsert : null;

  return [set, setOnInsert, update].filter((target): target is UpdateTarget => Boolean(target));
}

function collectSources(
  targets: readonly UpdateTarget[],
  sourceFields: readonly string[],
): UpdateTarget {
  const values: UpdateTarget = {};

  for (const target of targets) {
    for (const source of sourceFields) {
      if (Object.prototype.hasOwnProperty.call(target, source) && target[source] !== undefined) {
        values[source] = target[source];
      }
    }
  }

  return values;
}

async function patchUpdate(
  update: UpdateTarget | null | undefined,
  fieldsBySource: Readonly<Record<string, readonly string[]>>,
  compute: SearchFieldComputer,
  query: {
    getQuery: () => Record<string, any>;
    model: {
      findOne: (filter: Record<string, any>) => any;
      db?: { readyState?: number };
    };
  },
): Promise<void> {
  if (!update || Array.isArray(update)) return;

  const sourceFields = Object.keys(fieldsBySource);
  const targets = updateTargets(update);
  const presentSources = sourceFields.filter((source) =>
    targets.some((target) => Object.prototype.hasOwnProperty.call(target, source)),
  );
  if (presentSources.length === 0) return;

  const partialComputed = compute(collectSources(targets, sourceFields));
  const tokenFields = Object.keys(partialComputed).filter((field) =>
    Array.isArray(partialComputed[field]),
  );

  let existing: UpdateTarget | null = null;
  if (
    tokenFields.length > 0 &&
    presentSources.length < sourceFields.length &&
    query.model.db?.readyState === 1
  ) {
    existing = await query.model.findOne(query.getQuery()).select(sourceFields.join(' ')).lean();
  }

  const computed = compute({
    ...(existing ?? {}),
    ...collectSources(targets, sourceFields),
  });

  for (const target of targets) {
    const targetSources = sourceFields.filter((source) =>
      Object.prototype.hasOwnProperty.call(target, source),
    );
    if (targetSources.length === 0) continue;

    const fields: SearchFieldValues = {};
    for (const source of targetSources) {
      for (const field of fieldsBySource[source] ?? []) {
        if (computed[field] !== undefined) fields[field] = computed[field];
      }
    }
    // Los arrays combinados (`searchTokens`) se recalculan una sola vez con
    // todos los orígenes, aunque el target sólo traiga uno de ellos.
    for (const field of tokenFields) {
      if (computed[field] !== undefined) fields[field] = computed[field];
    }

    if (target === update) {
      Object.assign(update, fields);
    } else {
      Object.assign(target, fields);
    }
  }
}

export function registerSearchFieldHooks(
  schema: any,
  fieldsBySource: Readonly<Record<string, readonly string[]>>,
  compute: SearchFieldComputer,
): void {
  schema.pre('validate', function (this: Record<string, any>) {
    applySearchFields(this, compute);
  });

  for (const hook of ['findOneAndUpdate', 'updateOne', 'updateMany'] as const) {
    schema.pre(hook, async function (this: any) {
      await patchUpdate(this.getUpdate(), fieldsBySource, compute, this);
    });
  }
}
