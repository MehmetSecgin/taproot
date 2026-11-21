import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import type { Executor } from '../src/cli/types.js';
import { QUERY_FLAGS, queryCommand, queryCommandWith, type QueryFlag } from '../src/commands/query.js';

const unusedExecutor = {} as Executor;

function offeredFlags(define: (program: Command, executor: Executor) => void): string[] {
  const program = new Command('demo');
  define(program, unusedExecutor);
  return program.commands[0].options.map((option) => option.long ?? '');
}

describe('query command flags', () => {
  it('offers only the flags it is given', () => {
    // act
    const offered = offeredFlags(queryCommandWith({ flags: ['datasource', 'sql'] }));

    // assert
    expect(offered).toEqual(['--datasource', '--sql']);
  });

  it('offers every flag in the stock query command', () => {
    // act
    const offered = offeredFlags(queryCommand);

    // assert
    expect(offered).toEqual(QUERY_FLAGS.map((flag) => `--${flag}`));
  });

  it('refuses a flag it does not know', () => {
    // act
    const build = () => queryCommandWith({ flags: ['datasource', 'drop-table'] as QueryFlag[] });

    // assert
    expect(build).toThrow('unknown query flags: drop-table');
  });
});
