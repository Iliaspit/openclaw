import type { SubagentModelCompletion } from "./subagent-registry.types.js";

export function classifySubagentModelCompletion(
  rawStopReason?: string,
): SubagentModelCompletion {
  const normalized = rawStopReason?.trim().toLowerCase();
  if (normalized === "stop" || normalized === "end_turn") {
    return "complete";
  }
  if (normalized === "length" || normalized === "max_tokens") {
    return "truncated";
  }
  return "unknown";
}
