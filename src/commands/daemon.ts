import { Command } from 'commander';
import type { AppContext } from '../core/app.js';
import { printJson, renderRecord } from '../core/output.js';
import { createProgress } from '../core/progress.js';
import { rpcCall } from '../daemon/client.js';
import { daemonLogPath, spawnDaemon } from '../daemon/spawn.js';
import { RpcMethod } from '../daemon/types.js';

function shouldPrintPlainSuccess(ctx: AppContext): boolean {
  if (ctx.jsonMode) return false;
  if (ctx.verbose) return true;
  return !process.stderr.isTTY;
}

export function registerDaemon(program: Command, getCtx: () => AppContext): void {
  const d = program.command('daemon').description('taproot daemon operations');

  d.command('start').action(async () => {
    const ctx = getCtx();
    const progress = createProgress({
      enabled: !ctx.jsonMode && !ctx.verbose,
      noAnimations: ctx.noAnimations,
      noColor: ctx.noColor,
      verbose: ctx.verbose,
      plainUpdates: !ctx.jsonMode && process.stderr.isTTY,
    });
    try {
      progress.update('starting taprootd');
      const res = await spawnDaemon();
      if (res) {
        if (ctx.jsonMode) printJson({ started: true, status: res.data });
        else {
          if (shouldPrintPlainSuccess(ctx)) console.log('taprootd started');
          else progress.succeed('taprootd started');
        }
        return;
      }
      progress.fail('taprootd start timed out');
      throw new Error(`taprootd did not become healthy within timeout. Check ${daemonLogPath()}`);
    } finally {
      progress.stop();
    }
  });

  d.command('status').action(async () => {
    const ctx = getCtx();
    const res = await rpcCall({ method: RpcMethod.DaemonStatus });
    if (!res.ok) throw new Error(res.error?.message || 'daemon status failed');
    if (ctx.jsonMode) {
      printJson({
        ok: true,
        data: res.data || {},
        meta: { ...(res.meta || {}), requestId: res.requestId },
      });
    }
    else console.log(renderRecord((res.data || {}) as Record<string, unknown>));
  });

  d.command('stop').action(async () => {
    const ctx = getCtx();
    const progress = createProgress({
      enabled: !ctx.jsonMode && !ctx.verbose,
      noAnimations: ctx.noAnimations,
      noColor: ctx.noColor,
      verbose: ctx.verbose,
      plainUpdates: !ctx.jsonMode && process.stderr.isTTY,
    });
    try {
      progress.update('stopping taprootd');
      const res = await rpcCall({ method: RpcMethod.DaemonStop });
      if (!res.ok) throw new Error(res.error?.message || 'daemon stop failed');
      if (ctx.jsonMode) {
        printJson({
          ok: true,
          data: res.data || {},
          meta: { ...(res.meta || {}), requestId: res.requestId },
        });
      }
      else {
        if (shouldPrintPlainSuccess(ctx)) console.log('taprootd stopped');
        else progress.succeed('taprootd stopped');
      }
    } finally {
      progress.stop();
    }
  });

  d.command('restart').action(async () => {
    const ctx = getCtx();
    const progress = createProgress({
      enabled: !ctx.jsonMode && !ctx.verbose,
      noAnimations: ctx.noAnimations,
      noColor: ctx.noColor,
      verbose: ctx.verbose,
      plainUpdates: !ctx.jsonMode && process.stderr.isTTY,
    });
    try {
      progress.update('restarting taprootd');
      try {
        await rpcCall({ method: RpcMethod.DaemonStop });
      } catch {
        // ignore if not running
      }
      if (!(await spawnDaemon())) {
        progress.fail('taprootd restart timed out');
        throw new Error(`taprootd did not become healthy within timeout. Check ${daemonLogPath()}`);
      }
      if (shouldPrintPlainSuccess(ctx)) console.log('taprootd restarted');
      else progress.succeed('taprootd restarted');
    } finally {
      progress.stop();
    }
  });
}
