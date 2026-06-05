import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import os from "node:os";
import type { AgentOpts, Engine, EngineConfig, WorkflowContext } from "./types.ts";
import { Journal } from "./journal.ts";
import { Semaphore, defaultConcurrency } from "./semaphore.ts";
import { WorkflowBudget } from "./budget.ts";
import { Determinism } from "./determinism.ts";
import { sha256 } from "./canonical.ts";
import { runAgent, ensureWritableIsolation } from "./agent.ts";
import { makeTopologies } from "./topologies.ts";
import { aggregateKeys, makeScope, type EngineRuntime, type Scope } from "./runtime.ts";
import { createAdapters, resolveBackend as resolveBackendFromRegistry } from "../adapters/registry.ts";
import type { AgentAdapter, NormalizedAgentOpts, NormalizedSchema } from "../adapters/types.ts";

const DEFAULT_ENGINE_VERSION = "0.2.2";

class WorkflowEngine implements Engine, EngineRuntime {
  readonly config: Required<Pick<EngineConfig, "defaultBackend" | "autoRoute" | "seed" | "estimatedTokensPerCall" | "engineVersion">> & EngineConfig;
  readonly adapters: Record<string, AgentAdapter>;
  readonly journal: Journal;
  readonly semaphore: Semaphore;
  readonly activeWritableCwds = new Set<string>();
  readonly scopeStorage = new AsyncLocalStorage<Scope>();
  determinism: Determinism;
  readonly budget: WorkflowBudget;
  readonly ctx: WorkflowContext;

  constructor(config: EngineConfig = {}) {
    this.config = {
      ...config,
      defaultBackend: config.defaultBackend ?? "codex-sdk",
      autoRoute: config.autoRoute ?? true,
      seed: config.seed ?? 1,
      estimatedTokensPerCall: config.estimatedTokensPerCall ?? 1000,
      engineVersion: config.engineVersion ?? DEFAULT_ENGINE_VERSION,
    };
    this.adapters = createAdapters(this.config);
    const width = config.concurrency ?? defaultConcurrency(os.cpus().length, config.providerRateBudget, config.hardMaxConcurrency ?? 8);
    this.semaphore = new Semaphore(width);
    this.journal = new Journal(config.journalPath ?? path.join(process.cwd(), ".codex-flow", "journal.jsonl"));
    this.determinism = new Determinism(this.config.seed);
    this.budget = new WorkflowBudget(config.budget);
    const topologies = makeTopologies(this);
    this.ctx = {
      agent: <T = unknown>(prompt: string, opts?: AgentOpts) => runAgent<T>(this, prompt, opts),
      parallel: topologies.parallel,
      pipeline: topologies.pipeline,
      phase: topologies.phase,
      log: (msg: string, data?: unknown) => this.log(msg, data),
      now: () => this.now(),
      random: () => this.determinism.random(),
      budget: this.budget,
    };
  }

  async run<T>(script: string | ((ctx: WorkflowContext) => Promise<T> | T)): Promise<T> {
    this.determinism = new Determinism(this.config.seed);
    const prepared = await prepareScript<T>(script);
    this.journal.init({
      engineVersion: this.config.engineVersion,
      scriptHash: prepared.hash,
      defaultBackend: this.config.defaultBackend,
      seed: this.config.seed,
    });
    this.budget.loadTotals(this.journal.runningTotals());
    const root = makeScope(undefined, { phase: [], currentPrevKey: null });
    return this.determinism.withShadowedGlobals(async () => {
      const fn = await prepared.load();
      return this.withScope(root, async () => fn(this.ctx));
    });
  }

  currentScope(): Scope {
    const scope = this.scopeStorage.getStore();
    if (!scope) throw new Error("Workflow context is only available inside engine.run()");
    return scope;
  }

  async withScope<T>(scope: Scope, fn: () => Promise<T>): Promise<T> {
    return this.scopeStorage.run(scope, fn);
  }

  makeChildScope(overrides: Partial<Scope> = {}): Scope {
    return makeScope(this.currentScope(), overrides);
  }

  resolveBackend(opts: AgentOpts): string {
    return String(resolveBackendFromRegistry(this.config, opts));
  }

  async normalizeOpts(opts: AgentOpts, backend: string, key: string, cacheCwd: string | undefined, schema: NormalizedSchema | undefined): Promise<NormalizedAgentOpts> {
    const cwd = await ensureWritableIsolation(this, opts, key);
    return {
      ...opts,
      backend,
      sandbox: opts.sandbox ?? "read-only",
      model: opts.model ?? this.config.defaultModel,
      cwd,
      cacheCwd,
      schema,
    };
  }

  log(msg: string, data?: unknown): void {
    const scope = this.currentScope();
    this.journal.appendLog({ type: "log", phase: [...scope.phase], ts: this.journalNow(), msg, data });
  }

  now(): number {
    return this.determinism.now();
  }

  journalNow(): number {
    return this.determinism.journalNow();
  }
}

export function createEngine(config: EngineConfig = {}): Engine {
  return new WorkflowEngine(config);
}

export async function runWorkflow<T>(script: string | ((ctx: WorkflowContext) => Promise<T> | T), config: EngineConfig = {}): Promise<T> {
  return createEngine(config).run(script);
}

async function prepareScript<T>(script: string | ((ctx: WorkflowContext) => Promise<T> | T)): Promise<{ hash: string; load: () => Promise<(ctx: WorkflowContext) => Promise<T> | T> }> {
  if (typeof script === "function") return { hash: sha256(script.toString()), load: async () => script };
  const absolute = path.resolve(script);
  const source = await readFile(absolute, "utf8");
  const hash = sha256(source);
  return {
    hash,
    load: async () => {
      const mod = await import(pathToFileURL(absolute).href + `?v=${hash}`);
      const fn = mod.default ?? mod.workflow;
      if (typeof fn !== "function") throw new Error(`Workflow script ${script} must export a default function`);
      return fn;
    },
  };
}

export type { AgentOpts, AgentResult, WorkflowContext, EngineConfig, Usage } from "./types.ts";
