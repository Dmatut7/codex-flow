import type { AgentOpts, BackendName, Sandbox, Usage } from "../engine/types.ts";

export interface NormalizedSchema {
  validationSchema: any;
  adapterSchema: any;
  validator: (value: unknown) => { ok: true; value: unknown } | { ok: false; errors: string[] };
}

export interface NormalizedAgentOpts extends Omit<AgentOpts, "schema"> {
  backend: BackendName;
  sandbox: Sandbox;
  model?: string;
  cwd?: string;
  cacheCwd?: string;
  schema?: NormalizedSchema;
}

export interface AdapterRuntime {
  signal: AbortSignal;
  log?: (msg: string, data?: unknown) => void;
}

export interface AdapterResult {
  finalResponse: string;
  usage: Usage;
  threadId?: string;
}

export interface AgentAdapter {
  readonly name: string;
  run(prompt: string, normalizedOpts: NormalizedAgentOpts, runtime: AdapterRuntime): Promise<AdapterResult>;
}

export type FakeResponse = unknown | string | Error | ((request: { prompt: string; opts: NormalizedAgentOpts; attempt: number }) => unknown | Promise<unknown>);

export interface FakeAdapterConfig {
  responses?: FakeResponse[];
  resolver?: (request: { prompt: string; opts: NormalizedAgentOpts; attempt: number }) => unknown | Promise<unknown>;
  usage?: Partial<Usage>;
  delayMs?: number;
}

export interface AdapterRegistryConfig {
  fake?: FakeAdapterConfig;
  codexSdk?: Record<string, unknown>;
  codexExec?: Record<string, unknown>;
  openaiResponses?: Record<string, unknown>;
}
