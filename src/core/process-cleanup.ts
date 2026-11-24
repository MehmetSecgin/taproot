type CleanupFn = () => void | Promise<void>;

const cleanupByKey = new Map<string, CleanupFn>();
let isCleanupRunning = false;

async function tryCleanup(cleanup: CleanupFn): Promise<boolean> {
  try {
    await cleanup();
    return true;
  } catch {
    return false;
  }
}

export function registerCleanup(key: string, cleanup: CleanupFn): () => void {
  cleanupByKey.set(key, cleanup);
  return () => {
    cleanupByKey.delete(key);
  };
}

export async function runRegisteredCleanup(): Promise<void> {
  if (isCleanupRunning) {
    return;
  }
  isCleanupRunning = true;
  const cleanups = [...cleanupByKey.values()].toReversed();
  cleanupByKey.clear();
  for (const cleanup of cleanups) {
    await tryCleanup(cleanup);
  }
  isCleanupRunning = false;
}
