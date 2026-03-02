import fs from 'node:fs';
import { Command } from 'commander';
import type { AppContext } from '../core/app.js';
import { printEnvelope, printJson } from '../core/output.js';

export function registerSelfCheck(program: Command, getCtx: () => AppContext): void {
  program
    .command('self-check')
    .description('Validate local runtime, stores, and built-in plugin registry')
    .action(() => {
      const ctx = getCtx();
      const checks = [
        { check: 'node_version', status: 'ok', detail: process.version },
        { check: 'state_root', status: fs.existsSync(ctx.paths.stateRoot) ? 'ok' : 'fail', detail: ctx.paths.stateRoot },
        { check: 'kb_dir', status: fs.existsSync(ctx.paths.kbDir) ? 'ok' : 'warn', detail: ctx.paths.kbDir },
        { check: 'plugins', status: 'ok', detail: ctx.pluginRegistry.list().map((p) => p.manifest.name).join(', ') },
      ];
      const data = { cliVersion: '0.1.0', skillVersion: '0.1.0', checks };
      if (ctx.jsonMode) printJson(data);
      else checks.forEach((c) => console.log(`${c.status.toUpperCase()} ${c.check}: ${c.detail}`));
    });
}
