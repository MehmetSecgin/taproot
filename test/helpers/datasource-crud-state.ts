import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from './cli.js';
import { tempStateRoot } from './state-root.js';

export function setupEmptyState(): { stateRoot: string; kbDir: string; env: Record<string, string> } {
  const { stateRoot, configDir } = tempStateRoot();
  fs.writeFileSync(path.join(configDir, 'datasources.json'), '[]');
  fs.writeFileSync(path.join(configDir, 'templates.json'), '[]');
  fs.writeFileSync(path.join(configDir, 'deterministic-config.json'), '{}');
  const kbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-datasource-kb-'));
  fs.mkdirSync(kbDir, { recursive: true });
  fs.writeFileSync(path.join(kbDir, 'services.json'), '[]');
  return {
    stateRoot,
    kbDir,
    env: {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      TAPROOT_KB_DIR: kbDir,
    },
  };
}

export function addProfile(env: Record<string, string>, extra: string[] = []): ReturnType<typeof runCli> {
  return runCli(
    [
      'datasource',
      'add',
      '--name',
      'qa-svc',
      '--kind',
      'mysql',
      '--credential-ref',
      'qa:svc',
      '--env',
      'qa',
      '--service',
      'svc',
      '--host',
      '127.0.0.1',
      '--port',
      '3306',
      '--database',
      'svcdb',
      ...extra,
    ],
    env,
  );
}
