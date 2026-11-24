import { describe, expect, it } from 'vitest';
import { outputError } from './helpers/cli-contract-envelopes.js';
import { runCli } from './helpers/cli.js';
import { tempStateRoot } from './helpers/state-root.js';

const BAD_INPUT_EXIT_CODE = 2;

const MALFORMED_ARGUMENTS = [
  {
    title: 'exits BAD_INPUT for a --hint that is not key=value',
    args: ['datasource', 'add', '--name', 'x', '--kind', 'mysql', '--credential-ref', 'qa:x', '--hint', 'brokenpair'],
    messageFragment: "Invalid --hint 'brokenpair'",
  },
  {
    title: 'exits BAD_INPUT for a --connector-ref that is not name=ref',
    args: ['datasource', 'add', '--name', 'x', '--kind', 'mysql', '--credential-ref', 'qa:x', '--connector-ref', 'brokenpair'],
    messageFragment: "Invalid --connector-ref 'brokenpair'",
  },
  {
    title: 'exits BAD_INPUT for datasource import without --file',
    args: ['datasource', 'import'],
    messageFragment: 'Specify --file <path>',
  },
  {
    title: 'exits BAD_INPUT for a --kv that is not key=value',
    args: ['creds', 'set', '--ref', 'qa:orders', '--kv', 'brokenpair'],
    messageFragment: "Invalid --kv 'brokenpair'",
  },
  {
    title: 'exits BAD_INPUT for grpc describe without a proto root or datasource',
    args: ['grpc', 'describe'],
    messageFragment: '--proto-root or --datasource required',
  },
  {
    title: 'points a positional query argument at --sql and --datasource',
    args: ['query', 'demo-db', 'SELECT 1'],
    messageFragment: 'Pass the query text with --sql "<query>" and the datasource with --datasource <name>',
  },
];

describe('cli argument guards classify as BAD_INPUT', () => {
  it.each(MALFORMED_ARGUMENTS)('$title', ({ args, messageFragment }) => {
    // arrange
    const env = { TAPROOT_STATE_ROOT: tempStateRoot().stateRoot, TAPROOT_MASTER_KEY: 'test-key' };

    // act
    const out = runCli(args, env);

    // assert
    expect(out.status).toBe(BAD_INPUT_EXIT_CODE);
    expect(outputError(out.stdout).code).toBe('BAD_INPUT');
    expect(outputError(out.stdout).message).toContain(messageFragment);
  });
});
