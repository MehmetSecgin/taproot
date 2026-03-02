import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Command } from 'commander';
import type { AppContext } from '../core/app.js';
import { printJson } from '../core/output.js';
import { createProgress } from '../core/progress.js';
import { rpcCall } from '../daemon/client.js';

function runDirFromCtx(ctx: AppContext): string {
  return path.join(ctx.paths.stateRoot || path.join(os.homedir(), '.taproot'), 'run');
}

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
      const runDir = runDirFromCtx(ctx);
      fs.mkdirSync(runDir, { recursive: true });
      const logPath = path.join(runDir, 'taprootd.log');
      progress.update('starting taprootd');
      const child = spawn(process.execPath, [path.join(process.cwd(), 'dist', 'daemon-main.js')], {
        detached: true,
        stdio: ['ignore', fs.openSync(logPath, 'a'), fs.openSync(logPath, 'a')],
      });
      child.unref();

      const startedAt = Date.now();
      while (Date.now() - startedAt < 5000) {
        try {
          progress.update('waiting for daemon health check');
          const res = await rpcCall({ method: 'daemon.status' });
          if (res.ok) {
            if (ctx.jsonMode) printJson({ started: true, status: res.data });
            else {
              if (shouldPrintPlainSuccess(ctx)) console.log('taprootd started');
              else progress.succeed('taprootd started');
            }
            return;
          }
        } catch {
          // wait for daemon
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      progress.fail('taprootd start timed out');
      throw new Error(`taprootd did not become healthy within timeout. Check ${logPath}`);
    } finally {
      progress.stop();
    }
  });

  d.command('status').action(async () => {
    const ctx = getCtx();
    const res = await rpcCall({ method: 'daemon.status' });
    if (!res.ok) throw new Error(res.error?.message || 'daemon status failed');
    printJson(res.data || {});
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
      const res = await rpcCall({ method: 'daemon.stop' });
      if (!res.ok) throw new Error(res.error?.message || 'daemon stop failed');
      if (ctx.jsonMode) printJson(res.data || {});
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
        await rpcCall({ method: 'daemon.stop' });
      } catch {
        // ignore if not running
      }
      const runDir = runDirFromCtx(ctx);
      fs.mkdirSync(runDir, { recursive: true });
      const logPath = path.join(runDir, 'taprootd.log');
      const child = spawn(process.execPath, [path.join(process.cwd(), 'dist', 'daemon-main.js')], {
        detached: true,
        stdio: ['ignore', fs.openSync(logPath, 'a'), fs.openSync(logPath, 'a')],
      });
      child.unref();
      if (shouldPrintPlainSuccess(ctx)) console.log('taprootd restarted');
      else progress.succeed('taprootd restarted');
    } finally {
      progress.stop();
    }
  });
}
