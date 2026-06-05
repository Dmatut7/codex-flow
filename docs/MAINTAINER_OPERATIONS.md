# Maintainer operations

This file records the project-specific release and Codex skill maintenance steps. It is intentionally operational: follow it when publishing, updating bundled skills, or helping another maintainer refresh their local setup.

## What is already configured

- npm package: `codex-flow`
- npm owner used here: `tutudma`
- GitHub repo: `Dmatut7/codex-flow`
- npm Trusted Publisher: GitHub Actions → `Dmatut7/codex-flow` → `publish.yml`
- Allowed Trusted Publisher action: `npm publish`
- Release workflow: `.github/workflows/publish.yml`

The release workflow uses OIDC Trusted Publishing. It must not use `NPM_TOKEN`, `NODE_AUTH_TOKEN`, or checked-in `.npmrc` credentials.

## Normal release flow

Start from a clean `main` branch.

```bash
git checkout main
git pull origin main
git status --short
npm run typecheck
npm test
```

Update `CHANGELOG.md` first. Move the relevant `Unreleased` notes into a dated version section.

Then bump and tag:

```bash
npm version patch   # or: npm version minor / npm version major
git push origin main --tags
```

Pushing the `v*` tag starts GitHub Actions. The workflow verifies the tag matches `package.json`, runs typecheck/tests, then publishes to npm by OIDC.

Check:

```bash
npm view codex-flow version
```

If the GitHub Action fails, fix the repo/workflow and push a new commit/tag as appropriate. Do not fall back to local token publishing unless Trusted Publishing itself is unavailable.

## One-time npm Trusted Publisher setup

This was already done for `codex-flow`, but if the package is recreated or moved:

1. Open `https://www.npmjs.com/package/codex-flow/access`.
2. In **Trusted Publisher**, choose **GitHub Actions**.
3. Fill:
   - Organization or user: `Dmatut7`
   - Repository: `codex-flow`
   - Workflow filename: `publish.yml`
   - Environment name: leave blank unless the workflow adds a GitHub environment
4. Allow only `npm publish`.
5. Confirm password / 2FA.
6. Verify the page shows `Dmatut7/codex-flow`, `publish.yml`, and permission `npm publish`.

CLI equivalent, if npm authentication supports trust endpoints:

```bash
npx npm@^11.10.0 trust github codex-flow \
  --repo Dmatut7/codex-flow \
  --file publish.yml \
  --allow-publish \
  --yes
```

## How users receive updated Codex skills

Important: publishing a new npm version does not automatically rewrite a user's installed Codex skill files.

`codex-flow install-codex` copies the bundled skills from the installed package into the user's Codex home:

- source: global npm package contents
- target: `~/.codex/skills/dynamic-workflow`
- target: `~/.codex/skills/business-defect-audit`
- target: `~/.codex/skills/parallel-fix`

So every user-facing skill update needs two user commands after the npm release:

```bash
npm install -g codex-flow@latest
codex-flow install-codex
```

Then they should restart Codex App or Codex CLI. `codex-flow doctor` can confirm whether the installed skills are present/current.

## Updating Codex skills after someone changes this repo

The bundled skills live in:

- `codex-skill/` → installs as `dynamic-workflow`
- `codex-skill-business-audit/` → installs as `business-defect-audit`
- `codex-skill-parallel-fix/` → installs as `parallel-fix`

Short user-facing update instructions:

```bash
npm install -g codex-flow@latest
codex-flow install-codex
codex-flow doctor
# restart Codex App or Codex CLI
```

For maintainers working from a local checkout:

```bash
git pull origin main
npm install
node bin/codex-flow.mjs install-codex
node bin/codex-flow.mjs doctor
# restart Codex App or Codex CLI
```

`install-codex` replaces stale installed skill folders. That is expected.

## What not to commit

These are local run artifacts and should stay untracked:

- `.codex-flow/` journals and generated temporary workflows
- `.codex-workflow/`
- `.dongt/`
- `node_modules/`
- temporary `.npmrc` files containing publish tokens
- screenshots or one-off browser artifacts from npm/GitHub setup

If a temporary workflow is useful as a reusable example, copy a cleaned, import-free version into `examples/` and add tests/docs for it. Do not commit raw `.codex-flow/generated/*` files.

## Changing bundled skills

When editing any bundled skill:

1. Edit the source folder in this repo, not `~/.codex/skills`.
2. Run:

```bash
npm run typecheck
npm test
node bin/codex-flow.mjs install-codex --dir "$(mktemp -d)"
```

3. If the change is user-visible, update `CHANGELOG.md`.
4. Commit the repo change. Users get it by reinstalling `codex-flow@latest` and running `codex-flow install-codex`.

## Emergency local publish fallback

Only use this if GitHub Actions / OIDC is down and the release cannot wait.

```bash
npm run typecheck
npm test
npm publish --access public
```

Do not save tokens in the repo. If a temporary npm token or temporary npmrc is used, delete it immediately after publishing.
