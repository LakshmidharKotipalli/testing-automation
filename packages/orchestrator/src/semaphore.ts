/**
 * FIFO async semaphore. A released permit is handed directly to the next waiter, so the limit can never be
 * exceeded by a concurrent acquire. Tracks the maximum permits held at once (observed concurrency).
 */
export class Semaphore {
  private active = 0;
  private maxObserved = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(private readonly permits: number) {
    if (permits < 1) throw new Error("semaphore requires at least one permit");
  }

  get maxActive(): number {
    return this.maxObserved;
  }

  get inUse(): number {
    return this.active;
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.permits) {
      this.active++;
    } else {
      // The releasing holder transfers its permit to us; `active` is unchanged by the transfer.
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.maxObserved = Math.max(this.maxObserved, this.active);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    };
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
