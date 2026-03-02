import { Command } from 'commander';
import type { AppContext } from '../core/app.js';
import { classifyError, fillTemplate, normalizeService, parseParamPairs, runDatasourceConnectors } from '../core/app.js';
import { createRunArtifacts, writeRunSummary, appendEvent } from '../core/artifacts.js';
import { printJson, renderTable } from '../core/output.js';
import { enforceMutationPolicy } from '../core/safety.js';

function rowFromArray(columns: string[], row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of columns) out[c] = row[c];
  return out;
}

export function registerQuery(program: Command, getCtx: () => AppContext): void {
  program
    .command('query')
    .description('Execute plugin-native query against resolved datasource')
    .option('--datasource <name>')
    .option('--env <env>')
    .option('--service <service>')
    .option('--intent <intent>')
    .option('--template <id>')
    .option('--query <native>')
    .option('--param <key=value>', 'repeatable', (v, p: string[]) => (p || []).concat(v), [])
    .option('--allow-mutate', 'allow mutating query', false)
    .action(async (opts) => {
      const ctx = getCtx();
      let datasource = opts.datasource ? ctx.datasourceStore.get(opts.datasource) : undefined;
      const service = normalizeService(opts.service);
      if (!datasource && opts.env && service) {
        datasource = ctx.datasourceStore.resolveByEnvService(opts.env, service);
      }
      if (!datasource && opts.env && service) {
        const kb = ctx.kbStore.resolveConnection(service, opts.env);
        if (kb) {
          datasource = {
            name: `${opts.env}-${service}`,
            kind: String(kb.engine || 'mysql').toLowerCase().includes('postgres') ? 'postgres' : 'mysql',
            env: opts.env,
            service,
            tags: ['kb-derived'],
            connection: {
              host: kb.host as string | undefined,
              port: kb.port as number | undefined,
              target: kb.target as string | undefined,
              database: kb.database as string | undefined,
            },
            credentialRef: `${opts.env}:${service}`,
            policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
            updatedAt: new Date().toISOString(),
            confidence: 0.8,
          } as any;
          ctx.datasourceStore.save(datasource as any);
        }
      }
      if (!datasource) throw new Error('Datasource resolution failed. Use --datasource or --env+--service.');

      let query = (opts.query || '').trim();
      const params = parseParamPairs(opts.param || []);
      if (!query && opts.template) {
        const tpl = ctx.templateStore.get(opts.template);
        if (!tpl) throw new Error(`Template not found: ${opts.template}`);
        query = fillTemplate(tpl.nativeQueryTemplate, params);
      }
      if (!query && opts.intent) {
        const tpl = ctx.kbStore.resolveQuery(service || datasource.service || '', opts.intent) || ctx.templateStore.resolveByIntent({ datasourceName: datasource.name, datasourceKind: datasource.kind, intent: opts.intent });
        if (tpl) query = fillTemplate(String((tpl as any).nativeQueryTemplate), params);
      }
      if (!query) throw new Error('No query resolved. Provide --query, --template, or --intent.');

      enforceMutationPolicy({ sql: query, allowMutate: Boolean(opts.allowMutate), datasource: datasource as any });
      const capability = opts.allowMutate ? 'executeMutate' : 'executeRead';
      const plugin = ctx.pluginRegistry.get(datasource.kind);
      if (!plugin?.execute) throw new Error(`No execute-capable plugin for datasource kind '${datasource.kind}'.`);
      if (!plugin.manifest.capabilities.includes(capability as any)) {
        throw new Error(`Plugin '${plugin.manifest.name}' does not support capability ${capability}.`);
      }

      const creds = await ctx.credentialStore.get(datasource.credentialRef);
      const artifacts = createRunArtifacts(ctx.paths.runsDir, datasource.name.replace(/[^a-z0-9-]/gi, '-'));
      appendEvent(artifacts.runDir, `query started capability=${capability}`);
      try {
        const connectorChecks = await runDatasourceConnectors({
          datasource: datasource as any,
          credentialStore: ctx.credentialStore,
          pluginRegistry: ctx.pluginRegistry,
          mode: 'connect',
        });
        for (const c of connectorChecks) appendEvent(artifacts.runDir, `connector ${c.check} ${c.status}: ${c.detail}`);
        if (connectorChecks.some((c) => c.status === 'fail')) {
          throw new Error(`connector preflight failed: ${connectorChecks.filter((c) => c.status === 'fail').map((c) => c.detail).join(' | ')}`);
        }
        const result = await plugin.execute(
          {
            datasource: datasource as any,
            query,
            capability: capability as any,
          },
          creds,
        );
        result.runId = artifacts.runId;
        writeRunSummary(artifacts.runDir, result);
        appendEvent(artifacts.runDir, 'query succeeded');

        ctx.learningStore.saveSuccess({ datasource: datasource as any, queryIntent: opts.intent, sql: query, result });

        if (ctx.jsonMode) printJson(result);
        else console.log(renderTable(result.result.rows.map((r) => rowFromArray(result.result.columns, r))));
      } catch (error) {
        const message = (error as Error).message;
        const code = classifyError(message);
        appendEvent(artifacts.runDir, `query failed code=${code} message=${message}`);
        throw new Error(`${code}: ${message}`);
      }
    });
}
