import { mkdirSync, existsSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { JournalLogRecord, JournalManifest, JournalNodeRecord, Usage } from "./types.ts";

export class Journal {
  private manifest?: JournalManifest;
  private replayMap = new Map<string, JournalNodeRecord>();
  private lastByKey = new Map<string, JournalNodeRecord>();
  private lastTotals: Usage & { nodes: number } = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, nodes: 0 };

  constructor(private readonly filePath: string) {}

  init(expected: Omit<JournalManifest, "type" | "startedAt">): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!existsSync(this.filePath)) {
      this.manifest = { type: "manifest", ...expected, startedAt: Date.now() };
      writeFileSync(this.filePath, JSON.stringify(this.manifest) + "\n", "utf8");
      return;
    }
    this.load();
    const matches = this.manifest && this.manifest.engineVersion === expected.engineVersion && this.manifest.scriptHash === expected.scriptHash && this.manifest.defaultBackend === expected.defaultBackend && this.manifest.seed === expected.seed;
    if (!matches) {
      this.replayMap.clear();
      this.lastByKey.clear();
      this.lastTotals = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, nodes: 0 };
      this.manifest = { type: "manifest", ...expected, startedAt: Date.now() };
      writeFileSync(this.filePath, JSON.stringify(this.manifest) + "\n", "utf8");
    }
  }

  get(key: string): JournalNodeRecord | undefined {
    return this.replayMap.get(key);
  }

  runningTotals(): Usage & { nodes: number } {
    return { ...this.lastTotals };
  }

  appendNode(record: JournalNodeRecord): void {
    this.append(record);
    this.lastByKey.set(record.key, record);
    if (record.status === "terminal") this.replayMap.set(record.key, record);
    else this.replayMap.delete(record.key);
    this.lastTotals = { ...record.runningTotals };
  }

  appendLog(record: JournalLogRecord): void {
    this.append(record);
  }

  private append(record: unknown): void {
    appendFileSync(this.filePath, JSON.stringify(record) + "\n", "utf8");
  }

  private load(): void {
    this.replayMap.clear();
    this.lastByKey.clear();
    const text = readFileSync(this.filePath, "utf8");
    const lines = text.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed.type === "manifest") this.manifest = parsed;
      if (parsed.type === "node") {
        this.lastByKey.set(parsed.key, parsed);
        this.lastTotals = { ...this.lastTotals, ...(parsed.runningTotals ?? {}) };
      }
    }
    for (const [key, record] of this.lastByKey.entries()) {
      if (record.status === "terminal") this.replayMap.set(key, record);
    }
  }
}
