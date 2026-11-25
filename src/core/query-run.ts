import type { QueryDeps, QueryOutcome } from './query-types.js';
import { failureOutcome, refreshCatalogAndHintSchemaNames } from './query-failure.js';
import type { Attempt } from './query-failure.js';
import { executePlugin, preflightConnectors } from './query-plugin-run.js';
import { runSafetyGuards } from './query-safety-guards.js';
import { selectPlugin } from './query-plugin-selection.js';
import type { QueryRun } from './query-plugin-run.js';
import type { PreparedQuery } from './query-preparation.js';
import { buildSuccessOutcome } from './query-success.js';
import { buildSchemaContext } from './schema-context.js';
import { ensureDatasourceCatalog } from './schema-refresh.js';
import { resolveSessionTimeZone } from './session-timezone.js';

type QueryRunInput = Pick<QueryRun, 'request' | 'deps' | 'prepared' | 'startedAt'>;

async function refreshCatalogInBackground(deps: QueryDeps, prepared: PreparedQuery): Promise<void> {
  const catalog = await ensureDatasourceCatalog(deps.ctx, prepared.datasource, {
    sessionId: prepared.sessionId,
    acquireQuerySlot: deps.acquireQuerySlot,
    afterSchemaError: false,
  });
  if (catalog.outcome === 'failed') {
    deps.report.log(`schema catalog skipped: ${catalog.error}`);
  } else if (catalog.outcome === 'fetched') {
    deps.report.log(`schema catalog cached: ${catalog.tableCount} tables`);
  }
}

function deriveRunContext(input: QueryRunInput): Pick<QueryRun, 'sessionTimeZone' | 'schemaContext'> {
  const { request, deps, prepared } = input;
  const { datasource } = prepared;
  const sessionTimeZone = resolveSessionTimeZone({
    override: request.tz,
    datasourceHint: datasource.resolverHints?.timeZone,
    configDefault: deps.ctx.runtimeConfigStore.queryTimeZone(),
  });
  const schemaContext = buildSchemaContext(prepared.query, deps.ctx.schemaCatalogStore.get(datasource.name));
  return { sessionTimeZone, schemaContext };
}

export async function startQueryRun(input: QueryRunInput): Promise<Attempt<QueryRun>> {
  const { request, deps, prepared } = input;
  const { ctx } = deps;
  const { sessionTimeZone, schemaContext } = deriveRunContext(input);
  void refreshCatalogInBackground(deps, prepared);
  const capability = request.allowMutate ? 'executeMutate' : 'executeRead';
  const selection = selectPlugin(ctx, prepared.datasource, capability);
  if ('refusal' in selection) {
    return { failed: failureOutcome(new Error(selection.refusal), { schemaContext }) };
  }
  const credentials = await ctx.credentialStore.get(prepared.datasource.credentialRef);
  return { value: { ...input, schemaContext, sessionTimeZone, capability, credentials, ...selection } };
}

export async function runQuery(run: QueryRun): Promise<QueryOutcome> {
  const { deps, prepared, schemaContext } = run;
  try {
    const guardWarnings = runSafetyGuards(run);
    const connectMs = await preflightConnectors(run);
    const execution = await executePlugin(run);
    return buildSuccessOutcome(run, { connectMs, execution }, [...prepared.warnings, ...guardWarnings]);
  } catch (error) {
    const failure = failureOutcome(error, { sessionId: prepared.sessionId, schemaContext });
    return refreshCatalogAndHintSchemaNames(failure, {
      ctx: deps.ctx,
      datasource: prepared.datasource,
      schemaContext,
      sessionId: prepared.sessionId,
      acquireQuerySlot: deps.acquireQuerySlot,
    });
  }
}
