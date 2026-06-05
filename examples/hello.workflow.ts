// Minimal real Codex structured-output workflow.
// Run: codex-flow run examples/hello.workflow.ts --backend codex-sdk

const AnswerSchema = {
  type: "object",
  additionalProperties: false,
  required: ["topic", "ideas"],
  properties: {
    topic: { type: "string" },
    ideas: { type: "array", items: { type: "string" } },
  },
};

export default async function workflow(ctx: any) {
  const { agent, log } = ctx;
  log("asking Codex for structured ideas");

  const result = await agent(
    'Give me 3 coffee shop name ideas. Return JSON like {"topic":"name ideas","ideas":["...","...","..."]}.',
    {
      schema: AnswerSchema,
      sandbox: "read-only",
    },
  );

  log("got answer", result.output);
  return result.output;
}
