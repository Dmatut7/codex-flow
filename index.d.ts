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

export interface EngineConfig {
  defaultBackend?: BackendName;
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
  adapters?: Record<string, unknown>;
}

export interface Engine {
  ctx: WorkflowContext;
  adapters: Record<string, unknown>;
  run<T>(script: string | ((ctx: WorkflowContext) => Promise<T> | T)): Promise<T>;
}

export function createEngine(config?: EngineConfig): Engine;
export function runWorkflow<T>(
  script: string | ((ctx: WorkflowContext) => Promise<T> | T),
  config?: EngineConfig,
): Promise<T>;
