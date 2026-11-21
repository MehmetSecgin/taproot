import type { Command } from 'commander';
import { commandGroup, type Executor } from '../cli/types.js';
import { printEnvelope } from '../core/output.js';

export const DATASOURCE_GROUP_DESCRIPTION = 'Datasource profile operations';

export function datasourceListCommand(program: Command, executor: Executor): void {
  commandGroup(program, 'datasource', DATASOURCE_GROUP_DESCRIPTION)
    .command('list')
    .description('List datasource profiles; optional [pattern] keeps names containing it')
    .argument('[pattern]', 'case-insensitive substring of the datasource name')
    .option('--detailed', 'include confidence and updatedAt', false)
    .action(async (pattern: string | undefined, opts: { detailed: boolean }) => {
      printEnvelope(true, await executor.listDatasources({ pattern: pattern || '', detailed: Boolean(opts.detailed) }));
    });
}
