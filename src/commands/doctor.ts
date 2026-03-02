import { Command } from 'commander';
import type { AppContext } from '../core/app.js';
import { classifyError, normalizeService, runDatasourceConnectors } from '../core/app.js';
import { exitCodeForClass } from '../core/exit-codes.js';
import { renderTable, printJson } from '../core/output.js';
import { createProgress } from '../core/progress.js';

function compactDetail(detail: string, max = 160): string {
  const oneLine = detail.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}...`;
}

export function registerDoctor(program: Command, getCtx: () => AppContext): void {
  program
    .command('doctor')
    .description('Preflight checks against resolved datasource/plugin')
    .option('--datasource <name>')
    .option('--env <env>')
    .option('--service <service>')
    .option('--connect', 'run connector connect steps during doctor', false)
    .option('--verbose-detail', 'print full check details in table mode', false)
    .option('--all', 'print all checks in table mode (default: warnings/failures only)', false)
    .action(async (opts) => {
      const ctx = getCtx();
      const progress = createProgress({
        enabled: !ctx.jsonMode && !ctx.verbose,
        noAnimations: ctx.noAnimations,
        noColor: ctx.noColor,
        verbose: ctx.verbose,
        plainUpdates: !ctx.jsonMode && process.stderr.isTTY,
      });
      const logVerbose = (msg: string): void => {
        if (!ctx.jsonMode && ctx.verbose) process.stderr.write(`[telequery] ${msg}\n`);
      };

      try {
        progress.update('resolving datasource');
        let datasource = opts.datasource ? ctx.datasourceStore.get(opts.datasource) : undefined;
        if (!datasource && opts.env && opts.service) {
          const service = normalizeService(opts.service);
          datasource = ctx.datasourceStore.resolveByEnvService(opts.env, service);
          if (!datasource) {
            const kb = ctx.kbStore.resolveConnection(service, opts.env);
            if (kb) {
              const dsFromKb = {
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
              datasource = ctx.datasourceStore.save(dsFromKb);
              logVerbose(`bootstrapped datasource from KB (${dsFromKb.name})`);
            }
          }
        }
        if (!datasource) {
          progress.fail('could not resolve datasource');
          throw new Error('Could not resolve datasource. Use --datasource or --env+--service.');
        }
        progress.update(`checking plugin for ${datasource.name}`);
        const plugin = ctx.pluginRegistry.get(datasource.kind);
        if (!plugin || !plugin.doctor) {
          progress.fail('doctor capability unavailable');
          throw new Error(`No doctor-capable plugin for datasource kind '${datasource.kind}'.`);
        }
        const creds = await ctx.credentialStore.get(datasource.credentialRef);
        progress.update('running connector checks');
        const connectorChecks = await runDatasourceConnectors({
          datasource: datasource as any,
          credentialStore: ctx.credentialStore,
          pluginRegistry: ctx.pluginRegistry,
          mode: 'doctor',
        });
        const checks = [...connectorChecks];
        if (opts.connect) {
          progress.update('running connector connect step');
          checks.push(
            ...(await runDatasourceConnectors({
              datasource: datasource as any,
              credentialStore: ctx.credentialStore,
              pluginRegistry: ctx.pluginRegistry,
              mode: 'connect',
            })),
          );
        }
        progress.update(`running plugin doctor (${plugin.manifest.name})`);
        checks.push(...(await plugin.doctor({ datasource, credentials: creds })));

        const failCount = checks.filter((c) => c.status === 'fail').length;
        const warnCount = checks.filter((c) => c.status === 'warn').length;
        const okCount = checks.filter((c) => c.status === 'ok').length;
        const tableRows = checks.map((c) => ({
          check: c.check,
          status: c.status,
          detail: opts.verboseDetail || ctx.verbose ? c.detail : compactDetail(c.detail),
        }));
        const visibleRows = opts.all || ctx.verbose ? tableRows : tableRows.filter((r) => r.status !== 'ok');

        if (ctx.jsonMode) {
          printJson({
            datasource: datasource.name,
            plugin: plugin.manifest.name,
            checks,
            summary: { ok: okCount, warn: warnCount, fail: failCount, total: checks.length },
          });
        } else {
          const summary = `doctor summary: ok=${okCount} warn=${warnCount} fail=${failCount} total=${checks.length}`;
          if (ctx.verbose) {
            console.log(summary);
          } else if (!failCount && !warnCount) {
            progress.succeed(summary);
          } else {
            progress.warn(summary);
          }
          if (visibleRows.length) {
            console.log(renderTable(visibleRows));
          } else if (opts.all || ctx.verbose) {
            console.log('No checks to display.');
          }
        }

        if (checks.some((c) => c.status === 'fail')) {
          const firstFailure = checks.find((c) => c.status === 'fail');
          const code = classifyError(firstFailure?.detail || '');
          process.exitCode = exitCodeForClass(code);
        }
      } finally {
        progress.stop();
      }
    });
}
