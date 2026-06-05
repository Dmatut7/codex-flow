// 最简单的真实工作流示例:问 Codex 一个问题,拿到结构化(JSON)结果。
// 完全用你的 Codex 会员运行,不需要任何 API key。
//
// 跑它:  codex-flow run examples/hello.workflow.ts
//
import { z } from "zod";
import type { WorkflowContext } from "../engine/index.ts";

// 你想让 Codex 返回的数据"长什么样"。引擎会强制 Codex 按这个结构返回。
const Answer = z.object({
  topic: z.string(),            // 主题
  ideas: z.array(z.string()),  // 3 条点子
}).strict();

export default async function workflow({ agent, log }: WorkflowContext) {
  log("正在问 Codex…");

  // agent() = 让 Codex 干一件事。没写 backend,就用默认的 codex-sdk(你的会员)。
  const r = await agent(
    '给我 3 个咖啡店的店名点子。返回 JSON,格式:{"topic": "店名点子", "ideas": ["...","...","..."]}。',
    {
      schema: Answer,        // 要结构化结果
      sandbox: "read-only",  // 只读,不改你电脑上的文件,最安全
    },
  );

  log("拿到结果:", r.output);
  return r.output; // 这个会被打印到屏幕上
}
