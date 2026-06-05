import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installCodex } from "../cli/install-codex.ts";

const binPath = fileURLToPath(new URL("../bin/codex-flow.mjs", import.meta.url));

describe("codex-flow cli", () => {
  it("install-codex copies the skill into the target dir", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "codex-flow-cli-"));
    await installCodex(["--dir", dir]);
    const skillMd = path.join(dir, "dynamic-workflow", "SKILL.md");
    assert.ok(existsSync(skillMd), "SKILL.md should exist");
    const text = await readFile(skillMd, "utf8");
    assert.match(text, /name: dynamic-workflow/);
    assert.ok(existsSync(path.join(dir, "dynamic-workflow", "references", "engine-api.md")), "reference should be copied");
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
});
