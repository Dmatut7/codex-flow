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

function valueForSchema(schema: any): unknown {
  if (!schema || typeof schema !== "object") return { ok: true };
  if (schema.enum?.length) return schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type.find((item: string) => item !== "null") : schema.type;
  if (type === "string") return "value";
  if (type === "number" || type === "integer") return 0.8;
  if (type === "boolean") return true;
  if (type === "array") return [valueForSchema(schema.items)];
  if (type === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema.properties ?? {})) out[key] = valueForSchema(value);
    return out;
  }
  return { ok: true };
}

describe("example workflows", () => {
  it("are import-free so users can copy them into any project", async () => {
    for (const file of await workflowFiles()) {
      const source = await readFile(path.join(examplesDir, file), "utf8");
      assert.doesNotMatch(source, /^import\s/m, `${file} should not import repo-local code or dependencies`);
      assert.doesNotMatch(source, /runWorkflow\(/, `${file} should be a workflow template, not a self-running script`);
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
          adapters: {
            fake: {
              resolver: ({ opts }) => valueForSchema(opts.schema?.validationSchema),
            },
          },
        });
        const result = await engine.run(mod.default);
        assert.notEqual(result, undefined, `${file} should return a result`);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });
});
