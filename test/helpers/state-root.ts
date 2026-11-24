import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tempStateRoot(): { stateRoot: string; configDir: string } {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-state-'));
  const configDir = path.join(stateRoot, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  return { stateRoot, configDir };
}

export function writeRuntimeConfig(stateRoot: string, config: Record<string, unknown>): void {
  const configDir = path.join(stateRoot, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'deterministic-config.json'), JSON.stringify(config));
}
