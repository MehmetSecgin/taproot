import type { Command } from 'commander';
import type { AppContext } from '../core/app.js';
import type { DatasourceListRequest } from '../core/datasource-list.js';
import type { SchemaRequest } from '../core/schema-read.js';
import type { QueryOpts } from '../commands/query-types.js';
import type { DaemonReply } from '../commands/query-present.js';

export interface Executor {
  addOptions: (program: Command) => void;
  query: (opts: QueryOpts) => Promise<DaemonReply>;
  listDatasources: (request: DatasourceListRequest) => Promise<Record<string, unknown>>;
  readSchema: (request: SchemaRequest) => Promise<Record<string, unknown>>;
}

export interface LocalExecutor extends Executor {
  context: () => AppContext;
}

export type CliCommand<E extends Executor = Executor> = (program: Command, executor: E) => void;

export function commandGroup(program: Command, name: string, description: string): Command {
  return program.commands.find((command) => command.name() === name) ?? program.command(name).description(description);
}
