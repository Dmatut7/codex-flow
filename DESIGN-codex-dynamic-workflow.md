# 动态工作流引擎 · 设计文档 + 任务文档（供 Codex 实现）

> 目标读者：将要**用 Codex（OpenAI 的编码 agent）照此文档把这个引擎从零实现出来**的工程师 / Codex 本身。
> 本文档的所有 Codex 能力声明都经过 2026-06 的实测核对（核对对象见文末「附录 A：事实来源与核对记录」）。凡是和你记忆里的旧版 API 冲突的地方，以本文档为准——已经有两处把"想当然"的写法纠正过来了。
> 写作约定：散文用中文，**标识符 / API / 代码一律英文**，便于直接落地。

---

## 0. 一句话概括

我们要造一个**与后端无关（backend-agnostic）的动态工作流引擎**:工作流脚本只面向 `agent() / parallel() / pipeline() / phase() / log() / budget` 这一套原语写一次;每个 `agent()` 调用经过引擎唯一的一道"接缝"——查内容寻址日志(命中即免费重放)→ 没命中就从全局信号量取并发槽 → 交给某个 Agent 适配器执行 → 按 JSON Schema 校验+修复 → 把 token 用量计入预算 → 追加一条日志记录。**默认后端是 `@openai/codex-sdk` 的进程内 Thread**;另外两个适配器(`codex-exec` 子进程、`openai-responses` 直连)可以零改动替换进来。并发、续跑、预算、确定性**全部住在引擎里、与后端无关**,所以换后端、混后端都不改变重放行为。

---

## 1. 为什么要做这个(WHY)

这一节解释动机。实现时不必读,但它决定了后面每一个设计取舍,**强烈建议先读懂**。

### 1.1 "动态工作流"到底买到了什么

一个单独的 agent(无论 Codex 还是别的)是一条**模型自己临时决定下一步**的线性对话。它有三个天花板:

1. **没有可复现的编排**。同样的任务跑两次,agent 可能走完全不同的路径。当任务是"审查 40 个文件 × 3 个维度,再逐条对抗式验证"这种**结构化、可并行**的工作时,把"怎么编排"交给模型即兴发挥,既慢又不稳。
2. **没有真正的并行**。一条对话里,agent 串行地做完一件再做下一件。而"40 文件 × 3 维度 = 120 个相互独立的子任务"本应同时跑。
3. **没有断点续跑**。跑到第 100 个子任务时崩了 / 超预算了,整条对话要从头再来,前 99 个的 token 全白花。

