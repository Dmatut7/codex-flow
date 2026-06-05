# Roadmap

`codex-flow` is usable today as a Codex App / CLI workflow orchestrator. The next work is about distribution, adoption proof, and real-world workflow polish.

## Near term

- Publish `codex-flow` to npm after the maintainer provides the npm publish-time OTP.
- Add GitHub Actions CI after refreshing GitHub CLI auth with the `workflow` scope.
- Add a real screen-recorded demo video showing: say dynamic workflow → Codex generates workflow → parallel agents run → journal replay.
- Collect early external feedback: stars, issues, screenshots, and short usage notes from real maintainers.

## Medium term

- Add more real-backend compatibility smoke coverage for Codex SDK / CLI event-shape changes.
- Improve generated workflow templates for common OSS maintainer tasks.
- Add docs for team/project-level rollout patterns.
- Add richer journal summary rendering for reports.

## Long term

- Build a community workflow gallery.
- Support richer report/export formats from journaled workflow output.
- Explore optional integrations for issue/PR sources while keeping the local CLI path simple.
