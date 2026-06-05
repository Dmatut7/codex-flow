export class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly width: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.width) {
      this.active++;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
    return () => this.release();
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    if (next) next();
  }
}

export function defaultConcurrency(cpus: number, providerRateBudget = cpus, hardMax = 8): number {
  return Math.max(1, Math.min(cpus, providerRateBudget, hardMax));
}
