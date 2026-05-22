import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Paths {
  stateRoot: string;
  configDir: string;
  runtimeConfigFile: string;
  datasourceFile: string;
  credentialFile: string;
  templatesFile: string;
  cacheDir: string;
  runsDir: string;
  runsLedgerDir: string;
  learningDir: string;
  kbDir: string;
}

const LEGACY_KB_SUBPATH = path.join('domains', 'engineering', 'references', 'db-kb');

function legacyKbFromMemoryRoot(memoryRoot: string): string {
  return path.join(memoryRoot, LEGACY_KB_SUBPATH);
}

export function resolveKbDir(explicit: string | undefined, stateRoot: string): string {
  const direct = (explicit || process.env.TAPROOT_KB_DIR || '').trim();
  if (direct) return direct;
  const legacyEnv = (process.env.OBSIDIAN_MEMORY_ROOT || '').trim();
  if (legacyEnv) return legacyKbFromMemoryRoot(legacyEnv);
  const legacyHome = path.join(os.homedir(), 'memory-root');
  if (fs.existsSync(legacyHome)) return legacyKbFromMemoryRoot(legacyHome);
  return path.join(stateRoot, 'kb');
}

function buildPaths(stateRoot: string, kbDir: string): Paths {
  const configDir = path.join(stateRoot, 'config');
  return {
    stateRoot,
    configDir,
    runtimeConfigFile: path.join(configDir, 'deterministic-config.json'),
    datasourceFile: path.join(configDir, 'datasources.json'),
    credentialFile: path.join(configDir, 'credentials.json.enc'),
    templatesFile: path.join(configDir, 'templates.json'),
    cacheDir: path.join(stateRoot, 'cache'),
    runsDir: path.join(stateRoot, 'runs'),
    runsLedgerDir: path.join(stateRoot, 'learning', 'runs-ledger'),
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
