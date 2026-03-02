import { Command } from 'commander';
import type { AppContext } from '../core/app.js';
import { normalizeService, runDatasourceConnectors } from '../core/app.js';
import { renderTable, printJson } from '../core/output.js';

export function registerDoctor(program: Command, getCtx: () => AppContext): void {
  program
    .command('doctor')
    .description('Preflight checks against resolved datasource/plugin')
    .option('--datasource <name>')
    .option('--env <env>')
    .option('--service <service>')
    .option('--connect', 'run connector connect steps during doctor', false)
    .action(async (opts) => {
      const ctx = getCtx();
      let datasource = opts.datasource ? ctx.datasourceStore.get(opts.datasource) : undefined;
      if (!datasource && opts.env && opts.service) {
        const service = normalizeService(opts.service);
        datasource = ctx.datasourceStore.resolveByEnvService(opts.env, service);
        if (!datasource) {
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
      }
      if (!datasource) throw new Error('Could not resolve datasource. Use --datasource or --env+--service.');
      const plugin = ctx.pluginRegistry.get(datasource.kind);
      if (!plugin || !plugin.doctor) throw new Error(`No doctor-capable plugin for datasource kind '${datasource.kind}'.`);
      const creds = await ctx.credentialStore.get(datasource.credentialRef);
      const connectorChecks = await runDatasourceConnectors({
        datasource: datasource as any,
        credentialStore: ctx.credentialStore,
        pluginRegistry: ctx.pluginRegistry,
        mode: 'doctor',
      });
      const checks = [...connectorChecks];
      if (opts.connect) {
        checks.push(
          ...(await runDatasourceConnectors({
            datasource: datasource as any,
            credentialStore: ctx.credentialStore,
            pluginRegistry: ctx.pluginRegistry,
            mode: 'connect',
          })),
        );
      }
      checks.push(...(await plugin.doctor({ datasource, credentials: creds })));
      if (ctx.jsonMode) printJson({ datasource: datasource.name, plugin: plugin.manifest.name, checks });
      else console.log(renderTable(checks.map((c) => ({ check: c.check, status: c.status, detail: c.detail }))));
      if (checks.some((c) => c.status === 'fail')) process.exitCode = 1;
    });
}
