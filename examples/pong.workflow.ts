import type { WorkflowContext } from "../engine/index.ts";

export default async function workflow({ agent, phase, log }: WorkflowContext) {
  return phase("pong", async () => {
    const result = await agent("Return a tiny pong marker.", { backend: "fake", nodeKey: "pong" });
    log("pong complete", result.output);
    return result.output;
  });
}
