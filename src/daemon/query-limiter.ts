import { overloaded } from '../core/error-classification.js';

export interface QueryLimiterStats {
  inFlight: number;
  queued: number;
  maxConcurrent: number;
  maxQueued: number;
}

type QueueEntry = {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
};

function toAbortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  if (typeof reason === 'string' && reason.trim()) return new Error(reason);
  return new Error('Operation aborted.');
}

export class QueryLimiter {
  private readonly queue: QueueEntry[] = [];
  private inFlight = 0;

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueued: number,
  ) {}

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight = Math.max(0, this.inFlight - 1);
      const next = this.queue.shift();
      if (!next) return;
      this.inFlight += 1;
      next.resolve(this.makeRelease());
    };
  }

  async acquire(input?: { signal?: AbortSignal }): Promise<() => void> {
    if (input?.signal?.aborted) {
      throw toAbortError(input.signal.reason);
    }
    if (this.inFlight < this.maxConcurrent) {
      this.inFlight += 1;
      return this.makeRelease();
    }
    if (this.queue.length >= this.maxQueued) {
      throw overloaded(`query queue limit reached (${this.queue.length}/${this.maxQueued}); wait and retry once, or set TAPROOT_FORCE_DIRECT=1`);
    }
    return await new Promise<() => void>((resolve, reject) => {
      const entry: QueueEntry = {
        resolve: (release) => {
          cleanup();
          if (input?.signal?.aborted) {
            release();
            reject(toAbortError(input.signal.reason));
            return;
          }
          resolve(release);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
      const onAbort = () => {
        const idx = this.queue.indexOf(entry);
        if (idx >= 0) this.queue.splice(idx, 1);
        entry.reject(toAbortError(input?.signal?.reason));
      };
      const cleanup = () => input?.signal?.removeEventListener('abort', onAbort);
      input?.signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(entry);
    });
  }

  stats(): QueryLimiterStats {
    return {
      inFlight: this.inFlight,
      queued: this.queue.length,
      maxConcurrent: this.maxConcurrent,
      maxQueued: this.maxQueued,
    };
  }
}
