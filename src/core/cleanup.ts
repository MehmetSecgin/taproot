type CleanupFn = () => void | Promise<void>;

const entries = new Map<string, CleanupFn>();
let running = false;

export function registerCleanup(key: string, fn: CleanupFn): () => void {
  entries.set(key, fn);
  return () => entries.delete(key);
}

export async function runRegisteredCleanup(): Promise<void> {
  if (running) return;
  running = true;
  const fns = [...entries.values()].reverse();
  entries.clear();
  for (const fn of fns) {
    try {
      await fn();
    } catch {
      // best-effort cleanup
    }
  }
  running = false;
}
