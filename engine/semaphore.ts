export class Semaphore {
  private active = 0;
  private queue: Array<{ resolve: (release: () => void) => void; reject: (error: unknown) => void; signal?: AbortSignal; onAbort?: () => void }> = [];

  constructor(private readonly width: number) {}

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw abortError(signal);
    if (this.active < this.width) {
      this.active++;
      return () => this.release();
    }
    return new Promise<() => void>((resolve, reject) => {
      const queued = { resolve, reject, signal } as { resolve: (release: () => void) => void; reject: (error: unknown) => void; signal?: AbortSignal; onAbort?: () => void };
      queued.onAbort = () => {
        this.queue = this.queue.filter((item) => item !== queued);
        reject(abortError(signal));
      };
      signal?.addEventListener("abort", queued.onAbort, { once: true });
      this.queue.push(queued);
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      if (next.onAbort) next.signal?.removeEventListener("abort", next.onAbort);
      if (next.signal?.aborted) {
        next.reject(abortError(next.signal));
        this.release();
        return;
      }
      next.resolve(() => this.release());
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }
}

function abortError(signal?: AbortSignal): unknown {
  return signal?.reason instanceof Error ? signal.reason : new Error("semaphore acquire aborted");
}

export function defaultConcurrency(cpus: number, providerRateBudget = cpus, hardMax = 8): number {
  return Math.max(1, Math.min(cpus, providerRateBudget, hardMax));
}
