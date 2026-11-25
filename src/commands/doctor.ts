import type { Command } from 'commander';
import type { LocalExecutor } from '../cli/types.js';
import { createVerboseLog } from '../cli/verbose-log.js';
import type { AppContext } from '../core/app.js';
import { ensureStarterRuntime } from '../core/runtime-init.js';
import type { DatasourceProfile } from '../types/datasource.js';
import { reportDoctorChecks, runDoctorChecks } from './doctor-checks.js';
import { compareWithKb, reportKbRoutingBlocked } from './doctor-kb.js';
import { isDoctorCapable } from './doctor-plugin.js';
import type { DoctorCapablePlugin } from './doctor-plugin.js';
import { reportUnresolvedTarget, resolveDoctorDatasource } from './doctor-target.js';
import type { DoctorOptions } from './doctor-target.js';

function requireDoctorPlugin(ctx: AppContext, datasource: DatasourceProfile): DoctorCapablePlugin {
  const plugin = ctx.pluginRegistry.get(datasource.kind);
  if (!isDoctorCapable(plugin)) {
    throw new Error(`No doctor-capable plugin for datasource kind '${datasource.kind}'.`);
  }
  return plugin;
}

async function doctorDatasource(ctx: AppContext, datasource: DatasourceProfile, connect: boolean): Promise<void> {
  const target = { datasource, plugin: requireDoctorPlugin(ctx, datasource) };
  const kbComparison = compareWithKb(ctx, datasource);
  if (kbComparison.blockingConflicts.length > 0) {
    reportKbRoutingBlocked(target, kbComparison.blockingConflicts);
    return;
  }
  const checks = await runDoctorChecks(ctx, target, connect);
  reportDoctorChecks(target, kbComparison.warnings, checks);
}

async function runDoctor(ctx: AppContext, opts: DoctorOptions): Promise<void> {
  ensureStarterRuntime(ctx);
  const resolution = resolveDoctorDatasource(ctx, opts);
  if ('unresolved' in resolution) {
    reportUnresolvedTarget(resolution.unresolved, createVerboseLog(ctx));
    return;
  }
  await doctorDatasource(ctx, resolution.datasource, opts.connect);
}

export function doctorCommand(program: Command, executor: LocalExecutor): void {
  program
    .command('doctor')
    .description('Check one datasource: connectors, credentials and connection. Not needed before a routine query.')
    .option('--datasource <name>', 'datasource profile name; find one with taproot datasource list <pattern>')
    .option('--env <env>', 'environment (e.g. qa, stg); pair with --service when no --datasource is given')
    .option('--namespace <namespace>', 'namespace within the environment (e.g. develop)')
    .option('--service <service>', 'service name; pair with --env')
    .option('--connect', 'run connector connect steps during doctor', false)
    .action(async (opts: DoctorOptions) => {
      await runDoctor(executor.context(), opts);
    });
}
