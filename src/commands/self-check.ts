import { Command } from 'commander';
import type { AppContext } from '../core/app.js';
import { EXIT_CODES } from '../core/exit-codes.js';
import { printJson } from '../core/output.js';
import { collectReadinessSnapshot, nextCommandForReadiness } from '../core/readiness.js';
import { TAPROOT_SKILL_VERSION, TAPROOT_VERSION } from '../core/version.js';

export function registerSelfCheck(program: Command, getCtx: () => AppContext): void {
  program
    .command('self-check')
    .description('Validate local runtime, stores, and built-in plugin registry')
    .option('--agent', 'emit agent-readiness summary', false)
    .action(async (opts) => {
      const ctx = getCtx();
      const snapshot = await collectReadinessSnapshot(ctx);
      if (opts.agent) {
        const data = {
          readiness: snapshot.readiness,
          missing: snapshot.readiness === 'ready' ? null : snapshot.readiness,
          nextCommand: nextCommandForReadiness(snapshot.readiness),
          checks: snapshot.checks,
        };
        if (ctx.jsonMode) printJson(data);
        else {
          console.log(`readiness: ${data.readiness}`);
          if (data.missing) console.log(`missing: ${data.missing}`);
          if (data.nextCommand) console.log(`nextCommand: ${data.nextCommand}`);
          snapshot.checks.forEach((check) => console.log(`${check.status.toUpperCase()} ${check.check}: ${check.detail}`));
        }
        if (snapshot.readiness !== 'ready') process.exitCode = EXIT_CODES.NOT_READY;
        return;
      }

      const data = { cliVersion: TAPROOT_VERSION, skillVersion: TAPROOT_SKILL_VERSION, checks: snapshot.checks };
      if (ctx.jsonMode) printJson(data);
      else snapshot.checks.forEach((check) => console.log(`${check.status.toUpperCase()} ${check.check}: ${check.detail}`));
    });
}
