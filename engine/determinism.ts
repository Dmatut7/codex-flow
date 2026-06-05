export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a += 0x6D2B79F5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Determinism {
  private readonly rand: () => number;
  private nowValue: number;

  constructor(seed: number) {
    this.rand = mulberry32(seed);
    this.nowValue = seed;
  }

  now(): number {
    this.nowValue += 1;
    return this.nowValue;
  }

  random(): number {
    return this.rand();
  }

  async withShadowedGlobals<T>(fn: () => Promise<T>): Promise<T> {
    const originalDate = globalThis.Date;
    const originalRandom = Math.random;
    const originalPerformanceNow = (globalThis.performance as any)?.now?.bind(globalThis.performance);
    const deterministicNow = () => this.now();
    const self = this;
    class DeterministicDate extends originalDate {
      constructor(...args: any[]) {
        if (args.length === 0) super(deterministicNow());
        else super(...(args as []));
      }
      static now(): number { return deterministicNow(); }
    }
    try {
      (globalThis as any).Date = DeterministicDate;
      Math.random = () => self.random();
      if ((globalThis.performance as any) && originalPerformanceNow) {
        try { (globalThis.performance as any).now = deterministicNow; } catch {}
      }
      return await fn();
    } finally {
      (globalThis as any).Date = originalDate;
      Math.random = originalRandom;
      if ((globalThis.performance as any) && originalPerformanceNow) {
        try { (globalThis.performance as any).now = originalPerformanceNow; } catch {}
      }
    }
  }
}
