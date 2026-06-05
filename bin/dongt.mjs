#!/usr/bin/env node
// Global entry for the `dongt` CLI. Registers the tsx ESM loader so the
// TypeScript engine + the user's .ts workflow files load with no build step.
import { register } from "tsx/esm/api";

register();
await import(new URL("../cli/main.ts", import.meta.url).href);
