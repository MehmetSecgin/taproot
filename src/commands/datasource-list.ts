import type { Command } from 'commander';
import type { Executor } from '../cli/types.js';
import { printSuccess } from '../core/output.js';
import { datasourceGroup } from './datasource-group.js';

export function datasourceListCommand(program: Command, executor: Executor): void {
  datasourceGroup(program)
    .command('list')
    .description('List datasource profiles; optional [pattern] keeps names containing it')
    .argument('[pattern]', 'case-insensitive substring of the datasource name')
    .option('--detailed', 'include updatedAt', false)
    .action(async (pattern: string | undefined, opts: { detailed: boolean }) => {
      printSuccess(await executor.listDatasources({ pattern: pattern ?? '', detailed: opts.detailed }));
    });
}
