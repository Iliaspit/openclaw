import { subagentRuns } from "./subagent-registry-memory.js";
import {
  persistSubagentRunsToDisk,
  restoreSubagentRunsFromDisk,
} from "./subagent-registry-state.js";

export function markSubagentRunForFreshReroute(runId: string): boolean {
  const key = runId.trim();
  if (!key) {
    return false;
  }
  restoreSubagentRunsFromDisk({ runs: subagentRuns, mergeOnly: true });
  const entry = subagentRuns.get(key);
  if (!entry) {
    return false;
  }
  if (entry.suppressAnnounceReason === "fresh-reroute") {
    return false;
  }
  entry.suppressAnnounceReason = "fresh-reroute";
  persistSubagentRunsToDisk(subagentRuns);
  return true;
}
