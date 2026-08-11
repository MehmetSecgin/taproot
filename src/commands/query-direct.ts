import { createInterface } from 'node:readline/promises';
import { randomUUID } from 'node:crypto';
import { stdin as input, stdout as output } from 'node:process';
import type { AppContext } from '../core/app.js';
import { executeQuery } from '../core/execute-query.js';
import type { QueryReport, QueryExecutionRequest } from '../core/execute-query.js';
import type { ProgressReporter } from '../core/progress.js';
import { presentQueryOutcome } from './query-present.js';
import type { QueryOpts } from './query-types.js';

async function promptPassword(ref: string, progress: ProgressReporter): Promise<string> {
  progress.stop();
  const rl = createInterface({ input, output });
  try {
    const value = await rl.question(`Password for ${ref}: `);
    return value.trim();
  } finally {
    rl.close();
  }
}

export function cliQueryReport(ctx: AppContext, progress: ProgressReporter): QueryReport {
  const logVerbose = (msg: string): void => {
    if (!ctx.jsonMode && ctx.verbose) process.stderr.write(`[taproot] ${msg}\n`);
  };
  return {
    update: (message) => progress.update(message),
    phase: (phase, ms) => logVerbose(`phase ${phase}: ${ms}ms`),
    verbose: logVerbose,
    notice: (message) => {
      if (!ctx.jsonMode) process.stderr.write(`[taproot] ${message}\n`);
    },
  };
}

export async function runDirectQuery(input: {
  request: QueryExecutionRequest;
  ctx: AppContext;
  opts: QueryOpts;
  progress: ProgressReporter;
}): Promise<void> {
  const { request, ctx, opts, progress } = input;
  const canPrompt = !ctx.jsonMode && process.stdin.isTTY && !process.env.CI;
  const outcome = await executeQuery(request, {
    ctx,
    report: cliQueryReport(ctx, progress),
    promptPassword: canPrompt ? (ref) => promptPassword(ref, progress) : undefined,
  });
  presentQueryOutcome({ outcome, ctx, opts, progress, requestId: randomUUID() });
}
