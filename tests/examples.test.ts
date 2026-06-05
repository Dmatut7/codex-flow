import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createEngine } from "../engine/index.ts";

const examplesDir = path.resolve("examples");

async function workflowFiles(): Promise<string[]> {
  const entries = await readdir(examplesDir);
  return entries.filter((entry) => entry.endsWith(".workflow.ts")).sort();
}

describe("example workflows", () => {
  it("are import-free so users can copy them into any project", async () => {
    for (const file of await workflowFiles()) {
      const source = await readFile(path.join(examplesDir, file), "utf8");
      assert.doesNotMatch(source, /^import\s/m, `${file} should not import repo-local code or dependencies`);
      assert.doesNotMatch(source, /runWorkflow\(/, `${file} should be a workflow template, not a self-running script`);
    }
  });

  it("docs do not point global-install users at a local node_modules example path", async () => {
    for (const file of ["docs/CODEX_APP_CLI.md", "docs/FAQ.md"]) {
      const source = await readFile(path.resolve(file), "utf8");
      assert.doesNotMatch(source, /node_modules\/codex-flow\/examples/, `${file} should use codex-flow try or a real local path`);
    }
  });

  it("all run through the fake backend", async () => {
    for (const file of await workflowFiles()) {
      const dir = await mkdtemp(path.join(tmpdir(), "codex-flow-example-"));
      try {
        const mod = await import(`${pathToFileURL(path.join(examplesDir, file)).href}?t=${Date.now()}`);
        assert.equal(typeof mod.default, "function", `${file} should export a default workflow function`);
        const engine = createEngine({
          defaultBackend: "fake",
          autoRoute: false,
          journalPath: path.join(dir, "journal.jsonl"),
        });
        const result = await engine.run(mod.default);
        assert.notEqual(result, undefined, `${file} should return a result`);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it("business audit template rejects a failed verifier instead of returning empty results", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "codex-flow-business-audit-"));
    try {
      const file = path.resolve("codex-skill-business-audit/references/audit-template.workflow.ts");
      const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
      const engine = createEngine({
        defaultBackend: "fake",
        autoRoute: false,
        journalPath: path.join(dir, "journal.jsonl"),
        adapters: {
          fake: {
            resolver: async ({ prompt }) => {
              if (prompt.startsWith("Reconstruct")) {
                return {
                  invariants: [],
                  moneyRules: [],
                  authzRules: [],
                  stateTransitions: [],
                  flows: ["checkout"],
                  oracleQuality: "weak",
                };
              }
              if (prompt.startsWith("Audit")) return { lens: "test lens", defects: [] };
              if (prompt.startsWith("Hunt")) return { contradictions: [], unenforcedRules: [] };
              if (prompt.startsWith("Trace")) return { flow: "checkout", weaknesses: [] };
              if (prompt.startsWith("You are an ADVERSARIAL")) throw new Error("verify unavailable");
              return {};
            },
          },
        },
      });

      await assert.rejects(
        () => engine.run(mod.default),
        /business audit verify failed or was skipped/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
