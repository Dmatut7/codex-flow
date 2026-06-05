import { AsyncLocalStorage } from "node:async_hooks";

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

interface DeterministicState {
  randomState: number;
  nowValue: number;
  hrtimeNanoseconds: bigint;
}

function makeState(seed: number): DeterministicState {
  return {
    randomState: seed >>> 0,
    nowValue: seed,
    hrtimeNanoseconds: BigInt(seed) * 1_000_000n,
  };
}

function deriveSeed(seed: number, key: string): number {
  let hash = seed >>> 0;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function nextRandom(state: DeterministicState): number {
  state.randomState += 0x6D2B79F5;
  let t = state.randomState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function nextNow(state: DeterministicState): number {
  state.nowValue += 1;
  return state.nowValue;
}

function nextHrtimeNanoseconds(state: DeterministicState): bigint {
  state.hrtimeNanoseconds += 1_000_000n;
  return state.hrtimeNanoseconds;
}

export class Determinism {
  private readonly seed: number;
  private readonly workflowState: DeterministicState;
  private readonly isolatedGlobals = new AsyncLocalStorage<DeterministicState>();
  private journalNowValue: number;

  constructor(seed: number) {
    this.seed = seed;
    this.workflowState = makeState(seed);
    this.journalNowValue = seed;
  }

  now(): number {
    return nextNow(this.workflowState);
  }

  journalNow(): number {
    this.journalNowValue += 1;
    return this.journalNowValue;
  }

  random(): number {
    return nextRandom(this.workflowState);
  }

  async withIsolatedGlobals<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.isolatedGlobals.run(makeState(deriveSeed(this.seed, key)), fn);
  }

  async withShadowedGlobals<T>(fn: () => Promise<T>): Promise<T> {
    const originalDate = globalThis.Date;
    const originalRandom = Math.random;
    const originalPerformanceNow = (globalThis.performance as any)?.now?.bind(globalThis.performance);
    const originalHrtime = process.hrtime;
    const originalHrtimeBigint = process.hrtime.bigint;
    const originalRandomUUID = (globalThis.crypto as any)?.randomUUID;
    const originalGetRandomValues = (globalThis.crypto as any)?.getRandomValues;
    const deterministicNow = () => this.globalNow();
    const self = this;
    class DeterministicDate extends originalDate {
      constructor(...args: any[]) {
        if (args.length === 0) super(deterministicNow());
        else super(...(args as []));
      }
      static now(): number { return deterministicNow(); }
    }
    const deterministicHrtime = ((time?: [number, number]) => {
      const current = self.nextGlobalHrtimeNanoseconds();
      const seconds = Number(current / 1_000_000_000n);
      const nanoseconds = Number(current % 1_000_000_000n);
      if (!time) return [seconds, nanoseconds] as [number, number];
      let deltaSeconds = seconds - time[0];
      let deltaNanoseconds = nanoseconds - time[1];
      if (deltaNanoseconds < 0) {
        deltaSeconds -= 1;
        deltaNanoseconds += 1_000_000_000;
      }
      return [deltaSeconds, deltaNanoseconds] as [number, number];
    }) as NodeJS.HRTime;
    deterministicHrtime.bigint = () => self.nextGlobalHrtimeNanoseconds();
    const deterministicGetRandomValues = <TArray extends ArrayBufferView | null>(array: TArray): TArray => {
      if (!array || typeof array !== "object" || !("byteLength" in array)) return array;
      const view = new Uint8Array((array as ArrayBufferView).buffer, (array as ArrayBufferView).byteOffset, (array as ArrayBufferView).byteLength);
      for (let i = 0; i < view.length; i += 1) view[i] = Math.floor(self.globalRandom() * 256);
      return array;
    };
    const deterministicRandomUUID = () => {
      const bytes = new Uint8Array(16);
      deterministicGetRandomValues(bytes);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
    };
    try {
      // Best-effort: dependencies that captured real globals at import time may still leak; scripts must keep control flow off wall-clock/RNG.
      (globalThis as any).Date = DeterministicDate;
      Math.random = () => self.globalRandom();
      (process.hrtime as any) = deterministicHrtime;
      (process.hrtime as any).bigint = deterministicHrtime.bigint;
      if ((globalThis.performance as any) && originalPerformanceNow) {
        try { (globalThis.performance as any).now = deterministicNow; } catch {}
      }
      if ((globalThis.crypto as any)?.randomUUID) {
        try { (globalThis.crypto as any).randomUUID = deterministicRandomUUID; } catch {}
      }
      if ((globalThis.crypto as any)?.getRandomValues) {
        try { (globalThis.crypto as any).getRandomValues = deterministicGetRandomValues; } catch {}
      }
      return await fn();
    } finally {
      (globalThis as any).Date = originalDate;
      Math.random = originalRandom;
      (process.hrtime as any) = originalHrtime;
      (process.hrtime as any).bigint = originalHrtimeBigint;
      if ((globalThis.performance as any) && originalPerformanceNow) {
        try { (globalThis.performance as any).now = originalPerformanceNow; } catch {}
      }
      if ((globalThis.crypto as any)?.randomUUID && originalRandomUUID) {
        try { (globalThis.crypto as any).randomUUID = originalRandomUUID; } catch {}
      }
      if ((globalThis.crypto as any)?.getRandomValues && originalGetRandomValues) {
        try { (globalThis.crypto as any).getRandomValues = originalGetRandomValues; } catch {}
      }
    }
  }

  private globalState(): DeterministicState {
    return this.isolatedGlobals.getStore() ?? this.workflowState;
  }

  private globalNow(): number {
    return nextNow(this.globalState());
  }

  private globalRandom(): number {
    return nextRandom(this.globalState());
  }

  private nextGlobalHrtimeNanoseconds(): bigint {
    return nextHrtimeNanoseconds(this.globalState());
  }
}
