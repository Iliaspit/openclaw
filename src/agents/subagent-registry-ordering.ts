import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function compareSubagentRunRecency(
  left: SubagentRunRecord,
  right: SubagentRunRecord,
): number {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt - right.createdAt;
  }
  const leftStartedAt = typeof left.startedAt === "number" ? left.startedAt : left.createdAt;
  const rightStartedAt = typeof right.startedAt === "number" ? right.startedAt : right.createdAt;
  if (leftStartedAt !== rightStartedAt) {
    return leftStartedAt - rightStartedAt;
  }
  return left.runId.localeCompare(right.runId);
}

export function isSubagentRunNewer(
  candidate: SubagentRunRecord,
  current: SubagentRunRecord,
): boolean {
  return compareSubagentRunRecency(candidate, current) > 0;
}
