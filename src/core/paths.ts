import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonFile } from './json.js';
import { str } from './strings.js';

export interface Paths {
  stateRoot: string;
  configDir: string;
  configSnapshotsDir: string;
  runtimeConfigFile: string;
  datasourceFile: string;
  credentialFile: string;
  cacheDir: string;
  runsDir: string;
  runsLedgerDir: string;
  learningDir: string;
  kbDir: string;
}

export const RUNS_LEDGER_DIR_NAME = 'runs-ledger';

function runtimeConfigFileFor(stateRoot: string): string {
  return path.join(stateRoot, 'config', 'deterministic-config.json');
}

export function resolveKbDir(explicit: string | undefined, stateRoot: string): string {
  const direct = (explicit || process.env.TAPROOT_KB_DIR || '').trim();
  if (direct) return direct;
  const saved = str(readJsonFile<{ kbDir?: unknown }>(runtimeConfigFileFor(stateRoot), {}).kbDir).trim();
  return saved || path.join(stateRoot, 'kb');
}

function buildPaths(stateRoot: string, kbDir: string): Paths {
  const configDir = path.join(stateRoot, 'config');
  return {
    stateRoot,
    configDir,
    configSnapshotsDir: path.join(stateRoot, 'config-snapshots'),
    runtimeConfigFile: runtimeConfigFileFor(stateRoot),
    datasourceFile: path.join(configDir, 'datasources.json'),
    credentialFile: path.join(configDir, 'credentials.json.enc'),
    cacheDir: path.join(stateRoot, 'cache'),
    runsDir: path.join(stateRoot, 'runs'),
    runsLedgerDir: path.join(stateRoot, 'learning', RUNS_LEDGER_DIR_NAME),
    learningDir: path.join(stateRoot, 'learning'),
    kbDir,
  };
}

export function resolvePaths(kbDir?: string): Paths {
  const explicitStateRoot = (process.env.TAPROOT_STATE_ROOT || '').trim();
  const stateRoot = explicitStateRoot || path.join(os.homedir(), '.taproot');
  return buildPaths(stateRoot, resolveKbDir(kbDir, stateRoot));
}

export function ensurePaths(paths: Paths): void {
  [paths.stateRoot, paths.configDir, paths.cacheDir, paths.runsDir, paths.learningDir, paths.runsLedgerDir].forEach((p) => fs.mkdirSync(p, { recursive: true }));
}

export function resolveFallbackPaths(kbDir?: string): Paths {
  const stateRoot = path.join(process.cwd(), '.taproot-state');
  return buildPaths(stateRoot, resolveKbDir(kbDir, stateRoot));
}
