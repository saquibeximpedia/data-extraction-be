/** Caps how many async jobs run at once */
export class Semaphore {
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor(private max: number) {}

  /** Changes the cap; a larger one lets waiting jobs start straight away */
  public setMax(max: number): void {
    this.max = max;
    while (this.active < this.max && this.waiting.length) {
      this.active++;
      this.waiting.shift()!();
    }
  }

  public async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await fn();
    } finally {
      // Hand the slot straight to the next waiter, unless the cap was lowered meanwhile
      if (this.waiting.length && this.active <= this.max) {
        this.waiting.shift()!();
      } else {
        this.active--;
      }
    }
  }
}

/** Spaces out calls so no more than `perMinute` start in any minute */
export class RateLimiter {
  private nextSlotAt = 0;
  private readonly intervalMs: number;

  constructor(perMinute: number) {
    this.intervalMs = perMinute > 0 ? 60_000 / perMinute : 0;
  }

  public async wait(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlotAt);
    this.nextSlotAt = slot + this.intervalMs;
    if (slot > now) {
      await new Promise((resolve) => setTimeout(resolve, slot - now));
    }
  }
}
