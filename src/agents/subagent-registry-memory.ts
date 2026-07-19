import type { SubagentRunRecord, SubagentSliceBudgetRecord } from "./subagent-registry.types.js";

export const subagentRuns = new Map<string, SubagentRunRecord>();
export const subagentSliceBudgets = new Map<string, SubagentSliceBudgetRecord>();
