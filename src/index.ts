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
import { credsTopologyHint } from './commands/creds-topology-hint.js';
import { removedCliHint } from './core/removed-cli.js';
import { builtinPlugins } from './plugins-builtins/index.js';

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
