import type { ItemCtx } from "./types.ts";
import type { EngineRuntime, Scope } from "./runtime.ts";
import { aggregateKeys } from "./runtime.ts";

export function makeTopologies(runtime: EngineRuntime) {
  return {
    async parallel<R>(thunks: Array<() => Promise<R>>): Promise<Array<R | null>> {
      const parent = runtime.currentScope();
      const parentPrev = parent.currentPrevKey;
      const results = await Promise.allSettled(thunks.map((thunk, idx) => {
        const child = runtime.makeChildScope({ currentPrevKey: parentPrev, parallelIdx: idx });
        return runtime.withScope(child, thunk).then((value) => ({ value, key: child.currentPrevKey }));
      }));
      const keys: Array<string | null> = [];
      const out = results.map((result) => {
        if (result.status === "fulfilled") {
          keys.push(result.value.key);
          return result.value.value;
        }
        keys.push(null);
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
          const child = runtime.makeChildScope({ currentPrevKey: itemKey, itemIdx, stageIdx });
          const itemCtx: ItemCtx = { itemIdx, stageIdx, cwd: child.cwd };
          const value = await runtime.withScope(child, () => stages[stageIdx](prev, itemCtx));
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
        keys.push(null);
        return null;
      });
      parent.currentPrevKey = aggregateKeys(keys) ?? parent.currentPrevKey;
      return out;
    },

    async phase<R>(title: string, body: () => Promise<R>): Promise<R> {
      const parent = runtime.currentScope();
      const child: Scope = runtime.makeChildScope({ phase: [...parent.phase, title], currentPrevKey: parent.currentPrevKey });
      const result = await runtime.withScope(child, body);
      parent.currentPrevKey = child.currentPrevKey;
      return result;
    },
  };
}
