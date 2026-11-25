import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CredentialStore } from '../src/store/credentials.js';

vi.mock(import('keytar'), () => ({
  getPassword: async (): Promise<string> => JSON.stringify({ user: 'from-keychain' }),
  setPassword: async (): Promise<void> => {
    await Promise.resolve();
  },
}));

async function storeWithFileCredentials(useKeychain: boolean): Promise<CredentialStore> {
  vi.stubEnv('TAPROOT_NO_KEYCHAIN', '');
  vi.stubEnv('TAPROOT_MASTER_KEY', 'test-key');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-creds-'));
  const file = path.join(directory, 'credentials.json.enc');
  await new CredentialStore(file, false).set('dev', { user: 'from-file' });
  return new CredentialStore(file, useKeychain);
}

describe('credential store keychain choice', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    [true, 'from-keychain'],
    [false, 'from-file'],
  ])('with useKeychain %s, reads the user %s', async (useKeychain, user) => {
    // arrange
    const store = await storeWithFileCredentials(useKeychain);

    // act
    const credentials = await store.get('dev');

    // assert
    expect(credentials).toStrictEqual({ user });
  });
});
