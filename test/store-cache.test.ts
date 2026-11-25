import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readJsonFile, writeJsonFile } from '../src/core/json.js';
import { CredentialStore } from '../src/store/credentials.js';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function tmpFile(content: unknown): string {
  const file = path.join(makeTempDir('taproot-json-'), 'data.json');
  fs.writeFileSync(file, JSON.stringify(content));
  return file;
}

describe('reading a cached JSON file', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads a file once while its mtime and size are unchanged', () => {
    // arrange
    const file = tmpFile({ name: 'first' });
    const parse = vi.spyOn(JSON, 'parse');

    // act
    const first = readJsonFile(file, {});
    const second = readJsonFile(file, {});

    // assert
    expect(second).toStrictEqual({ name: 'first' });
    expect(second).toBe(first);
    const parseCount = parse.mock.calls.length;
    expect(parseCount).toBe(1);
  });

  it('returns a frozen value so callers cannot edit the cached copy', () => {
    // arrange
    const file = tmpFile({ rows: [{ name: 'first' }] });

    // act
    const value = readJsonFile<{ rows: { name: string }[] }>(file, { rows: [] });

    // assert
    expect(() => value.rows.push({ name: 'second' })).toThrow(TypeError);
    expect(() => { value.rows[0].name = 'edited'; }).toThrow(TypeError);
    expect(readJsonFile(file, {})).toStrictEqual({ rows: [{ name: 'first' }] });
  });

  it('sees an edit by another writer', () => {
    // arrange
    const file = tmpFile({ name: 'first' });
    readJsonFile(file, {});

    // act
    fs.writeFileSync(file, JSON.stringify({ name: 'edited by another process' }));

    // assert
    expect(readJsonFile(file, {})).toStrictEqual({ name: 'edited by another process' });
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
    expect(readJsonFile(file, {})).toStrictEqual({ name: 'bbbb' });
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
    const file = path.join(makeTempDir('taproot-creds-'), 'credentials.enc.json');
    const store = new CredentialStore(file, true);
    const pbkdf2 = vi.spyOn(crypto, 'pbkdf2Sync');

    // act
    await store.set('qa:orders', { user: 'qa_user', password: 'secret123' });
    const lookups = [await store.get('qa:orders'), await store.get('qa:orders'), await store.get('qa:orders')];

    // assert
    expect(lookups).toStrictEqual(Array.from({ length: 3 }, () => ({ user: 'qa_user', password: 'secret123' })));
    const keyDerivationCount = pbkdf2.mock.calls.length;
    expect(keyDerivationCount).toBe(1);
  });
});
