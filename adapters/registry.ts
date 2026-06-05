import type { AgentOpts, BackendName, EngineConfig } from "../engine/types.ts";
import type { AgentAdapter } from "./types.ts";
import { FakeAdapter } from "./fake.ts";
import { CodexSdkAdapter } from "./codex-sdk.ts";
import { CodexExecAdapter } from "./codex-exec.ts";
import { OpenAIResponsesAdapter } from "./openai-responses.ts";

export function createAdapters(config: EngineConfig): Record<string, AgentAdapter> {
  const adapters: Record<string, AgentAdapter> = {
    fake: new FakeAdapter(config.adapters?.fake),
    "codex-sdk": new CodexSdkAdapter(config.adapters?.codexSdk ?? {}, config),
    "codex-exec": new CodexExecAdapter(config.adapters?.codexExec ?? {}, config),
    "openai-responses": new OpenAIResponsesAdapter(config.adapters?.openaiResponses ?? {}, config),
  };
  return adapters;
}

export function resolveBackend(config: EngineConfig, opts: AgentOpts): BackendName {
  if (opts.backend) return opts.backend;
  if (config.autoRoute !== false) {
    const routed = autoRoute(opts);
    if (routed) return routed;
  }
  return config.defaultBackend ?? "codex-sdk";
}

export function autoRoute(opts: AgentOpts): BackendName | undefined {
  if (opts.isolate === true) return "codex-exec";
  const schemaOnly = opts.schema && (opts.pure === true || opts.kind === "extract" || opts.kind === "classify" || opts.kind === "judge") && !opts.cwd && opts.sandbox !== "workspace-write" && opts.sandbox !== "danger-full-access" && !opts.additionalDirectories?.length;
  if (schemaOnly) return "openai-responses";
  return undefined;
}
