import { Command } from 'commander';
import { normalizeNamespace, normalizeService } from '../core/app.js';
import type { AppContext } from '../core/app.js';
import { EXIT_CODES } from '../core/exit-codes.js';
import { printJson } from '../core/output.js';
import { collectReadinessSnapshot, nextCommandForReadiness } from '../core/readiness.js';
import { ensureStarterRuntime } from '../core/runtime-init.js';
import { TAPROOT_SKILL_VERSION, TAPROOT_VERSION } from '../core/version.js';
import { DoctorStatus } from '../types/core.js';

export function registerSelfCheck(program: Command, getCtx: () => AppContext): void {
  program
    .command('self-check')
    .description('Validate local runtime, stores, and built-in plugin registry')
    .option('--agent', 'emit agent-readiness summary', false)
    .option('--datasource <name>')
    .option('--env <env>')
    .option('--namespace <namespace>')
    .option('--service <service>')
    .action(async (opts) => {
      const ctx = getCtx();
      const createdConfig = ensureStarterRuntime(ctx);
      const target =
        opts.datasource || (opts.env && opts.service)
          ? {
              ...(opts.datasource ? { datasource: String(opts.datasource) } : {}),
              ...(opts.env ? { env: String(opts.env) } : {}),
              ...(opts.namespace ? { namespace: normalizeNamespace(String(opts.namespace)) } : {}),
              ...(opts.service ? { service: normalizeService(String(opts.service), ctx.runtimeConfigStore.serviceAliases()) } : {}),
            }
          : undefined;
      const snapshot = await collectReadinessSnapshot(ctx, { target, createdConfig });
      if (opts.agent) {
        const trimmedChecks = snapshot.checks.map((check) => check.status === DoctorStatus.Ok
          ? { check: check.check, status: check.status }
          : check);
        const data = {
          readiness: snapshot.readiness,
          missing: snapshot.readiness === 'ready' ? null : snapshot.readiness,
          nextCommand:
            snapshot.nextActionDetails[0]?.command ||
            nextCommandForReadiness(snapshot.readiness, {
              ...(snapshot.target?.datasource ? { datasource: ctx.datasourceStore.get(snapshot.target.datasource) } : {}),
              ...(target ? { target } : {}),
              checks: snapshot.checks,
            }),
          nextActionDetails: snapshot.nextActionDetails,
          checks: trimmedChecks,
          ...(snapshot.target ? { target: snapshot.target } : {}),
        };
        printJson(data);
        if (snapshot.readiness !== 'ready') process.exitCode = EXIT_CODES.NOT_READY;
        return;
      }

      const data = { cliVersion: TAPROOT_VERSION, skillVersion: TAPROOT_SKILL_VERSION, checks: snapshot.checks };
      printJson(data);
    });
}
