# Prompt gallery

After installing the Codex skill:

```bash
npm install -g github:Dmatut7/codex-flow
codex-flow install-codex
codex-flow doctor
```

Restart Codex App or Codex CLI, open any repository, then copy one of these prompts.

## Bug investigation

```text
用动态工作流帮我排查这个 bug。请把可能原因拆成多个方向并行分析，最后合并成一个最可能原因、证据和下一步修复建议。

现象：<粘贴 bug 现象>
相关文件：<可选，列文件或目录>
```

```text
Use a dynamic workflow to investigate this bug in parallel. Split the work by likely cause / file area, then merge the findings into one likely root cause, evidence, and next action.

Symptom: <paste bug>
Relevant files: <optional files or folders>
```

## PR review

```text
用动态工作流做一次 PR review。并行检查正确性、回归风险、测试/文档、API/配置影响，最后给 approve / changes_requested / needs_more_info 的结论和必须修的点。
```

```text
Use a dynamic workflow for PR review. Run parallel review passes for correctness, regression risk, tests/docs, and API/config impact. Merge them into one verdict with must-fix items.
```

## Issue triage

```text
用动态工作流帮我批量 triage 这些 issue。每个 issue 并行判断类别、优先级、下一步和是否需要 maintainer 立刻看，最后给一个批处理行动建议。

<粘贴 issue 列表>
```

```text
Use a dynamic workflow to triage these issues in parallel. For each issue, classify category, priority, next step, and whether it needs maintainer attention now. Then summarize the batch action.

<paste issues>
```

## Release smoke

```text
用动态工作流做 release smoke check。并行检查 package metadata、README 首次体验、CLI 示例、release notes/license/contributing，最后告诉我能不能发布和阻塞项。
```

```text
Use a dynamic workflow for release smoke checks. In parallel, review package metadata, README first-run experience, CLI examples, release notes, license, and contributing docs. Then report readiness and blockers.
```

## Large refactor planning

```text
用动态工作流帮我评估这个重构计划。并行看架构影响、测试风险、迁移步骤、兼容性风险，最后给一个最小安全落地计划。

计划：<粘贴计划>
```

## Good result shape

Ask Codex to summarize:

- workflow file path under `.codex-flow/generated/`
- journal path under `.codex-flow/journal/`
- which branches ran in parallel
- which results were replayed on rerun
- exact rerun command

Example add-on:

```text
最后请告诉我生成的 workflow 路径、journal 路径、并行分支列表、哪些是 replayed，以及下次复跑命令。
```
