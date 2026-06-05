#!/usr/bin/env node
// Global entry for the `codex-flow` CLI. Registers the tsx ESM loader so the
// TypeScript engine + the user's .ts workflow files load with no build step.
process.env.TSX_DISABLE_CACHE ??= "1";

const { register } = await import("tsx/esm/api");
register();
await import(new URL("../cli/main.ts", import.meta.url).href);
