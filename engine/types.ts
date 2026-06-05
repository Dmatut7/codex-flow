import type { AgentAdapter, AdapterRegistryConfig, NormalizedAgentOpts } from "../adapters/types.ts";

export type Sandbox = "read-only" | "workspace-write" | "danger-full-access";
export type BackendName = "codex-sdk" | "codex-exec" | "openai-responses" | "fake" | string;
export type AgentKind = "agentic" | "extract" | "classify" | "judge";
export type BudgetExceededPolicy = "throw" | "skip" | "downgrade";

export interface Usage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens?: number;
}

export interface AgentOpts {
  schema?: unknown;
  backend?: BackendName;
  kind?: AgentKind;
  pure?: boolean;
  isolate?: boolean;
  model?: string;
  cwd?: string;
  sandbox?: Sandbox;
  additionalDirectories?: string[];
  modelReasoningEffort?: string;
  threadId?: string;
  timeoutMs?: number;
  retries?: number;
  nodeKey?: string;
  signal?: AbortSignal;
}

export interface AgentResult<T = unknown> {
  output: T;
  raw: string;
  threadId?: string;
  usage: Usage;
  backend: string;
  replayed: boolean;
  status: "ok" | "error";
}

export interface ItemCtx {
  itemIdx: number;
  stageIdx: number;
  cwd?: string;
}

export interface BudgetController {
  configure(o: { maxTokens?: number; maxNodes?: number; onExceeded?: BudgetExceededPolicy }): void;
  reserve(estimate?: number): void;
  reconcile(actual: Usage, estimate?: number): void;
  guard(): void;
  remaining(): { tokens: number; nodes: number };
  totals(): Usage & { nodes: number };
}

export interface WorkflowContext {
  agent<T = unknown>(prompt: string, opts?: AgentOpts): Promise<AgentResult<T>>;
  parallel<R>(thunks: Array<() => Promise<R>>): Promise<Array<R | null>>;
  pipeline<I, O>(items: I[], ...stages: Array<(prev: any, itemCtx: ItemCtx) => Promise<any>>): Promise<Array<O | null>>;
  phase<R>(title: string, body: () => Promise<R>): Promise<R>;
  log(msg: string, data?: unknown): void;
  now(): number;
  random(): number;
  budget: BudgetController;
}

export interface EngineRunResult<T = unknown> {
  result: T;
}

export interface EngineConfig {
  defaultBackend?: BackendName;
  forceBackend?: BackendName;
  autoRoute?: boolean;
  concurrency?: number;
  hardMaxConcurrency?: number;
  providerRateBudget?: number;
  journalPath?: string;
  seed?: number;
  engineVersion?: string;
  defaultModel?: string;
  estimatedTokensPerCall?: number;
  timeoutMs?: number;
  transientRetries?: number;
  transientBaseMs?: number;
  scratchRoot?: string;
  budget?: { maxTokens?: number; maxNodes?: number; onExceeded?: BudgetExceededPolicy };
  adapters?: AdapterRegistryConfig;
}

export interface Engine {
  ctx: WorkflowContext;
  adapters: Record<string, any>;
  run<T>(script: string | ((ctx: WorkflowContext) => Promise<T> | T)): Promise<T>;
}

export interface StructuralPosition {
  phase: string[];
  parallelIdx?: number;
  itemIdx?: number;
  stageIdx?: number;
  topologyPath?: string[];
  callOrdinal: number;
  nodeKey?: string;
}

export interface JournalManifest {
  type: "manifest";
  engineVersion: string;
  scriptHash: string;
  defaultBackend: string;
  seed: number;
  startedAt: number;
}

export interface JournalNodeRecord {
  type: "node";
  key: string;
  backend: string;
  threadId?: string;
  status: "terminal" | "repair" | "timeout" | "failed";
  attempt?: number;
  result?: unknown;
  raw?: string;
  usage: Usage;
  prevKey?: string | null;
  structuralPosition: StructuralPosition;
  ts: number;
  runningTotals: Usage & { nodes: number };
}

export interface JournalLogRecord {
  type: "log";
  phase: string[];
  ts: number;
  msg: string;
  data?: unknown;
}

export type JournalRecord = JournalManifest | JournalNodeRecord | JournalLogRecord;

export interface EngineStateLike {
  config: Required<Pick<EngineConfig, "defaultBackend" | "autoRoute" | "seed" | "estimatedTokensPerCall" | "engineVersion">> & EngineConfig;
  adapters: Record<string, any>;
  resolveBackend(opts: AgentOpts): string;
  normalizeOpts(opts: AgentOpts, backend: string, cacheKey?: string): Promise<NormalizedAgentOpts>;
}

export const ZERO_USAGE: Usage = {
  input_tokens: 0,
  cached_input_tokens: 0,
  output_tokens: 0,
};
