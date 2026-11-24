import type { AppContext } from './app.js';
import { SQL_DATASOURCE_KINDS } from '../types/datasource.js';
import type { DatasourceProfile } from '../types/datasource.js';
import type { TableContext } from '../types/schema-context.js';
import { RUNTIME_CONSTANTS } from './constants.js';
import { withQueryTimeout } from './query-timeout.js';
import { buildCatalogTables } from './schema-catalog-build.js';
import { readCatalogRows } from './schema-catalog-read.js';
import type { CatalogReadTarget } from './schema-catalog-read.js';

export type QuerySlot = (signal: AbortSignal) => Promise<() => void>;

type CatalogRequest = {
  sessionId: string | undefined;
  acquireQuerySlot: QuerySlot | undefined;
  afterSchemaError: boolean;
};

type CatalogEnsureResult = {
  outcome: 'unsupported' | 'cached' | 'fetched' | 'failed';
  tableCount: number;
  error?: string;
};

const MS_PER_HOUR = 3_600_000;

const inFlightCatalogFetches = new Map<string, Promise<CatalogEnsureResult>>();
const recentCatalogFailures = new Map<string, { failedAt: number; error: string }>();

async function fetchCatalogTables(target: CatalogReadTarget): Promise<Record<string, TableContext>> {
  const rows = await withQueryTimeout({
    timeoutMs: RUNTIME_CONSTANTS.query.catalogTimeoutMs,
    signal: undefined,
    run: async (signal) => readCatalogRows(target, signal),
  });
  return buildCatalogTables(rows, target.datasource.connection.database ?? '');
}

function cachedTableCount(ctx: AppContext, datasource: DatasourceProfile): number {
  return Object.keys(ctx.schemaCatalogStore.get(datasource.name)?.tables ?? {}).length;
}

function outcomeWithoutFetching(ctx: AppContext, datasource: DatasourceProfile, request: CatalogRequest): CatalogEnsureResult | undefined {
  const cached = ctx.schemaCatalogStore.get(datasource.name);
  const tableCount = cachedTableCount(ctx, datasource);
  const maxAgeMs = request.afterSchemaError
    ? RUNTIME_CONSTANTS.query.catalogMaxAgeAfterSchemaErrorMs
    : RUNTIME_CONSTANTS.query.catalogTtlHours * MS_PER_HOUR;
  if (cached !== undefined && Date.now() - Date.parse(cached.fetchedAt) < maxAgeMs) {
    return { outcome: 'cached', tableCount };
  }
  const lastFailure = recentCatalogFailures.get(datasource.name);
  if (lastFailure !== undefined && Date.now() - lastFailure.failedAt < RUNTIME_CONSTANTS.query.catalogFailureRetryMs) {
    return { outcome: 'failed', tableCount, error: lastFailure.error };
  }
  return undefined;
}

function saveFetchedCatalog(ctx: AppContext, datasource: DatasourceProfile, tables: Record<string, TableContext>): CatalogEnsureResult {
  ctx.schemaCatalogStore.save(datasource.name, tables);
  recentCatalogFailures.delete(datasource.name);
  return { outcome: 'fetched', tableCount: Object.keys(tables).length };
}

function recordFetchFailure(datasource: DatasourceProfile, error: unknown, tableCount: number): CatalogEnsureResult {
  const message = error instanceof Error ? error.message : String(error);
  recentCatalogFailures.set(datasource.name, { failedAt: Date.now(), error: message });
  return { outcome: 'failed', tableCount, error: message };
}

async function fetchAndSaveCatalog(ctx: AppContext, datasource: DatasourceProfile, request: CatalogRequest): Promise<CatalogEnsureResult> {
  const tableCount = cachedTableCount(ctx, datasource);
  try {
    const tables = await fetchCatalogTables({ ctx, datasource, sessionId: request.sessionId, acquireQuerySlot: request.acquireQuerySlot });
    return saveFetchedCatalog(ctx, datasource, tables);
  } catch (error) {
    return recordFetchFailure(datasource, error, tableCount);
  } finally {
    inFlightCatalogFetches.delete(datasource.name);
  }
}

async function joinOrStartCatalogFetch(ctx: AppContext, datasource: DatasourceProfile, request: CatalogRequest): Promise<CatalogEnsureResult> {
  const running = inFlightCatalogFetches.get(datasource.name);
  if (running !== undefined) {
    return running;
  }
  const fetching = fetchAndSaveCatalog(ctx, datasource, request);
  inFlightCatalogFetches.set(datasource.name, fetching);
  return fetching;
}

export async function ensureDatasourceCatalog(ctx: AppContext, datasource: DatasourceProfile, request: CatalogRequest): Promise<CatalogEnsureResult> {
  if (!SQL_DATASOURCE_KINDS.has(datasource.kind)) {
    return { outcome: 'unsupported', tableCount: 0 };
  }
  const settledOutcome = outcomeWithoutFetching(ctx, datasource, request);
  return settledOutcome ?? (await joinOrStartCatalogFetch(ctx, datasource, request));
}
