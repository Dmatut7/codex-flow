# Launch playbook

Use this when sharing `codex-flow` publicly or preparing the Codex for Open Source application.

Repo: https://github.com/Dmatut7/codex-flow
Install now: `npm install -g github:Dmatut7/codex-flow`
After npm publish: `npm install -g codex-flow`

## One-line pitch

`codex-flow` turns one Codex App / CLI request into parallel, resumable, journaled Codex sub-agents for bug investigations, PR review, issue triage, and release checks.

## Short pitch

Codex is powerful, but a normal turn is linear. `codex-flow` lets maintainers say “use a dynamic workflow” and have Codex generate a workflow, run sub-agents in parallel, journal every node, and resume completed work after interruption. It uses the logged-in Codex membership by default, so early users do not need an OpenAI API key.

## Why it matters

- Complex maintainer tasks are naturally parallel: files, hypotheses, issues, checks.
- Long Codex sessions need replay/resume, not “start over”.
- Journaled runs make agent work auditable.
- The Codex skill makes it feel like a native natural-language feature instead of a library users must learn first.

## Positioning

Use this line when people ask “why not just use X?”:

```text
codex-flow is not a general graph framework or a replacement for Codex. It is a small workflow layer that lets Codex App / CLI generate and execute parallel, resumable, journaled maintainer workflows.
```

## Suggested posts

### X / Twitter

```text
I open-sourced codex-flow: a tiny workflow layer for Codex App / CLI.

Say “use a dynamic workflow” and Codex can split a bug investigation / PR review / issue triage into parallel, resumable, journaled sub-agents.

Repo: https://github.com/Dmatut7/codex-flow
```

### Hacker News / Reddit style

```text
I built codex-flow, an open-source workflow layer for Codex App / CLI.

The idea: many maintainer tasks are not one linear agent turn. They are parallel investigations over files, hypotheses, issues, or release checks. codex-flow lets Codex generate a temporary workflow, run sub-agents in parallel, write a journal, and resume completed work for free after interruption.

It works with a Codex/ChatGPT membership by default through codex-sdk / codex-exec, and has a fake backend for tests.

Repo: https://github.com/Dmatut7/codex-flow
```

### GitHub repo blurb

```text
Dynamic workflow orchestration for Codex: parallel, resumable, journaled sub-agents for bug investigations, PR review, issue triage, and release checks.
```

## Demo script

1. Install:

```bash
npm install -g github:Dmatut7/codex-flow
codex-flow doctor
codex-flow install-codex
codex-flow doctor
```

2. Restart Codex.
3. Open any project.
4. Say:

```text
use a dynamic workflow to investigate this bug across the repo in parallel
```

5. Show:

- generated `.codex-flow/generated/*.workflow.ts`,
- journal `.codex-flow/journal/*.jsonl`,
- parallel branches,
- rerun replaying completed nodes.

## Best next signals before applying for Codex OSS credits

- npm package published as `codex-flow`.
- Animated README demo is embedded; a real screen-recorded video would be the next upgrade.
- 3-5 stars or at least one outside user issue/comment.
- Maintainer workflow gallery exists; add issue triage and real user feedback next.
- GitHub Actions CI after enabling `workflow` scope on the GitHub token.
