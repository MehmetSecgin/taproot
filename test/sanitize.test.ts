import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function runCli(args: string[], options: { env?: Record<string, string>; cwd?: string } = {}) {
  const distCli = path.join(process.cwd(), 'dist', 'index.js');
  return spawnSync(process.execPath, [distCli, ...args], {
    cwd: options.cwd || process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ...(options.env || {}) },
  });
}

function setupRepo(files: Record<string, string>, extraConfig?: (stateRoot: string) => void) {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-sanitize-'));
  spawnSync('git', ['init'], { cwd: repoDir, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir, encoding: 'utf8' });
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(repoDir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  spawnSync('git', ['add', '.'], { cwd: repoDir, encoding: 'utf8' });
  spawnSync('git', ['commit', '-m', 'fixture'], { cwd: repoDir, encoding: 'utf8' });

  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-sanitize-state-'));
  const configDir = path.join(stateRoot, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  if (extraConfig) extraConfig(stateRoot);
  return {
    repoDir,
    env: {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
    },
  };
}

describe('sanitize check-repo', () => {
  it('detects github token pattern', () => {
    const { repoDir, env } = setupRepo({ 'secret.txt': 'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' });
    const out = runCli(['sanitize', 'check-repo'], { cwd: repoDir, env });
    expect(out.status).toBe(1);
    expect(out.stdout).toContain('github-token');
  });

  it('detects private key header', () => {
    const { repoDir, env } = setupRepo({ 'id_rsa': '-----BEGIN RSA PRIVATE KEY-----\nabc' });
    const out = runCli(['sanitize', 'check-repo'], { cwd: repoDir, env });
    expect(out.status).toBe(1);
    expect(out.stdout).toContain('private-key');
  });

  it('detects AWS secret key pattern', () => {
    const { repoDir, env } = setupRepo({ 'aws.txt': 'AKIAIOSFODNN7EXAMPLE' });
    const out = runCli(['sanitize', 'check-repo'], { cwd: repoDir, env });
    expect(out.status).toBe(1);
    expect(out.stdout).toContain('aws-secret');
  });

  it('detects password assignment', () => {
    const { repoDir, env } = setupRepo({ 'config.ini': 'password = "hunter2"' });
    const out = runCli(['sanitize', 'check-repo'], { cwd: repoDir, env });
    expect(out.status).toBe(1);
    expect(out.stdout).toContain('password-assignment');
  });

  it('passes clean repo', () => {
    const { repoDir, env } = setupRepo({ 'README.md': 'safe content only' });
    const out = runCli(['sanitize', 'check-repo'], { cwd: repoDir, env });
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout).count).toBe(0);
  });

  it('respects custom deny patterns', () => {
    const { repoDir, env } = setupRepo(
      { 'notes.txt': 'company-internal-secret' },
      (stateRoot) => {
        fs.writeFileSync(path.join(stateRoot, 'config', 'sanitize-denylist.txt'), 'company-internal-secret');
      },
    );
    const out = runCli(['sanitize', 'check-repo'], { cwd: repoDir, env });
    expect(out.status).toBe(1);
    expect(out.stdout).toContain('custom:company-internal-secret');
  });
});
