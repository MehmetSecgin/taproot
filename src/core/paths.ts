import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Paths {
  stateRoot: string;
  configDir: string;
  datasourceFile: string;
  credentialFile: string;
  templatesFile: string;
  cacheDir: string;
  runsDir: string;
  learningDir: string;
  kbDir: string;
}

export function resolveMemoryRoot(explicit?: string): string {
  const env = (explicit || process.env.OBSIDIAN_MEMORY_ROOT || '').trim();
  if (env) return env;
  const candidate = path.join(os.homedir(), 'memory-root');
  if (fs.existsSync(candidate)) return candidate;
  return path.join(os.homedir(), '.codex', 'memory');
}

export function resolvePaths(memoryRoot?: string): Paths {
  const explicitStateRoot = (process.env.TAPROOT_STATE_ROOT || '').trim();
  const stateRoot = explicitStateRoot || path.join(os.homedir(), '.taproot');
  const configDir = path.join(stateRoot, 'config');
  const kbDir = path.join(memoryRoot || resolveMemoryRoot(), 'domains', 'engineering', 'references', 'db-kb');
  return {
    stateRoot,
    configDir,
    datasourceFile: path.join(configDir, 'datasources.json'),
    credentialFile: path.join(configDir, 'credentials.json.enc'),
    templatesFile: path.join(configDir, 'templates.json'),
    cacheDir: path.join(stateRoot, 'cache'),
    runsDir: path.join(stateRoot, 'runs'),
    learningDir: path.join(stateRoot, 'learning'),
    kbDir,
  };
}

export function ensurePaths(paths: Paths): void {
  [paths.stateRoot, paths.configDir, paths.cacheDir, paths.runsDir, paths.learningDir].forEach((p) => fs.mkdirSync(p, { recursive: true }));
}

export function resolveFallbackPaths(memoryRoot?: string): Paths {
  const stateRoot = path.join(process.cwd(), '.taproot-state');
  const configDir = path.join(stateRoot, 'config');
  const kbDir = path.join(memoryRoot || resolveMemoryRoot(), 'domains', 'engineering', 'references', 'db-kb');
  return {
    stateRoot,
    configDir,
    datasourceFile: path.join(configDir, 'datasources.json'),
    credentialFile: path.join(configDir, 'credentials.json.enc'),
    templatesFile: path.join(configDir, 'templates.json'),
    cacheDir: path.join(stateRoot, 'cache'),
    runsDir: path.join(stateRoot, 'runs'),
    learningDir: path.join(stateRoot, 'learning'),
    kbDir,
  };
}
