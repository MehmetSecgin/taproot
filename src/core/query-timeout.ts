export function queryTimeoutError(timeoutMs: number): Error {
  return new Error(`QUERY_TIMEOUT: query exceeded timeout (${timeoutMs}ms) and was aborted.`);
}

export function parseTimeoutMs(value: unknown, fallbackMs: number): number {
  if (value === undefined || value === null || value === '') return fallbackMs;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`BAD_INPUT: invalid timeout '${String(value)}'. Expected a positive integer in milliseconds.`);
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
