import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import type { Executor } from '../src/cli/types.js';
import { QUERY_FLAGS, queryCommand, queryCommandWith } from '../src/commands/query.js';

function failBecauseUnused(): never {
  throw new Error('the executor is not used when a command is only defined');
}

const unusedExecutor: Executor = {
  addOptions: failBecauseUnused,
  query: failBecauseUnused,
  listDatasources: failBecauseUnused,
  readSchema: failBecauseUnused,
};

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
    expect(offered).toStrictEqual(['--datasource', '--sql']);
  });

  it('offers every flag in the stock query command', () => {
    // act
    const offered = offeredFlags(queryCommand);

    // assert
    expect(offered).toStrictEqual(QUERY_FLAGS.map((flag) => `--${flag}`));
  });

  it('refuses a flag it does not know', () => {
    // act
    const flags = ['datasource', 'drop-table'];
    const build = (): void => {
      Reflect.apply(queryCommandWith, undefined, [{ flags }]);
    };

    // assert
    expect(build).toThrow('unknown query flags: drop-table');
  });
});
