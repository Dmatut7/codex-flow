import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentOpts, EngineConfig, Usage } from "./types.ts";
import type { AgentAdapter, NormalizedAgentOpts, NormalizedSchema } from "../adapters/types.ts";
import { Journal } from "./journal.ts";
import { Semaphore } from "./semaphore.ts";
import { WorkflowBudget } from "./budget.ts";
import { ensureWritableIsolation } from "./agent.ts";

export interface Scope {
  phase: string[];
  callOrdinal: number;
  currentPrevKey: string | null;
  parallelIdx?: number;
  itemIdx?: number;
  stageIdx?: number;
  cwd?: string;
}

export interface EngineRuntime {
  config: Required<Pick<EngineConfig, "defaultBackend" | "autoRoute" | "seed" | "estimatedTokensPerCall" | "engineVersion">> & EngineConfig;
  adapters: Record<string, AgentAdapter>;
  journal: Journal;
  semaphore: Semaphore;
  budget: WorkflowBudget;
  scopeStorage: AsyncLocalStorage<Scope>;
  currentScope(): Scope;
  withScope<T>(scope: Scope, fn: () => Promise<T>): Promise<T>;
  makeChildScope(overrides?: Partial<Scope>): Scope;
  resolveBackend(opts: AgentOpts): string;
  normalizeOpts(opts: AgentOpts, backend: string, key: string, cacheCwd: string | undefined, schema: NormalizedSchema | undefined): Promise<NormalizedAgentOpts>;
  log(msg: string, data?: unknown): void;
  now(): number;
}

export function makeScope(parent?: Scope, overrides: Partial<Scope> = {}): Scope {
  return {
    phase: overrides.phase ?? [...(parent?.phase ?? [])],
    callOrdinal: overrides.callOrdinal ?? 0,
    currentPrevKey: overrides.currentPrevKey ?? parent?.currentPrevKey ?? null,
    parallelIdx: overrides.parallelIdx,
    itemIdx: overrides.itemIdx,
    stageIdx: overrides.stageIdx,
    cwd: overrides.cwd,
  };
}

export function aggregateKeys(keys: Array<string | null | undefined>): string | null {
  const present = keys.filter(Boolean) as string[];
  if (!present.length) return null;
  return `agg:${present.join("|")}`;
}
