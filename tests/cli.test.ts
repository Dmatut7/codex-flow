import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installCodex } from "../cli/install-codex.ts";
import { unavailableHint } from "../cli/smoke.ts";

const binPath = fileURLToPath(new URL("../bin/codex-flow.mjs", import.meta.url));
const rootExportUrl = pathToFileURL(fileURLToPath(new URL("../index.mjs", import.meta.url))).href;
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const tscPath = fileURLToPath(new URL("../node_modules/.bin/tsc", import.meta.url));

describe("codex-flow cli", () => {
  it("root package export works from plain node", () => {
    const code = `
      const m = await import(${JSON.stringify(rootExportUrl)});
      const engine = m.createEngine({ defaultBackend: "fake", autoRoute: false });
      const result = await engine.run(async ({ agent }) => (await agent("root export", { backend: "fake" })).output);
      console.log(JSON.stringify(result));
    `;
    const res = spawnSync("node", ["--input-type=module", "-e", code], { encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /"prompt":"root export"/);
  });

  it("root package export provides TypeScript types to consumers", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "codex-flow-types-"));
    await mkdir(path.join(dir, "node_modules"), { recursive: true });
    await symlink(repoRoot, path.join(dir, "node_modules", "codex-flow"));
    await writeFile(path.join(dir, "package.json"), '{"type":"module"}\n', "utf8");
    await writeFile(
      path.join(dir, "consumer.ts"),
      `
        import { createEngine, type WorkflowContext } from "codex-flow";

        const engine = createEngine({ defaultBackend: "fake", autoRoute: false });
        const workflow = async (ctx: WorkflowContext) => {
          const result = await ctx.agent<{ prompt: string }>("typed", { backend: "fake" });
          return result.output.prompt;
        };
        await engine.run(workflow);
      `,
      "utf8",
    );
    await writeFile(
      path.join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          skipLibCheck: true,
        },
        include: ["consumer.ts"],
      }),
      "utf8",
    );

    const res = spawnSync(tscPath, ["--project", "tsconfig.json", "--noEmit"], { cwd: dir, encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    await rm(dir, { recursive: true, force: true });
  });

  it("typecheck covers published CLI TypeScript sources", async () => {
    const tsconfig = JSON.parse(await readFile(path.join(repoRoot, "tsconfig.json"), "utf8")) as { include?: string[] };
    assert.ok(tsconfig.include?.includes("cli/**/*.ts"), "tsconfig include should cover cli/**/*.ts");
  });

  it("release workflow is configured for npm trusted publishing", async () => {
    const workflow = await readFile(path.join(repoRoot, ".github", "workflows", "publish.yml"), "utf8");

    assert.match(workflow, /on:\s*\n\s+push:\s*\n\s+tags:\s*\n\s+- ['"]v\*['"]/);
    assert.match(workflow, /id-token:\s*write/);
    assert.match(workflow, /npm install -g npm@\^11\.10\.0/);
    assert.match(workflow, /npm publish --access public/);
    assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN|NPM_TOKEN|_authToken/);
  });

  it("smoke tells codex-sdk users to use membership login instead of an API key", () => {
    const hint = unavailableHint("codex-sdk");
    assert.match(hint, /Codex membership/i);
    assert.doesNotMatch(hint, /CODEX_API_KEY|OPENAI_API_KEY/);
  });

  it("install-codex copies the skill into the target dir", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "codex-flow-cli-"));
    await installCodex(["--dir", dir]);
    const skillMd = path.join(dir, "dynamic-workflow", "SKILL.md");
    assert.ok(existsSync(skillMd), "SKILL.md should exist");
    const text = await readFile(skillMd, "utf8");
    assert.match(text, /name: dynamic-workflow/);
    assert.ok(existsSync(path.join(dir, "dynamic-workflow", "references", "engine-api.md")), "reference should be copied");
    assert.ok(existsSync(path.join(dir, "dynamic-workflow", "references", "setup.md")), "setup reference should be copied");
    assert.ok(existsSync(path.join(dir, "business-defect-audit", "SKILL.md")), "business audit skill should be copied");
    assert.ok(existsSync(path.join(dir, "parallel-fix", "SKILL.md")), "parallel fix skill should be copied");
    assert.ok(existsSync(path.join(dir, "parallel-fix", "references", "fix-method.md")), "parallel fix reference should be copied");
    await rm(dir, { recursive: true, force: true });
  });

  it("install-codex replaces a stale installed skill", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "codex-flow-cli-"));
    const stale = path.join(dir, "dynamic-workflow", "stale.txt");
    await mkdir(path.dirname(stale), { recursive: true });
    await writeFile(stale, "old", "utf8");
    await installCodex(["--dir", dir]);
    assert.equal(existsSync(stale), false, "stale files should not survive reinstall");
    await rm(dir, { recursive: true, force: true });
  });

  it("run executes an import-free workflow via the fake backend", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "codex-flow-run-"));
    const wf = path.join(dir, "t.workflow.ts");
    await writeFile(wf, 'export default async function workflow(ctx){ const r = await ctx.agent("hi", {}); return r.output; }\n', "utf8");
    const res = spawnSync("node", [binPath, "run", wf, "--backend", "fake", "--journal", path.join(dir, "j.jsonl")], {
      encoding: "utf8",
      cwd: dir,
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /"prompt": "hi"/);
    await rm(dir, { recursive: true, force: true });
  });

  it("run honors --cwd and --seed", async () => {
    const project = await mkdtemp(path.join(tmpdir(), "codex-flow-cwd-project-"));
    const outside = await mkdtemp(path.join(tmpdir(), "codex-flow-cwd-outside-"));
    const wf = path.join(project, ".codex-flow", "generated", "cwd.workflow.ts");
    await mkdir(path.dirname(wf), { recursive: true });
    await writeFile(
      wf,
      "export default async function workflow(ctx){ return { cwd: process.cwd(), random: ctx.random() }; }\n",
      "utf8",
    );

    const res = spawnSync("node", [
      binPath,
      "run",
      ".codex-flow/generated/cwd.workflow.ts",
      "--cwd",
      project,
      "--backend",
      "fake",
      "--seed",
      "123",
    ], {
      encoding: "utf8",
      cwd: outside,
    });

    assert.equal(res.status, 0, res.stderr);
    const body = JSON.parse(res.stdout);
    assert.equal(body.cwd, realpathSync(project));
    assert.equal(body.random, 0.7872516233474016);
    assert.ok(existsSync(path.join(project, ".codex-flow", "journal", "cwd.jsonl")), "default journal should be under --cwd");
    await rm(project, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("doctor checks the local fake backend and reports missing skill without failing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "codex-flow-doctor-"));
    const res = spawnSync("node", [binPath, "doctor", "--json"], {
      encoding: "utf8",
      env: { ...process.env, CODEX_HOME: dir },
    });
    assert.equal(res.status, 0, res.stderr);
    const body = JSON.parse(res.stdout);
    const fake = body.checks.find((check: any) => check.name === "fake backend");
    const skill = body.checks.find((check: any) => check.name === "codex skill");
    assert.equal(fake.status, "ok");
    assert.equal(skill.status, "warn");
    assert.match(skill.next, /codex-flow install-codex/);
    await rm(dir, { recursive: true, force: true });
  });

  it("doctor warns when the installed Codex skill is stale", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "codex-flow-doctor-"));
    const skillDir = path.join(dir, "skills", "dynamic-workflow");
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, "SKILL.md"), "---\nname: dynamic-workflow\n---\nold skill\n", "utf8");

    const res = spawnSync("node", [binPath, "doctor", "--json"], {
      encoding: "utf8",
      env: { ...process.env, CODEX_HOME: dir },
    });
    assert.equal(res.status, 0, res.stderr);
    const body = JSON.parse(res.stdout);
    const skill = body.checks.find((check: any) => check.name === "codex skill");
    assert.equal(skill.status, "warn");
    assert.match(skill.detail, /stale/);
    assert.match(skill.next, /codex-flow install-codex/);
    await rm(dir, { recursive: true, force: true });
  });

  it("doctor warns when the bundled business audit skill is missing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "codex-flow-doctor-"));
    const skillDir = path.join(dir, "skills", "dynamic-workflow", "references");
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(dir, "skills", "dynamic-workflow", "SKILL.md"), "---\nname: dynamic-workflow\n---\n", "utf8");
    await writeFile(path.join(skillDir, "engine-api.md"), "api\n", "utf8");
    await writeFile(path.join(skillDir, "setup.md"), "setup\n", "utf8");

    const res = spawnSync("node", [binPath, "doctor", "--json"], {
      encoding: "utf8",
      env: { ...process.env, CODEX_HOME: dir },
    });
    assert.equal(res.status, 0, res.stderr);
    const body = JSON.parse(res.stdout);
    const dynamicSkill = body.checks.find((check: any) => check.name === "codex skill");
    const businessSkill = body.checks.find((check: any) => check.name === "business audit skill");
    assert.equal(dynamicSkill.status, "ok");
    assert.equal(businessSkill.status, "warn");
    assert.match(businessSkill.detail, /business-defect-audit/);
    assert.match(businessSkill.next, /codex-flow install-codex/);
    await rm(dir, { recursive: true, force: true });
  });

  it("doctor warns when the bundled parallel fix skill is missing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "codex-flow-doctor-"));
    const dynamicRefs = path.join(dir, "skills", "dynamic-workflow", "references");
    const auditRefs = path.join(dir, "skills", "business-defect-audit", "references");
    const auditAgents = path.join(dir, "skills", "business-defect-audit", "agents");
    await mkdir(dynamicRefs, { recursive: true });
    await mkdir(auditRefs, { recursive: true });
    await mkdir(auditAgents, { recursive: true });
    await writeFile(path.join(dir, "skills", "dynamic-workflow", "SKILL.md"), "---\nname: dynamic-workflow\n---\n", "utf8");
    await writeFile(path.join(dynamicRefs, "engine-api.md"), "api\n", "utf8");
    await writeFile(path.join(dynamicRefs, "setup.md"), "setup\n", "utf8");
    await writeFile(path.join(dir, "skills", "business-defect-audit", "SKILL.md"), "---\nname: business-defect-audit\n---\n", "utf8");
    await writeFile(path.join(auditRefs, "audit-method.md"), "method\n", "utf8");
    await writeFile(path.join(auditRefs, "audit-template.workflow.ts"), "workflow\n", "utf8");
    await writeFile(path.join(auditAgents, "openai.yaml"), "agent\n", "utf8");

    const res = spawnSync("node", [binPath, "doctor", "--json"], {
      encoding: "utf8",
      env: { ...process.env, CODEX_HOME: dir },
    });
    assert.equal(res.status, 0, res.stderr);
    const body = JSON.parse(res.stdout);
    const parallelSkill = body.checks.find((check: any) => check.name === "parallel fix skill");
    assert.equal(parallelSkill.status, "warn");
    assert.match(parallelSkill.detail, /parallel-fix/);
    assert.match(parallelSkill.next, /codex-flow install-codex/);
    await rm(dir, { recursive: true, force: true });
  });

  it("doctor and smoke report unavailable temp dirs without crashing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "codex-flow-temp-"));
    const badTmp = path.join(dir, "tmp");
    await mkdir(badTmp);
    await chmod(badTmp, 0o500);
    const env = { ...process.env, CODEX_HOME: dir, TMPDIR: badTmp, TMP: badTmp, TEMP: badTmp };

    try {
      const doctor = spawnSync("node", [binPath, "doctor", "--json"], { encoding: "utf8", env });
      assert.equal(doctor.status, 0, doctor.stderr);
      const body = JSON.parse(doctor.stdout);
      const fake = body.checks.find((check: any) => check.name === "fake backend");
      assert.equal(fake.status, "warn");
      assert.match(fake.detail, /temporary directory unavailable/i);

      const smoke = spawnSync("node", [binPath, "smoke", "--backend", "codex-sdk"], { encoding: "utf8", env });
      assert.equal(smoke.status, 0, smoke.stderr);
      assert.match(smoke.stdout, /SMOKE_SKIPPED/);
      assert.match(smoke.stdout, /temporary directory unavailable/i);
    } finally {
      await chmod(badTmp, 0o700);
    }
    await rm(dir, { recursive: true, force: true });
  });

  it("init creates a starter workflow that runs through the fake backend", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "codex-flow-init-"));
    const init = spawnSync("node", [binPath, "init"], {
      encoding: "utf8",
      cwd: dir,
    });
    assert.equal(init.status, 0, init.stderr);
    const wf = path.join(dir, ".codex-flow", "generated", "starter.workflow.ts");
    assert.ok(existsSync(wf), "starter workflow should exist");

    const second = spawnSync("node", [binPath, "init"], {
      encoding: "utf8",
      cwd: dir,
    });
    assert.equal(second.status, 2);
    assert.match(second.stderr, /already exists/);

    const run = spawnSync("node", [binPath, "run", wf, "--backend", "fake"], {
      encoding: "utf8",
      cwd: dir,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /README first impression/);
    assert.ok(existsSync(path.join(dir, ".codex-flow", "journal", "starter.jsonl")), "default journal should exist");
    await rm(dir, { recursive: true, force: true });
  });

  it("try creates and runs the starter workflow in one command", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "codex-flow-try-"));
    const res = spawnSync("node", [binPath, "try"], {
      encoding: "utf8",
      cwd: dir,
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /codex-flow try/);
    assert.match(res.stdout, /README first impression/);
    assert.match(res.stdout, /codex-flow install-codex/);
    assert.ok(existsSync(path.join(dir, ".codex-flow", "generated", "starter.workflow.ts")), "starter workflow should exist");
    assert.ok(existsSync(path.join(dir, ".codex-flow", "journal", "starter.jsonl")), "starter journal should exist");
    await rm(dir, { recursive: true, force: true });
  });

  it("try does not overwrite an existing starter workflow", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "codex-flow-try-"));
    const wf = path.join(dir, ".codex-flow", "generated", "starter.workflow.ts");
    await mkdir(path.dirname(wf), { recursive: true });
    const custom = "export default async function workflow(){ return { custom: true }; }\n";
    await writeFile(wf, custom, "utf8");

    const res = spawnSync("node", [binPath, "try"], {
      encoding: "utf8",
      cwd: dir,
    });

    assert.equal(res.status, 0, res.stderr);
    assert.equal(await readFile(wf, "utf8"), custom);
    assert.match(res.stdout, /Using existing starter workflow/);
    assert.match(res.stdout, /"custom": true/);
    await rm(dir, { recursive: true, force: true });
  });

  it("try forces the fake backend even when an existing starter pins another backend", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "codex-flow-try-"));
    const wf = path.join(dir, ".codex-flow", "generated", "starter.workflow.ts");
    await mkdir(path.dirname(wf), { recursive: true });
    await writeFile(
      wf,
      'export default async function workflow(ctx){ const r = await ctx.agent("forced fake", { backend: "not-real" }); return r.output; }\n',
      "utf8",
    );

    const res = spawnSync("node", [binPath, "try"], {
      encoding: "utf8",
      cwd: dir,
    });

    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /"prompt": "forced fake"/);
    await rm(dir, { recursive: true, force: true });
  });

  it("smoke fails nonzero for invalid backend names", () => {
    const res = spawnSync("node", [binPath, "smoke", "--backend", "fake"], { encoding: "utf8" });
    assert.notEqual(res.status, 0);
    assert.match(res.stdout + res.stderr, /SMOKE_FAILED/);
    assert.match(res.stdout + res.stderr, /codex-sdk\|codex-exec\|openai-responses/);
  });
});
