#!/usr/bin/env node
import { startDaemon } from './daemon/server.js';

async function main() {
  const instance = await startDaemon();
  process.stdout.write(`telequeryd started on ${instance.socketPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
});
