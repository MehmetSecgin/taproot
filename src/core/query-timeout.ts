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

export async function withQueryTimeout<T>(input: {
  timeoutMs: number;
  run: () => Promise<T>;
  onTimeout?: () => void | Promise<void>;
}): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      input.run(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          void Promise.resolve(input.onTimeout?.()).catch(() => {});
          reject(queryTimeoutError(input.timeoutMs));
        }, input.timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
