import { enforceDatabaseConfinement } from './database-confinement.js';
import type { QueryRun } from './query-plugin-run.js';
import { collectRangeWarnings, enforceMutationPolicy, enforcePartitionPredicate } from './safety.js';

export function runSafetyGuards(run: QueryRun): string[] {
  const { request, prepared, schemaContext } = run;
  const { datasource, query } = prepared;
  enforceMutationPolicy({ sql: query, allowMutate: request.allowMutate, datasource });
  enforceDatabaseConfinement({ sql: query, datasource });
  const partitionWarnings = enforcePartitionPredicate({
    sql: query,
    datasource,
    schemaContext,
    allowPartitionScan: request.allowPartitionScan,
  });
  return [...partitionWarnings, ...collectRangeWarnings({ sql: query, schemaContext })];
}
