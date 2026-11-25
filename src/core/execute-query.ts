import { prepareQuery } from './query-preparation.js';
import { runQuery, startQueryRun } from './query-run.js';
import type { QueryDeps, QueryExecutionRequest, QueryOutcome, QueryReport } from './query-types.js';

export const silentQueryReport: QueryReport = { log: () => null };

export async function executeQuery(request: QueryExecutionRequest, deps: QueryDeps): Promise<QueryOutcome> {
  const startedAt = Date.now();
  const preparation = await prepareQuery(request, deps);
  if ('failed' in preparation) {
    return preparation.failed;
  }
  const run = await startQueryRun({ request, deps, prepared: preparation.value, startedAt });
  return 'failed' in run ? run.failed : runQuery(run.value);
}
