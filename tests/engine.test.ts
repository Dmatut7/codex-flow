import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { createEngine } from "../engine/index.ts";
import { TimeoutError } from "../engine/agent.ts";

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "codex-workflow-test-"));
}

async function readJsonl(file: string): Promise<any[]> {
  const text = await readFile(file, "utf8");
  return text.trim().split("\n").map((line) => JSON.parse(line));
}

describe("dynamic workflow engine", () => {
  it("runs a linear fake workflow and writes logs to journal", async () => {
    const dir = await tempDir();
    const journalPath = path.join(dir, "journal.jsonl");
    const engine = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      journalPath,
      adapters: { fake: { responses: [{ step: 1 }, { step: 2 }, { step: 3 }] } },
    });

    const result = await engine.run(async ({ agent, phase, log }) => phase("linear", async () => {
      log("starting linear workflow", { ok: true });
      const a = await agent("one", { backend: "fake" });
      const b = await agent("two", { backend: "fake" });
      const c = await agent("three", { backend: "fake" });
      return [a.output, b.output, c.output];
    }));

    assert.deepEqual(result, [{ step: 1 }, { step: 2 }, { step: 3 }]);
    assert.equal(engine.adapters.fake.calls.length, 3);
    const lines = await readJsonl(journalPath);
    assert.equal(lines.some((line) => line.type === "log" && line.msg === "starting linear workflow"), true);
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps pipeline stages unbarriered and parallel failures isolated", async () => {
    const dir = await tempDir();
    const events: string[] = [];
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const engine = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      concurrency: 2,
      journalPath: path.join(dir, "journal.jsonl"),
      adapters: {
        fake: {
          resolver: async ({ prompt }) => {
            events.push(`start:${prompt}`);
            if (prompt === "A:s0") await delay(60);
            if (prompt === "B:s0") await delay(10);
            if (prompt === "bad") throw new Error("terminal fake failure");
            events.push(`end:${prompt}`);
            return { prompt };
          },
        },
      },
    });

    const pipelineResult = await engine.run(async ({ pipeline, agent }) => pipeline(["A", "B"],
      async (item) => (await agent(`${item}:s0`, { backend: "fake" })).output,
      async (prev) => (await agent(`${prev.prompt}:s1`, { backend: "fake" })).output,
    ));

    assert.deepEqual(pipelineResult, [
      { prompt: "A:s0:s1" },
      { prompt: "B:s0:s1" },
    ]);
    assert.ok(events.indexOf("start:B:s0:s1") < events.indexOf("end:A:s0"));

    const parallelResult = await engine.run(async ({ parallel, agent }) => parallel([
      async () => (await agent("good", { backend: "fake" })).output,
      async () => (await agent("bad", { backend: "fake" })).output,
      async () => (await agent("also-good", { backend: "fake" })).output,
    ]));
    assert.deepEqual(parallelResult, [{ prompt: "good" }, null, { prompt: "also-good" }]);
    await rm(dir, { recursive: true, force: true });
  });

  it("replays by keyed journal and only invalidates the changed pipeline subtree", async () => {
    const dir = await tempDir();
    const journalPath = path.join(dir, "journal.jsonl");
    const runWorkflow = async (changedA: boolean, responses: any[] = []) => {
      const engine = createEngine({
        defaultBackend: "fake",
        autoRoute: false,
        journalPath,
        adapters: { fake: { responses } },
      });
      const result = await engine.run(async ({ pipeline, agent }) => pipeline(["A", "B"],
        async (item) => (await agent(item === "A" && changedA ? "A changed:s0" : `${item}:s0`, { backend: "fake" })).output,
        async (prev) => (await agent(`${prev.file}:s1`, { backend: "fake" })).output,
      ));
      return { engine, result };
    };

    await runWorkflow(false, [
      { file: "A", stage: 0 },
      { file: "B", stage: 0 },
      { file: "A", stage: 1 },
      { file: "B", stage: 1 },
    ]);

    const replay = await runWorkflow(false);
    assert.equal(replay.engine.adapters.fake.calls.length, 0);

    const changed = await runWorkflow(true, [
      { file: "A", stage: 0, changed: true },
      { file: "A", stage: 1, changed: true },
    ]);
    assert.deepEqual(changed.engine.adapters.fake.calls.map((call: any) => call.prompt), ["A changed:s0", "A:s1"]);
    assert.deepEqual(changed.result, [
      { file: "A", stage: 1, changed: true },
      { file: "B", stage: 1 },
    ]);
    await rm(dir, { recursive: true, force: true });
  });

  it("repairs invalid schema output under the same cache key", async () => {
    const dir = await tempDir();
    const journalPath = path.join(dir, "journal.jsonl");
    const Schema = z.object({ ok: z.boolean() }).strict();
    const engine = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      journalPath,
      adapters: { fake: { responses: ['{"ok":"no"}', { ok: true }] } },
    });

    const result = await engine.run(async ({ agent }) => agent("return ok", { backend: "fake", schema: Schema, retries: 1 }));

    assert.deepEqual(result.output, { ok: true });
    assert.equal(engine.adapters.fake.calls.length, 2);
    const records = (await readJsonl(journalPath)).filter((line) => line.type === "node");
    assert.deepEqual(records.map((record) => record.status), ["repair", "terminal"]);
    assert.equal(new Set(records.map((record) => record.key)).size, 1);
    await rm(dir, { recursive: true, force: true });
  });

  it("retries transient adapter errors without consuming schema repair attempts", async () => {
    const dir = await tempDir();
    const journalPath = path.join(dir, "journal.jsonl");
    const Schema = z.object({ ok: z.boolean() }).strict();
    let attempts = 0;
    const engine = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      transientBaseMs: 0,
      journalPath,
      adapters: {
        fake: {
          resolver: async () => {
            attempts += 1;
            if (attempts <= 2) throw { status: 429, message: "rate limit" };
            return { ok: true };
          },
        },
      },
    });

    const result = await engine.run(async ({ agent }) => agent("transient then valid", {
      backend: "fake",
      schema: Schema,
      retries: 0,
    }));

    assert.deepEqual(result.output, { ok: true });
    assert.equal(engine.adapters.fake.calls.length, 3);
    const records = (await readJsonl(journalPath)).filter((line) => line.type === "node");
    assert.deepEqual(records.map((record) => record.status), ["terminal"]);
    await rm(dir, { recursive: true, force: true });
  });

  it("does not retry terminal adapter errors or timeout errors", async () => {
    const dir = await tempDir();
    const terminalJournalPath = path.join(dir, "terminal.jsonl");
    const terminalEngine = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      journalPath: terminalJournalPath,
      adapters: { fake: { resolver: async () => { throw new Error("auth denied"); } } },
    });

    const terminal = await terminalEngine.run(async ({ agent }) => agent("terminal", { backend: "fake" }));

    assert.equal(terminal.status, "error");
    assert.equal(terminalEngine.adapters.fake.calls.length, 1);

    const timeoutJournalPath = path.join(dir, "timeout.jsonl");
    const timeoutEngine = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      journalPath: timeoutJournalPath,
      adapters: { fake: { resolver: async () => { throw new TimeoutError(); } } },
    });

    const timeout = await timeoutEngine.run(async ({ agent }) => agent("timeout", { backend: "fake" }));

    assert.equal(timeout.status, "error");
    assert.equal(timeoutEngine.adapters.fake.calls.length, 1);
    const timeoutRecords = (await readJsonl(timeoutJournalPath)).filter((line) => line.type === "node");
    assert.deepEqual(timeoutRecords.map((record) => record.status), ["timeout"]);
    await rm(dir, { recursive: true, force: true });
  });

  it("applies budget skip without charging replayed nodes", async () => {
    const dir = await tempDir();
    const journalPath = path.join(dir, "journal.jsonl");
    const engine = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      journalPath,
      budget: { maxNodes: 1, onExceeded: "skip" },
      adapters: { fake: { responses: [{ ok: 1 }, { ok: 2 }] } },
    });

    const first = await engine.run(async ({ agent }) => [
      await agent("first", { backend: "fake" }),
      await agent("second", { backend: "fake" }),
    ]);
    assert.deepEqual(first[0].output, { ok: 1 });
    assert.equal(first[1].status, "error");
    assert.equal(engine.adapters.fake.calls.length, 1);

    const replayEngine = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      journalPath,
      budget: { maxNodes: 1, onExceeded: "skip" },
      adapters: { fake: { responses: [] } },
    });
    const replay = await replayEngine.run(async ({ agent }) => [
      await agent("first", { backend: "fake" }),
      await agent("second", { backend: "fake" }),
    ]);
    assert.equal(replay[0].replayed, true);
    assert.equal(replayEngine.adapters.fake.calls.length, 0);
    await rm(dir, { recursive: true, force: true });
  });

  it("ignores a trailing crash residue when loading journal", async () => {
    const dir = await tempDir();
    const journalPath = path.join(dir, "journal.jsonl");
    const engine = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      journalPath,
      adapters: { fake: { responses: [{ ok: true }] } },
    });
    await engine.run(async ({ agent }) => agent("stable", { backend: "fake" }));
    await writeFile(journalPath, (await readFile(journalPath, "utf8")) + "{ broken", "utf8");

    const replayEngine = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      journalPath,
      adapters: { fake: { responses: [] } },
    });
    const replay = await replayEngine.run(async ({ agent }) => agent("stable", { backend: "fake" }));
    assert.equal(replay.replayed, true);
    assert.equal(replayEngine.adapters.fake.calls.length, 0);
    await rm(dir, { recursive: true, force: true });
  });
});
