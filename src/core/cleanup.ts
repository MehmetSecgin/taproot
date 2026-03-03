type CleanupFn = () => void | Promise<void>;

interface CleanupEntry {
  key: string;
  fn: CleanupFn;
}

class CleanupRegistry {
  private readonly entries = new Map<string, CleanupEntry>();
  private running = false;

  register(key: string, fn: CleanupFn): () => void {
    this.entries.set(key, { key, fn });
    return () => this.entries.delete(key);
  }

  async runAll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries.reverse()) {
      try {
        await entry.fn();
      } catch {
        // best-effort cleanup
      }
    }
    this.running = false;
  }
}

const registry = new CleanupRegistry();

export function registerCleanup(key: string, fn: CleanupFn): () => void {
  return registry.register(key, fn);
}

export async function runRegisteredCleanup(): Promise<void> {
  await registry.runAll();
}
