#!/usr/bin/env node
import { startDaemon } from './daemon/server.js';
import { EXIT_CODES, classifyExitCode } from './core/exit-codes.js';
import { cleanupProgress } from './core/progress.js';

function fatal(error: unknown, code: string): never {
  cleanupProgress();
  const message = (error as Error)?.message || String(error || 'Unknown error');
  process.stderr.write(`${code}: ${message}\n`);
  process.exit(classifyExitCode(error));
}

process.on('unhandledRejection', (reason) => fatal(reason, 'UNHANDLED_REJECTION'));
process.on('uncaughtException', (error) => fatal(error, 'UNCAUGHT_EXCEPTION'));

async function main() {
  const instance = await startDaemon();
  process.stdout.write(`taprootd started on ${instance.socketPath}\n`);
}

main().catch((error) => {
  cleanupProgress();
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(classifyExitCode(error) || EXIT_CODES.GENERAL_ERROR);
});
