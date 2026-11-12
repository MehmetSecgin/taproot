import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DIST_CLI = path.join(process.cwd(), 'dist', 'index.js');

export function runCli(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [DIST_CLI, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}
