# AGENTS.md — 给在本仓库工作的 AI agent 的常驻护栏

本仓库是一个**与后端无关的动态工作流引擎**(Codex 可用)。完整设计是唯一事实源:
**`DESIGN-codex-dynamic-workflow.md`**。任何与你记忆/直觉冲突处,以该文档为准。

## 工作规则(每个 turn 都遵守)

1. **只做被明确要求的事。** 文档/任务没让改的,不要碰、不要"顺手优化"、不要加功能或抽象。
2. **一次一项,改完即验证再继续。** 每改完一个任务,跑 `npm run typecheck` 和 `npm test`,
   贴输出,确认现有测试仍全过 + 新测试过,再做下一项。做完当前任务就停下等确认,别往下冲。
3. **不重构、不重命名、不动无关代码;不加新依赖**(deps 只用 package.json 已列的:
   @openai/codex-sdk、openai、zod、zod-to-json-schema、ajv)。
4. **不改任何已通过测试的断言含义**来"让它过"。测试红了就修代码,不是改测试。
5. **不确定 = 停下来问,绝不猜**,也绝不替文档单方面做设计决定。
6. **每个独立修复做一个 git commit**(如 `fix #1: transient retry`),便于逐项 review 和回滚。
7. 没实现的部分要明确标出并停下问,禁止留 TODO/占位却声称"完成"。

## 绝不可回退的不变量(写错 = 本次失败)

**Codex API 事实(已实测核对,见设计文档附录 A):**
- TS SDK 线程选项字段是 **`sandboxMode`**,不是 `sandbox`。
- `thread.run/runStreamed` 的 `finalResponse` 是**字符串**,要自己 `JSON.parse`,SDK 不替你解析。
- 最终答案取 `item.type === "agent_message"` 的 `.text`;SDK 里**没有 `assistant_message`**
  这个类型(仅 codex-exec 适配器为防 CLI 漂移才两种拼写都收)。
- 自己写的 codex-exec 适配器用稳定公开旗标 **`--json`**(不是 SDK 内部的 `--experimental-json`);
  exec 的**进程退出码权威**;`codex exec resume` 时全局旗标放在 `resume` 之前。
- openai-responses 用 **`text.format: {type:"json_schema", strict:true}` + `parallel_tool_calls:false`**
  (不是 Chat 的 `response_format`)。

**引擎机制不变量:**
- **续跑是 keyed 查找**(按 cacheKey 查 map),不是按 append 顺序扫描。
- **`prevKey` 走依赖边**:pipeline 中 stage k 链自同项 stage k-1;parallel 兄弟只链外层 phase
  作用域;顺序调用线性链。不许改成会"改一个兄弟就失效全部兄弟"的链法。
- **cacheKey 排除** signal / backend 身份 / threadId / ts / jitter / repair 追加的校验文本 / env /
  墙钟 / 非经 ctx 的 RNG;repair 用**原始 prompt** 算 key(同 key 子记录)。
- **`structuralPosition` 在 `agent()` 入口同步分配**(第一个 await 之前)。
- 作用域追踪用 **`AsyncLocalStorage`**(并发安全),不要退回可变 currentScope 指针。
- **schema 双轨**:发给模型的 `adapterSchema` 剥掉模型会忽略的关键字
  (minLength/maxLength/min/max/pattern/format);Ajv 用完整 `validationSchema` 校验。
  strict 上限:根必须是 object(非 anyOf)、≤100 属性、≤5 嵌套、≤500 enum、全 required。
- **预算是 best-effort 软上限**(reserve→取槽→run→reconcile);`downgrade` 策略只对 schema-only
  节点合法。计费输入 = `input_tokens - cached_input_tokens`。重放结果不计费。
- **确定性**:`run()` 期间 `Date/Date.now/Math.random/performance.now/process.hrtime/crypto 随机`
  被 shadow 成种子化版本。脚本控制流只用 `ctx.now()/ctx.random()`。
- ⚠️ **引擎运行期绝不调用 `Math.random` 或 `ctx.random` 做退避/抖动**——run() 内它们被 shadow 成
  种子 PRNG,引擎一消费就会错位脚本的 ctx.random() 序列、破坏确定性。需要抖动用**确定性函数**
  (由 attempt + cacheKey 派生,如 `parseInt(key.slice(0,4),16) % jitterMs`)。
- **错误三分类**:瞬时(429/5xx/网络/Reconnecting)→ 独立指数退避重试(不计入 schema-repair 上限、
  不计 repair 费);可修复(schema 不过)→ repair 循环(有上限、按 attempt 计费);
  终态(auth/4xx/turn.failed 致命/超时/abort)→ null。**超时和 abort 不重试。**
- **可写节点(sandbox≠read-only)用真实 `opts.cwd`**(缺失则报错),引擎用活跃 cwd 注册表防止
  两个并发可写 run 落同一 cwd(撞了 throw)。**不要**把可写节点丢进空 scratch 目录。

## 如何验证

```bash
npm run typecheck     # tsc --noEmit,必须干净
npm test              # node --test;现有 6 个测试必须全绿,新功能要加对应测试
```

测试用 **FakeAdapter**(零网络、确定性);真实后端(codex-sdk/exec/responses)不进单测。
新机制的测试参照 tests/engine.test.ts 已有模式:golden-journal 重放、子树失效、repair 同 key、
预算 skip、崩溃残行。

## 文件地图(简)

- `engine/index.ts` 装配 + run() 入口;`engine/agent.ts` agent() 接缝(key/重放/repair/预算/隔离);
  `engine/topologies.ts` parallel/pipeline/phase/log;`engine/journal.ts` keyed 日志;
  `engine/canonical.ts` 稳定 JSON+sha256;`engine/schema.ts` strict+repair;`engine/budget.ts`;
  `engine/semaphore.ts` 全局 FIFO;`engine/determinism.ts` shadow+PRNG;`engine/runtime.ts` 接口+Scope;
  `engine/cli.ts` `codex-engine run`。
- `adapters/{codex-sdk,codex-exec,openai-responses,fake,registry,types}.ts`。
- `examples/triage.workflow.ts` 可跑示例;`tests/engine.test.ts` 测试。
