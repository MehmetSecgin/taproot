import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonFile } from './json.js';
import { str } from './strings.js';

export interface Paths {
  stateRoot: string;
  configDir: string;
  runtimeConfigFile: string;
  datasourceFile: string;
  credentialFile: string;
  cacheDir: string;
  kbDir: string;
}

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
    runtimeConfigFile: runtimeConfigFileFor(stateRoot),
    datasourceFile: path.join(configDir, 'datasources.json'),
    credentialFile: path.join(configDir, 'credentials.json.enc'),
    cacheDir: path.join(stateRoot, 'cache'),
    kbDir,
  };
}

export function resolvePaths(kbDir?: string): Paths {
  const explicitStateRoot = (process.env.TAPROOT_STATE_ROOT || '').trim();
  const stateRoot = explicitStateRoot || path.join(os.homedir(), '.taproot');
  return buildPaths(stateRoot, resolveKbDir(kbDir, stateRoot));
}

const OWNER_ONLY_DIR_MODE = 0o700;

function tryRestrictToOwner(dir: string): void {
  try {
    fs.chmodSync(dir, OWNER_ONLY_DIR_MODE);
  } catch {
    return;
  }
}

export function ensurePaths(paths: Paths): void {
  fs.mkdirSync(paths.stateRoot, { recursive: true });
  fs.mkdirSync(paths.configDir, { recursive: true, mode: OWNER_ONLY_DIR_MODE });
  tryRestrictToOwner(paths.configDir);
  fs.mkdirSync(paths.cacheDir, { recursive: true });
}

export function resolveFallbackPaths(kbDir?: string): Paths {
  const stateRoot = path.join(process.cwd(), '.taproot-state');
  return buildPaths(stateRoot, resolveKbDir(kbDir, stateRoot));
}
