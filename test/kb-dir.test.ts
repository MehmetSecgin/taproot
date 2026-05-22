import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveKbDir } from '../src/core/paths.js';

const STATE_ROOT = '/tmp/taproot-kb-dir-test-state';

const originalEnv = {
  TAPROOT_KB_DIR: process.env.TAPROOT_KB_DIR,
  OBSIDIAN_MEMORY_ROOT: process.env.OBSIDIAN_MEMORY_ROOT,
  HOME: process.env.HOME,
};

function clearEnv(): void {
  delete process.env.TAPROOT_KB_DIR;
  delete process.env.OBSIDIAN_MEMORY_ROOT;
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe('resolveKbDir', () => {
  beforeEach(clearEnv);
  afterEach(restoreEnv);

  it('uses the explicit argument when provided', () => {
    expect(resolveKbDir('/explicit/kb', STATE_ROOT)).toBe('/explicit/kb');
  });

  it('uses TAPROOT_KB_DIR directly without any subpath magic', () => {
    process.env.TAPROOT_KB_DIR = '/my/team/kb';
    expect(resolveKbDir(undefined, STATE_ROOT)).toBe('/my/team/kb');
  });

  it('falls back to OBSIDIAN_MEMORY_ROOT with the legacy db-kb subpath', () => {
    process.env.OBSIDIAN_MEMORY_ROOT = '/some/vault';
    expect(resolveKbDir(undefined, STATE_ROOT)).toBe('/some/vault/domains/engineering/references/db-kb');
  });

  it('defaults to <stateRoot>/kb when no env var is set and no legacy home dir exists', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-kb-home-'));
    process.env.HOME = tmpHome;
    try {
      expect(resolveKbDir(undefined, STATE_ROOT)).toBe(path.join(STATE_ROOT, 'kb'));
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('prefers TAPROOT_KB_DIR over OBSIDIAN_MEMORY_ROOT when both are set', () => {
    process.env.TAPROOT_KB_DIR = '/preferred/kb';
    process.env.OBSIDIAN_MEMORY_ROOT = '/legacy/vault';
    expect(resolveKbDir(undefined, STATE_ROOT)).toBe('/preferred/kb');
  });
});
