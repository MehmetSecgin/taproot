import { RUNTIME_CONSTANTS } from './constants.js';
import { TaprootError, badInput } from './taproot-error.js';

export function queryTimeoutError(timeoutMs: number): Error {
  return new TaprootError(
    'QUERY_TIMEOUT',
    `query exceeded timeout (${timeoutMs}ms) and was aborted. ` +
      `Raise the limit with --timeout <ms> (or defaults.query.timeoutMs in runtime config), ` +
      `or narrow the scan by adding a partition/time predicate.`,
  );
}

function describeTimeoutInput(value: unknown): string {
  const isPrimitive = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint';
  return isPrimitive ? String(value) : JSON.stringify(value);
}

export function parseTimeoutMs(value: unknown, fallbackMs: number): number {
  if (value === undefined || value === null || value === '') {
    return fallbackMs;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw badInput(`invalid timeout '${describeTimeoutInput(value)}'. Expected a positive integer in milliseconds.`);
  }
  return Math.floor(parsed);
}

export function preflightBudgetMs(timeoutMs: number): number {
  return Math.max(timeoutMs, RUNTIME_CONSTANTS.connector.preflightTimeoutMs);
}

export function queryBudgetMs(timeoutMs: number): number {
  return 2 * timeoutMs + preflightBudgetMs(timeoutMs);
}

function abortReasonAsError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error(String(reason));
}

async function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener(
      'abort',
      () => {
        reject(abortReasonAsError(signal));
      },
      { once: true },
    );
  });
}

export async function withQueryTimeout<Result>(input: {
  timeoutMs: number;
  signal: AbortSignal | undefined;
  run: (signal: AbortSignal) => Promise<Result>;
}): Promise<Result> {
  const timeout = new AbortController();
  const timer = setTimeout(() => {
    timeout.abort(queryTimeoutError(input.timeoutMs));
  }, input.timeoutMs);
  const runSignal = input.signal === undefined ? timeout.signal : AbortSignal.any([input.signal, timeout.signal]);
  try {
    runSignal.throwIfAborted();
    return await Promise.race([input.run(runSignal), rejectOnAbort(runSignal)]);
  } finally {
    clearTimeout(timer);
  }
}
