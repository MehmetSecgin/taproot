import { overloaded } from '../core/taproot-error.js';

type QueryLimiterStats = {
  inFlight: number;
  queued: number;
  maxConcurrent: number;
  maxQueued: number;
};

type QueueEntry = {
  admit: (release: () => void) => void;
  fail: (error: Error) => void;
};

function toAbortError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  if (typeof reason === 'string' && reason.trim() !== '') {
    return new Error(reason);
  }
  return new Error('Operation aborted.');
}

export class QueryLimiter {
  private readonly queue: QueueEntry[] = [];
  private readonly maxConcurrent: number;
  private readonly maxQueued: number;
  private inFlight = 0;

  public constructor(maxConcurrent: number, maxQueued: number) {
    this.maxConcurrent = maxConcurrent;
    this.maxQueued = maxQueued;
  }

  public async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted === true) {
      throw toAbortError(signal.reason);
    }
    if (this.inFlight < this.maxConcurrent) {
      this.inFlight += 1;
      return this.createReleaseOnce();
    }
    if (this.queue.length >= this.maxQueued) {
      throw overloaded(`query queue limit reached (${this.queue.length}/${this.maxQueued}); wait and retry once, or set TAPROOT_FORCE_DIRECT=1`);
    }
    return this.waitForSlot(signal);
  }

  public stats(): QueryLimiterStats {
    return {
      inFlight: this.inFlight,
      queued: this.queue.length,
      maxConcurrent: this.maxConcurrent,
      maxQueued: this.maxQueued,
    };
  }

  private createReleaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.inFlight = Math.max(0, this.inFlight - 1);
      const next = this.queue.shift();
      if (next === undefined) {
        return;
      }
      this.inFlight += 1;
      next.admit(this.createReleaseOnce());
    };
  }

  private async waitForSlot(signal: AbortSignal | undefined): Promise<() => void> {
    return new Promise<() => void>((resolve, reject) => {
      const stopListening = new AbortController();
      const entry: QueueEntry = {
        admit: (release) => {
          stopListening.abort();
          if (signal?.aborted === true) {
            release();
            reject(toAbortError(signal.reason));
            return;
          }
          resolve(release);
        },
        fail: (error) => {
          stopListening.abort();
          reject(error);
        },
      };
      signal?.addEventListener('abort', () => {
        const position = this.queue.indexOf(entry);
        if (position !== -1) {
          this.queue.splice(position, 1);
        }
        entry.fail(toAbortError(signal.reason));
      }, { once: true, signal: stopListening.signal });
      this.queue.push(entry);
    });
  }
}
