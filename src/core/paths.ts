import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonFile } from './json.js';
import { firstNonEmpty, textUnlessFalsy } from './text-presence.js';

type Paths = {
  stateRoot: string;
  configDir: string;
  runtimeConfigFile: string;
  datasourceFile: string;
  credentialFile: string;
  cacheDir: string;
  kbDir: string;
};

function configDirOf(stateRoot: string): string {
  return path.join(stateRoot, 'config');
}

function runtimeConfigFileOf(stateRoot: string): string {
  return path.join(configDirOf(stateRoot), 'deterministic-config.json');
}

export function resolveKbDir(explicit: string | undefined, stateRoot: string): string {
  const direct = (firstNonEmpty(explicit, process.env.TAPROOT_KB_DIR) ?? '').trim();
  if (direct !== '') {
    return direct;
  }
  const saved = textUnlessFalsy(readJsonFile<{ kbDir?: unknown }>(runtimeConfigFileOf(stateRoot), {}).kbDir).trim();
  return saved === '' ? path.join(stateRoot, 'kb') : saved;
}

function buildPaths(stateRoot: string, kbDir: string): Paths {
  const configDir = configDirOf(stateRoot);
  return {
    stateRoot,
    configDir,
    runtimeConfigFile: runtimeConfigFileOf(stateRoot),
    datasourceFile: path.join(configDir, 'datasources.json'),
    credentialFile: path.join(configDir, 'credentials.json.enc'),
    cacheDir: path.join(stateRoot, 'cache'),
    kbDir,
  };
}

export function resolvePaths(kbDir?: string): Paths {
  const explicitStateRoot = (process.env.TAPROOT_STATE_ROOT ?? '').trim();
  const stateRoot = explicitStateRoot === '' ? path.join(os.homedir(), '.taproot') : explicitStateRoot;
  return buildPaths(stateRoot, resolveKbDir(kbDir, stateRoot));
}

const OWNER_ONLY_DIR_MODE = 0o700;

function restrictToOwnerIfPossible(dir: string): boolean {
  try {
    fs.chmodSync(dir, OWNER_ONLY_DIR_MODE);
    return true;
  } catch {
    return false;
  }
}

export function ensurePaths(paths: Paths): void {
  fs.mkdirSync(paths.stateRoot, { recursive: true });
  fs.mkdirSync(paths.configDir, { recursive: true, mode: OWNER_ONLY_DIR_MODE });
  restrictToOwnerIfPossible(paths.configDir);
  fs.mkdirSync(paths.cacheDir, { recursive: true });
}

export function resolveFallbackPaths(kbDir?: string): Paths {
  const stateRoot = path.join(process.cwd(), '.taproot-state');
  return buildPaths(stateRoot, resolveKbDir(kbDir, stateRoot));
}
