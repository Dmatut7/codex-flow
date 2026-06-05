import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { createEngine } from "../engine/index.ts";
import { ConcurrentWritableCwdError, TimeoutError } from "../engine/agent.ts";
import { Semaphore } from "../engine/semaphore.ts";
import { normalizeSchema, parseAndValidate } from "../engine/schema.ts";
import { resolveBackend } from "../adapters/registry.ts";
import { OpenAIResponsesAdapter } from "../adapters/openai-responses.ts";

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "codex-workflow-test-"));
}

async function readJsonl(file: string): Promise<any[]> {
  const text = await readFile(file, "utf8");
  return text.trim().split("\n").map((line) => JSON.parse(line));
}

describe("dynamic workflow engine", () => {
  it("does not over-admit semaphore callers when a new acquire races a queued waiter", async () => {
    const semaphore = new Semaphore(1);
    let active = 0;
    let maxActive = 0;
    const enter = () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return () => { active -= 1; };
    };

    const releaseA = await semaphore.acquire();
    const leaveA = enter();
    const b = semaphore.acquire().then((release) => ({ release, leave: enter() }));

    leaveA();
    releaseA();

    const c = semaphore.acquire().then((release) => ({ release, leave: enter() }));
    const bHandle = await b;
    await Promise.resolve();

    assert.equal(maxActive, 1);

    bHandle.leave();
    bHandle.release();
    const cHandle = await c;
    cHandle.leave();
    cHandle.release();
  });

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

  it("uses the package release version as the default journal engine version", async () => {
    const dir = await tempDir();
    const journalPath = path.join(dir, "journal.jsonl");
    await createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      journalPath,
    }).run(async ({ agent }) => agent("version", { backend: "fake" }));

    const [manifest] = await readJsonl(journalPath);
    assert.equal(manifest.engineVersion, "0.2.3");
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

  it("bulkheads AgentResult errors in parallel and pipeline", async () => {
    const dir = await tempDir();
    const calls: string[] = [];
    const engine = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      journalPath: path.join(dir, "journal.jsonl"),
      adapters: {
        fake: {
          resolver: async ({ prompt }) => {
            calls.push(prompt);
            if (prompt === "bad") throw new Error("terminal fake failure");
            return { prompt };
          },
        },
      },
    });

    const parallelResult = await engine.run(async ({ parallel, agent }) => parallel([
      async () => agent("bad", { backend: "fake" }),
      async () => agent("good", { backend: "fake" }),
    ]));

    assert.deepEqual(parallelResult.map((item: any) => item?.output ?? null), [null, { prompt: "good" }]);

    const pipelineResult = await engine.run(async ({ pipeline, agent }) => pipeline(["bad"], 
      async () => agent("bad", { backend: "fake" }),
      async () => agent("should-not-run", { backend: "fake" }),
    ));

    assert.deepEqual(pipelineResult, [null]);
    assert.equal(calls.includes("should-not-run"), false);
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps completed child keys from thrown parallel branches in downstream dependencies", async () => {
    const dir = await tempDir();
    const journalPath = path.join(dir, "journal.jsonl");
    const calls: string[] = [];
    const workflow = (innerPrompt: string) => async ({ parallel, agent }: any) => {
      await parallel([
        async () => {
          await agent(innerPrompt, { backend: "fake" });
          throw new Error("branch failed after agent");
        },
      ]);
      return agent("after parallel", { backend: "fake" });
    };

    const first = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      journalPath,
      adapters: { fake: { resolver: async ({ prompt }) => { calls.push(`first:${prompt}`); return { prompt, run: 1 }; } } },
    });
    const firstResult = await first.run(workflow("inner-v1"));

    assert.deepEqual(firstResult.output, { prompt: "after parallel", run: 1 });

    const second = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      journalPath,
      adapters: { fake: { resolver: async ({ prompt }) => { calls.push(`second:${prompt}`); return { prompt, run: 2 }; } } },
    });
    const secondResult = await second.run(workflow("inner-v2"));

    assert.equal(secondResult.replayed, false);
    assert.deepEqual(secondResult.output, { prompt: "after parallel", run: 2 });
    assert.deepEqual(calls, ["first:inner-v1", "first:after parallel", "second:inner-v2", "second:after parallel"]);
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps completed child keys from thrown pipeline stages in downstream dependencies", async () => {
    const dir = await tempDir();
    const journalPath = path.join(dir, "journal.jsonl");
    const calls: string[] = [];
    const workflow = (innerPrompt: string) => async ({ pipeline, agent }: any) => {
      await pipeline(["item"], async () => {
        await agent(innerPrompt, { backend: "fake" });
        throw new Error("stage failed after agent");
      });
      return agent("after pipeline", { backend: "fake" });
    };

    const first = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      journalPath,
      adapters: { fake: { resolver: async ({ prompt }) => { calls.push(`first:${prompt}`); return { prompt, run: 1 }; } } },
    });
    const firstResult = await first.run(workflow("stage-v1"));

    assert.deepEqual(firstResult.output, { prompt: "after pipeline", run: 1 });

    const second = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      journalPath,
      adapters: { fake: { resolver: async ({ prompt }) => { calls.push(`second:${prompt}`); return { prompt, run: 2 }; } } },
    });
    const secondResult = await second.run(workflow("stage-v2"));

    assert.equal(secondResult.replayed, false);
    assert.deepEqual(secondResult.output, { prompt: "after pipeline", run: 2 });
    assert.deepEqual(calls, ["first:stage-v1", "first:after pipeline", "second:stage-v2", "second:after pipeline"]);
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

  it("replays nested parallel nodes without cache-key aliasing", async () => {
    const dir = await tempDir();
    const journalPath = path.join(dir, "journal.jsonl");
    const workflow = async ({ parallel, agent }: any) => parallel(["outer-a", "outer-b"].map((outer: string) => async () => {
      const [inner] = await parallel([
        async () => (await agent("same nested prompt", { backend: "fake" })).output,
      ]);
      return { outer, inner };
    }));

    const first = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      journalPath,
      adapters: { fake: { responses: [{ value: "a" }, { value: "b" }] } },
    });
    const firstResult = await first.run(workflow);

    assert.deepEqual(firstResult, [
      { outer: "outer-a", inner: { value: "a" } },
      { outer: "outer-b", inner: { value: "b" } },
    ]);

    const replay = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      journalPath,
      adapters: { fake: { responses: [] } },
    });
    const replayResult = await replay.run(workflow);

    assert.deepEqual(replayResult, firstResult);
    assert.equal(replay.adapters.fake.calls.length, 0);
    await rm(dir, { recursive: true, force: true });
  });

  it("replays phases inside parallel without cache-key aliasing", async () => {
    const dir = await tempDir();
    const journalPath = path.join(dir, "journal.jsonl");
    const workflow = async ({ parallel, phase, agent }: any) => parallel(["outer-a", "outer-b"].map((outer: string) => async () => {
      const result = await phase("shared phase", () => agent("same phase prompt", { backend: "fake" }));
      return { outer, inner: result.output };
    }));

    let count = 0;
    const first = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      journalPath,
      adapters: { fake: { resolver: async () => ({ value: ++count }) } },
    });
    const firstResult = await first.run(workflow);

    assert.deepEqual(firstResult, [
      { outer: "outer-a", inner: { value: 1 } },
      { outer: "outer-b", inner: { value: 2 } },
    ]);

    const replay = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      journalPath,
      adapters: { fake: { resolver: async () => { throw new Error("should replay"); } } },
    });
    const replayResult = await replay.run(workflow);

    assert.deepEqual(replayResult, firstResult);
    assert.equal(replay.adapters.fake.calls.length, 0);
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

  it("rejects boolean false schemas instead of treating them as absent", () => {
    assert.throws(
      () => normalizeSchema(false),
      /Strict schema root must be an object/,
    );
  });

  it("enforces strict object schemas inside combinators and definitions", () => {
    const assertRejectsExtraPayload = (payloadSchema: any, extraRoot: Record<string, unknown> = {}) => {
      const schema = normalizeSchema({
        type: "object",
        additionalProperties: false,
        required: ["payload"],
        properties: {
          payload: payloadSchema,
        },
        ...extraRoot,
      });

      const result = parseAndValidate(JSON.stringify({ payload: { role: "admin", injected: true } }), schema);

      assert.equal(result.ok, false);
    };

    assertRejectsExtraPayload({ oneOf: [{ type: "object", properties: { role: { type: "string" } } }] });
    assertRejectsExtraPayload({ allOf: [{ type: "object", properties: { role: { type: "string" } } }] });
    assertRejectsExtraPayload({ oneOf: [{ properties: { role: { type: "string" } } }] });
    assertRejectsExtraPayload({ $ref: "#/$defs/PayloadWithoutType" }, {
      $defs: {
        PayloadWithoutType: { properties: { role: { type: "string" } } },
      },
    });
    assertRejectsExtraPayload({ $ref: "#/$defs/Payload" }, {
      $defs: {
        Payload: { type: "object", properties: { role: { type: "string" } } },
      },
    });
  });

  it("allows root object combinators without making their properties impossible", () => {
    const assertRootCombinator = (schemaInput: any) => {
      const schema = normalizeSchema(schemaInput);

      assert.equal(parseAndValidate(JSON.stringify({ role: "admin" }), schema).ok, true);
      assert.equal(parseAndValidate(JSON.stringify({ role: "admin", injected: true }), schema).ok, false);
      assert.deepEqual(Object.keys(schema!.adapterSchema.properties), ["role"]);
    };

    assertRootCombinator({
      type: "object",
      allOf: [{ type: "object", properties: { role: { type: "string" } } }],
    });
    assertRootCombinator({
      type: "object",
      oneOf: [{ type: "object", properties: { role: { type: "string" } } }],
    });

    const schema = normalizeSchema({
      type: "object",
      oneOf: [
        { type: "object", properties: { role: { enum: ["admin"] } } },
        { type: "object", properties: { role: { enum: ["user"] } } },
      ],
    });
    assert.equal(parseAndValidate(JSON.stringify({ role: "admin" }), schema).ok, true);
    assert.equal(parseAndValidate(JSON.stringify({ role: "user" }), schema).ok, true);
  });

  it("preserves property names that match unsupported adapter keywords", () => {
    const schema = normalizeSchema({
      type: "object",
      properties: {
        format: { type: "string" },
        pattern: { type: "string" },
      },
    });

    assert.deepEqual(Object.keys(schema!.adapterSchema.properties), ["format", "pattern"]);
    assert.equal(parseAndValidate('{"format":"json","pattern":"literal"}', schema).ok, true);
  });

  it("rejects unsupported format constraints instead of silently ignoring them", () => {
    assert.throws(
      () => normalizeSchema({
        type: "object",
        properties: {
          email: { type: "string", format: "email" },
        },
      }),
      /unsupported schema keyword.*format/i,
    );
  });

  it("default fake backend returns schema-shaped output", async () => {
    const dir = await tempDir();
    const engine = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      journalPath: path.join(dir, "journal.jsonl"),
    });
    const Schema = {
      type: "object",
      additionalProperties: false,
      required: ["name", "count", "ok", "items", "status"],
      properties: {
        name: { type: "string" },
        count: { type: "number" },
        ok: { type: "boolean" },
        items: { type: "array", items: { type: "string" } },
        status: { enum: ["pass", "warn"] },
      },
    };

    const result = await engine.run(async ({ agent }) => agent("schema fake", { backend: "fake", schema: Schema, retries: 0 }));

    assert.equal(result.status, "ok");
    assert.deepEqual(result.output, {
      name: "value",
      count: 0.8,
      ok: true,
      items: ["value"],
      status: "pass",
    });
    await rm(dir, { recursive: true, force: true });
  });

  it("namespaces returned thread ids by backend and strips the namespace before adapter resume", async () => {
    const dir = await tempDir();
    const journalPath = path.join(dir, "journal.jsonl");
    const seenThreadIds: Array<string | undefined> = [];
    const engine = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      journalPath,
      adapters: {
        fake: {
          resolver: async ({ prompt, opts }) => {
            seenThreadIds.push(opts.threadId);
            return { prompt };
          },
        },
      },
    });

    const result = await engine.run(async ({ agent }) => {
      const first = await agent("start", { backend: "fake" });
      const second = await agent("resume", { backend: "fake", threadId: first.threadId });
      return { first, second };
    });

    assert.equal(result.first.threadId, "fake:fake-1");
    assert.equal(result.second.threadId, "fake:fake-2");
    assert.deepEqual(seenThreadIds, [undefined, "fake-1"]);
    const nodes = (await readJsonl(journalPath)).filter((line) => line.type === "node");
    assert.equal(nodes[0].threadId, "fake:fake-1");
    assert.equal(nodes[1].threadId, "fake:fake-2");
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects thread ids from a different backend before adapter execution", async () => {
    const dir = await tempDir();
    const engine = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      journalPath: path.join(dir, "journal.jsonl"),
    });

    await assert.rejects(
      () => engine.run(async ({ agent }) => agent("wrong resume", { backend: "fake", threadId: "codex-sdk:thread-1" })),
      /threadId belongs to backend codex-sdk, not fake/,
    );
    assert.equal(engine.adapters.fake.calls.length, 0);
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

  it("does not start an agent that timed out while waiting for concurrency", async () => {
    const dir = await tempDir();
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const started: string[] = [];
    const engine = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      concurrency: 1,
      journalPath: path.join(dir, "journal.jsonl"),
      adapters: {
        fake: {
          resolver: async ({ prompt }) => {
            started.push(prompt);
            if (prompt === "first") await delay(80);
            return { prompt };
          },
        },
      },
    });

    const [first, second] = await engine.run(async ({ agent }) => Promise.all([
      agent("first", { backend: "fake" }),
      agent("second", { backend: "fake", timeoutMs: 10 }),
    ]));

    assert.equal(first.status, "ok");
    assert.equal(second.status, "error");
    assert.deepEqual(started, ["first"]);
    await rm(dir, { recursive: true, force: true });
  });

  it("does not accept success after timeout when an adapter ignores the signal", async () => {
    const dir = await tempDir();
    const journalPath = path.join(dir, "journal.jsonl");
    const engine = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      journalPath,
      adapters: { fake: { delayMs: 30, responses: [{ ok: true }] } },
    });

    const result = await engine.run(async ({ agent }) => agent("late success", {
      backend: "fake",
      timeoutMs: 1,
    }));

    assert.equal(result.status, "error");
    assert.equal(result.output, null);
    assert.equal(engine.adapters.fake.calls.length, 1);
    const records = (await readJsonl(journalPath)).filter((line) => line.type === "node");
    assert.deepEqual(records.map((record) => record.status), ["timeout"]);
    await rm(dir, { recursive: true, force: true });
  });

  it("does not start an agent when the caller signal is already aborted", async () => {
    const dir = await tempDir();
    const journalPath = path.join(dir, "journal.jsonl");
    const abortController = new AbortController();
    abortController.abort(new Error("caller aborted"));
    const engine = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      journalPath,
      adapters: { fake: { responses: [{ ok: true }] } },
    });

    const result = await engine.run(async ({ agent }) => agent("pre-aborted", {
      backend: "fake",
      signal: abortController.signal,
    }));

    assert.equal(result.status, "error");
    assert.equal(result.output, null);
    assert.equal(engine.adapters.fake.calls.length, 0);
    const records = (await readJsonl(journalPath)).filter((line) => line.type === "node");
    assert.deepEqual(records.map((record) => record.status), ["timeout"]);
    await rm(dir, { recursive: true, force: true });
  });

  it("uses the real cwd for workspace-write nodes", async () => {
    const dir = await tempDir();
    const realCwd = path.join(dir, "repo");
    await mkdir(realCwd, { recursive: true });
    const journalPath = path.join(dir, "journal.jsonl");
    let seenCwd = "";
    const engine = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      journalPath,
      adapters: {
        fake: {
          resolver: async ({ opts }) => {
            seenCwd = opts.cwd ?? "";
            return { ok: true };
          },
        },
      },
    });

    const result = await engine.run(async ({ agent }) => agent("write in repo", {
      backend: "fake",
      cwd: realCwd,
      sandbox: "workspace-write",
    }));

    assert.deepEqual(result.output, { ok: true });
    assert.equal(seenCwd, await realpath(realCwd));
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects concurrent writable agents using the same cwd and releases the registry", async () => {
    const dir = await tempDir();
    const realCwd = path.join(dir, "repo");
    await mkdir(realCwd, { recursive: true });
    const journalPath = path.join(dir, "journal.jsonl");
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const engine = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      concurrency: 2,
      journalPath,
      adapters: {
        fake: {
          resolver: async () => {
            await delay(80);
            return { ok: true };
          },
        },
      },
    });

    await assert.rejects(
      engine.run(async ({ agent }) => Promise.all([
        agent("first", { backend: "fake", cwd: realCwd, sandbox: "workspace-write" }),
        agent("second", { backend: "fake", cwd: realCwd, sandbox: "workspace-write" }),
      ])),
      ConcurrentWritableCwdError,
    );
    await delay(100);

    const after = await engine.run(async ({ agent }) => agent("after", {
      backend: "fake",
      cwd: realCwd,
      sandbox: "workspace-write",
    }));
    assert.deepEqual(after.output, { ok: true });
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps writable cwd locked across transient retry backoff", async () => {
    const dir = await tempDir();
    const realCwd = path.join(dir, "repo");
    await mkdir(realCwd, { recursive: true });
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    let firstAttempts = 0;
    const engine = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      concurrency: 2,
      transientBaseMs: 50,
      transientRetries: 1,
      journalPath: path.join(dir, "journal.jsonl"),
      adapters: {
        fake: {
          resolver: async ({ prompt }) => {
            if (prompt === "first" && firstAttempts++ === 0) throw { status: 429, message: "rate limit" };
            return { ok: true };
          },
        },
      },
    });

    await assert.rejects(
      engine.run(async ({ parallel, agent }) => parallel([
        async () => agent("first", { backend: "fake", cwd: realCwd, sandbox: "workspace-write" }),
        async () => {
          await delay(10);
          return agent("second", { backend: "fake", cwd: realCwd, sandbox: "workspace-write" });
        },
      ])),
      ConcurrentWritableCwdError,
    );
    const after = await engine.run(async ({ agent }) => agent("after retry collision", {
      backend: "fake",
      cwd: realCwd,
      sandbox: "workspace-write",
    }));
    assert.deepEqual(after.output, { ok: true });
    await rm(dir, { recursive: true, force: true });
  });

  it("propagates writable cwd collisions through parallel instead of bulkheading them", async () => {
    const dir = await tempDir();
    const realCwd = path.join(dir, "repo");
    await mkdir(realCwd, { recursive: true });
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const engine = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      concurrency: 2,
      journalPath: path.join(dir, "journal.jsonl"),
      adapters: {
        fake: {
          resolver: async () => {
            await delay(80);
            return { ok: true };
          },
        },
      },
    });

    await assert.rejects(
      engine.run(async ({ parallel, agent }) => parallel([
        async () => agent("first", { backend: "fake", cwd: realCwd, sandbox: "workspace-write" }),
        async () => agent("second", { backend: "fake", cwd: realCwd, sandbox: "workspace-write" }),
      ])),
      ConcurrentWritableCwdError,
    );
    await rm(dir, { recursive: true, force: true });
  });

  it("propagates writable configuration errors through topologies", async () => {
    const dir = await tempDir();
    const engine = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      concurrency: 2,
      journalPath: path.join(dir, "journal.jsonl"),
    });

    await assert.rejects(
      engine.run(async ({ parallel, agent }) => parallel([
        async () => agent("missing parallel cwd", { backend: "fake", sandbox: "workspace-write" }),
      ])),
      /workspace-write\/danger-full-access requires opts.cwd/,
    );

    await assert.rejects(
      engine.run(async ({ pipeline, agent }) => pipeline(["item"],
        async () => agent("missing pipeline cwd", { backend: "fake", sandbox: "workspace-write" }),
      )),
      /workspace-write\/danger-full-access requires opts.cwd/,
    );
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects concurrent writable agents that share an additional directory", async () => {
    const dir = await tempDir();
    const repoA = path.join(dir, "repo-a");
    const repoB = path.join(dir, "repo-b");
    const shared = path.join(dir, "shared");
    await mkdir(repoA, { recursive: true });
    await mkdir(repoB, { recursive: true });
    await mkdir(shared, { recursive: true });
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const engine = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      concurrency: 2,
      journalPath: path.join(dir, "journal.jsonl"),
      adapters: {
        fake: {
          resolver: async () => {
            await delay(80);
            return { ok: true };
          },
        },
      },
    });

    await assert.rejects(
      engine.run(async ({ parallel, agent }) => parallel([
        async () => agent("a", { backend: "fake", cwd: repoA, sandbox: "workspace-write", additionalDirectories: [shared] }),
        async () => agent("b", { backend: "fake", cwd: repoB, sandbox: "workspace-write", additionalDirectories: [shared] }),
      ])),
      ConcurrentWritableCwdError,
    );
    await delay(100);

    const after = await engine.run(async ({ agent }) => agent("after shared dir collision", {
      backend: "fake",
      cwd: repoA,
      sandbox: "workspace-write",
      additionalDirectories: [shared],
    }));
    assert.deepEqual(after.output, { ok: true });
    await rm(dir, { recursive: true, force: true });
  });

  it("allows concurrent writable agents with different cwd and requires cwd for writable sandboxes", async () => {
    const dir = await tempDir();
    const journalPath = path.join(dir, "journal.jsonl");
    const a = path.join(dir, "repo-a");
    const b = path.join(dir, "repo-b");
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    const seen = new Set<string>();
    const engine = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      concurrency: 2,
      journalPath,
      adapters: {
        fake: {
          resolver: async ({ opts }) => {
            seen.add(opts.cwd ?? "");
            return { cwd: opts.cwd };
          },
        },
      },
    });

    const results = await engine.run(async ({ parallel, agent }) => parallel([
      async () => (await agent("a", { backend: "fake", cwd: a, sandbox: "workspace-write" })).output,
      async () => (await agent("b", { backend: "fake", cwd: b, sandbox: "workspace-write" })).output,
    ]));

    assert.deepEqual(results, [{ cwd: await realpath(a) }, { cwd: await realpath(b) }]);
    assert.deepEqual([...seen].sort(), [await realpath(a), await realpath(b)].sort());

    await assert.rejects(
      engine.run(async ({ agent }) => agent("missing cwd", {
        backend: "fake",
        sandbox: "workspace-write",
      })),
      /workspace-write\/danger-full-access requires opts.cwd/,
    );
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects concurrent writable agents using symlink aliases for the same cwd", async () => {
    const dir = await tempDir();
    const realCwd = path.join(dir, "repo");
    const aliasCwd = path.join(dir, "repo-link");
    await mkdir(realCwd, { recursive: true });
    await symlink(realCwd, aliasCwd, "dir");
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const engine = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      concurrency: 2,
      journalPath: path.join(dir, "journal.jsonl"),
      adapters: {
        fake: {
          resolver: async () => {
            await delay(80);
            return { ok: true };
          },
        },
      },
    });

    await assert.rejects(
      engine.run(async ({ agent }) => Promise.all([
        agent("real", { backend: "fake", cwd: realCwd, sandbox: "workspace-write" }),
        agent("alias", { backend: "fake", cwd: aliasCwd, sandbox: "workspace-write" }),
      ])),
      ConcurrentWritableCwdError,
    );
    await rm(dir, { recursive: true, force: true });
  });

  it("shadows crypto randomness and process.hrtime deterministically for the workflow body", async () => {
    const runOnce = async () => {
      const dir = await tempDir();
      const engine = createEngine({
        defaultBackend: "fake",
        autoRoute: false,
        seed: 42,
        journalPath: path.join(dir, "journal.jsonl"),
      });
      const result = await engine.run(async () => {
        const bytes = new Uint8Array(8);
        globalThis.crypto.getRandomValues(bytes);
        return {
          uuid: globalThis.crypto.randomUUID(),
          bytes: [...bytes],
          hr: process.hrtime(),
          bigint: process.hrtime.bigint().toString(),
        };
      });
      await rm(dir, { recursive: true, force: true });
      return result;
    };

    const first = await runOnce();
    const second = await runOnce();

    assert.deepEqual(first, second);
    assert.match(first.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(first.bytes.length, 8);
    assert.equal(first.hr.length, 2);
  });

  it("restores shadowed process and crypto globals after workflow run", async () => {
    const originalHrtime = process.hrtime;
    const originalHrtimeBigint = process.hrtime.bigint;
    const originalRandomUUID = globalThis.crypto.randomUUID;
    const originalGetRandomValues = globalThis.crypto.getRandomValues;
    const dir = await tempDir();
    const engine = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      seed: 7,
      journalPath: path.join(dir, "journal.jsonl"),
    });

    await engine.run(async () => {
      globalThis.crypto.randomUUID();
      globalThis.crypto.getRandomValues(new Uint8Array(2));
      process.hrtime();
      process.hrtime.bigint();
    });

    assert.equal(process.hrtime, originalHrtime);
    assert.equal(process.hrtime.bigint, originalHrtimeBigint);
    assert.equal(globalThis.crypto.randomUUID, originalRandomUUID);
    assert.equal(globalThis.crypto.getRandomValues, originalGetRandomValues);
    await rm(dir, { recursive: true, force: true });
  });


  it("routes to codex-exec only when isolate is explicitly true", () => {
    assert.equal(resolveBackend({ defaultBackend: "codex-sdk", autoRoute: true }, {}), "codex-sdk");
    assert.equal(resolveBackend({ defaultBackend: "codex-sdk", autoRoute: true }, { isolate: false }), "codex-sdk");
    assert.equal(resolveBackend({ defaultBackend: "codex-sdk", autoRoute: true }, { isolate: true }), "codex-exec");
    assert.equal(resolveBackend({ defaultBackend: "codex-sdk", autoRoute: true }, { backend: "codex-sdk", isolate: true }), "codex-sdk");
  });

  it("passes abort signals through openai-responses requests", async () => {
    const adapter = new OpenAIResponsesAdapter({}, { defaultModel: "test-model" }) as any;
    const calls: any[] = [];
    adapter.client = {
      responses: {
        create: async (...args: any[]) => {
          calls.push(args);
          return {
            id: "resp-1",
            output_parsed: { ok: true },
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
      },
    };
    const abortController = new AbortController();
    const schema = normalizeSchema({
      type: "object",
      additionalProperties: false,
      required: ["ok"],
      properties: { ok: { type: "boolean" } },
    });

    const result = await adapter.run("prompt", {
      backend: "openai-responses",
      sandbox: "read-only",
      schema,
    }, { signal: abortController.signal });

    assert.deepEqual(JSON.parse(result.finalResponse), { ok: true });
    assert.equal(calls[0][1]?.signal, abortController.signal);
  });

  it("passes codex-exec prompts as data and limits inherited environment", async () => {
    const dir = await tempDir();
    const fakeCodex = path.join(dir, "fake-codex.mjs");
    const argsPath = path.join(dir, "args.json");
    const envPath = path.join(dir, "env.json");
    await writeFile(fakeCodex, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
writeFileSync(process.env.CODEX_EXEC_ARGS_PATH, JSON.stringify(args));
writeFileSync(process.env.CODEX_EXEC_ENV_PATH, JSON.stringify({
  NPM_TOKEN: process.env.NPM_TOKEN ?? null,
  CODEX_API_KEY: process.env.CODEX_API_KEY ?? null,
  PATH: Boolean(process.env.PATH),
  HOME: Boolean(process.env.HOME)
}));
const outputPath = args[args.indexOf("-o") + 1];
writeFileSync(outputPath, '{"ok":true}');
console.log(JSON.stringify({ type: "thread.started", thread_id: "fake-thread" }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }));
`, "utf8");
    await chmod(fakeCodex, 0o755);
    const previousNpmToken = process.env.NPM_TOKEN;
    process.env.NPM_TOKEN = "leaked-token";
    try {
      const engine = createEngine({
        defaultBackend: "codex-exec",
        autoRoute: false,
        journalPath: path.join(dir, "journal.jsonl"),
        adapters: {
          codexExec: {
            codexPath: fakeCodex,
            env: {
              CODEX_EXEC_ARGS_PATH: argsPath,
              CODEX_EXEC_ENV_PATH: envPath,
              CODEX_API_KEY: "scoped-token",
            },
          },
        },
      });
      const Schema = {
        type: "object",
        additionalProperties: false,
        required: ["ok"],
        properties: { ok: { type: "boolean" } },
      };

      const result = await engine.run(async ({ agent }) => agent("--help", { backend: "codex-exec", schema: Schema }));

      assert.deepEqual(result.output, { ok: true });
      const args = JSON.parse(await readFile(argsPath, "utf8"));
      assert.equal(args[args.length - 2], "--");
      assert.equal(args[args.length - 1], "--help");
      const env = JSON.parse(await readFile(envPath, "utf8"));
      assert.equal(env.NPM_TOKEN, null);
      assert.equal(env.CODEX_API_KEY, "scoped-token");
    } finally {
      if (previousNpmToken === undefined) delete process.env.NPM_TOKEN;
      else process.env.NPM_TOKEN = previousNpmToken;
      await rm(dir, { recursive: true, force: true });
    }
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

  it("applies budget skip atomically across parallel agents", async () => {
    const dir = await tempDir();
    const engine = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      concurrency: 3,
      journalPath: path.join(dir, "journal.jsonl"),
      budget: { maxNodes: 1, onExceeded: "skip" },
      adapters: { fake: { delayMs: 20 } },
    });

    const results = await engine.run(async ({ parallel, agent }) => parallel([
      async () => agent("a", { backend: "fake" }),
      async () => agent("b", { backend: "fake" }),
      async () => agent("c", { backend: "fake" }),
    ]));

    assert.equal(engine.adapters.fake.calls.length, 1);
    assert.equal(results.filter((result) => result?.status === "ok").length, 1);
    assert.equal(results.filter((result) => result === null).length, 2);
    await rm(dir, { recursive: true, force: true });
  });


  it("produces the same cache key sequence for the same script and seed", async () => {
    const runOnce = async (): Promise<string[]> => {
      const dir = await tempDir();
      const journalPath = path.join(dir, "journal.jsonl");
      const engine = createEngine({
        defaultBackend: "fake",
        autoRoute: false,
        seed: 98765,
        journalPath,
        adapters: { fake: { responses: [{ step: 1 }, { step: 2 }, { step: 3 }] } },
      });

      await engine.run(async ({ agent, now, random }) => {
        const marker = `${now()}:${random().toFixed(8)}`;
        await agent(`first:${marker}`, { backend: "fake" });
        await agent(`second:${marker}`, { backend: "fake" });
        await agent(`third:${marker}`, { backend: "fake" });
      });

      const keys = (await readJsonl(journalPath))
        .filter((line) => line.type === "node")
        .map((line) => line.key);
      await rm(dir, { recursive: true, force: true });
      return keys;
    };

    assert.deepEqual(await runOnce(), await runOnce());
  });

  it("does not let internal journal timestamps shift ctx.now across replay", async () => {
    const dir = await tempDir();
    const journalPath = path.join(dir, "journal.jsonl");
    const workflow = async ({ agent, now }: any) => {
      await agent("before now", { backend: "fake" });
      return now();
    };

    const first = await createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      seed: 123,
      journalPath,
    }).run(workflow);
    const second = await createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      seed: 123,
      journalPath,
      adapters: { fake: { resolver: async () => { throw new Error("should replay"); } } },
    }).run(workflow);

    assert.equal(second, first);
    await rm(dir, { recursive: true, force: true });
  });

  it("reruns a node when the journal ends with a non-terminal repair record", async () => {
    const dir = await tempDir();
    const journalPath = path.join(dir, "journal.jsonl");
    const Schema = z.object({ ok: z.boolean() }).strict();
    const workflow = async ({ agent }: any) => agent("repair then crash", {
      backend: "fake",
      schema: Schema,
      retries: 1,
    });

    const first = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      journalPath,
      adapters: { fake: { responses: ['{"ok":"no"}', { ok: true }] } },
    });
    await first.run(workflow);

    const initialRecords = await readJsonl(journalPath);
    const repairOnly = initialRecords.filter((line) => line.type === "manifest" || line.status === "repair");
    assert.deepEqual(repairOnly.map((line) => line.type === "node" ? line.status : line.type), ["manifest", "repair"]);
    await writeFile(journalPath, repairOnly.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");

    const resumed = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      journalPath,
      adapters: { fake: { responses: [{ ok: true }] } },
    });
    const result = await resumed.run(workflow);

    assert.deepEqual(result.output, { ok: true });
    assert.equal(resumed.adapters.fake.calls.length, 1);
    const statuses = (await readJsonl(journalPath))
      .filter((line) => line.type === "node")
      .map((line) => line.status);
    assert.deepEqual(statuses, ["repair", "terminal"]);
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

  it("rejects journal replay when a malformed line appears before later records", async () => {
    const dir = await tempDir();
    const journalPath = path.join(dir, "journal.jsonl");
    const engine = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      journalPath,
      adapters: { fake: { responses: [{ ok: true }] } },
    });
    await engine.run(async ({ agent }) => agent("stable", { backend: "fake" }));
    const lines = (await readFile(journalPath, "utf8")).trim().split("\n");
    await writeFile(journalPath, [lines[0], "{ broken", ...lines.slice(1)].join("\n") + "\n", "utf8");

    const replayEngine = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      journalPath,
      adapters: { fake: { responses: [] } },
    });

    await assert.rejects(
      replayEngine.run(async ({ agent }) => agent("stable", { backend: "fake" })),
      /journal.*corrupt|invalid JSON/i,
    );
    await rm(dir, { recursive: true, force: true });
  });

  it("replays failed and timeout terminal-null records without calling the backend again", async () => {
    const dir = await tempDir();
    const failedJournalPath = path.join(dir, "failed.jsonl");
    const failed = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      journalPath: failedJournalPath,
      adapters: { fake: { resolver: async () => { throw new Error("auth denied"); } } },
    });

    const failedResult = await failed.run(async ({ agent }) => agent("stable failed node", { backend: "fake" }));

    assert.equal(failedResult.status, "error");
    assert.equal(failed.adapters.fake.calls.length, 1);

    const failedReplay = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      journalPath: failedJournalPath,
      adapters: { fake: { resolver: async () => { throw new Error("should not be called"); } } },
    });
    const replayedFailed = await failedReplay.run(async ({ agent }) => agent("stable failed node", { backend: "fake" }));

    assert.equal(replayedFailed.replayed, true);
    assert.equal(replayedFailed.status, "error");
    assert.equal(failedReplay.adapters.fake.calls.length, 0);

    const timeoutJournalPath = path.join(dir, "timeout-replay.jsonl");
    const timeout = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      journalPath: timeoutJournalPath,
      adapters: { fake: { resolver: async () => { throw new TimeoutError(); } } },
    });

    const timeoutResult = await timeout.run(async ({ agent }) => agent("stable timeout node", { backend: "fake" }));

    assert.equal(timeoutResult.status, "error");
    assert.equal(timeout.adapters.fake.calls.length, 1);

    const timeoutReplay = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      journalPath: timeoutJournalPath,
      adapters: { fake: { resolver: async () => { throw new Error("should not be called"); } } },
    });
    const replayedTimeout = await timeoutReplay.run(async ({ agent }) => agent("stable timeout node", { backend: "fake" }));

    assert.equal(replayedTimeout.replayed, true);
    assert.equal(replayedTimeout.status, "error");
    assert.equal(timeoutReplay.adapters.fake.calls.length, 0);
    await rm(dir, { recursive: true, force: true });
  });

  it("replays successful null outputs as ok results", async () => {
    const dir = await tempDir();
    const journalPath = path.join(dir, "journal.jsonl");
    const workflow = async ({ agent }: any) => agent("return null", { backend: "fake" });

    const first = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      journalPath,
      adapters: { fake: { responses: ["null"] } },
    });
    const firstResult = await first.run(workflow);
    assert.equal(firstResult.status, "ok");
    assert.equal(firstResult.output, null);

    const second = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      journalPath,
      adapters: { fake: { resolver: async () => { throw new Error("should replay"); } } },
    });
    const secondResult = await second.run(workflow);
    assert.equal(secondResult.replayed, true);
    assert.equal(secondResult.status, "ok");
    assert.equal(secondResult.output, null);
    assert.equal(second.adapters.fake.calls.length, 0);
    await rm(dir, { recursive: true, force: true });
  });

  it("replays a completed node even when the default backend changes", async () => {
    const dir = await tempDir();
    const journalPath = path.join(dir, "journal.jsonl");
    const first = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      journalPath,
      adapters: { fake: { responses: [{ ok: true }] } },
    });

    await first.run(async ({ agent }) => agent("stable backend-agnostic node"));

    const replayEngine = createEngine({
      defaultBackend: "openai-responses",
      autoRoute: false,
      journalPath,
    });
    const replay = await replayEngine.run(async ({ agent }) => agent("stable backend-agnostic node"));

    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.output, { ok: true });
    await rm(dir, { recursive: true, force: true });
  });

  it("does not replay implicit-cwd nodes across different process cwd values", async () => {
    const originalCwd = process.cwd();
    const dir = await tempDir();
    const journalPath = path.join(dir, "journal.jsonl");
    const repoA = path.join(dir, "repo-a");
    const repoB = path.join(dir, "repo-b");
    await mkdir(repoA, { recursive: true });
    await mkdir(repoB, { recursive: true });

    try {
      process.chdir(repoA);
      const first = createEngine({
        defaultBackend: "fake",
        autoRoute: false,
        journalPath,
        adapters: { fake: { resolver: async () => ({ cwd: process.cwd() }) } },
      });
      const firstResult = await first.run(async ({ agent }) => agent<{ cwd: string }>("read implicit cwd", { backend: "fake" }));

      process.chdir(repoB);
      const second = createEngine({
        defaultBackend: "fake",
        autoRoute: false,
        journalPath,
        adapters: { fake: { resolver: async () => ({ cwd: process.cwd() }) } },
      });
      const secondResult = await second.run(async ({ agent }) => agent<{ cwd: string }>("read implicit cwd", { backend: "fake" }));

      assert.equal(firstResult.output.cwd, await realpath(repoA));
      assert.equal(secondResult.replayed, false);
      assert.equal(second.adapters.fake.calls.length, 1);
      assert.equal(secondResult.output.cwd, await realpath(repoB));
    } finally {
      process.chdir(originalCwd);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resets deterministic counters for each run on the same engine", async () => {
    const dir = await tempDir();
    const engine = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      seed: 123,
      journalPath: path.join(dir, "journal.jsonl"),
    });
    const workflow = async ({ now, random }: any) => [now(), random(), now(), random()];

    const first = await engine.run(workflow);
    const second = await engine.run(workflow);

    assert.deepEqual(second, first);
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps ctx.random stable when adapter code consumes shadowed Math.random before replay", async () => {
    const dir = await tempDir();
    const journalPath = path.join(dir, "journal.jsonl");
    const workflow = async ({ agent, random }: any) => {
      const result = await agent("adapter hidden randomness", { backend: "fake" });
      return { output: result.output, value: random() };
    };

    const first = await createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      seed: 7,
      journalPath,
      adapters: {
        fake: {
          resolver: async () => {
            Math.random();
            return { ok: true };
          },
        },
      },
    }).run(workflow);

    const secondEngine = createEngine({
      defaultBackend: "fake",
      autoRoute: false,
      seed: 7,
      journalPath,
      adapters: { fake: { resolver: async () => { throw new Error("should replay"); } } },
    });
    const second = await secondEngine.run(workflow);

    assert.deepEqual(second, first);
    assert.equal(secondEngine.adapters.fake.calls.length, 0);
    await rm(dir, { recursive: true, force: true });
  });

  it("imports workflow files under deterministic shadows", async () => {
    const runOnce = async (): Promise<number> => {
      const dir = await tempDir();
      const wf = path.join(dir, "top-level.workflow.ts");
      await writeFile(wf, "const value = Math.random(); export default async function workflow(){ return value; }\n", "utf8");
      const engine = createEngine({
        defaultBackend: "fake",
        autoRoute: false,
        seed: 456,
        journalPath: path.join(dir, "journal.jsonl"),
      });
      const result = await engine.run<number>(wf);
      await rm(dir, { recursive: true, force: true });
      return result;
    };

    assert.equal(await runOnce(), await runOnce());
  });

  it("includes additional directories and reasoning effort in cache keys", async () => {
    const dir = await tempDir();
    const journalPath = path.join(dir, "journal.jsonl");
    const runOnce = async (additionalDirectories: string[], modelReasoningEffort: string, marker: number) => {
      const engine = createEngine({
        defaultBackend: "fake",
        autoRoute: false,
        journalPath,
        adapters: { fake: { responses: [{ marker }] } },
      });
      const result = await engine.run(async ({ agent }) => agent("same prompt", {
        backend: "fake",
        additionalDirectories,
        modelReasoningEffort,
      }));
      return { engine, result };
    };

    await runOnce([path.join(dir, "a")], "low", 1);
    const changedDir = await runOnce([path.join(dir, "b")], "low", 2);
    const changedEffort = await runOnce([path.join(dir, "b")], "high", 3);

    assert.equal(changedDir.result.replayed, false);
    assert.deepEqual(changedDir.result.output, { marker: 2 });
    assert.equal(changedEffort.result.replayed, false);
    assert.deepEqual(changedEffort.result.output, { marker: 3 });
    assert.equal(changedDir.engine.adapters.fake.calls.length, 1);
    assert.equal(changedEffort.engine.adapters.fake.calls.length, 1);
    await rm(dir, { recursive: true, force: true });
  });
});
