import { existsSync, readFileSync } from "node:fs";

// Live progress for `codex-flow run`: tails the append-only journal while the
// workflow runs and prints concise per-node progress to STDERR (stdout stays a
// clean final JSON). This is what makes a long audit visible in Codex App / CLI
// instead of a silent black box. CLI-only — no engine changes, works for every backend.

interface JournalLine {
  type?: string;
  status?: string;
  msg?: string;
  key?: string;
  structuralPosition?: { phase?: string[]; nodeKey?: string };
}

export function startProgress(journalPath: string, write: (s: string) => void = (s) => process.stderr.write(s)): () => void {
  let seen = 0;
  let lastPhase = " "; // sentinel so the first real phase always prints

  const render = (rec: JournalLine): void => {
    if (rec.type === "node" && rec.status && rec.status !== "repair") {
      const phase = (rec.structuralPosition?.phase ?? []).join(" › ") || "(workflow)";
      if (phase !== lastPhase) {
        write(`\n▶ ${phase}\n`);
        lastPhase = phase;
      }
      const label = rec.structuralPosition?.nodeKey ?? (rec.key ? rec.key.slice(0, 10) : "node");
      const mark = rec.status === "terminal" ? "✓" : "⚠";
      const suffix = rec.status === "terminal" ? "" : ` (${rec.status})`;
      write(`  ${mark} ${label}${suffix}\n`);
    } else if (rec.type === "log" && rec.msg && !/item completed|codex (sdk |exec )?item/i.test(rec.msg)) {
      // surface workflow author milestones (ctx.log), skip the adapter's per-item spam
      write(`    · ${rec.msg}\n`);
    }
  };

  const tick = (): void => {
    if (!existsSync(journalPath)) return;
    let text: string;
    try {
      text = readFileSync(journalPath, "utf8");
    } catch {
      return;
    }
    const lines = text.split("\n");
    for (let i = seen; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) {
        if (i < lines.length - 1) seen = i + 1; // skip stable blank lines, not a torn trailing one
        continue;
      }
      let rec: JournalLine;
      try {
        rec = JSON.parse(line);
      } catch {
        break; // torn trailing line mid-write — retry on the next tick
      }
      seen = i + 1;
      render(rec);
    }
  };

  const timer = setInterval(tick, 400);
  if (typeof timer.unref === "function") timer.unref();
  return () => {
    clearInterval(timer);
    tick(); // flush whatever landed after the last poll
  };
}
