import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function runCli(args: string[]) {
  const distCli = path.join(process.cwd(), 'dist', 'index.js');
  return spawnSync(process.execPath, [distCli, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

describe('cli contract', () => {
  it('prints root help with stable commands', () => {
    const out = runCli(['--help']);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('Universal query orchestration CLI');
    expect(out.stdout).toContain('self-check');
    expect(out.stdout).toContain('doctor');
    expect(out.stdout).toContain('query');
    expect(out.stdout).toContain('datasource');
    expect(out.stdout).toContain('template');
    expect(out.stdout).toContain('kb');
    expect(out.stdout).toContain('daemon');
    expect(out.stdout).toContain('session');
  });

  it('prints skill version', () => {
    const out = runCli(['--skill-version']);
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe('telequery-skill@0.1.0');
  });

  it('completion zsh includes command name', () => {
    const out = runCli(['completion', 'zsh']);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('compdef _telequery_complete telequery');
  });

  it('self-check json includes checks', () => {
    const out = runCli(['--json', 'self-check']);
    expect(out.status).toBe(0);
    const parsed = JSON.parse(out.stdout);
    expect(Array.isArray(parsed.checks)).toBe(true);
  });

  it('returns bad-input exit code for unknown option', () => {
    const out = runCli(['creds', 'set', '--ref', 'x', '--host', 'localhost']);
    expect(out.status).toBe(2);
    expect(out.stderr.toLowerCase()).toContain('unknown option');
  });
});
