import type { Command } from 'commander';
import type { AppContext } from '../core/app.js';
import type { DatasourceListRequest } from '../core/datasource-list.js';
import type { SchemaRequest } from '../core/schema-read.js';
import type { QueryReply } from './query-reply.js';

export type QueryCliOptions = {
  datasource?: string;
  env?: string;
  namespace?: string;
  service?: string;
  sql?: string;
  query?: string;
  param?: string[];
  allowDiscovery?: boolean;
  allowMutate?: boolean;
  allowPartitionScan?: boolean;
  explain?: boolean;
  rowsObject?: boolean;
  proto?: string;
  protoRoot?: string;
  allowFlush?: boolean;
  allowKeys?: boolean;
  requestJson?: string;
  skipProtoValidate?: boolean;
  timeout?: string;
  tz?: string;
  jsonExtract?: string[];
};

export type Executor = {
  addOptions: (program: Command) => void;
  query: (opts: QueryCliOptions) => Promise<QueryReply>;
  listDatasources: (request: DatasourceListRequest) => Promise<Record<string, unknown>>;
  readSchema: (request: SchemaRequest) => Promise<Record<string, unknown>>;
};

export type LocalExecutor = Executor & {
  context: () => AppContext;
};

export type CliCommand<CommandExecutor extends Executor = Executor> = (program: Command, executor: CommandExecutor) => void;
