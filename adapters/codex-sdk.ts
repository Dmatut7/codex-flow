import type { AgentAdapter, AdapterResult, AdapterRuntime, NormalizedAgentOpts } from "./types.ts";
import type { EngineConfig, Usage } from "../engine/types.ts";

export class CodexSdkAdapter implements AgentAdapter {
  readonly name = "codex-sdk";
  private client: any;

  constructor(private readonly adapterConfig: Record<string, unknown> = {}, private readonly engineConfig: EngineConfig = {}) {}

  async run(prompt: string, opts: NormalizedAgentOpts, runtime: AdapterRuntime): Promise<AdapterResult> {
    const { Codex } = await import("@openai/codex-sdk");
    this.client ??= new Codex(this.adapterConfig as any);
    const threadOptions = {
      workingDirectory: opts.cwd,
      skipGitRepoCheck: true,
      model: opts.model ?? this.engineConfig.defaultModel,
      sandboxMode: opts.sandbox ?? "read-only",
      additionalDirectories: opts.additionalDirectories,
      modelReasoningEffort: opts.modelReasoningEffort,
    };
    const thread = opts.threadId ? this.client.resumeThread(opts.threadId, threadOptions) : this.client.startThread(threadOptions);
    const { events } = await thread.runStreamed(prompt, { outputSchema: opts.schema?.adapterSchema, signal: runtime.signal });
    let finalResponse = "";
    let usage: Usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
    for await (const event of events) {
      if (event.type === "item.completed") {
        runtime.log?.("codex item completed", event.item);
        if (event.item?.type === "agent_message") finalResponse = event.item.text ?? "";
      }
      if (event.type === "turn.completed") usage = normalizeUsage(event.usage);
      if (event.type === "turn.failed") throw new Error(event.error?.message ?? "codex turn failed");
      if (event.type === "error") {
        const message = String(event.message ?? event.error?.message ?? "");
        if (!/^Reconnecting/i.test(message)) throw new Error(message || "codex stream error");
      }
    }
    return { finalResponse, usage, threadId: thread.id ?? undefined };
  }
}

function normalizeUsage(usage: any): Usage {
  return {
    input_tokens: usage?.input_tokens ?? 0,
    cached_input_tokens: usage?.cached_input_tokens ?? 0,
    output_tokens: usage?.output_tokens ?? 0,
    reasoning_output_tokens: usage?.reasoning_output_tokens ?? 0,
  };
}
