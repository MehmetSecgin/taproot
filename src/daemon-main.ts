#!/usr/bin/env node
import { buildContext } from './api/core.js';
import { DATASOURCE_COLUMNS, datasourceListMethod, queryMethod, schemaMethod, startDaemon, statusMethod, stopMethod } from './api/daemon.js';
import { runRegisteredCleanup } from './core/cleanup.js';
import { EXIT_CODES, classifyExitCode } from './core/exit-codes.js';
import { defaultSocketPath } from './daemon/client.js';
import { builtinPlugins } from './plugins-builtins/index.js';

function fatal(error: unknown, code: string): void {
  const message = (error as Error)?.message || String(error || 'Unknown error');
  void runRegisteredCleanup().finally(() => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code, message } })}\n`);
    process.exit(classifyExitCode(error) || EXIT_CODES.GENERAL_ERROR);
  });
}

process.on('unhandledRejection', (reason) => fatal(reason, 'UNHANDLED_REJECTION'));
process.on('uncaughtException', (error) => fatal(error, 'UNCAUGHT_EXCEPTION'));

async function main() {
  const socketPath = defaultSocketPath();
  await startDaemon({
    ctx: buildContext({ kbDir: undefined, verbose: false, plugins: builtinPlugins(), useKeychain: true }),
    listen: { kind: 'unix', socketPath },
    methods: [statusMethod(), stopMethod(), queryMethod(), datasourceListMethod({ columns: DATASOURCE_COLUMNS }), schemaMethod()],
    checkDatasource: undefined,
    log: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
  });
  process.stdout.write(`${JSON.stringify({ started: true, socketPath })}\n`);
}

main().catch((error) => fatal(error, 'DAEMON_START_FAILED'));
