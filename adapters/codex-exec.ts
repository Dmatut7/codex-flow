import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentAdapter, AdapterResult, AdapterRuntime, NormalizedAgentOpts } from "./types.ts";
import type { EngineConfig, Usage } from "../engine/types.ts";

export class CodexExecAdapter implements AgentAdapter {
  readonly name = "codex-exec";
  constructor(private readonly adapterConfig: Record<string, unknown> = {}, private readonly engineConfig: EngineConfig = {}) {}

  async run(prompt: string, opts: NormalizedAgentOpts, runtime: AdapterRuntime): Promise<AdapterResult> {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "codex-exec-"));
    const schemaPath = opts.schema ? path.join(tmp, "schema.json") : undefined;
    const outputPath = path.join(tmp, "last-message.txt");
    if (schemaPath) writeFileSync(schemaPath, JSON.stringify(opts.schema!.adapterSchema), "utf8");
    const args = ["exec", "--json", "--sandbox", opts.sandbox ?? "read-only", "--skip-git-repo-check", "-o", outputPath];
    if (opts.cwd) args.push("-C", opts.cwd);
    if (schemaPath) args.push("--output-schema", schemaPath);
    if (opts.threadId) args.push("resume", opts.threadId, "--", prompt);
    else args.push("--", prompt);

    try {
      return await new Promise<AdapterResult>((resolve, reject) => {
        const child = spawn(String(this.adapterConfig.codexPath ?? "codex"), args, {
          env: codexExecEnv(this.adapterConfig.env as Record<string, string> | undefined),
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let finalResponse = "";
        let usage: Usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
        let threadId: string | undefined;
        let fatalMessage = "";

        const abort = () => {
          try { process.kill(-child.pid!, "SIGTERM"); } catch {}
          setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }, Number(this.adapterConfig.graceWindowMs ?? 2000));
        };
        runtime.signal.addEventListener("abort", abort, { once: true });

        child.stdout.on("data", (chunk) => {
          stdout += chunk.toString();
          const lines = stdout.split("\n");
          stdout = lines.pop() ?? "";
          for (const line of lines) {
            const event = parseLine(line);
            if (!event) continue;
            if (event.type === "thread.started") threadId = event.thread_id ?? event.threadId;
            if (event.type === "item.completed") {
              const item = event.item ?? {};
              runtime.log?.("codex exec item completed", item);
              if (item.type === "agent_message" || item.type === "assistant_message") finalResponse = item.text ?? "";
            }
            if (event.type === "turn.completed") usage = normalizeUsage(event.usage);
            if (event.type === "turn.failed") fatalMessage = event.error?.message ?? "codex exec turn failed";
            if (event.type === "error") {
              const message = String(event.message ?? event.error?.message ?? "");
              if (!/^Reconnecting/i.test(message)) fatalMessage = message;
            }
          }
        });
        child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
        child.on("error", reject);
        child.on("close", (code) => {
          runtime.signal.removeEventListener("abort", abort);
          if (code !== 0) return reject(new Error(fatalMessage || stderr || `codex exec exited ${code}`));
          if (fatalMessage) return reject(new Error(fatalMessage));
          try {
            const fromFile = readFileSync(outputPath, "utf8").trim();
            if (fromFile) finalResponse = fromFile;
          } catch {}
          resolve({ finalResponse, usage, threadId });
        });
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

function codexExecEnv(extraEnv: Record<string, string> | undefined): NodeJS.ProcessEnv {
  const keep = ["HOME", "PATH", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "CODEX_HOME"];
  const out: NodeJS.ProcessEnv = {};
  for (const key of keep) {
    if (process.env[key] !== undefined) out[key] = process.env[key];
  }
  return { ...out, ...(extraEnv ?? {}) };
}

function parseLine(line: string): any | undefined {
  try { return JSON.parse(line); } catch { return undefined; }
}

function normalizeUsage(usage: any): Usage {
  return {
    input_tokens: usage?.input_tokens ?? 0,
    cached_input_tokens: usage?.cached_input_tokens ?? 0,
    output_tokens: usage?.output_tokens ?? 0,
    reasoning_output_tokens: usage?.reasoning_output_tokens ?? 0,
  };
}
