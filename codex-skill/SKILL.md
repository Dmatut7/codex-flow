---
name: dynamic-workflow
description: Use when the user asks to run a "动态工作流" / "dynamic workflow", or describes a complex multi-step task, a bug investigation, or work that should be split and run in parallel ("拆开并行跑", "parallel analysis", "并行排查", "complex multi-step task"). This skill turns Codex into an orchestrator: it generates a temporary workflow, runs many Codex sub-agents in parallel with resume + journaling via the `codex-flow` engine, and summarizes the result — instead of doing everything in one linear turn. Do NOT use for a single trivial question or a one-step edit; just answer those directly.
metadata:
  short-description: Orchestrate parallel, resumable Codex workflows
---

# Dynamic Workflow

You are the natural-language driver for the `codex-flow` workflow engine. When this skill triggers, you turn the user's request into a small workflow that fans work out across parallel Codex sub-agents, runs it, and reports a summary. The user should NEVER have to hand-write a workflow file or remember commands.

## When to actually use it

Use a dynamic workflow when the task is **multi-step, parallelizable, or repeated over many items**, e.g.:
- "排查这个 bug" over several files/hypotheses
- "review/analyze these N things" (one sub-agent per thing, in parallel)
- "do X then verify X for each item" (a per-item pipeline)
- anything long enough that resume-after-interrupt matters

If it's a single trivial question or one tiny edit, just answer/do it directly — do not spin up a workflow.

## Steps

0. **Preflight if needed.** If this is the first workflow in the project or the CLI availability is unclear, run `codex-flow doctor`. If `codex-flow` is missing, tell the user to install it with `npm install -g github:Dmatut7/codex-flow` (or `npm install -g codex-flow` after npm publish) and stop.

1. **Restate the goal in one line.** If the input material or output shape is genuinely missing, ask at most ONE necessary question. Otherwise infer and proceed.

2. **Generate a workflow file** at `.codex-flow/generated/<slug>.workflow.ts` (create dirs as needed). Follow `references/engine-api.md` EXACTLY:
   - `export default async function workflow(ctx) { ... }`
   - **Import-free**: no `import` lines. Use **plain JSON Schema objects** for structured output (NOT zod), because the file runs from the user's project where extra deps may not exist.
   - Express the work with `ctx.parallel` (independent fan-out), `ctx.pipeline` (per-item multi-stage), `ctx.phase`, `ctx.agent`, `ctx.log`. One `ctx.agent(...)` call = one sub-task. Don't write one giant single-agent prompt that bypasses the engine.

3. **Run it** (this uses the user's Codex/ChatGPT membership login — no API key needed):
   ```bash
   codex-flow run .codex-flow/generated/<slug>.workflow.ts
   ```
   Journal is written to `.codex-flow/journal/<slug>.jsonl` automatically. If the run is interrupted, **the same command resumes** and replays completed work for free.

4. **Summarize for the user**: the result, what each parallel branch found, the journal path, and the one-line rerun command. Do NOT paste the whole generated script unless asked.

## Hard rules

- **Membership, not API key.** Default backend is `codex-sdk` (the logged-in Codex/ChatGPT account). Never tell the user to set `OPENAI_API_KEY` unless they explicitly ask for the `openai-responses` backend.
- **Sandbox.** Read-only/analysis sub-agents: `sandbox: "read-only"`. Sub-agents that must edit real files: `sandbox: "workspace-write"` AND `cwd: process.cwd()`. Two parallel writable agents must NOT share the same `cwd` (the engine throws if they do) — give each a distinct directory or keep writes sequential.
- **Current project is the workspace.** `codex-flow run` already runs in the user's project directory; read-only agents need no `cwd`.
- **On failure**, read the error and fix only the generated workflow (e.g. a bad prompt or schema). Do not try to modify the `codex-flow` engine itself.

See `references/engine-api.md` for the exact API and a copy-paste template. Installed setup/troubleshooting reference: `references/setup.md`.
