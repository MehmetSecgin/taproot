import { RUNTIME_CONSTANTS } from './constants.js';
import { badInput, queryTimeoutErr } from './error-classification.js';

export function queryTimeoutError(timeoutMs: number): Error {
  return queryTimeoutErr(
    `query exceeded timeout (${timeoutMs}ms) and was aborted. ` +
      `Raise the limit with --timeout <ms> (or defaults.query.timeoutMs in runtime config), ` +
      `or narrow the scan by adding a partition/time predicate.`,
  );
}

export function parseTimeoutMs(value: unknown, fallbackMs: number): number {
  if (value === undefined || value === null || value === '') return fallbackMs;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw badInput(`invalid timeout '${String(value)}'. Expected a positive integer in milliseconds.`);
  }
  return Math.floor(parsed);
}

export function preflightBudgetMs(timeoutMs: number): number {
  return Math.max(timeoutMs, RUNTIME_CONSTANTS.connector.preflightTimeoutMs);
}

export function queryBudgetMs(timeoutMs: number): number {
  return 2 * timeoutMs + preflightBudgetMs(timeoutMs);
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
}

export async function withQueryTimeout<T>(input: {
  timeoutMs: number;
  signal: AbortSignal | undefined;
  run: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(queryTimeoutError(input.timeoutMs)), input.timeoutMs);
  const runSignal = input.signal ? AbortSignal.any([input.signal, timeout.signal]) : timeout.signal;
  try {
    runSignal.throwIfAborted();
    return await Promise.race([input.run(runSignal), rejectOnAbort(runSignal)]);
  } finally {
    clearTimeout(timer);
  }
}
