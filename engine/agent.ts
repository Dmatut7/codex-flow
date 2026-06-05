import { realpathSync } from "node:fs";
import path from "node:path";
import type { AgentOpts, AgentResult, StructuralPosition, Usage } from "./types.ts";
import { ZERO_USAGE } from "./types.ts";
import type { EngineRuntime, Scope } from "./runtime.ts";
import { sha256 } from "./canonical.ts";
import { buildRepairPrompt, normalizeSchema, parseAndValidate } from "./schema.ts";
import type { AdapterResult, AgentAdapter, NormalizedAgentOpts } from "../adapters/types.ts";

export class TimeoutError extends Error {
  constructor(message = "agent call timed out") {
    super(message);
    this.name = "TimeoutError";
  }
}

export class ConcurrentWritableCwdError extends Error {
  constructor(cwd: string) {
    super(`Concurrent writable agent already active for cwd: ${cwd}`);
    this.name = "ConcurrentWritableCwdError";
  }
}

export async function runAgent<T>(runtime: EngineRuntime, prompt: string, opts: AgentOpts = {}): Promise<AgentResult<T>> {
  const scope = runtime.currentScope();
  const structuralPosition = allocateStructuralPosition(scope, opts.nodeKey);
  const schema = normalizeSchema(opts.schema);
  const backendInitial = runtime.resolveBackend(opts);
  const cacheCwd = cacheCwdFor(opts);
  const cacheAdditionalDirectories = opts.additionalDirectories?.map((dir) => path.resolve(dir)).sort();
  const sandbox = opts.sandbox ?? "read-only";
  const prevKey = scope.currentPrevKey ?? null;
  const key = sha256({
    prompt,
    schema: schema?.validationSchema,
    model: opts.model ?? runtime.config.defaultModel,
    modelReasoningEffort: opts.modelReasoningEffort,
    additionalDirectories: cacheAdditionalDirectories,
    cwd: cacheCwd,
    sandbox,
    structuralPosition,
    prevKey,
  });

  const replay = runtime.journal.get(key);
  if (replay) {
    const result = makeResult<T>(replay.result as T, replay.raw ?? "", replay.usage, replay.backend, true, replay.threadId, replay.status === "terminal" && replay.result !== null ? "ok" : "error");
    scope.currentPrevKey = key;
    return result;
  }

  let backend = backendInitial;
  const action = runtime.budget.actionFor(opts);
  if (action === "skip") {
    const skipped = makeResult<T>(null as T, "", ZERO_USAGE, backend, false, undefined, "error");
    appendTerminal(runtime, key, backend, structuralPosition, prevKey, skipped, "failed");
    scope.currentPrevKey = key;
    return skipped;
  }
  if (action === "downgrade") backend = "openai-responses";

  const normalized = await runtime.normalizeOpts({ ...opts, schema: undefined }, backend, key, cacheCwd, schema);
  const adapter = runtime.adapters[backend];
  if (!adapter) throw new Error(`Unknown backend: ${backend}`);

  const maxRepair = opts.retries ?? 2;
  let currentPrompt = prompt;
  let lastUsage: Usage = ZERO_USAGE;
  let lastRaw = "";
  let threadId: string | undefined;

  for (let attempt = 0; attempt <= maxRepair; attempt++) {
    const estimate = runtime.config.estimatedTokensPerCall;
    runtime.budget.reserve(estimate);
    const abortController = new AbortController();
    const timeoutMs = opts.timeoutMs ?? runtime.config.timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abortFromOuter = () => abortController.abort(opts.signal?.reason);
    opts.signal?.addEventListener("abort", abortFromOuter, { once: true });
    if (timeoutMs) timer = setTimeout(() => abortController.abort(new TimeoutError()), timeoutMs);
    try {
      const adapterResult = await runAdapterWithTransientRetry(runtime, adapter, currentPrompt, normalized, abortController.signal, key);
      lastUsage = adapterResult.usage;
      lastRaw = adapterResult.finalResponse;
      threadId = adapterResult.threadId;
      runtime.budget.reconcile(lastUsage, estimate);
    } catch (error) {
      runtime.budget.reconcile(ZERO_USAGE, estimate);
      if (error instanceof ConcurrentWritableCwdError) throw error;
      const status = abortController.signal.aborted || error instanceof TimeoutError ? "timeout" : "failed";
      const failed = makeResult<T>(null as T, errorMessage(error), ZERO_USAGE, backend, false, threadId, "error");
      appendTerminal(runtime, key, backend, structuralPosition, prevKey, failed, status);
      scope.currentPrevKey = key;
      return failed;
    } finally {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abortFromOuter);
    }

    const parsed = parseAndValidate(lastRaw, schema);
    if (parsed.ok) {
      const ok = makeResult<T>(parsed.output as T, lastRaw, lastUsage, backend, false, threadId, "ok");
      appendTerminal(runtime, key, backend, structuralPosition, prevKey, ok, "terminal");
      scope.currentPrevKey = key;
      return ok;
    }

    if (attempt < maxRepair) {
      runtime.journal.appendNode({
        type: "node",
        key,
        backend,
        threadId,
        status: "repair",
        attempt: attempt + 1,
        raw: lastRaw,
        usage: lastUsage,
        prevKey,
        structuralPosition,
        ts: runtime.now(),
        runningTotals: runtime.budget.totals(),
      });
      currentPrompt = buildRepairPrompt(prompt, lastRaw, parsed.errors);
      continue;
    }

    const failed = makeResult<T>(null as T, lastRaw, lastUsage, backend, false, threadId, "error");
    appendTerminal(runtime, key, backend, structuralPosition, prevKey, failed, "terminal");
    scope.currentPrevKey = key;
    return failed;
  }
  throw new Error("unreachable agent loop");
}

