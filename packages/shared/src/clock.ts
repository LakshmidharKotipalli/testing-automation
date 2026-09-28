export interface Clock {
  now(): number;
  iso(): string;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  iso: () => new Date().toISOString(),
};

/** Manually advanced clock for deterministic tests. */
export class FakeClock implements Clock {
  constructor(private current: number = Date.parse("2026-01-01T00:00:00.000Z")) {}
  now(): number {
    return this.current;
  }
  iso(): string {
    return new Date(this.current).toISOString();
  }
  advance(ms: number): void {
    this.current += ms;
  }
}
