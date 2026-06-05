import OpenAI from "openai";
import type { AgentAdapter, AdapterResult, NormalizedAgentOpts } from "./types.ts";
import type { EngineConfig, Usage } from "../engine/types.ts";

export class OpenAIResponsesAdapter implements AgentAdapter {
  readonly name = "openai-responses";
  private client?: OpenAI;

  constructor(private readonly adapterConfig: Record<string, unknown> = {}, private readonly engineConfig: EngineConfig = {}) {}

  async run(prompt: string, opts: NormalizedAgentOpts): Promise<AdapterResult> {
    this.client ??= new OpenAI(this.adapterConfig as any);
    if (!opts.schema) throw new Error("openai-responses backend requires a schema");
    const response: any = await this.client.responses.create({
      model: opts.model ?? this.engineConfig.defaultModel ?? "gpt-5-mini",
      input: prompt,
      text: { format: { type: "json_schema", name: "workflow_output", schema: opts.schema.adapterSchema, strict: true } },
      parallel_tool_calls: false,
      previous_response_id: opts.threadId,
    } as any);
    const parsed = response.output_parsed ?? extractParsedResponse(response);
    return {
      finalResponse: JSON.stringify(parsed),
      usage: normalizeUsage(response.usage),
      threadId: response.id,
    };
  }
}

function extractParsedResponse(response: any): unknown {
  const text = response.output_text;
  if (text) return JSON.parse(text);
  return response.output?.[0]?.content?.[0]?.parsed ?? response.output?.[0]?.content?.[0]?.text ?? response;
}

function normalizeUsage(usage: any): Usage {
  return {
    input_tokens: usage?.input_tokens ?? 0,
    cached_input_tokens: usage?.input_tokens_details?.cached_tokens ?? usage?.cached_input_tokens ?? 0,
    output_tokens: usage?.output_tokens ?? 0,
    reasoning_output_tokens: usage?.output_tokens_details?.reasoning_tokens ?? usage?.reasoning_output_tokens ?? 0,
  };
}