function allocateStructuralPosition(scope: Scope, nodeKey?: string): StructuralPosition {
  const callOrdinal = scope.callOrdinal++;
  return {
    phase: [...scope.phase],
    parallelIdx: scope.parallelIdx,
    itemIdx: scope.itemIdx,
    stageIdx: scope.stageIdx,
    topologyPath: scope.topologyPath.length > 1 ? [...scope.topologyPath] : undefined,
    callOrdinal,
    nodeKey,
  };
}

function makeResult<T>(output: T, raw: string, usage: Usage, backend: string, replayed: boolean, threadId: string | undefined, status: "ok" | "error"): AgentResult<T> {
  return { output, raw, usage, backend, replayed, threadId, status };
}

function appendTerminal<T>(runtime: EngineRuntime, key: string, backend: string, structuralPosition: StructuralPosition, prevKey: string | null, result: AgentResult<T>, status: "terminal" | "timeout" | "failed"): void {
  runtime.journal.appendNode({
    type: "node",
    key,
    backend,
    threadId: result.threadId,
    status: status === "terminal" ? "terminal" : status,
    result: result.status === "ok" ? result.output : null,
    raw: result.raw,
    usage: result.usage,
    prevKey,
    structuralPosition,
    ts: runtime.now(),
    runningTotals: runtime.budget.totals(),
  });
}

async function runAdapterWithTransientRetry(
  runtime: EngineRuntime,
  adapter: AgentAdapter,
  prompt: string,
  normalized: NormalizedAgentOpts,
  signal: AbortSignal,
  cacheKey: string,
): Promise<AdapterResult> {
  const maxRetries = runtime.config.transientRetries ?? 3;
  const baseMs = runtime.config.transientBaseMs ?? 500;
  for (let retry = 0; ; retry++) {
    const release = await runtime.semaphore.acquire(signal);
    let releaseWritable = () => {};
    try {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new TimeoutError("agent call aborted");
      releaseWritable = registerWritableCwd(runtime, normalized);
      return await adapter.run(prompt, normalized, {
        signal,
        log: (msg, data) => runtime.log(msg, data),
      });
    } catch (error) {
      if (signal.aborted || error instanceof TimeoutError || !isTransient(error) || retry >= maxRetries) throw error;
    } finally {
      releaseWritable();
      release();
    }
    await sleep(transientDelayMs(baseMs, retry, cacheKey), signal);
  }
}

export function isTransient(error: unknown): boolean {
  const status = numericStatus(error);
  if (status === 429) return true;
  if (status !== undefined && status >= 500) return true;
  if (status !== undefined && status >= 400) return false;
  return /429|rate.?limit|quota|overloaded|throttl|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|reconnecting/i.test(errorMessage(error));
}

function numericStatus(error: unknown): number | undefined {
  const candidate = (error as { status?: unknown; statusCode?: unknown })?.status ?? (error as { statusCode?: unknown })?.statusCode;
  const status = Number(candidate);
  return Number.isFinite(status) ? status : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return String(error ?? "");
}

function transientDelayMs(baseMs: number, retry: number, cacheKey: string): number {
  if (baseMs <= 0) return 0;
  const start = (retry * 4) % Math.max(1, cacheKey.length - 4);
  const jitter = parseInt(cacheKey.slice(start, start + 4), 16) % baseMs;
  return baseMs * 2 ** retry + jitter;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new TimeoutError("agent call aborted"));
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new TimeoutError("agent call aborted"));
    };
    function done(): void {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function ensureWritableIsolation(runtime: EngineRuntime, opts: AgentOpts, key: string): Promise<string | undefined> {
  const sandbox = opts.sandbox ?? "read-only";
  if (sandbox === "read-only") return opts.cwd ? path.resolve(opts.cwd) : undefined;
  if (!opts.cwd) throw new Error("workspace-write/danger-full-access requires opts.cwd");
  return realWritableCwd(opts.cwd);
}

function registerWritableCwd(runtime: EngineRuntime, normalized: NormalizedAgentOpts): () => void {
  if (normalized.sandbox === "read-only") return () => {};
  if (!normalized.cwd) throw new Error("workspace-write/danger-full-access requires opts.cwd");
  const cwd = realWritableCwd(normalized.cwd);
  if (runtime.activeWritableCwds.has(cwd)) throw new ConcurrentWritableCwdError(cwd);
  runtime.activeWritableCwds.add(cwd);
  return () => {
    runtime.activeWritableCwds.delete(cwd);
  };
}

function cacheCwdFor(opts: AgentOpts): string | undefined {
  if (!opts.cwd) return undefined;
  if ((opts.sandbox ?? "read-only") === "read-only") return path.resolve(opts.cwd);
  return realWritableCwd(opts.cwd);
}

function realWritableCwd(cwd: string): string {
  try {
    return realpathSync.native(cwd);
  } catch {
    throw new Error(`workspace-write/danger-full-access cwd not found: ${path.resolve(cwd)}`);
  }
}
