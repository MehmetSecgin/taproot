import { describe, expect, it } from 'vitest';
import { runCli } from './helpers/cli.js';
import { tempStateRoot } from './helpers/state-root.js';

function expectBadInput(args: string[], fragment: string) {
  const out = runCli(args, { TAPROOT_STATE_ROOT: tempStateRoot().stateRoot, TAPROOT_MASTER_KEY: 'test-key' });
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
