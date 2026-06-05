export class Semaphore {
  private active = 0;
  private queue: Array<{ resolve: () => void; reject: (error: unknown) => void; signal?: AbortSignal; onAbort?: () => void }> = [];

  constructor(private readonly width: number) {}

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw abortError(signal);
    if (this.active < this.width) {
      this.active++;
      return () => this.release();
    }
    const waiter = await new Promise<{ signal?: AbortSignal; onAbort?: () => void }>((resolve, reject) => {
      const queued = { resolve: () => resolve(queued), reject, signal } as { resolve: () => void; reject: (error: unknown) => void; signal?: AbortSignal; onAbort?: () => void };
      queued.onAbort = () => {
        this.queue = this.queue.filter((item) => item !== queued);
        reject(abortError(signal));
      };
      signal?.addEventListener("abort", queued.onAbort, { once: true });
      this.queue.push(queued);
    });
    if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
    if (signal?.aborted) throw abortError(signal);
    this.active++;
    return () => this.release();
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    if (next) next.resolve();
  }
}

function abortError(signal?: AbortSignal): unknown {
  return signal?.reason instanceof Error ? signal.reason : new Error("semaphore acquire aborted");
}

export function defaultConcurrency(cpus: number, providerRateBudget = cpus, hardMax = 8): number {
  return Math.max(1, Math.min(cpus, providerRateBudget, hardMax));
}
