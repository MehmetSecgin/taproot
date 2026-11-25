#!/usr/bin/env node
import { buildContext } from './api/core.js';
import { DATASOURCE_COLUMNS, datasourceListMethod, queryMethod, schemaMethod, startDaemon, statusMethod, stopMethod } from './api/daemon.js';
import { errorTextOrUnknown } from './core/error-text.js';
import { runRegisteredCleanup } from './core/process-cleanup.js';
import { EXIT_CODES, classifyExitCode } from './core/exit-codes.js';
import { defaultSocketPath } from './daemon/socket-path.js';
import { builtinPlugins } from './plugins-builtins/index.js';

async function exitWithError(error: unknown, code: string): Promise<void> {
  const message = errorTextOrUnknown(error);
  try {
    await runRegisteredCleanup();
  } finally {
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code, message } })}\n`);
    process.exit(classifyExitCode(error) || EXIT_CODES.GENERAL_ERROR);
  }
}

process.on('unhandledRejection', (reason) => {
  void exitWithError(reason, 'UNHANDLED_REJECTION');
});
process.on('uncaughtException', (error) => {
  void exitWithError(error, 'UNCAUGHT_EXCEPTION');
});

async function startTaprootDaemon(): Promise<void> {
  const socketPath = defaultSocketPath();
  await startDaemon({
    ctx: buildContext({ kbDir: undefined, verbose: false, plugins: builtinPlugins(), useKeychain: true }),
    listen: { kind: 'unix', socketPath },
    methods: [statusMethod(), stopMethod(), queryMethod(), datasourceListMethod({ columns: DATASOURCE_COLUMNS }), schemaMethod()],
    checkDatasource: undefined,
    log: (event) => {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    },
  });
  process.stdout.write(`${JSON.stringify({ started: true, socketPath })}\n`);
}

try {
  await startTaprootDaemon();
} catch (error) {
  await exitWithError(error, 'DAEMON_START_FAILED');
}
