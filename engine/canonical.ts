import { createHash } from "node:crypto";

function normalize(value: unknown): unknown {
  if (value === undefined) return { __undefined: true };
  if (value === null) return null;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => normalize(item));
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = normalize((value as Record<string, unknown>)[key]);
  }
  return out;
}

export function canonicalJSON(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalJSON(value)).digest("hex");
}
