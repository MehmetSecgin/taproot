import type { AppContext } from './app.js';
import { classifyError } from './error-classification.js';
import type { QueryOutcome, QueryOutcomeMeta } from './query-types.js';
import { propertyOf } from './object-property.js';
import { suggestSchemaNames } from './schema-context.js';
import type { SchemaContext } from '../types/schema-context.js';
import { ensureDatasourceCatalog } from './schema-refresh.js';
import type { QuerySlot } from './schema-refresh.js';
import { textUnlessFalsy } from './text-presence.js';
import type { DatasourceProfile } from '../types/datasource.js';

type QueryFailure = Extract<QueryOutcome, { ok: false }>;

export type Attempt<Value> = { value: Value } | { failed: QueryFailure };

type SchemaHintRequest = {
  ctx: AppContext;
  datasource: DatasourceProfile;
  schemaContext: SchemaContext;
  sessionId: string | undefined;
  acquireQuerySlot: QuerySlot | undefined;
};

const SCHEMA_NAME_ERROR_CODES = new Set(['UNKNOWN_COLUMN', 'UNKNOWN_TABLE']);

export function failureOutcome(error: unknown, meta: QueryOutcomeMeta): QueryFailure {
  const message = textUnlessFalsy(propertyOf(error, 'message'));
  return {
    ok: false,
    code: classifyError(message),
    message,
    details: propertyOf(error, 'details'),
    meta,
  };
}

export async function attempt<Value>(run: () => Promise<Value> | Value): Promise<Attempt<Value>> {
  try {
    return { value: await run() };
  } catch (error) {
    return { failed: failureOutcome(error, {}) };
  }
}

function detailsRecord(details: unknown): Record<string, unknown> {
  return typeof details === 'object' && details !== null ? { ...details } : {};
}

export function refreshCatalogAndHintSchemaNames(failure: QueryFailure, request: SchemaHintRequest): QueryFailure {
  if (!SCHEMA_NAME_ERROR_CODES.has(failure.code)) {
    return failure;
  }
  const { ctx, datasource, schemaContext } = request;
  void ensureDatasourceCatalog(ctx, datasource, {
    sessionId: request.sessionId,
    acquireQuerySlot: request.acquireQuerySlot,
    afterSchemaError: true,
  });
  const didYouMean = suggestSchemaNames(failure, schemaContext, ctx.schemaCatalogStore.get(datasource.name));
  if (didYouMean.length === 0) {
    return failure;
  }
  return {
    ...failure,
    message: `${failure.message}. Did you mean: ${didYouMean.join(', ')}?`,
    details: { ...detailsRecord(failure.details), didYouMean },
  };
}
