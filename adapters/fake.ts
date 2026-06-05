import type { AdapterResult, AgentAdapter, FakeAdapterConfig, FakeResponse, NormalizedAgentOpts } from "./types.ts";
import type { Usage } from "../engine/types.ts";

export interface FakeCall {
  prompt: string;
  opts: NormalizedAgentOpts;
  attempt: number;
}

export class FakeAdapter implements AgentAdapter {
  readonly name = "fake";
  readonly calls: FakeCall[] = [];
  private responses: FakeResponse[];

  constructor(private readonly config: FakeAdapterConfig = {}) {
    this.responses = [...(config.responses ?? [])];
  }

  async run(prompt: string, opts: NormalizedAgentOpts): Promise<AdapterResult> {
    const attempt = this.calls.filter((call) => call.prompt === prompt).length;
    const call = { prompt, opts, attempt };
    this.calls.push(call);
    if (this.config.delayMs) await delay(this.config.delayMs);
    const response = this.config.resolver ? await this.config.resolver(call) : await this.nextResponse(call);
    if (response instanceof Error) throw response;
    return {
      finalResponse: typeof response === "string" ? response : JSON.stringify(response),
      usage: this.usage(),
      threadId: `fake-${this.calls.length}`,
    };
  }

  private async nextResponse(call: FakeCall): Promise<unknown> {
    if (!this.responses.length) return { prompt: call.prompt };
    const response = this.responses.shift();
    if (typeof response === "function") return response(call);
    return response;
  }

  private usage(): Usage {
    return {
      input_tokens: this.config.usage?.input_tokens ?? 10,
      cached_input_tokens: this.config.usage?.cached_input_tokens ?? 0,
      output_tokens: this.config.usage?.output_tokens ?? 2,
      reasoning_output_tokens: this.config.usage?.reasoning_output_tokens ?? 0,
    };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
