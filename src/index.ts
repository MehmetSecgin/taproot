#!/usr/bin/env node
import {
  buildCli,
  credsCommand,
  daemonCommand,
  datasourceAdminCommand,
  datasourceListCommand,
  doctorCommand,
  grpcCommand,
  initCommand,
  kbCommand,
  localExecutor,
  queryCommand,
  schemaCommand,
} from './api/cli.js';
import { removedCliHint } from './core/removed-cli.js';
import { builtinPlugins } from './plugins-builtins/index.js';

function credsTopologyHint(message: string, argv: string[]): string | undefined {
  const lower = message.toLowerCase();
  const misuse = /unknown option/.test(lower) && /(--host|--port|--database|--target)/.test(lower) && argv.includes('creds') && argv.includes('set');
  return misuse
    ? `${message}. Connection topology (--host, --port, --database, --target) belongs on the datasource profile ('taproot datasource add'), not on credentials.`
    : undefined;
}

void buildCli({
  name: 'taproot',
  description: 'Query MySQL/TiDB, Redis and gRPC datasources through one CLI. Every command prints one line of JSON.',
  commands: [
    doctorCommand,
    queryCommand,
    datasourceListCommand,
    datasourceAdminCommand,
    schemaCommand,
    kbCommand,
    credsCommand,
    daemonCommand,
    initCommand,
    grpcCommand,
  ],
  executor: localExecutor({ plugins: builtinPlugins() }),
  hint: (message, argv) => credsTopologyHint(message, argv) ?? removedCliHint(message),
}).run(process.argv);
