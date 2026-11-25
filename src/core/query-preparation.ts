import { badInput } from './taproot-error.js';
import type { QueryDeps, QueryExecutionRequest } from './query-types.js';
import { parseJsonExtractSpecs } from './json-extract.js';
import type { JsonExtractSpec } from './json-extract.js';
import { parseKeyValuePairs } from './key-value.js';
import { attempt } from './query-failure.js';
import type { Attempt } from './query-failure.js';
import type { DatasourceProfile } from '../types/datasource.js';

export type PreparedQuery = {
  datasource: DatasourceProfile;
  resolutionSource: string;
  resolveMs: number;
  warnings: string[];
  sessionId: string | undefined;
  query: string;
  params: Record<string, string>;
  jsonExtractSpecs: JsonExtractSpec[];
};

type ParsedQueryInputs = Pick<PreparedQuery, 'params' | 'jsonExtractSpecs'>;

function isWholeNumberOfOneOrMore(value: number): boolean {
  return Number.isInteger(value) && value >= 1;
}

function parseQueryInputs(request: QueryExecutionRequest, query: string): ParsedQueryInputs {
  const params = parseKeyValuePairs('--param', request.params ?? []);
  const jsonExtractSpecs = parseJsonExtractSpecs(request.jsonExtract);
  if (query === '') {
    throw new Error('No query resolved. Provide --sql (or --query for Redis and gRPC).');
  }
  if (request.maxRows !== undefined && !isWholeNumberOfOneOrMore(request.maxRows)) {
    throw badInput(`maxRows must be a whole number of 1 or more, got ${JSON.stringify(request.maxRows)}.`);
  }
  return { params, jsonExtractSpecs };
}

type ResolvedDatasourceStep = Pick<PreparedQuery, 'datasource' | 'resolutionSource' | 'warnings' | 'resolveMs'>;

async function resolveDatasourceTimed(request: QueryExecutionRequest, deps: QueryDeps): Promise<ResolvedDatasourceStep> {
  const resolveStart = Date.now();
  const resolved = await deps.resolveDatasource(request, deps);
  const resolveMs = Date.now() - resolveStart;
  deps.report.log(`datasource ready (${resolved.datasource.name})`);
  return { datasource: resolved.datasource, resolutionSource: resolved.source, warnings: [...resolved.warnings], resolveMs };
}

export async function prepareQuery(request: QueryExecutionRequest, deps: QueryDeps): Promise<Attempt<PreparedQuery>> {
  const resolution = await attempt(async () => resolveDatasourceTimed(request, deps));
  if ('failed' in resolution) {
    return resolution;
  }
  const sessionId = deps.openSession?.(resolution.value.datasource);
  const query = request.query.trim();
  const inputs = await attempt(() => parseQueryInputs(request, query));
  if ('failed' in inputs) {
    return inputs;
  }
  deps.report.log('query resolved');
  return { value: { ...resolution.value, sessionId, query, ...inputs.value } };
}
