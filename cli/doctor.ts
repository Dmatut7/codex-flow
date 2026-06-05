import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEngine } from "../engine/index.ts";

type CheckStatus = "ok" | "warn" | "fail";

interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  next?: string;
}

function codexHome(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
    return String(pkg.version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
}

function checkNode(): Check {
  const major = Number(process.versions.node.split(".")[0] ?? "0");
  if (major >= 18) return { name: "node", status: "ok", detail: process.version };
  return { name: "node", status: "fail", detail: process.version, next: "Install Node.js 18 or newer." };
}

function checkCodexCli(): Check {
  const result = spawnSync("codex", ["--version"], { encoding: "utf8" });
  if (result.status === 0) {
    const version = (result.stdout || result.stderr).trim();
    return { name: "codex cli", status: "ok", detail: version || "available" };
  }
  return {
    name: "codex cli",
    status: "warn",
    detail: "not found on PATH",
    next: "Install/login Codex CLI if you want the codex-exec backend. codex-sdk can still work from Codex App membership.",
  };
}

function checkSkill(): Check {
  const skillDir = path.join(codexHome(), "skills", "dynamic-workflow");
  const skillPath = path.join(skillDir, "SKILL.md");
  const required = [
    skillPath,
    path.join(skillDir, "references", "engine-api.md"),
    path.join(skillDir, "references", "setup.md"),
  ];
  if (existsSync(skillPath)) {
    const missing = required.filter((file) => !existsSync(file));
    if (!missing.length) return { name: "codex skill", status: "ok", detail: skillPath };
    return {
      name: "codex skill",
      status: "warn",
      detail: `stale or incomplete: ${skillDir}`,
      next: "Run `codex-flow install-codex`, then restart Codex.",
    };
  }
  return {
    name: "codex skill",
    status: "warn",
    detail: `missing: ${skillPath}`,
    next: "Run `codex-flow install-codex`, then restart Codex.",
  };
}

async function checkFakeBackend(): Promise<Check> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codex-flow-doctor-"));
  try {
    const engine = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      journalPath: path.join(dir, "doctor.jsonl"),
    });
    const output = await engine.run(async ({ agent }) => (await agent("doctor ping", { backend: "fake", nodeKey: "doctor" })).output);
    if (output && typeof output === "object" && "prompt" in output) {
      return { name: "fake backend", status: "ok", detail: "engine can run and journal a local fake agent" };
    }
    return { name: "fake backend", status: "fail", detail: "unexpected fake backend output" };
  } catch (error) {
    return {
      name: "fake backend",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function symbol(status: CheckStatus): string {
  if (status === "ok") return "✓";
  if (status === "warn") return "!";
  return "✗";
}

export async function doctor(argv: string[]): Promise<void> {
  const checks: Check[] = [
    { name: "codex-flow", status: "ok", detail: packageVersion() },
    checkNode(),
    checkSkill(),
    checkCodexCli(),
    await checkFakeBackend(),
  ];

  if (argv.includes("--json")) {
    console.log(JSON.stringify({ checks }, null, 2));
    return;
  }

  console.log("codex-flow doctor");
  for (const check of checks) {
    console.log(`${symbol(check.status)} ${check.name}: ${check.detail}`);
    if (check.next) console.log(`  next: ${check.next}`);
  }
  console.log("");
  console.log("Next real-backend check:");
  console.log("  codex-flow smoke --backend codex-sdk");
}
