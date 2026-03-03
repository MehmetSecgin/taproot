export interface QueryLimiterStats {
  inFlight: number;
  queued: number;
  maxConcurrent: number;
  maxQueued: number;
}

type QueueEntry = {
  resolve: (release: () => void) => void;
};

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

  async acquire(): Promise<() => void> {
    if (this.inFlight < this.maxConcurrent) {
      this.inFlight += 1;
      return this.makeRelease();
    }
    if (this.queue.length >= this.maxQueued) {
      throw new Error(`OVERLOADED: query queue limit reached (${this.queue.length}/${this.maxQueued})`);
    }
    return await new Promise<() => void>((resolve) => {
      this.queue.push({ resolve });
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
