import type { Command } from 'commander';
import { collectRepeated } from '../cli/options.js';
import type { Executor } from '../cli/types.js';
import { printSuccess } from '../core/output.js';

export function schemaCommand(program: Command, executor: Executor): void {
  program
    .command('schema')
    .description('Table names of a SQL datasource; with --table, their columns, indexes and partitioning. Answers from the schema cache, so check it before writing a query.')
    .requiredOption('--datasource <name>', 'datasource profile name; find one with datasource list')
    .option('--table <name>', 'describe this table. Repeatable.', collectRepeated, [])
    .action(async (opts: { datasource: string; table: string[] }) => {
      printSuccess(await executor.readSchema({ datasource: opts.datasource, tables: opts.table }));
    });
}
