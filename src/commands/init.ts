import path from 'node:path';
import type { Command } from 'commander';
import type { LocalExecutor } from '../cli/types.js';
import type { AppContext } from '../core/app.js';
import { printSuccess } from '../core/output.js';
import { collectReadinessSnapshot } from '../core/readiness.js';
import { ensureStarterRuntime } from '../core/runtime-init.js';
import { textUnlessFalsy } from '../core/text-presence.js';
import { DoctorStatus } from '../types/plugin.js';
import type { DoctorCheck } from '../types/plugin.js';
import { initDatasource } from './init-datasource.js';
import type { InitDatasourceOptions } from './init-datasource.js';

function kbDirRequestedForSave(program: Command, ctx: AppContext): string {
  const fromFlag = textUnlessFalsy(program.opts<{ kbDir?: string }>().kbDir).trim();
  if (fromFlag !== '') {
    return fromFlag;
  }
  const kbDirAlreadySaved = (ctx.runtimeConfigStore.get().kbDir ?? '') !== '';
  return kbDirAlreadySaved ? '' : textUnlessFalsy(process.env.TAPROOT_KB_DIR).trim();
}

function compactCheck(check: DoctorCheck): Pick<DoctorCheck, 'check' | 'status'> | DoctorCheck {
  return check.status === DoctorStatus.Ok ? { check: check.check, status: check.status } : check;
}

async function initRuntime(program: Command, ctx: AppContext): Promise<void> {
  const createdConfig = ensureStarterRuntime(ctx);
  const kbDirToSave = kbDirRequestedForSave(program, ctx);
  const hasKbDirToSave = kbDirToSave !== '';
  if (hasKbDirToSave) {
    ctx.runtimeConfigStore.saveKbDir(path.resolve(kbDirToSave));
  }
  const snapshot = await collectReadinessSnapshot(ctx, { createdConfig });
  printSuccess({
    checks: snapshot.checks.map(compactCheck),
    readiness: snapshot.readiness,
    ...(hasKbDirToSave ? { savedKbDir: path.resolve(kbDirToSave) } : {}),
  });
}

export function initCommand(program: Command, executor: LocalExecutor): void {
  const init = program.command('init').description('Initialize local TapRoot runtime state for first use');

  init.action(async () => {
    await initRuntime(program, executor.context());
  });

  init.command('datasource')
    .description('Create a datasource profile from KB-backed connection metadata')
    .requiredOption('--env <env>', 'environment (e.g. qa, stg)')
    .option('--namespace <namespace>', 'namespace within the environment (e.g. develop)')
    .requiredOption('--service <service>', 'service name')
    .action(async (opts: InitDatasourceOptions) => {
      await initDatasource(executor.context(), opts);
    });
}
