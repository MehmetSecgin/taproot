#!/usr/bin/env node
import { startDaemon } from './daemon/server.js';
import { EXIT_CODES, classifyExitCode } from './core/exit-codes.js';
import { runRegisteredCleanup } from './core/cleanup.js';

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
  const instance = await startDaemon();
  process.stdout.write(`${JSON.stringify({ started: true, socketPath: instance.socketPath })}\n`);
}

main().catch((error) => fatal(error, 'DAEMON_START_FAILED'));
