import AjvModule from "ajv";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { NormalizedSchema } from "../adapters/types.ts";

const UNSUPPORTED_FOR_MODEL = new Set(["minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "pattern", "format"]);

export function normalizeSchema(schema: unknown): NormalizedSchema | undefined {
  if (!schema) return undefined;
  const validationSchema = enforceStrictSchema(toJsonSchema(schema));
  const adapterSchema = stripUnsupportedKeywords(validationSchema);
  const AjvCtor: any = (AjvModule as any).default ?? AjvModule;
  const ajv = new AjvCtor({ allErrors: true, strict: false });
  const validate = ajv.compile(validationSchema);
  return {
    validationSchema,
    adapterSchema,
    validator(value: unknown) {
      if (validate(value)) return { ok: true, value };
      return { ok: false, errors: (validate.errors ?? []).map((error: any) => `${error.instancePath || "/"} ${error.message ?? "invalid"}`) };
    },
  };
}

export function parseAndValidate(raw: string, schema?: NormalizedSchema): { ok: true; output: unknown } | { ok: false; errors: string[] } {
  if (!schema) return { ok: true, output: parseLoose(raw) };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, errors: [`JSON parse failed: ${(error as Error).message}`] };
  }
  const result = schema.validator(parsed);
  return result.ok ? { ok: true, output: result.value } : { ok: false, errors: result.errors };
}

export function buildRepairPrompt(originalPrompt: string, raw: string, errors: string[]): string {
  return [
    originalPrompt,
    "",
    "The previous final response did not satisfy the required JSON schema.",
    "Return only corrected JSON. Do not include prose.",
    "Validation errors:",
    ...errors.map((error) => `- ${error}`),
    "Previous final response:",
    raw,
  ].join("\n");
}

function parseLoose(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return raw; }
}

function toJsonSchema(schema: unknown): any {
  if (isZodSchema(schema)) {
    const converted = zodToJsonSchema(schema as any, { target: "openAi" });
    return unwrapZodSchema(converted);
  }
  return clone(schema);
}

function isZodSchema(schema: unknown): boolean {
  return Boolean(schema && typeof schema === "object" && "safeParse" in (schema as any) && "_def" in (schema as any));
}

function unwrapZodSchema(schema: any): any {
  const cloned = clone(schema);
  delete cloned.$schema;
  if (cloned.definitions && cloned.$ref) {
    const ref = String(cloned.$ref).replace("#/definitions/", "");
    const inner = cloned.definitions[ref];
    if (inner) return inner;
  }
  return cloned;
}

function enforceStrictSchema(schema: any): any {
  let root = clone(schema);
  if (root.anyOf) throw new Error("Strict schema root must be an object and cannot use anyOf");
  if (root.type === "array") {
    root = { type: "object", properties: { items: root }, required: ["items"], additionalProperties: false };
  }
  if (root.type !== "object") throw new Error("Strict schema root must be an object");
  const stats = { properties: 0, enumValues: 0, maxDepth: 0 };
  const normalized = visit(root, 1, stats);
  if (stats.properties > 100) throw new Error("Strict schema exceeds 100 total properties");
  if (stats.maxDepth > 5) throw new Error("Strict schema exceeds 5 levels of nesting");
  if (stats.enumValues > 500) throw new Error("Strict schema exceeds 500 enum values");
  return normalized;
}

function visit(node: any, depth: number, stats: { properties: number; enumValues: number; maxDepth: number }): any {
  if (!node || typeof node !== "object") return node;
  stats.maxDepth = Math.max(stats.maxDepth, depth);
  const out = clone(node);
  if (Array.isArray(out.enum)) stats.enumValues += out.enum.length;
  const types = Array.isArray(out.type) ? out.type : [out.type];
  if (types.includes("object")) {
    out.properties = out.properties ?? {};
    const keys = Object.keys(out.properties);
    stats.properties += keys.length;
    out.required = keys;
    out.additionalProperties = false;
    for (const key of keys) out.properties[key] = visit(out.properties[key], depth + 1, stats);
  }
  if (out.items) out.items = visit(out.items, depth + 1, stats);
  if (Array.isArray(out.anyOf)) out.anyOf = out.anyOf.map((child: any) => visit(child, depth + 1, stats));
  return out;
}

function stripUnsupportedKeywords(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(stripUnsupportedKeywords);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED_FOR_MODEL.has(key)) continue;
    out[key] = stripUnsupportedKeywords(value);
  }
  return out;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
