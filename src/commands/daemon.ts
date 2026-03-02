import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Command } from 'commander';
import type { AppContext } from '../core/app.js';
import { printJson } from '../core/output.js';
import { rpcCall } from '../daemon/client.js';

function runDirFromCtx(ctx: AppContext): string {
  return path.join(ctx.paths.stateRoot || path.join(os.homedir(), '.telequery'), 'run');
}

export function registerDaemon(program: Command, getCtx: () => AppContext): void {
  const d = program.command('daemon').description('telequery daemon operations');

  d.command('start').action(async () => {
    const ctx = getCtx();
    const runDir = runDirFromCtx(ctx);
    fs.mkdirSync(runDir, { recursive: true });
    const logPath = path.join(runDir, 'telequeryd.log');
    const child = spawn(process.execPath, [path.join(process.cwd(), 'dist', 'daemon-main.js')], {
      detached: true,
      stdio: ['ignore', fs.openSync(logPath, 'a'), fs.openSync(logPath, 'a')],
    });
    child.unref();

    const startedAt = Date.now();
    while (Date.now() - startedAt < 5000) {
      try {
        const res = await rpcCall({ method: 'daemon.status' });
        if (res.ok) {
          if (ctx.jsonMode) printJson({ started: true, status: res.data });
          else console.log('telequeryd started');
          return;
        }
      } catch {
        // wait for daemon
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`telequeryd did not become healthy within timeout. Check ${logPath}`);
  });

  d.command('status').action(async () => {
    const ctx = getCtx();
    const res = await rpcCall({ method: 'daemon.status' });
    if (!res.ok) throw new Error(res.error?.message || 'daemon status failed');
    printJson(res.data || {});
  });

  d.command('stop').action(async () => {
    const ctx = getCtx();
    const res = await rpcCall({ method: 'daemon.stop' });
    if (!res.ok) throw new Error(res.error?.message || 'daemon stop failed');
    if (ctx.jsonMode) printJson(res.data || {});
    else console.log('telequeryd stopped');
  });

  d.command('restart').action(async () => {
    const ctx = getCtx();
    try {
      await rpcCall({ method: 'daemon.stop' });
    } catch {
      // ignore if not running
    }
    const runDir = runDirFromCtx(ctx);
    fs.mkdirSync(runDir, { recursive: true });
    const logPath = path.join(runDir, 'telequeryd.log');
    const child = spawn(process.execPath, [path.join(process.cwd(), 'dist', 'daemon-main.js')], {
      detached: true,
      stdio: ['ignore', fs.openSync(logPath, 'a'), fs.openSync(logPath, 'a')],
    });
    child.unref();
    console.log('telequeryd restarted');
  });
}
