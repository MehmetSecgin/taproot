import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveKbDir } from '../src/core/paths.js';

const originalKbDir = process.env.TAPROOT_KB_DIR;

function stateRootWithSavedKbDir(kbDir?: string): string {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-kb-dir-test-state-'));
  if (kbDir) {
    fs.mkdirSync(path.join(stateRoot, 'config'), { recursive: true });
    fs.writeFileSync(path.join(stateRoot, 'config', 'deterministic-config.json'), JSON.stringify({ kbDir }));
  }
  return stateRoot;
}

describe('resolveKbDir', () => {
  beforeEach(() => {
    delete process.env.TAPROOT_KB_DIR;
  });
  afterEach(() => {
    if (originalKbDir === undefined) delete process.env.TAPROOT_KB_DIR;
    else process.env.TAPROOT_KB_DIR = originalKbDir;
  });

  it('uses the explicit argument over the env var and the saved value', () => {
    process.env.TAPROOT_KB_DIR = '/env/kb';
    expect(resolveKbDir('/explicit/kb', stateRootWithSavedKbDir('/saved/kb'))).toBe('/explicit/kb');
  });

  it('uses TAPROOT_KB_DIR over the saved value', () => {
    process.env.TAPROOT_KB_DIR = '/env/kb';
    expect(resolveKbDir(undefined, stateRootWithSavedKbDir('/saved/kb'))).toBe('/env/kb');
  });

  it('uses the kbDir saved in runtime config when no flag or env var is set', () => {
    expect(resolveKbDir(undefined, stateRootWithSavedKbDir('/saved/kb'))).toBe('/saved/kb');
  });

  it('defaults to <stateRoot>/kb when nothing is configured', () => {
    const stateRoot = stateRootWithSavedKbDir();
    expect(resolveKbDir(undefined, stateRoot)).toBe(path.join(stateRoot, 'kb'));
  });
});
