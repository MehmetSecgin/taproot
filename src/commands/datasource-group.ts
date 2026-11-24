import type { Command } from 'commander';

export function datasourceGroup(program: Command): Command {
  return program.commands.find((command) => command.name() === 'datasource') ?? program.command('datasource').description('Datasource profile operations');
}
