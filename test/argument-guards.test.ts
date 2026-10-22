import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function runCli(args: string[]) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-arg-guards-'));
  return spawnSync(process.execPath, [path.join(process.cwd(), 'dist', 'index.js'), ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, TAPROOT_STATE_ROOT: stateRoot, TAPROOT_MASTER_KEY: 'test-key' },
  });
}

function expectBadInput(args: string[], fragment: string) {
  const out = runCli(args);
  expect(out.status).toBe(2);
  const envelope = JSON.parse(out.stdout);
  expect(envelope.error.code).toBe('BAD_INPUT');
  expect(envelope.error.message).toContain(fragment);
}

describe('CLI argument guards classify as BAD_INPUT', () => {
  it('rejects a malformed --hint', () => {
    expectBadInput(
      ['datasource', 'add', '--name', 'x', '--kind', 'mysql', '--credential-ref', 'qa:x', '--hint', 'brokenpair'],
      "Invalid --hint 'brokenpair'",
    );
  });

  it('rejects a malformed --connector-ref', () => {
    expectBadInput(
      ['datasource', 'add', '--name', 'x', '--kind', 'mysql', '--credential-ref', 'qa:x', '--connector-ref', 'brokenpair'],
      "Invalid --connector-ref 'brokenpair'",
    );
  });

  it('rejects datasource import without --file', () => {
    expectBadInput(['datasource', 'import'], 'Specify --file <path>');
  });

  it('rejects a malformed --kv', () => {
    expectBadInput(['creds', 'set', '--ref', 'qa:orders', '--kv', 'brokenpair'], "Invalid --kv 'brokenpair'");
  });

  it('rejects grpc describe without a proto root or datasource', () => {
    expectBadInput(['grpc', 'describe'], '--proto-root or --datasource required');
  });

  it('points a positional query argument at --sql and --datasource', () => {
    expectBadInput(
      ['query', 'demo-db', 'SELECT 1'],
      'Pass the query text with --sql "<query>" and the datasource with --datasource <name>',
    );
  });

});
