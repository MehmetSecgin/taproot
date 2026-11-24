import process from 'node:process';
import type { AppContext } from '../core/app.js';
import { runRegisteredCleanup } from '../core/process-cleanup.js';

const EXIT_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

async function closePlugins(ctx: AppContext): Promise<void> {
  for (const plugin of ctx.pluginRegistry.values()) {
    await plugin.close?.();
  }
}

async function cleanUpThenExit(): Promise<void> {
  try {
    await runRegisteredCleanup();
  } finally {
    process.exit(0);
  }
}

export function cleanUpAndExit(): void {
  void cleanUpThenExit();
}

export function installExitSignalHandlers(): void {
  for (const signal of EXIT_SIGNALS) {
    process.on(signal, cleanUpAndExit);
  }
}

function removeExitSignalHandlers(): void {
  for (const signal of EXIT_SIGNALS) {
    process.off(signal, cleanUpAndExit);
  }
}

export function createShutdown(ctx: AppContext, timers: NodeJS.Timeout[], stopAcceptingConnections: () => Promise<void>): () => Promise<void> {
  let stopped = false;
  return async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    removeExitSignalHandlers();
    for (const timer of timers) {
      clearInterval(timer);
    }
    await stopAcceptingConnections();
    await closePlugins(ctx);
  };
}
