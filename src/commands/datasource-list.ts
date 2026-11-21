import type { Command } from 'commander';
import type { Executor } from '../cli/types.js';
import { printEnvelope } from '../core/output.js';

export function datasourceGroup(program: Command): Command {
  return program.commands.find((command) => command.name() === 'datasource') ?? program.command('datasource').description('Datasource profile operations');
}

export function datasourceListCommand(program: Command, executor: Executor): void {
  datasourceGroup(program)
    .command('list')
    .description('List datasource profiles; optional [pattern] keeps names containing it')
    .argument('[pattern]', 'case-insensitive substring of the datasource name')
    .option('--detailed', 'include updatedAt', false)
    .action(async (pattern: string | undefined, opts: { detailed: boolean }) => {
      printEnvelope(true, await executor.listDatasources({ pattern: pattern || '', detailed: Boolean(opts.detailed) }));
    });
}
