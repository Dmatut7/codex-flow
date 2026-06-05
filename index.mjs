import { register } from "tsx/esm/api";

register();

const engine = await import("./engine/index.ts");

export const createEngine = engine.createEngine;
export const runWorkflow = engine.runWorkflow;
