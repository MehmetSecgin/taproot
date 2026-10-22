import path from 'node:path';
import { Command } from 'commander';
import type { AppContext } from '../core/app.js';
import { defaultDatasourceName, normalizeNamespace, normalizeService } from '../core/app.js';
import { reconcileDatasource } from '../core/bootstrap.js';
import { printEnvelope } from '../core/output.js';
import { collectReadinessSnapshot } from '../core/readiness.js';
import { ensureStarterRuntime } from '../core/runtime-init.js';
import { str } from '../core/strings.js';
import { DoctorStatus } from '../types/core.js';

export function registerInit(program: Command, getCtx: () => AppContext): void {
  const init = program.command('init').description('Initialize local TapRoot runtime state for first use');

  init.action(async () => {
    const ctx = getCtx();
    const createdConfig = ensureStarterRuntime(ctx);
    const kbDirToSave = str(program.opts().kbDir).trim() || (ctx.runtimeConfigStore.get().kbDir ? '' : str(process.env.TAPROOT_KB_DIR).trim());
    if (kbDirToSave) ctx.runtimeConfigStore.saveKbDir(path.resolve(kbDirToSave));
    const snapshot = await collectReadinessSnapshot(ctx, { createdConfig });
    const trimmedChecks = snapshot.checks.map((check) => check.status === DoctorStatus.Ok
      ? { check: check.check, status: check.status }
      : check);
    const data = {
      checks: trimmedChecks,
      readiness: snapshot.readiness,
      ...(kbDirToSave ? { savedKbDir: path.resolve(kbDirToSave) } : {}),
    };
    printEnvelope(true, data);
  });

  init.command('datasource')
    .description('Create a datasource profile from KB-backed connection metadata')
    .requiredOption('--env <env>')
    .option('--namespace <namespace>')
    .requiredOption('--service <service>')
    .action(async (opts) => {
      const ctx = getCtx();
      ctx.kbStore.requirePresent();
      const service = normalizeService(opts.service, ctx.runtimeConfigStore.serviceAliases());
      const namespace = normalizeNamespace(opts.namespace);
      const datasourceName = defaultDatasourceName(opts.env, service, namespace || undefined);
      const result = await reconcileDatasource(ctx, opts.env, service, datasourceName, namespace || undefined);
      if (!result) {
        throw new Error(`No KB data found for env=${opts.env}${namespace ? ` namespace=${namespace}` : ''} service=${service}`);
      }
      const data = {
        source: result.source,
        skipped: result.source === 'store-existing',
        profile: result.profile,
        credentialRefs: result.credentialRefs,
        connectors: result.connectors,
        warnings: result.warnings,
      };
      printEnvelope(true, data);
    });
}
