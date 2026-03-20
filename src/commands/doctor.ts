import { Command } from 'commander';
import type { AppContext } from '../core/app.js';
import { classifyError, normalizeService, runDatasourceConnectors } from '../core/app.js';
import { criticalDatasourceKbConflicts, datasourceKbConflicts } from '../core/conflicts.js';
import { exitCodeForClass } from '../core/exit-codes.js';
import { renderTable, printJson } from '../core/output.js';
import { createProgress } from '../core/progress.js';

function compactDetail(detail: string, max = 160): string {
  const oneLine = detail.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}...`;
}

function doctorNextActions(datasourceName: string, checks: Array<{ check: string; status: string; detail: string }>): string[] {
  const actions = new Set<string>();
  for (const check of checks) {
    const label = String(check.check || '').toLowerCase();
    const detail = String(check.detail || '');
    if (check.status === 'ok') continue;

    if (label.startsWith('openvpn')) {
      if (/no connectcommand configured/i.test(detail)) {
        actions.add(`taproot connector setup --datasource ${datasourceName} --connector openvpn --connect-command '<command>' --status-command '<command>'`);
      } else {
        actions.add(`taproot doctor --datasource ${datasourceName} --connect`);
      }
    }
    if (label.startsWith('teleport')) {
      if (/no logincommand configured/i.test(detail)) {
        actions.add(`taproot connector setup --datasource ${datasourceName} --connector teleport --login-command 'tsh login --proxy <proxy> --auth <auth>'`);
      } else {
        actions.add(`taproot doctor --datasource ${datasourceName} --connect`);
      }
    }
    if (label.startsWith('kubectl-portforward')) {
      if (/no connectcommand configured/i.test(detail) || /no statuscommand configured/i.test(detail)) {
        actions.add(`taproot connector setup --datasource ${datasourceName} --connector kubectl-portforward --status-command '<command>' --connect-command '<command>'`);
      } else {
        actions.add(`taproot doctor --datasource ${datasourceName} --connect`);
      }
    }
    if (/connect/i.test(label)) {
      actions.add(`taproot doctor --datasource ${datasourceName} --connect`);
    }
  }
  return [...actions];
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
        if (!ctx.jsonMode && ctx.verbose) process.stderr.write(`[taproot] ${msg}\n`);
      };

      try {
        progress.update('resolving datasource');
        let datasource = opts.datasource ? ctx.datasourceStore.get(opts.datasource) : undefined;
        const warnings: string[] = [];
        if (!datasource && opts.env && opts.service) {
          const service = normalizeService(opts.service, ctx.runtimeConfigStore.serviceAliases());
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
        if (datasource.env && datasource.service) {
          const kb = ctx.kbStore.resolveConnection(datasource.service, datasource.env);
          if (kb) {
            const critical = criticalDatasourceKbConflicts(datasource as any, kb);
            if (critical.length) {
              const checks = [
                {
                  check: 'kb routing consistency',
                  status: 'fail' as const,
                  detail: `MISCONFIGURED_DATASOURCE: ${critical.join('; ')}`,
                },
              ];
              checks.push({
                check: 'doctor blocked',
                status: 'warn',
                detail: 'plugin/connectivity checks skipped until datasource routing matches KB',
              });
              if (ctx.jsonMode) {
                printJson({
                  datasource: datasource.name,
                  plugin: plugin.manifest.name,
                  warnings,
                  checks,
                  nextActions: [`taproot --json init datasource --env ${datasource.env} --service ${datasource.service}`],
                  summary: { ok: 0, warn: 1, fail: 1, total: checks.length },
                });
              } else {
                console.log(renderTable(checks.map((c) => ({ check: c.check, status: c.status, detail: c.detail }))));
                console.log('Next actions:');
                console.log(`- taproot --json init datasource --env ${datasource.env} --service ${datasource.service}`);
              }
              process.exitCode = exitCodeForClass('MISCONFIGURED_DATASOURCE');
              return;
            }
            const conflicts = datasourceKbConflicts(datasource as any, kb);
            if (conflicts.length) warnings.push(`datasource overrides KB (${conflicts.join('; ')})`);
          }
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
        const nextActions = doctorNextActions(datasource.name, checks);

        if (ctx.jsonMode) {
          printJson({
            datasource: datasource.name,
            plugin: plugin.manifest.name,
            warnings,
            checks,
            nextActions,
            summary: { ok: okCount, warn: warnCount, fail: failCount, total: checks.length },
          });
        } else {
          if (warnings.length) progress.warn(`warnings: ${warnings.join(' | ')}`);
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
          if (nextActions.length) {
            console.log('Next actions:');
            for (const action of nextActions) console.log(`- ${action}`);
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
