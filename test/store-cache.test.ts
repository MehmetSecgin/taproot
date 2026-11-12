import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readJsonFile, writeJsonFile } from '../src/core/json.js';
import { CredentialStore } from '../src/store/credentials.js';
import { RuntimeConfigStore } from '../src/store/runtime-config.js';

function tmpFile(content: unknown): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-json-')), 'data.json');
  fs.writeFileSync(file, JSON.stringify(content));
  return file;
}

describe('readJsonFile cache', () => {
  afterEach(() => vi.restoreAllMocks());

  it('parses an unchanged file once', () => {
    // arrange
    const file = tmpFile({ name: 'first' });
    const parse = vi.spyOn(JSON, 'parse');

    // act
    const first = readJsonFile(file, {});
    const second = readJsonFile(file, {});

    // assert
    expect(second).toEqual({ name: 'first' });
    expect(second).toBe(first);
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it('returns a frozen value so callers cannot edit the cached copy', () => {
    // arrange
    const file = tmpFile({ rows: [{ name: 'first' }] });

    // act
    const value = readJsonFile<{ rows: Array<{ name: string }> }>(file, { rows: [] });

    // assert
    expect(() => value.rows.push({ name: 'second' })).toThrow(TypeError);
    expect(() => { value.rows[0].name = 'edited'; }).toThrow(TypeError);
    expect(readJsonFile(file, {})).toEqual({ rows: [{ name: 'first' }] });
  });

  it('sees an edit by another writer', () => {
    // arrange
    const file = tmpFile({ name: 'first' });
    readJsonFile(file, {});

    // act
    fs.writeFileSync(file, JSON.stringify({ name: 'edited by another process' }));

    // assert
    expect(readJsonFile(file, {})).toEqual({ name: 'edited by another process' });
  });

  it('drops the cached copy on its own write even when mtime and size match', () => {
    // arrange
    const file = tmpFile({});
    writeJsonFile(file, { name: 'aaaa' });
    const pinned = new Date('2026-01-01T00:00:00Z');
    fs.utimesSync(file, pinned, pinned);
    readJsonFile(file, {});

    // act
    writeJsonFile(file, { name: 'bbbb' });
    fs.utimesSync(file, pinned, pinned);

    // assert
    expect(readJsonFile(file, {})).toEqual({ name: 'bbbb' });
  });
});

describe('runtime config', () => {
  it('checks an unchanged file once', () => {
    // arrange
    const store = new RuntimeConfigStore(tmpFile({ serviceAliases: { legacy: 'sample-service' } }));

    // act
    const first = store.get();
    const second = store.get();

    // assert
    expect(second).toEqual({ serviceAliases: { legacy: 'sample-service' } });
    expect(second).toBe(first);
  });
});

describe('credential fallback key', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('derives the key once across repeated lookups', async () => {
    // arrange
    vi.stubEnv('TAPROOT_NO_KEYCHAIN', '1');
    vi.stubEnv('TAPROOT_MASTER_KEY', 'test-key');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-creds-')), 'credentials.enc.json');
    const store = new CredentialStore(file);
    const pbkdf2 = vi.spyOn(crypto, 'pbkdf2Sync');

    // act
    await store.set('qa:orders', { user: 'qa_user', password: 'secret123' });
    const lookups = [await store.get('qa:orders'), await store.get('qa:orders'), await store.get('qa:orders')];

    // assert
    expect(lookups).toEqual(Array(3).fill({ user: 'qa_user', password: 'secret123' }));
    expect(pbkdf2).toHaveBeenCalledTimes(1);
  });
});
