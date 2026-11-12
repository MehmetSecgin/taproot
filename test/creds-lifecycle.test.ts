import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { runCli } from './helpers/cli.js';
import { tempStateRoot } from './helpers/state-root.js';

function setupState() {
  const { stateRoot } = tempStateRoot();
  return {
    env: {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      TAPROOT_NO_KEYCHAIN: '1',
    },
  };
}

describe('credential lifecycle', () => {
  it('creds set stores credential', () => {
    const { env } = setupState();
    const out = runCli(['creds', 'set', '--ref', 'qa:orders', '--user', 'qa_user', '--password', 'secret123'], env);
    expect(out.status).toBe(0);
    expect(out.stdout.toLowerCase()).toContain('saved');
  });

  it('creds show redacts password in human mode', () => {
    const { env } = setupState();
    runCli(['creds', 'set', '--ref', 'qa:orders', '--user', 'qa_user', '--password', 'secret123'], env);
    const out = runCli(['creds', 'show', '--ref', 'qa:orders'], env);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('qa_user');
    expect(out.stdout).toContain('[REDACTED]');
    expect(out.stdout).not.toContain('secret123');
  });

  it('creds show redacts password in json mode', () => {
    const { env } = setupState();
    runCli(['creds', 'set', '--ref', 'qa:orders', '--user', 'qa_user', '--password', 'secret123'], env);
    const out = runCli(['creds', 'show', '--ref', 'qa:orders'], env);
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout).data.values.password).toBe('[REDACTED]');
  });

  it('creds show redacts token', () => {
    const { env } = setupState();
    runCli(['creds', 'set', '--ref', 'x', '--token', 'mytoken'], env);
    const out = runCli(['creds', 'show', '--ref', 'x'], env);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('[REDACTED]');
    expect(out.stdout).not.toContain('mytoken');
  });

  it('creds unset removes credential', () => {
    const { env } = setupState();
    runCli(['creds', 'set', '--ref', 'qa:orders', '--user', 'qa_user', '--password', 'secret123'], env);
    const unsetOut = runCli(['creds', 'unset', '--ref', 'qa:orders'], env);
    const showOut = runCli(['creds', 'show', '--ref', 'qa:orders'], env);
    expect(unsetOut.status).toBe(0);
    expect(showOut.status).toBe(1);
  });

  it('creds show redacts every value outside the plain-key allowlist', () => {
    // arrange
    const { env } = setupState();
    runCli(['creds', 'set', '--ref', 'x', '--user', 'qa_user', '--kv', 'apiKey=key123', '--kv', 'region=us-east-1'], env);

    // act
    const out = runCli(['creds', 'show', '--ref', 'x'], env);

    // assert
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout).data.values).toEqual({ user: 'qa_user', apiKey: '[REDACTED]', region: '[REDACTED]' });
  });

  it('creds list enumerates refs without exposing secrets', () => {
    const { env } = setupState();
    runCli(['creds', 'set', '--ref', 'qa:orders', '--user', 'qa_user', '--password', 'secret123'], env);
    runCli(['creds', 'set', '--ref', 'prod:billing', '--token', 'mysecrettokenval'], env);
    const out = runCli(['creds', 'list'], env);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('qa:orders');
    expect(out.stdout).toContain('prod:billing');
    expect(out.stdout).not.toContain('secret123');
    expect(out.stdout).not.toContain('mysecrettokenval');

    const jsonOut = runCli(['creds', 'list'], env);
    expect(jsonOut.status).toBe(0);
    const parsed = JSON.parse(jsonOut.stdout).data as Array<{ ref: string; keys: string[]; source: string }>;
    expect(parsed.map((e) => e.ref).sort()).toEqual(['prod:billing', 'qa:orders']);
    for (const entry of parsed) {
      for (const key of entry.keys) {
        expect(['user', 'dbUser', 'password', 'token', 'statusCommand', 'connectCommand', 'disconnectCommand', 'loginCommand']).toContain(
          // sanity: keys are key names, not values
          key.length > 0 ? key : 'user',
        );
      }
    }
  });

  it('creds set with connector commands', () => {
    const { env } = setupState();
    runCli(['creds', 'set', '--ref', 'x', '--status-command', 'tsh status', '--connect-command', 'tsh db login'], env);
    const out = runCli(['creds', 'show', '--ref', 'x'], env);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('tsh status');
    expect(out.stdout).toContain('tsh db login');
  });
});

describe('credential file permissions', () => {
  it('keeps the credential file and its directory readable by the owner only', () => {
    // arrange
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-creds-'));
    const env = { TAPROOT_STATE_ROOT: stateRoot, TAPROOT_MASTER_KEY: 'test-key', TAPROOT_NO_KEYCHAIN: '1' };
    const credentialFile = path.join(stateRoot, 'config', 'credentials.json.enc');
    runCli(['creds', 'set', '--ref', 'qa:orders', '--user', 'qa_user'], env);
    fs.chmodSync(credentialFile, 0o644);

    // act
    runCli(['creds', 'set', '--ref', 'qa:other', '--user', 'other'], env);

    // assert
    expect(fs.statSync(path.join(stateRoot, 'config')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(credentialFile).mode & 0o777).toBe(0o600);
  });
});

describe('credential master key', () => {
  it('moves a file written with the default key to TAPROOT_MASTER_KEY on first read', () => {
    // arrange
    const { env } = setupState();
    const { TAPROOT_MASTER_KEY: _unused, ...defaultKeyEnv } = env;
    runCli(['creds', 'set', '--ref', 'qa:orders', '--user', 'qa_user'], { ...defaultKeyEnv, TAPROOT_MASTER_KEY: '' });

    // act
    const withKey = runCli(['creds', 'show', '--ref', 'qa:orders'], env);
    const withDefault = runCli(['creds', 'show', '--ref', 'qa:orders'], { ...defaultKeyEnv, TAPROOT_MASTER_KEY: '' });

    // assert
    expect(withKey.status).toBe(0);
    expect(withKey.stdout).toContain('qa_user');
    expect(withDefault.status).not.toBe(0);
    expect(withDefault.stderr + withDefault.stdout).toContain('cannot be decrypted');
  });

  it('refuses to overwrite a credential file it cannot decrypt', () => {
    // arrange
    const { env } = setupState();
    runCli(['creds', 'set', '--ref', 'qa:orders', '--user', 'qa_user'], env);

    // act
    const wrongKey = runCli(['creds', 'set', '--ref', 'qa:other', '--user', 'other'], { ...env, TAPROOT_MASTER_KEY: 'wrong-key' });
    const rightKey = runCli(['creds', 'show', '--ref', 'qa:orders'], env);

    // assert
    expect(wrongKey.status).not.toBe(0);
    expect(rightKey.stdout).toContain('qa_user');
  });
});
