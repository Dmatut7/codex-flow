import type { AgentOpts, BudgetController, BudgetExceededPolicy, Usage } from "./types.ts";

export class BudgetExceededError extends Error {
  constructor(message = "Workflow budget exceeded") {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export function billableTokens(usage: Usage): number {
  const input = Math.max(0, (usage.input_tokens ?? 0) - (usage.cached_input_tokens ?? 0));
  return input + (usage.output_tokens ?? 0) + (usage.reasoning_output_tokens ?? 0);
}

export class WorkflowBudget implements BudgetController {
  private maxTokens = Number.POSITIVE_INFINITY;
  private maxNodes = Number.POSITIVE_INFINITY;
  private onExceeded: BudgetExceededPolicy = "throw";
  private reservedTokens = 0;
  private totalUsage: Usage & { nodes: number } = {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    nodes: 0,
  };

  constructor(config?: { maxTokens?: number; maxNodes?: number; onExceeded?: BudgetExceededPolicy }, persisted?: Usage & { nodes: number }) {
    if (persisted) this.totalUsage = { ...this.totalUsage, ...persisted };
    if (config) this.configure(config);
  }

  loadTotals(totals: Usage & { nodes: number }): void {
    this.totalUsage = { ...this.totalUsage, ...totals };
  }

  configure(o: { maxTokens?: number; maxNodes?: number; onExceeded?: BudgetExceededPolicy }): void {
    if (o.maxTokens !== undefined) this.maxTokens = o.maxTokens;
    if (o.maxNodes !== undefined) this.maxNodes = o.maxNodes;
    if (o.onExceeded) this.onExceeded = o.onExceeded;
  }

  reserve(estimate = 0): void {
    this.guard();
    this.reservedTokens += estimate;
    this.totalUsage.nodes += 1;
  }

  cancelReservation(estimate = 0): void {
    this.reservedTokens = Math.max(0, this.reservedTokens - estimate);
    this.totalUsage.nodes = Math.max(0, this.totalUsage.nodes - 1);
  }

  reconcile(actual: Usage, estimate = 0): void {
    this.reservedTokens = Math.max(0, this.reservedTokens - estimate);
    this.totalUsage.input_tokens += actual.input_tokens ?? 0;
    this.totalUsage.cached_input_tokens += actual.cached_input_tokens ?? 0;
    this.totalUsage.output_tokens += actual.output_tokens ?? 0;
    this.totalUsage.reasoning_output_tokens = (this.totalUsage.reasoning_output_tokens ?? 0) + (actual.reasoning_output_tokens ?? 0);
  }

  guard(): void {
    if (this.isExceeded() && this.onExceeded === "throw") throw new BudgetExceededError();
  }

  actionFor(opts: AgentOpts): "continue" | "skip" | "downgrade" {
    if (!this.isExceeded()) return "continue";
    if (this.onExceeded === "throw") throw new BudgetExceededError();
    if (this.onExceeded === "downgrade" && isSchemaOnly(opts)) return "downgrade";
    return "skip";
  }

  remaining(): { tokens: number; nodes: number } {
    return {
      tokens: Math.max(0, this.maxTokens - billableTokens(this.totalUsage) - this.reservedTokens),
      nodes: Math.max(0, this.maxNodes - this.totalUsage.nodes),
    };
  }

  totals(): Usage & { nodes: number } {
    return { ...this.totalUsage };
  }

  private isExceeded(): boolean {
    return billableTokens(this.totalUsage) + this.reservedTokens >= this.maxTokens || this.totalUsage.nodes >= this.maxNodes;
  }
}

function isSchemaOnly(opts: AgentOpts): boolean {
  return Boolean(opts.schema && (opts.pure === true || opts.kind === "extract" || opts.kind === "classify" || opts.kind === "judge") && !opts.cwd && opts.sandbox !== "workspace-write" && opts.sandbox !== "danger-full-access" && !opts.additionalDirectories?.length);
}
