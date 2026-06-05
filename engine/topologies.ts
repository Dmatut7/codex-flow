import type { ItemCtx } from "./types.ts";
import type { EngineRuntime, Scope } from "./runtime.ts";
import { aggregateKeys } from "./runtime.ts";

export function makeTopologies(runtime: EngineRuntime) {
  return {
    async parallel<R>(thunks: Array<() => Promise<R>>): Promise<Array<R | null>> {
      const parent = runtime.currentScope();
      const parentPrev = parent.currentPrevKey;
      const results = await Promise.all(thunks.map(async (thunk, idx) => {
        const child = runtime.makeChildScope({ currentPrevKey: parentPrev, parallelIdx: idx, topologyPath: [...parent.topologyPath, `parallel:${idx}`] });
        try {
          return { status: "fulfilled" as const, value: await runtime.withScope(child, thunk), key: child.currentPrevKey };
        } catch (reason) {
          return { status: "rejected" as const, reason, key: child.currentPrevKey };
        }
      }));
      const keys: Array<string | null> = [];
      const out = results.map((result) => {
        if (result.status === "fulfilled") {
          keys.push(result.key);
          if (isErrorAgentResult(result.value)) return null;
          return result.value;
        }
        if (isWritableIsolationError(result.reason)) throw result.reason;
        keys.push(result.key);
        return null;
      });
      parent.currentPrevKey = aggregateKeys(keys) ?? parent.currentPrevKey;
      return out;
    },

    async pipeline<I, O>(items: I[], ...stages: Array<(prev: any, itemCtx: ItemCtx) => Promise<any>>): Promise<Array<O | null>> {
      const parent = runtime.currentScope();
      const parentPrev = parent.currentPrevKey;
      const results = await Promise.allSettled(items.map(async (item, itemIdx) => {
        let prev: any = item;
        let itemKey: string | null = parentPrev;
        for (let stageIdx = 0; stageIdx < stages.length; stageIdx++) {
          const child = runtime.makeChildScope({ currentPrevKey: itemKey, itemIdx, stageIdx, topologyPath: [...parent.topologyPath, `pipeline:${itemIdx}:${stageIdx}`] });
          const itemCtx: ItemCtx = { itemIdx, stageIdx, cwd: child.cwd };
          let value: any;
          try {
            value = await runtime.withScope(child, () => stages[stageIdx](prev, itemCtx));
          } catch (reason) {
            if (isWritableIsolationError(reason)) throw reason;
            return { value: null as O | null, key: child.currentPrevKey };
          }
          if (value === null || isErrorAgentResult(value)) return { value: null as O | null, key: child.currentPrevKey };
          prev = value;
          itemKey = child.currentPrevKey;
        }
        return { value: prev as O, key: itemKey };
      }));
      const keys: Array<string | null> = [];
      const out = results.map((result) => {
        if (result.status === "fulfilled") {
          keys.push(result.value.key);
          return result.value.value;
        }
        if (isWritableIsolationError(result.reason)) throw result.reason;
        keys.push(null);
        return null;
      });
      parent.currentPrevKey = aggregateKeys(keys) ?? parent.currentPrevKey;
      return out;
    },

    async phase<R>(title: string, body: () => Promise<R>): Promise<R> {
      const parent = runtime.currentScope();
      const child: Scope = runtime.makeChildScope({
        phase: [...parent.phase, title],
        currentPrevKey: parent.currentPrevKey,
        parallelIdx: parent.parallelIdx,
        itemIdx: parent.itemIdx,
        stageIdx: parent.stageIdx,
      });
      const result = await runtime.withScope(child, body);
      parent.currentPrevKey = child.currentPrevKey;
      return result;
    },
  };
}

function isErrorAgentResult(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && (value as { status?: unknown }).status === "error");
}

function isWritableIsolationError(value: unknown): boolean {
  return value instanceof Error && (value.name === "ConcurrentWritableCwdError" || value.name === "WritableIsolationError");
}
