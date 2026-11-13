import { Command } from 'commander';
import type { AppContext } from '../core/app.js';
import { criticalDatasourceKbConflicts, datasourceKbConflicts } from '../core/conflicts.js';
import { runDatasourceConnectors } from '../core/connector-runner.js';
import { badInput, classifyError } from '../core/error-classification.js';
import { doctorAll, selectDatasources } from '../core/doctor-all.js';
import { EXIT_CODES, exitCodeForClass } from '../core/exit-codes.js';
import { normalizeNamespace, normalizeService } from '../core/naming.js';
import { printEnvelope } from '../core/output.js';
import { ensureStarterRuntime } from '../core/runtime-init.js';
import { verboseLog } from './query-direct.js';
import { DoctorStatus } from '../types/core.js';
import type { DoctorCheck } from '../types/core.js';

interface UnresolvedTarget {
  env: string;
  service: string;
  namespace?: string;
  kbAvailable: boolean;
}

function unresolvedTargetLabel(target: UnresolvedTarget): string {
  return `env=${target.env}${target.namespace ? ` namespace=${target.namespace}` : ''} service=${target.service}`;
}

function unresolvedTargetChecks(target: UnresolvedTarget): DoctorCheck[] {
  const label = unresolvedTargetLabel(target);
  return [
    {
      check: 'target_datasource',
      status: DoctorStatus.Fail,
      detail: `No datasource profile for ${label}; doctor reports state and does not create one`,
    },
    {
      check: 'kb routing',
      status: target.kbAvailable ? DoctorStatus.Ok : DoctorStatus.Warn,
      detail: target.kbAvailable
        ? `KB has a connection for ${label}, so the profile can be created from it`
        : `KB has no connection for ${label}, so the profile has to be described by hand`,
    },
    {
      check: 'doctor blocked',
      status: DoctorStatus.Warn,
      detail: 'plugin/connectivity checks skipped until the datasource profile exists',
    },
  ];
}

export function registerDoctor(program: Command, getCtx: () => AppContext): void {
  program
    .command('doctor')
    .description('Check one datasource: connectors, credentials and connection. Not needed before a routine query.')
    .option('--datasource <name>', 'datasource profile name; find one with taproot datasource list <pattern>')
    .option('--env <env>', 'environment (e.g. qa, stg); pair with --service when no --datasource is given')
    .option('--namespace <namespace>', 'namespace within the environment (e.g. develop)')
    .option('--service <service>', 'service name; pair with --env')
    .option('--connect', 'run connector connect steps during doctor', false)
    .option('--all', 'check every datasource of --env (filter with --namespace, --kind); never runs connect steps', false)
    .option('--kind <kind>', 'with --all: only datasources of this kind (e.g. redis)')
    .option('--tcp-only', 'with --all: only open a TCP connection to host:port; no credentials, no query', false)
    .action(async (opts) => {
      const ctx = getCtx();
      ensureStarterRuntime(ctx);
      if (opts.all) {
        if (!opts.env) throw badInput('doctor --all needs --env <env>.');
        if (opts.datasource || opts.service) throw badInput('doctor --all checks a whole environment; drop --datasource and --service.');
        if (opts.connect) throw badInput('doctor --all never runs connect steps; run doctor --datasource <name> --connect for one datasource.');
        const selected = selectDatasources(ctx.datasourceStore.list(), {
          env: opts.env,
          namespace: normalizeNamespace(opts.namespace) || undefined,
          kind: opts.kind,
        });
        const rows = await doctorAll(ctx, selected, Boolean(opts.tcpOnly));
        printEnvelope(true, { rows });
        if (rows.some((r) => r.status !== 'reachable')) process.exitCode = EXIT_CODES.NOT_READY;
        return;
      }
      const logVerbose = verboseLog(ctx);
      let datasource = opts.datasource ? ctx.datasourceStore.get(opts.datasource) : undefined;
      const warnings: string[] = [];
      if (!datasource && opts.env && opts.service) {
        const service = normalizeService(opts.service, ctx.runtimeConfigStore.serviceAliases());
        const namespace = normalizeNamespace(opts.namespace);
        datasource = ctx.datasourceStore.resolveByEnvService(opts.env, service, namespace || undefined);
        if (!datasource) {
          const target: UnresolvedTarget = {
            env: opts.env,
            service,
            namespace: namespace || undefined,
            kbAvailable: Boolean(ctx.kbStore.resolveConnection(service, opts.env, namespace || undefined)),
          };
          logVerbose(`no datasource profile for ${unresolvedTargetLabel(target)}`);
          const checks = unresolvedTargetChecks(target);
          printEnvelope(true, {
            checks,
            summary: { ok: target.kbAvailable ? 1 : 0, warn: target.kbAvailable ? 1 : 2, fail: 1, total: checks.length },
          });
          process.exitCode = EXIT_CODES.NOT_READY;
          return;
        }
      }
      if (!datasource) {
        throw new Error('Could not resolve datasource. Use --datasource or --env+--service.');
      }
      const plugin = ctx.pluginRegistry.get(datasource.kind);
      if (!plugin || !plugin.doctor) {
        throw new Error(`No doctor-capable plugin for datasource kind '${datasource.kind}'.`);
      }
      if (datasource.env && datasource.service) {
        const kb = ctx.kbStore.resolveConnection(datasource.service, datasource.env, datasource.namespace);
        if (kb) {
          const critical = criticalDatasourceKbConflicts(datasource, kb);
          if (critical.length) {
            const checks: DoctorCheck[] = [
              {
                check: 'kb routing consistency',
                status: DoctorStatus.Fail,
                detail: `MISCONFIGURED_DATASOURCE: ${critical.join('; ')}`,
              },
            ];
            checks.push({
              check: 'doctor blocked',
              status: DoctorStatus.Warn,
              detail: 'plugin/connectivity checks skipped until datasource routing matches KB',
            });
            printEnvelope(true, {
              datasource: datasource.name,
              plugin: plugin.manifest.name,
              checks,
              summary: { ok: 0, warn: 1, fail: 1, total: checks.length },
            });
            process.exitCode = exitCodeForClass('MISCONFIGURED_DATASOURCE');
            return;
          }
          const conflicts = datasourceKbConflicts(datasource, kb);
          if (conflicts.length) warnings.push(`datasource overrides KB (${conflicts.join('; ')})`);
        }
      }
      const creds = await ctx.credentialStore.get(datasource.credentialRef);
      const connectorInput = { datasource, credentialStore: ctx.credentialStore, pluginRegistry: ctx.pluginRegistry };
      const checks = opts.connect ? await runDatasourceConnectors({ ...connectorInput, mode: 'connect' }) : [];
      checks.push(...(await runDatasourceConnectors({ ...connectorInput, mode: 'doctor' })));
      checks.push(...(await plugin.doctor({ datasource, credentials: creds })));

      const failCount = checks.filter((c) => c.status === DoctorStatus.Fail).length;
      const warnCount = checks.filter((c) => c.status === DoctorStatus.Warn).length;
      const okCount = checks.filter((c) => c.status === DoctorStatus.Ok).length;

      printEnvelope(true, {
        datasource: datasource.name,
        plugin: plugin.manifest.name,
        ...(warnings.length ? { warnings } : {}),
        checks,
        summary: { ok: okCount, warn: warnCount, fail: failCount, total: checks.length },
      });

      if (checks.some((c) => c.status === DoctorStatus.Fail)) {
        const firstFailure = checks.find((c) => c.status === DoctorStatus.Fail);
        const code = classifyError(firstFailure?.detail || '');
        process.exitCode = exitCodeForClass(code);
      }
    });
}