**动态工作流引擎**把这三件事拆开:
- **控制流 = 确定性的代码**(`for / while / if / fan-out 由 JS 跑),
- **干活 + 判断 = 可并行的子 agent**(每个 `agent()` 派生一个子任务,返回结构化结果)。

于是"怎么编排"变得可复现、可并行、可续跑;"智能判断"仍然交给模型。这正是常见的高质量模式得以成立的基础:对抗式验证(N 个怀疑者投票推翻一个结论)、judge panel(多方案打分再综合)、loop-until-dry(连续 K 轮没新发现才停)、migrate(发现站点 → 并行改写 → 验证)。这些模式都不是模型一句 prompt 能稳定做到的,需要外层有确定性的编排骨架。

### 1.2 为什么 Codex 需要一个"可移植的引擎",而不是直接用 Codex

Codex CLI / SDK 本身**没有内置的工作流编排原语**。它给你的是"一个很强的 agent + 可脚本化的调用方式"(`codex exec`、`@openai/codex-sdk`)。它**没有** `Workflow` 这种 fan-out 原语,**没有** `parallel/pipeline`,**没有**内容寻址的续跑日志,**没有**跨子任务的 token 预算。

所以这套东西必须**作为一层独立的引擎**自己造出来,把 Codex 当作"执行单个子任务的后端"来调用。这就是本文档的全部内容:**定义这层引擎的 API、机制和实现任务,让 Codex 把它建出来。**

### 1.3 为什么是"后端无关 + 适配器接缝",而不是写死 Codex

三条理由:

1. **同一个工作流里,不同节点的最优后端不一样。** 纯抽取/分类/judge 这种"给段文字、要个结构化结论、不碰文件系统"的节点,用 Codex 的完整 agent loop 是杀鸡用牛刀——一次 `openai-responses` 直连(单轮 Responses API + strict JSON)更便宜更快。而"读真实文件、改代码"的节点必须走完整 Codex agent。让节点声明意图、引擎自动路由,能省下大量 token。
2. **隔离强度可选。** 进程内的 `codex-sdk` Thread 最省事;但要"硬隔离 / 崩溃不影响主进程 / 给非 Node 编排器用",就需要 `codex-exec` 一个调用一个 OS 进程。
3. **未来不被锁死。** 把后端做成可替换的适配器,Codex 出新 SDK、或你想接别的模型,都只动适配器,引擎和脚本不变。

代价是多了一层 `Agent` 适配器接口。这层很薄,值得。

---

## 2. Codex 实际提供了什么(核对过的"积木")

> 这是整份设计的地基。**每一条都经过实测核对**(见附录 A)。注意几处和直觉相反的点,已用 ⚠️ 标出。

### 2.1 TypeScript SDK:`@openai/codex-sdk`(默认后端的基础)

实测版本 v0.128.0。**本质:它是 `codex` CLI 的薄封装——每个 turn 都 spawn 一次 CLI 子进程,通过 stdin/stdout 交换 JSONL 事件。**

```ts
import { Codex } from "@openai/codex-sdk";

// 构造:所有字段可选
const codex = new Codex({
  codexPathOverride,   // 自定义 codex 可执行文件路径
  env,                 // ⚠️ 若提供,完全 REPLACE 子进程的 process.env(不是 merge)
  config,              // JSON 对象,被摊平成 --config key=value 的 TOML override
  baseUrl,
  apiKey,              // 提供时注入为子进程的 CODEX_API_KEY
});

// 创建/恢复线程:⚠️ 二者都是【同步】的,立即返回 Thread,此时还没起 CLI
const thread  = codex.startThread(options?);          // options = ThreadOptions
const resumed = codex.resumeThread(id, options?);     // ⚠️ 第二个 options 参数文档没写但真实存在

// 跑一个 turn:async
const result = await thread.run(input, turnOptions?);
//   result = { items: ThreadItem[], finalResponse: string, usage }
//   ⚠️ finalResponse 是 agent_message 那条 item 的 .text【字符串】,SDK 不替你 JSON.parse!
//   ⚠️ input 可以是 string,也可以是 [{type:'text',text},{type:'local_image',path}]

// 流式跑:async,返回 { events } —— events 是 AsyncGenerator
const { events } = await thread.runStreamed(input, turnOptions?);
for await (const e of events) { /* see event types below */ }
```

**`ThreadOptions`(在 `startThread/resumeThread` 时固定,⚠️ TS SDK 里 per-turn 不能改 model/sandbox/cwd):**

| 字段 | 映射到的 CLI | 取值 |
|---|---|---|
| `workingDirectory` | `--cd` | 路径 |
| `skipGitRepoCheck` | `--skip-git-repo-check` | bool |
| `model` | `--model` | 如 `gpt-5-codex` |
| ⚠️ `sandboxMode` | `--sandbox` | `read-only` \| `workspace-write` \| `danger-full-access`(**字段名是 `sandboxMode`,不是 `sandbox`**) |
| `additionalDirectories` | 重复 `--add-dir` | 额外可写根 |
| `modelReasoningEffort` | `--config model_reasoning_effort=…` | |
| `networkAccessEnabled` | `--config sandbox_workspace_write.network_access=…` | |
| `webSearchMode` / `webSearchEnabled` | `--config web_search=…` | |
| `approvalPolicy` | `--config approval_policy=…` | |

**`turnOptions`(per-turn)只有两个字段:** `{ outputSchema?, signal? }`。
- `outputSchema`:⚠️**必须是 plain JSON Schema 对象**;传原始 Zod 会抛 `outputSchema must be a plain JSON object`。要用 Zod 得先 `zodToJsonSchema(schema, { target: 'openAi' })`。它被写进临时文件、以 `--output-schema <path>` 传入,只约束**最终消息**。
- `signal`:`AbortSignal`,转发给 spawn,用来取消(杀子进程)。

**`runStreamed` 的事件类型**(`e.type`):`thread.started`、`turn.started`、`turn.completed`、`turn.failed`、`item.started`、`item.completed`、`error`。
- `item.completed` 里的 `e.item.type`(⚠️ **规范取值见下**):`agent_message`、`reasoning`、`command_execution`、`file_change`、`mcp_tool_call`、`web_search`、`todo_list`、`error`。
- ⚠️ **最终答案的提取**:取 `item.type === "agent_message"` 那条的 `e.item.text`。**SDK 里没有 `assistant_message` 这个 item 类型**(那是 Chat Completions 的 role,不是 Codex 的 item 类型)。但不同 CLI 构建/文档间存在拼写漂移,`codex exec` 子进程那条路上**防御性地同时接受 `agent_message` 和 `assistant_message`**(详见 §6.2、附录 A 的纠错记录)。
- `turn.completed` 携带 `e.usage = { input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens? }`。**计费输入 = `input_tokens - cached_input_tokens`**;`reasoning_output_tokens` 可能不存在,读取要防御。
- `turn.failed` 携带 `e.error?.message`——这是失败哨兵。

**`thread.id`**:⚠️ 在第一个 `thread.started` 事件到达前是 `null`,之后才被填上(用于 `resumeThread` 热续)。

**并发安全(关键):** 因为**每次 `run()/runStreamed()` 都 `child_process.spawn` 一个独立的 codex 进程**,没有共享的可变连接,所以多个 Thread 用 `Promise.all` 并行**是安全的**。规矩:
- **一个并发单元一个 Thread**(`startThread()` 同步且廉价,随手建);
- ⚠️ **绝不在同一个【刚建好】的 Thread 上并行发两个 run**——`thread.id` 在 `thread.started` 前是 null,两个 run 会分叉成两段互不相干的对话;
- ⚠️ 多个 Thread **共享宿主文件系统**——并行写文件的节点必须各自有**不相交的 cwd**(见 §7.4,这是引擎要强制的)。

⚠️ 还有一点实现者必须知道:SDK 内部调用的是 `codex exec --experimental-json`(实验旗标);而你自己写 `codex-exec` 适配器时,用**稳定的公开旗标 `--json`**。

### 2.2 Python SDK:`openai-codex`(仅作参考,本引擎用 TS)

```python
from openai_codex import Codex, AsyncCodex, Sandbox
with Codex() as codex:
    thread = codex.thread_start(model="gpt-5-codex", sandbox=Sandbox.workspace_write)
    result = thread.run("Make the change.")                 # 注意:Python 的 run 可 per-turn 改 sandbox/model/cwd
    review = thread.run("Review the diff.", sandbox=Sandbox.read_only)
    print(result.final_response)
```

与 TS 的差异(实现 TS 引擎时不必管,但解释了为什么 TS 把 model/sandbox 固定在建线程时):Python 的 `run` **支持 per-turn** 改 model/sandbox/cwd;`AsyncCodex` 一个实例可经单条 JSON-RPC 连接**并发跑多个 turn**(按 turn id 路由)。`Sandbox.read_only / workspace_write / full_access`。

### 2.3 `codex exec`(headless CLI,`codex-exec` 适配器的基础)

```bash
codex exec "PROMPT"               # 进度走 stderr,最终 agent 消息走 stdout
```

| 旗标 | 作用 |
|---|---|
| `--json` | stdout 变成 **JSONL 事件流**(稳定公开旗标,**不是** `--experimental-json`) |
| `--output-schema <path>` | 最终回答须符合该 JSON Schema(只约束 final message) |
| `-o, --output-last-message <path>` | 把最终消息写进文件(同时也打到 stdout) |
| `--sandbox <mode>` | `read-only` \| `workspace-write` \| `danger-full-access` |
| `-C, --cd <path>` | 执行前切工作目录 |
| `--add-dir <path>` | 额外可写根 |
| `--skip-git-repo-check` | 绕过"必须在 git 仓库里"的检查 |
| `--ephemeral` | 不落 rollout 会话文件 |
| `--ignore-user-config` | 跳过 `$CODEX_HOME/config.toml` |

**续跑:** `codex exec resume [SESSION_ID]` 或 `codex exec resume --last`。⚠️ **全局旗标要放在 `resume` 子命令【之前】**。
**鉴权:** `CODEX_API_KEY=<key> codex exec …`(逐次注入,避免凭据被不可信代码读到)。
**JSONL 事件:** `thread.started`(首行带 `thread_id`)、`turn.started/completed/failed`、`item.started/completed`、`error`。`item` 类型:`agent_message`、`reasoning`、`command_execution`、`file_changes`、`mcp_tool_call`、`web_search`、`plan_update`。`turn.completed` 带 `usage`。
**失败哨兵:** ⚠️ **进程退出码权威**(0 成功;非 0 失败),外加 `turn.failed(.error.message)` / `error(.message)`。
**注意:** `error` 事件里若是 `Reconnecting... X/Y` 这类是**瞬时重连,不是致命**,要和真正的 `turn.failed` 区分(见 §7.8)。

### 2.4 OpenAI Responses API(`openai-responses` 适配器的基础)

用于"纯抽取/分类/judge"的廉价快路:

```ts
const r = await client.responses.create({
  model,
  input: prompt,
  text: { format: { type: "json_schema", name, schema, strict: true } }, // ⚠️ 是 text.format,不是 Chat 的 response_format
  parallel_tool_calls: false,   // ⚠️ OpenAI 明确:并行函数调用下不保证 schema
});
const obj = r.output_parsed;     // 已解析
const usage = r.usage;
// 可选:previous_response_id 串联
```

⚠️ **strict 模式的硬限制(schema 规范化时必须遵守,否则运行期硬报错):**
- 根**必须是 object**(不能 anyOf);天然是数组的输出要包成 `{ items: [...] }`;
- 总属性 ≤ 100、嵌套 ≤ 5 层、enum 总值 ≤ 500;
- `additionalProperties: false` 且**每个属性都在 `required` 里**(可选字段用 null 联合表达);
- ⚠️ 校验类关键字(`minLength/maxLength/minimum/maximum/pattern/format`)在 strict 生成时**被模型静默忽略**——靠它们保正确性会"生成通过但取值越界",然后被引擎自己的 Ajv 卡住、把 repair 预算耗光、永不收敛。处理办法见 §7.5。

### 2.5 配置(供工作流脚本可选利用,不是引擎必需)

`~/.codex/config.toml`(用户级)与项目级 `.codex/config.toml`;profiles(`--profile NAME` / `CODEX_PROFILE`);MCP server 用 `[mcp_servers.<name>]` 配,`codex mcp` 管理;指令用 `AGENTS.md`(从仓库根向下逐层拼接)。Codex 自己也能当 MCP server(`codex mcp`)。

---

## 3. 总体架构

```
            ┌──────────────────────── 工作流脚本(用户写,只用原语) ─────────────────────────┐
            │  agent() / parallel() / pipeline() / phase() / log() / ctx.budget / ctx.now/random │
            └───────────────────────────────────┬───────────────────────────────────────────────┘
                                                 │  每个 agent() 调用 = 唯一的"接缝"
                          ┌──────────────────────▼───────────────────────┐
                          │                  引擎(后端无关)               │
                          │  1. 算 structuralPosition + cacheKey          │
                          │  2. 查 journal(keyed map)→ 命中即免费重放    │
                          │  3. budget.reserve() → 取信号量槽             │
                          │  4. autoRoute / opts.backend → 选适配器        │
                          │  5. adapter.run(...)                          │
                          │  6. JSON.parse + schema 校验 + repair 循环     │
                          │  7. budget.reconcile(usage)                   │
                          │  8. 追加 journal 记录,返回 AgentResult        │
                          └───────┬───────────────┬───────────────┬───────┘
                                  │               │               │
                    ┌─────────────▼──┐  ┌─────────▼────────┐  ┌───▼──────────────────┐
                    │  codex-sdk     │  │  codex-exec      │  │  openai-responses    │
                    │ (默认/进程内)   │  │ (硬隔离/子进程)  │  │ (廉价/单轮 strict)   │
                    │ Thread+stream  │  │ 一调用一OS进程   │  │ Responses API        │
                    └────────────────┘  └──────────────────┘  └──────────────────────┘
```

**设计原则(逐条对应 §1.3 的理由):**
1. **`agent()` 是唯一感知后端的调用**,也是唯一的原子工作单元、唯一的续跑/计费/并发计量点。
2. **并发、续跑、预算、确定性全部在引擎里**,适配器是"哑"的——只负责"给个 prompt + schema,返回 finalResponse 字符串 + usage + 可选 threadId"。
3. **cacheKey 不含后端身份**:换后端重跑,未变前缀照样免费重放(重放的是已校验的**结构化数据**,与后端无关)。

---

## 4. 公开原语(精确签名)

引擎向脚本注入一个 `ctx`,六个原语绑在上面。

```ts
type Sandbox = "read-only" | "workspace-write" | "danger-full-access";

interface AgentOpts {
  schema?:   JSONSchema | ZodType;   // 给了就走 strict JSON;引擎统一转 JSON Schema
  backend?:  "codex-sdk" | "codex-exec" | "openai-responses" | "fake"; // 显式钉后端;否则 autoRoute
  kind?:     "agentic" | "extract" | "classify" | "judge";  // 路由意图(见 §6.3)
  pure?:     boolean;                // true = 纯函数式、不碰 fs/工具 → 允许降级到 openai-responses
  model?:    string;
  cwd?:      string;                 // 映射 workingDirectory / --cd
  sandbox?:  Sandbox;                // 映射 sandboxMode / --sandbox(默认 read-only)
  additionalDirectories?: string[];
  modelReasoningEffort?: string;
  threadId?: string;                 // 热续(仅当当前后端与产生它的后端一致才有效,见 §7.10b)
  timeoutMs?: number;                // 见 §7.9
  retries?:  number;                 // schema-repair 上限(默认 2)
  nodeKey?:  string;                 // 可选稳定别名,帮助调试/对齐结构位置
  signal?:   AbortSignal;
}

interface AgentResult<T = unknown> {
  output:   T;        // 已 JSON.parse + schema 校验的对象(无 schema 时是 raw string)
  raw:      string;   // 原始 finalResponse 字符串
  threadId?: string;  // 后端命名空间内的会话句柄(供热续)
  usage:    Usage;    // { input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens? }
  backend:  string;   // 实际执行该调用的后端(重放时是【当初】的后端)
  replayed: boolean;  // 是否来自 journal 重放(true 则不计费)
  status:   "ok" | "error";  // bulkhead:出错的项在 parallel/pipeline 里变成 null
}

interface Ctx {
  // ① 唯一感知后端的原子单元
  agent<T>(prompt: string, opts?: AgentOpts): Promise<AgentResult<T>>;

  // ② BARRIER 扇入:allSettled 语义(永不 fail-fast);某项终态失败 → 该槽位为 null,兄弟继续;
  //    按输入顺序返回,保证 journal 下标稳定。下游需要"全集"时用它。
  parallel<R>(thunks: Array<() => Promise<R>>): Promise<Array<R | null>>;

  // ③ 无屏障的逐项并行 map:每个 item 独立走 stage0→stage1→…→stageN 的 await 链,
  //    所有链共用同一信号量,于是 item i 的 stage k+1 能和 item j 的 stage k 重叠。
  //    某项失败 → 仅该项短路成 null,不影响别人。stage 回调拿 (prev, itemCtx)。
  //    itemCtx = { itemIdx, stageIdx, cwd?(引擎按需分配的隔离目录) }
  pipeline<I, O>(items: I[], ...stages: Array<(prev: any, itemCtx: ItemCtx) => Promise<any>>): Promise<Array<O | null>>;

  // ④ 命名作用域 + 显式屏障点(下游真需要"作用域内全部完成"时用);
  //    贡献 title 到 structuralPosition 命名空间,使不同 phase 里相同的 agent() 调用拿到不同 key。
  //    phase 之间相对顺序确定(顺序执行),形成可重放的主干。
  phase<R>(title: string, body: () => Promise<R>): Promise<R>;

  // ⑤ 纯副作用的结构化观测,写进同一条 append-only JSONL 流({type:'log', phase, ts, msg, data});
  //    ts 取自 ctx(绝不读真实 Date),所以 log 不会把墙钟泄进 key。log 不是调用点,从不参与续跑。
  //    它也是 codex-sdk 事件泵的出口:每个 item.completed 都经 log() 实时冒泡(模型推理/工具调用/改文件)。
  log(msg: string, data?: unknown): void;

  // ⑥ 确定性注入器(见 §7.7):
  now():    number;   // 记录-重放的时钟
  random(): number;   // 种子化 PRNG(种子写在 manifest)

  budget: {
    configure(o: { maxTokens?: number; maxNodes?: number; onExceeded?: "throw" | "skip" | "downgrade" }): void;
    reserve(estimate?: number): void;   // 取槽前预扣(见 §7.6)
    reconcile(actual: Usage): void;     // turn.completed 后对账
    guard(): void;                      // 超限则按 onExceeded 策略 throw/skip/downgrade
    remaining(): { tokens: number; nodes: number };
    totals(): Usage & { nodes: number };
  };
}
```

> 实现备注:`pipeline` 是**默认**多阶段写法;`parallel` 是**屏障**,仅当下游确实需要上一阶段**全部**结果(去重、合并、统计总数)时才用。判据:如果你写了 `const a = await parallel(...); const b = transform(a); const c = await parallel(...)`,而中间 `transform` 只是 flatten/map/filter、没有跨项依赖,那它不该要屏障——改写成 `pipeline` 把 transform 塞进某个 stage。

---

## 5. 默认后端:`codex-sdk` 适配器怎么跑一个 `agent()`

这是引擎与 Codex 的核心粘合,**全部基于 §2.1 已核对的事实**:

```ts
// adapters/codex-sdk.ts(伪代码,省略错误/取消细节)
const codex = new Codex();                       // 进程内共享一个 client
async function run(prompt, opts, { signal }) {
  const thread = codex.startThread({             // 一个并发节点一个 Thread
    workingDirectory: opts.cwd,
    skipGitRepoCheck: true,
    model: opts.model ?? defaultModel,
    sandboxMode: opts.sandbox ?? "read-only",    // ⚠️ sandboxMode,不是 sandbox
    additionalDirectories: opts.additionalDirectories,
    modelReasoningEffort: opts.modelReasoningEffort,
  });
  const { events } = await thread.runStreamed(prompt, {
    outputSchema: toJsonSchema(opts.schema),     // ⚠️ 必须是 plain JSON Schema
    signal,
  });
  let finalResponse = "", usage;
  for await (const e of events) {
    if (e.type === "item.completed") log(renderItem(e.item));      // 实时冒泡
    else if (e.type === "turn.completed") usage = e.usage;          // 计费用量
    else if (e.type === "turn.failed") throw new Error(e.error?.message);
    if (e.type === "item.completed" && e.item.type === "agent_message")
      finalResponse = e.item.text;               // ⚠️ 取 agent_message 的 text(字符串)
  }
  return { finalResponse, usage, threadId: thread.id };  // thread.id 首个 turn 后才有值
}
```

引擎拿到 `finalResponse`(**字符串**)后,自己 `JSON.parse` + 校验 + repair(§7.5),再计费、写日志。

---

## 6. 后端适配器层

### 6.1 适配器接口(三个后端都实现它)

```ts
// adapters/types.ts
interface Agent {
  run(
    prompt: string,
    normalizedOpts: NormalizedOpts,         // 引擎已把 cwd/sandbox/model/schema 标准化
    runtime: { signal: AbortSignal }
  ): Promise<AdapterResult>;
}
interface AdapterResult {
  finalResponse: string;   // ⚠️ 一律是字符串,引擎统一 parse
  usage: Usage;
  threadId?: string;       // 后端命名空间内的会话句柄
}
```

### 6.2 三个适配器要点

- **`codex-sdk`(默认)**:见 §5。进程内、最省事、`runStreamed` 给实时日志和精确用量、`resumeThread(id)` 热续。一节点一 Thread,绝不在同一新 Thread 上并行 run。
- **`codex-exec`(硬隔离)**:`spawn codex exec --json [--output-schema <tmp>] [-o <tmp>] --sandbox <mode> -C <cwd> --skip-git-repo-check 'PROMPT'`。
  - JSONL 行解析:跳过非 JSON 行;**最终答案 = 最后一条 `item.completed` 且 `item.type ∈ {agent_message, assistant_message}` 的 text**(⚠️ 两种拼写都收,防 CLI 漂移);`turn.completed` 是成功+用量哨兵;首行 `thread.started.thread_id` 捕获作为会话句柄。
  - ⚠️ **进程退出码权威**(0/非0);叠加 `turn.failed(.error.message)` / `error(.message)`。
  - 优先用 `--output-schema <tmp> + -o <tmp>` 读文件里的结构化结果,而非裸文本抓取。
  - 续跑:`codex exec [全局旗标] resume <id>`(全局旗标在 `resume` 之前)。
  - 取消/超时:见 §7.9(macOS 无 `timeout`,要手写 SIGTERM→SIGKILL 看门狗)。
- **`openai-responses`(廉价快路)**:见 §2.4。单轮、无 agent loop、无文件访问;`text.format: json_schema strict:true` + `parallel_tool_calls:false`;读 `output_parsed`;可 `previous_response_id` 串联。

### 6.3 路由(`autoRoute`)——⚠️ 必须靠显式信号,不能靠"猜"

```
resolve backend =
  opts.backend                              // ① 显式钉死,最高优先
  ?? autoRoute(opts)                        // ② 自动
  ?? config.defaultBackend (= "codex-sdk")  // ③ 兜底

autoRoute(opts):
  // 默认走 codex-sdk(有完整工具/文件能力)。只有【显式声明纯函数式】才降级。
  if (opts.schema 存在) AND (opts.pure === true OR opts.kind ∈ {extract,classify,judge})
     AND 不含任何 { cwd, sandbox≠read-only, additionalDirectories }:
        → "openai-responses"
  if (opts.kind === "agentic" 的硬隔离标志 / 显式 isolation):
        → "codex-exec"
  else → config.defaultBackend
```

⚠️ **绝不**用"没传 cwd"去推断"不需要文件"——prompt 里可能就让 agent 读文件。**误路由一个需要工具循环的节点到单轮 Responses,会得到一个自信的错误答案**。所以默认是有能力的 `codex-sdk`,降级必须是**作者显式 opt-in**。

---

## 7. 核心机制详解(这一节是"能不能正确实现"的成败点)

> 下面每个小节都对应评审里发现的一个真实坑。**实现时逐条满足,否则续跑/并发/预算会静默出错。**

### 7.1 structuralPosition 与 cacheKey —— 续跑是 keyed 查找,不是顺序扫描

**坑:** `parallel/pipeline` 下,各 `agent()` 调用的**完成顺序是调度相关、非确定的**,所以日志的物理 append 顺序 ≠ 脚本结构顺序。如果按"append 顺序前缀扫描"来重放,两次跑会因为兄弟节点 append 先后不同而"误判 mismatch"。

**规定(必须这样实现):**
1. **`structuralPosition` 在 `agent()` 入口【同步】分配**(第一个 `await` 之前),用按 `(phaseId, stageIdx, itemIdx, callOrdinal)` 作用域的确定性计数器,使并发兄弟拿到稳定、与完成顺序无关的位置。
2. **cacheKey = `sha256(canonicalJSON({ 原始prompt, 标准化schema, model, cwd?, sandbox?, structuralPosition, prevKey-chain }))`**。
   - **排除集(绝不进 key):** `signal, stream, backend 身份, threadId, ts, jitter, repair 追加的校验错误文本, env, 墙钟, 非经 ctx 的 RNG`。
   - `canonicalJSON`:键排序、空白规范化、`undefined` 显式处理。
3. **重放是 keyed 查找,不是位置扫描:** 续跑时引擎先把整个 journal 读成内存 map `{cacheKey → record}`(同 key 后写覆盖,天然处理 repair 子记录和崩溃重试行),然后每个 `agent()` 调用 `map.get(cacheKey)`,命中即返回**已校验**结果(不调后端、不花 token、不计费)。"最长未变前缀"这个心智模型由 §7.2 的 `prevKey` 哈希链在**确定性结构枚举**上实现,与物理 append 顺序解耦。

### 7.2 `prevKey` 依赖边链 —— fan-out 下的"精确失效"

**坑:** "每个 key 链到上一条"的线性模型在 `parallel/pipeline` 里没有意义——一个 `parallel` 里 50 个兄弟,谁是"上一条"?线性串会让你改了兄弟 #3 就把 #4..#50 全失效,毁掉"免费重放"。

**规定(显式依赖边模型):** 每个调用的 key 折入 (a) 自身内容+structuralPosition,(b) **它真实数据依赖的那些 key**:
- **`pipeline`:** item i 的 stage k 链自 **item i 的 stage k-1**(同项、上一阶段)。→ 改 item i 的 stage0 只失效 item i 自己的链,兄弟不动。
- **`parallel`:** 每个 thunk **只链自外层 phase/作用域 key**(兄弟相互独立;改一个不影响别的)。
- **顺序调用:** 线性链(自然语义)。

附一个**已验证的失效示例**进文档(实现者据此写测试):`pipeline([A,B], s0, s1)` 改 A 的 s0 → 只有 A.s0、A.s1 重跑;B.s0、B.s1 及任何 `parallel` 兄弟全部重放。

### 7.3 Journal 格式 与 续跑边界情形

**Manifest(第一行):** `{ engineVersion, scriptHash, defaultBackend, seed, startedAt }`。引擎版本/脚本哈希不匹配 → **整本作废重跑**,绝不误重放。

**记录行:**
```jsonc
{ "type":"node", "key","backend","threadId?",
  "status":"terminal"|"repair"|"timeout"|"failed",
  "attempt?": 2, "result","raw?","usage","prevKey","structuralPosition","ts","runningTotals" }
{ "type":"log", "phase","ts","msg","data" }
```

边界情形(必须处理):
- **崩溃残行:** 末尾半写的 JSONL 行检测并丢弃。
- **mid-repair 崩溃:** 只有 `status:"terminal"`(有效 或 终态失败→null)的记录可被重放;若某 key 最后一条是非终态 repair 子记录,该 key 视为未完成、重跑。
- **running budget 持久化:** 每节点把累计用量写进 `runningTotals`,续跑接着记账,不从零开始。

### 7.4 并发 + 文件系统隔离 —— 引擎必须**机械强制**,不能靠脚本作者自觉

**坑:** `codex-sdk` 多 Thread 共享文件系统。`agent()` 只暴露 `opts.cwd` 字符串,若并行写文件的节点共用一个 cwd + `workspace-write`,两个 codex 进程会在同一棵树上互相踩——静默的数据损坏。

**规定(二选一,文档要钉死默认):**
- **(默认)自动分配隔离目录:** 当 `sandbox !== "read-only"` 时,引擎为每个并发节点分配不相交的 scratch/worktree(如 `cwd = <base>/<phaseId>/<itemIdx>`,运行前创建,可选 `git worktree`),并通过 `itemCtx.cwd` 交给节点;或
- **(可选)运行期注册表:** 要求显式 `opts.cwd`,并维护一个登记表,**两个并发的可写 run 落在同一解析后的 cwd 时直接 throw**。

**信号量(并发池):** **全引擎一个共享的计数信号量**(p-limit 式 FIFO 等待队列)。**每一个 `agent()` 调用——直接的、`parallel` 里的、`pipeline` stage 里的——都从它取槽**,所以并发上限是**全局**的、不是按调用点。FIFO 让提交顺序≈启动顺序,稳定 journal 下标、避免饿死。默认宽度 `clamp(min(os.cpus().length, providerRateBudget), 1, hardMax)`,可配。**比最优更宽会让墙钟更差**(429 风暴、fd/RAM 耗尽、GC 抖动),所以这个 cap 是特性不是限制。可选双池:模型 I/O 宽池 + CPU 本地步窄池,互不饿死。

### 7.5 结构化输出 + strict 限制 + repair 循环

Schema 是单一事实源,在适配器边界统一规范化,**脚本永远收到已解析、合 schema 的对象**。

1. **入口接受 JSON Schema 或 Zod**;Zod 经 `zodToJsonSchema(schema, { target: 'openAi' })` 转换(原始 Zod 会让 SDK 抛错)。
2. **构建期强制 strict 规则并校验上限(§2.4):** 根必须是非 anyOf 的 object(天然数组包成 `{items}`);≤100 属性、≤5 嵌套、≤500 enum;`additionalProperties:false` 且全 `required`(可选字段用 null 联合)。超限**构建期就清晰报错**,别等运行期。
3. **⚠️ 模型在 strict 下静默忽略的校验关键字**(`minLength/maxLength/min/max/pattern/format`):要么**只保留在引擎事后的 Ajv 校验器**里、违反时用"明确复述该约束"的 repair prompt 修;要么发给模型前就剥掉——**关键是"发给模型的 schema"和"用来校验的 schema"别错位**,否则就是**无限 repair 陷阱**。
4. **统一的 validate-then-repair 循环(适配器返回之后跑):** `parse → validate(Ajv/zod) → 失败则构造 repair prompt(原 prompt + 校验错误)、用【同一 cacheKey】重发(repair 记为 journal 子记录)`,带抖动退避,上限 `retries`(默认 2~3)。只有终态(有效 / 终态失败→null)进 journal。⚠️ **repair 追加的校验错误文本必须排除在 cacheKey 之外**(否则每次 repair 都换 key,§7.1 排除集已列)。因为入库的是**已校验对象**,重放无需再校验。

### 7.6 预算 —— 诚实地说清楚它是"尽力而为的软上限"

**坑:** `guard()` 只在调用入口检查,N 个已过 guard、在途的调用可以把预算无限超出;而且用量只有 `turn.completed`(花完之后)才知道。把它说成"硬上限"是骗人。

**规定:**
- 明说:**这是 best-effort 软上限**,有界超出 ≈ `并发宽度 × 单次最大估计`;**精确硬上限不可能**(Codex 用量只在 turn 后已知)。
- **可选预扣对账:** 顺序是 `guard() → reserve(estimate) → 取信号量槽 → run → reconcile(实际usage,补差/退差) → 释放槽`。`estimate` 来自配置 `estimatedTokensPerCall` 或按后端默认。
- **`onExceeded` 策略按节点类型适用:** `downgrade`(降级到 openai-responses)**只对 schema-only 节点合法**——对需要 fs/工具的节点降级会产出错误结果,这种节点只能 `stop`/`skip`。
- **重放结果不计费**(但 `usage` 仍按当初记录上报,供可见性)。

### 7.7 确定性 —— 机制 + 诚实的边界

**坑:** "shadow 掉 Date/Math.random"被反复声称,但没说怎么做,而且光 shadow `Date.now/Math.random` 盖不住 `new Date()`、`performance.now()`、`process.hrtime`、`crypto.randomUUID`,以及依赖库内部的调用。

**规定:**
1. **机制:** 在受控作用域里把 `globalThis.Date`、`Date.now`、`Math.random`、`performance.now`、`process.hrtime`、`crypto.randomUUID/getRandomValues` 替换成 ctx 支持的确定性版本(记录-then-重放;PRNG 如 `mulberry32`,种子在 manifest)。
2. **诚实边界:** 这是**尽力而为**——在 import 时就捕获了真实 global 的传递依赖仍可能泄漏。所以**脚本作者契约 = "控制流里不用墙钟/RNG"**。
3. **硬不变量:** 唯一必须确定的是**调用点枚举(脚本的分支)**。模型**输出**的非确定性没关系——输出是入库的数据,不是控制流输入。
4. **基于模型输出分支的情形:** 如 `if (result.severity === "high") spawn 3 more`——这在重放时是 OK 的(`result` 被重放),但引擎必须保证脚本**读到的是 journal 里重放的上游结果,而不是重新调用**。

### 7.8 错误分类:瞬时 / 可修复 / 终态(三条不同的路)

| 类别 | 例子 | 处理 |
|---|---|---|
| **瞬时(transient)** | 429、5xx、网络、`error: Reconnecting... X/Y` | **指数退避+抖动重试**(独立预算,**不**计入 schema-repair 上限,**不**计 repair 费);连续命中可自适应收窄信号量 |
| **可修复(repairable)** | schema 校验不过 | §7.5 的 repair 循环(有上限、每次按 attempt 计费) |
| **终态(terminal)** | auth/4xx、`turn.failed` 致命、超时 | → `null`(bulkhead),journal 记 `status: failed/timeout` |

⚠️ 别把瞬时 429 当成 schema 失败去烧 repair 预算,也别把 `Reconnecting` 当崩溃。

### 7.9 取消 / 超时

- `opts.timeoutMs`(+ 配置默认)。到点引擎触发 `AbortController`:
  - `codex-sdk`:`signal` 转发给 spawn,杀子 codex 进程;
  - `codex-exec`:在**自己的进程组**里先 `SIGTERM`(Codex 当 Ctrl-C 优雅退)、`graceWindowMs` 后升 `SIGKILL`——**macOS 没有 `timeout/gtimeout`,要手写看门狗**;
  - `openai-responses`:`fetch` abort。
- 超时/被取消的调用**解析为终态 `null`**(bulkhead),journal 记 `status:"timeout"`;已观测到的 partial `turn.completed` 用量**照计**。被超时的 run 若已捕获 `threadId`,可供后续 `resumeThread` 热续。

### 7.10 鉴权 与 跨后端重放边界

**(a) 鉴权按后端注入,且密钥绝不进 cacheKey/journal:**
- `codex-exec`:`CODEX_API_KEY` 逐次注入(`config.adapters.codexExec.apiKeyEnv`);
- `codex-sdk`:`new Codex({ apiKey/env })` 注入,或留空继承已登录的 codex CLI;
- `openai-responses`:`apiKey/baseUrl`。

**(b) 跨后端重放的边界:** 重放的 `AgentResult` 报告**当初记录的 backend 和 usage**(`replayed:true`,usage 仅作可见性、不再计费)。`threadId` 是**后端命名空间内**的——`opts.threadId` 热续**只在当前解析后端 == 产生该 threadId 的后端时有效**;引擎遇到外来后端的 threadId 要**忽略并 warn、回退冷启**。重放正确性只依赖**内容**,所以工作流能扛进程重启、甚至 ephemeral 运行。

---

## 8. 文件布局

```
/engine/index.ts        公开入口:createEngine(config) + run(scriptPath|scriptFn);装配共享信号量、
                        journal、budget、clock/RNG 注入、适配器注册表;并导出 runWorkflow() 便捷函数,
                        让单文件示例能 `import { runWorkflow }` 直接 npx tsx 跑(零摩擦上手)。
/engine/agent.ts        agent() 原语:后端解析、cacheKey 计算、journal 重放或执行、validate-then-repair、
                        budget 计费、AgentResult 组装。
/engine/topologies.ts   parallel()(allSettled 屏障)、pipeline()(无屏障逐项并行链)、
                        phase()(命名屏障作用域 + 结构位置命名空间)、log()(结构化 JSONL 观测)。
/engine/journal.ts      append-only JSONL:manifest 行、哈希链内容寻址 key、keyed-map 重放匹配、
                        残行检测、running budget 持久化。
/engine/canonical.ts    稳定 canonical JSON(键排序、空白规范化、显式 undefined)+ sha256 cacheKey helper。
/engine/budget.ts       预算钩子:reserve/reconcile/guard/remaining/totals;计费输入 = input-cached;
                        防御性读 usage(reasoning_output_tokens 可选);onExceeded 按节点类型适用。
/engine/semaphore.ts    单一共享 p-limit 式 FIFO 信号量;可选双池;默认 clamp(min(cpus, rateBudget),1,hardMax)。
/engine/determinism.ts  种子 PRNG(mulberry32)、ctx.now()/ctx.random() 记录-重放、脚本作用域 global shadowing。
/engine/schema.ts       接受 JSON Schema 或 Zod、zodToJsonSchema(.,{target:'openAi'})、强制 strict 上限、
                        Ajv/zod 校验器、repair-prompt 构造。
/engine/types.ts        AgentResult、AgentOpts、JournalRecord、item 事件分类法(agent_message[|assistant_message]、
                        file_change[|file_changes]、reasoning、command_execution、mcp_tool_call、web_search、todo_list)。
/adapters/types.ts      Agent 适配器接口:run(prompt, normalizedOpts, {signal}) → AdapterResult{finalResponse,usage,threadId?}。
/adapters/codex-sdk.ts  【默认】new Codex(); startThread({...}); runStreamed(prompt,{outputSchema,signal});
                        事件泵→log()/usage;读 finalResponse + thread.id;resumeThread(id) 热续。
/adapters/codex-exec.ts 【硬隔离】spawn codex exec --json [...]; JSONL 行解析;退出码权威 + turn.failed/error;
                        SIGTERM→SIGKILL 看门狗;resume 全局旗标在子命令前。
/adapters/openai-responses.ts 【廉价】responses.create text.format json_schema strict:true + parallel_tool_calls:false;
                        output_parsed;usage;可选 previous_response_id。
/adapters/fake.ts       【测试】返回脚本化 finalResponse + 合成 usage,零网络,使引擎测试完全确定。
/adapters/registry.ts   name→adapter 映射 + autoRoute(opts)(§6.3)。
/examples/triage.workflow.ts  一个可直接跑的后端无关示例(见 §10)。
/codex.config.json      用户配置:{ defaultBackend, concurrency, budget:{maxTokens,maxNodes},
                        autoRoute, seed, estimatedTokensPerCall, adapters:{...auth...} }。
/package.json           deps:@openai/codex-sdk、openai、zod、zod-to-json-schema、ajv;engines.node>=18;devDep tsx。
```

---

## 9. 示例工作流脚本(后端无关、可跑、含续跑)

> 体现:`phase` 屏障、`pipeline` 无屏障逐项、`parallel` 屏障扇入、autoRoute 降级、`ctx.random()` 确定性、bulkhead null。

```ts
// examples/triage.workflow.ts
// 跑:        codex-engine run examples/triage.workflow.ts --backend codex-sdk
// 崩溃后续跑: 同命令加 --resume,未变前缀免费重放
import { z } from "zod";

export default async function workflow({ agent, parallel, pipeline, phase, log, budget, random }) {
  budget.configure({ maxTokens: 400_000, maxNodes: 50, onExceeded: "throw" });

  // ── Phase 1:廉价、纯 schema 的分诊 → autoRoute 自动降级到 openai-responses ──
  const Triage = z.object({
    files: z.array(z.string()), severity: z.enum(["low","med","high"]), rationale: z.string(),
  }).strict();
  const triage = await phase("triage", async () => {
    log("classifying the incoming bug report");
    const r = await agent(
      "列出这份 bug 报告最可能涉及的至多 5 个源文件、一个严重度、一行理由。\n\nREPORT:\n" +
      "购物车 >50 项时 POST /checkout 间歇 500;日志显示 pricing 超时。",
      { schema: Triage, pure: true, kind: "classify" }   // 显式 opt-in 纯函数式 → 走廉价快路
    );
    return r.output;
  });
  log(`triage picked ${triage.files.length} files`, { severity: triage.severity });

  // ── Phase 2:并行深挖,一文件一个重型 Codex agent(BARRIER) ──
  // 需要读真实文件 → codex-sdk 默认后端。每个节点拿引擎分配的隔离 cwd(§7.4)。
  const Finding = z.object({
    file: z.string(), diagnosis: z.string(), fixSketch: z.string(), confidence: z.number(),
  }).strict();
  const findings = await phase("deep-dive", async () =>
    parallel(triage.files.map((file) => async () =>
      (await agent(
        `检查 ${file},定位 checkout 超时的根因;给 diagnosis、fixSketch、0..1 confidence。`,
        { schema: Finding, cwd: "/work/checkout-svc", sandbox: "read-only" }
      )).output
    ))
  );
  const solid = findings.filter((f) => f && f.confidence >= 0.5);   // bulkhead:失败项为 null
  log(`got ${solid.length} confident findings of ${findings.length}`);

  // ── Phase 3:无屏障 pipeline —— 逐 finding:打补丁 → 自审(流式重叠) ──
  const Patch  = z.object({ file: z.string(), diff: z.string() }).strict();
  const Review = z.object({ approved: z.boolean(), notes: z.string() }).strict();
  const reviewed = await phase("patch-and-review", async () =>
    pipeline(solid,
      async (f) => (await agent(                         // stage0:改文件 → workspace-write
        `按 fixSketch 修复 ${f.file},返回 unified diff。\n` + f.fixSketch,
        { schema: Patch, cwd: "/work/checkout-svc", sandbox: "workspace-write" }
      )).output,
      async (patch) => (await agent(                     // stage1:廉价 judge → autoRoute 快路
        `审查这个 diff 是否会回归 checkout,只在不会回归时 approve。\n` + patch.diff,
        { schema: Review, pure: true, kind: "judge" }
      )).output
    )
  );

  // ── Phase 4:预算门控的单步裁决 ──
  return phase("verdict", async () => {
    budget.guard();
    const approvals = reviewed.filter((r) => r && r.approved).length;
    const tieBreak = random();                            // 确定性:种子化、入库、重放一致
    const Verdict = z.object({ ship: z.boolean(), summary: z.string() }).strict();
    const v = await agent(
      `${approvals}/${reviewed.length} 个补丁通过(tiebreak ${tieBreak.toFixed(3)}),决定 ship 还是 hold 并总结。`,
      { schema: Verdict, pure: true, kind: "judge" }
    );
    log("verdict", v.output);
    return v.output;
  });
}
```

---

## 10. 测试策略(任务里明确要求"怎么测")

最难写对的性质——确定性重放、改一处只失效子树、并发 bulkhead 隔离、预算记账、repair 收敛——恰恰需要一个**确定性的 FakeAdapter** 才测得了。

1. **FakeAdapter**(`/adapters/fake.ts`):`backend:"fake"`,返回脚本化的 `finalResponse` + 合成 `usage`,零网络 → 引擎测试完全确定。
2. **Golden-journal 测试:**
   - 跑脚本产出 journal J;**原样重跑**,断言**所有**调用 `replayed:true`、**零**适配器调用、**零**计费;
   - 改某节点 prompt,断言**恰好**该(子树/后缀)重跑、其余全部重放(直接验证 §7.1/§7.2)。
3. **并发测试:** 验证 `pipeline` 的 stage 跨项重叠(item i 的 stage k+1 与 item j 的 stage k 并行)、`parallel` 的屏障语义、某项失败 → null 而兄弟不受影响(bulkhead)。
4. **预算测试:** reserve/reconcile 对账、有界超出、`downgrade` 仅对 schema-only 节点生效。
5. **崩溃恢复测试:** 残行(半写 JSONL)+ 非终态 repair 子记录两种情形都能正确恢复。
6. **确定性测试:** 同脚本跑两次,断言两次产生的 cacheKey 序列完全一致。

---

## 11. 实施任务清单(任务文档 —— 按里程碑顺序,各带验收标准)

> 建议 Codex 按此顺序增量实现,**每个里程碑都能独立 `npx tsx` 跑通 + 通过该里程碑的测试**再进下一个。

- **M0 · 脚手架**
  `package.json`(deps、`engines.node>=18`、devDep `tsx`)、`tsconfig`、`/engine/types.ts`、`/adapters/types.ts`、`/adapters/fake.ts`、`codex.config.json` 样例。
  *验收:* `npx tsx` 能 import 引擎空壳;FakeAdapter 能返回固定字符串。

- **M1 · 原语 + FakeAdapter 端到端**
  `ctx` 注入;`agent()`(先只接 fake);`phase/log`;线性 `await` 串。
  *验收:* 一个三步线性脚本用 fake 后端跑通,`log` 进 JSONL。

- **M2 · 并发与拓扑**
  `semaphore.ts`(全局 FIFO)、`parallel`(allSettled 屏障 + null bulkhead)、`pipeline`(无屏障逐项链 + itemCtx)。
  *验收:* §10.3 的并发测试全过;并发上限被全局共享(不是按调用点)。

- **M3 · 确定性核心**
  `canonical.ts`、`determinism.ts`(ctx.now/random + global shadowing)、`structuralPosition` 同步分配、cacheKey 计算(含排除集)。
  *验收:* §10.6 确定性测试过(同脚本两次 cacheKey 序列一致)。

- **M4 · Journal 与续跑**
  `journal.ts`:manifest、keyed-map 重放、§7.2 依赖边 `prevKey`、残行/非终态检测、running totals。
  *验收:* §10.2 golden-journal 测试全过(原样重跑全 replay;改一处只失效对应子树)。

- **M5 · Schema 与 repair**
  `schema.ts`:JSON Schema/Zod 接受、`zodToJsonSchema({target:'openAi'})`、strict 上限校验(≤100/≤5/≤500、根对象、全 required)、忽略关键字策略、validate-then-repair(同 key 子记录、排除 repair 文本)。
  *验收:* 故意给会校验失败的 fake 输出,repair 在 `retries` 内收敛或终态 null;越界 schema 构建期报错。

- **M6 · 预算**
  `budget.ts`:reserve/reconcile/guard、有界软上限、`onExceeded` 按节点类型、重放不计费。
  *验收:* §10.4 预算测试过;超限按策略 throw/skip/downgrade。

- **M7 · codex-sdk 适配器(默认后端,真打 Codex)**
  §5 实现:`new Codex` 共享、一节点一 `startThread`、`runStreamed` 事件泵→log/usage、`agent_message.text` 提取、`thread.id` 捕获、`resumeThread` 热续、§7.4 隔离 cwd 强制、§7.9 取消。
  *验收:* §9 示例的 `deep-dive` phase 用真 Codex 跑通;并行写文件节点各自隔离不互踩。

- **M8 · 错误分类 + 取消/超时**
  §7.8 三类错误路径、§7.9 `timeoutMs` + macOS 安全看门狗、瞬时 429 独立退避(不烧 repair)。
  *验收:* 注入 429/超时,行为符合分类表;超时解析为 `status:"timeout"` 的 null。

- **M9 · 另两个适配器 + autoRoute**
  `codex-exec.ts`(JSONL 解析、退出码权威、两种 message 拼写、resume 旗标序、看门狗)、`openai-responses.ts`(`text.format` strict + `parallel_tool_calls:false`、`output_parsed`)、`registry.ts` autoRoute(§6.3 显式信号)。
  *验收:* §9 示例**整段**用 `--backend codex-sdk` 跑通,且把 `triage`/judge 节点切到 `openai-responses` 仍重放一致(跨后端重放,§7.10b)。

- **M10 · 鉴权、文档、打磨**
  §7.10 按后端注入密钥(绝不进 key/journal)、`runWorkflow()` 便捷导出、README + 本文档对齐、pin 依赖版本并注明针对的 `@openai/codex-sdk` / `codex` CLI 版本(防 item.type 拼写漂移)。
  *验收:* 别人 clone 后照 README 一条命令跑通示例;密钥不出现在任何 journal 行。

---

## 12. 风险与开放问题(实现前知情)

1. **item.type 拼写漂移**(`agent_message` vs `assistant_message`;`file_change` vs `file_changes`):codex-sdk 路径靠 SDK 的 result 对象(稳);codex-exec 路径靠 JSONL 抓取——**两种拼写都收**,并 pin 版本(M10)。
2. **`--output-schema` 只约束最终消息**,不约束中间 item——别指望它管住工具调用。
3. **确定性是尽力而为**:传递依赖在 import 时捕获真实 global 仍可能泄漏;脚本作者契约是"控制流不碰墙钟/RNG"。
4. **预算是软上限**:有界超出 = 并发宽度 × 单次估计;要更紧就调小并发或 `estimatedTokensPerCall`。
5. **`codex exec --experimental-json`(SDK 内部)vs `--json`(你的 exec 适配器用稳定公开旗标)** 别搞混。
6. **跨后端热续不可混用 threadId**:不同后端会话句柄命名空间不同,外来 threadId 要忽略+回退冷启。

---

## 附录 A:事实来源与核对记录(2026-06)

本设计的 Codex 能力声明**不是凭记忆**,而是按以下方式核对(其中两条把直觉写法纠正了):

**核对到的权威来源:**
- 实测安装包 `@openai/codex-sdk@0.128.0` 的 `dist/index.js`(`startThread/resumeThread` 同步、`runStreamed` 返回 `{events}`、per-turn 仅 `{outputSchema,signal}`、`ThreadOptions→CLI` 映射含 `sandboxMode→--sandbox`、`finalResponse` 是 `agent_message.text` 字符串而非预解析、`thread.id` 在 `thread.started` 前为 null、内部用 `exec --experimental-json`);
- 实测 `codex` CLI 0.133.0 的 `codex exec --help`(`--json`、`--output-schema`、`-o`、`--skip-git-repo-check`、`-C/--cd`、`--add-dir`、`--ephemeral`、`resume` 等);
- `developers.openai.com/codex`(SDK、noninteractive、config-reference、mcp 各页)与 `github.com/openai/codex` 的 `sdk/typescript`。

**两处纠错(原始直觉是错的,本文档已采用纠正后的写法):**
1. **没有 `assistant_message` 这个 item 类型。** SDK 的 item 联合是 `agent_message / reasoning / command_execution / file_change / mcp_tool_call / web_search / todo_list / error`。`assistant_message` 是 Chat Completions 的 role,不是 Codex item 类型。→ codex-sdk 路径**只取 `agent_message.text`**;codex-exec 路径出于 CLI 版本漂移**防御性地两种都收**。
2. **`CODEX_INTERNAL_ORIGINATOR_OVERRIDE` 不是无条件设置**,而是"仅当该 key 不存在时才默认为 `codex_sdk_ts`"——调用方提供的值会被保留。

**核对统计:** 14 条关键 Codex 声明里 12 条确认、2 条纠正(已并入正文);完整研究覆盖 4 个维度共 39 条 finding,设计经 3 个独立方案打分综合 + 13 项缺口评审。

---

## 附录 B:给实现者的一页速记(TL;DR)

- 一个 `agent()` = 一个原子单元 = 唯一感知后端的点 = 唯一计费/续跑/并发计量点。
- 默认后端 `codex-sdk`:一节点一 `startThread` → `runStreamed` → 取 `agent_message.text`(字符串,自己 parse)→ `turn.completed.usage` 计费(input - cached)。`sandboxMode` 不是 `sandbox`。
- 续跑是 **keyed 查找**(不是顺序扫描);`prevKey` 走**依赖边**(pipeline 同项上一阶段;parallel 仅链外层 phase)。
- 并发一个**全局** FIFO 信号量;写文件节点引擎**强制不相交 cwd**。
- strict schema:根对象、≤100/≤5/≤500、全 required;校验关键字模型会忽略——别让"发的 schema"和"校验的 schema"错位,否则无限 repair。
- 预算是**软上限**(诚实地说);确定性是**尽力而为**(脚本控制流不碰墙钟/RNG);错误分**瞬时/可修复/终态**三条路。
- 测试靠 **FakeAdapter + golden-journal**。
```
