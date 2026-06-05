export default async function workflow(ctx: any) {
  const { agent, phase, log } = ctx;
  return phase("pong", async () => {
    const result = await agent("Return a tiny pong marker.", { backend: "fake", nodeKey: "pong" });
    log("pong complete", result.output);
    return result.output;
  });
}
