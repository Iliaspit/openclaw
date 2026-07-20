import { subagentRuns } from "./subagent-registry-memory.js";
import { isSubagentRunNewer } from "./subagent-registry-ordering.js";
import {
  countActiveDescendantRunsFromRuns,
  listDescendantRunsForRequesterFromRuns,
  listRunsForControllerFromRuns,
} from "./subagent-registry-queries.js";
import { getSubagentRunsSnapshotForRead } from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import {
  getSubagentSessionRuntimeMs,
  getSubagentSessionStartedAt,
  resolveSubagentSessionStatus,
} from "./subagent-session-metrics.js";

export {
  getSubagentSessionRuntimeMs,
  getSubagentSessionStartedAt,
  resolveSubagentSessionStatus,
} from "./subagent-session-metrics.js";

export function listSubagentRunsForController(controllerSessionKey: string): SubagentRunRecord[] {
  return listRunsForControllerFromRuns(
    getSubagentRunsSnapshotForRead(subagentRuns),
    controllerSessionKey,
  );
}

export function countActiveDescendantRuns(rootSessionKey: string): number {
  return countActiveDescendantRunsFromRuns(
    getSubagentRunsSnapshotForRead(subagentRuns),
    rootSessionKey,
  );
}

export function listDescendantRunsForRequester(rootSessionKey: string): SubagentRunRecord[] {
  return listDescendantRunsForRequesterFromRuns(
    getSubagentRunsSnapshotForRead(subagentRuns),
    rootSessionKey,
  );
}

export function getSubagentRunByChildSessionKey(childSessionKey: string): SubagentRunRecord | null {
  return getLatestSubagentRunByChildSessionKey(childSessionKey);
}

function getPersistedSessionDisplaySubagentRunByChildSessionKey(
  childSessionKey: string,
): SubagentRunRecord | null {
  // Dashboard projection preserves cross-process active visibility; ownership stays latest-first.
  let latestActive: SubagentRunRecord | null = null;
  let latestEnded: SubagentRunRecord | null = null;
  for (const entry of getSubagentRunsSnapshotForRead(subagentRuns).values()) {
    if (entry.childSessionKey !== childSessionKey) {
      continue;
    }
    if (typeof entry.endedAt !== "number") {
      if (!latestActive || isSubagentRunNewer(entry, latestActive)) {
        latestActive = entry;
      }
      continue;
    }
    if (!latestEnded || isSubagentRunNewer(entry, latestEnded)) {
      latestEnded = entry;
    }
  }
  return latestActive ?? latestEnded;
}

export function getSessionDisplaySubagentRunByChildSessionKey(
  childSessionKey: string,
): SubagentRunRecord | null {
  const key = childSessionKey.trim();
  if (!key) {
    return null;
  }

  let latestInMemoryActive: SubagentRunRecord | null = null;
  let latestInMemoryEnded: SubagentRunRecord | null = null;
  for (const entry of subagentRuns.values()) {
    if (entry.childSessionKey !== key) {
      continue;
    }
    if (typeof entry.endedAt === "number") {
      if (!latestInMemoryEnded || isSubagentRunNewer(entry, latestInMemoryEnded)) {
        latestInMemoryEnded = entry;
      }
      continue;
    }
    if (!latestInMemoryActive || isSubagentRunNewer(entry, latestInMemoryActive)) {
      latestInMemoryActive = entry;
    }
  }

  if (latestInMemoryEnded || latestInMemoryActive) {
    if (
      latestInMemoryEnded &&
      (!latestInMemoryActive || isSubagentRunNewer(latestInMemoryEnded, latestInMemoryActive))
    ) {
      return latestInMemoryEnded;
    }
    return latestInMemoryActive ?? latestInMemoryEnded;
  }

  return getPersistedSessionDisplaySubagentRunByChildSessionKey(key);
}

export function getLatestSubagentRunByChildSessionKey(
  childSessionKey: string,
): SubagentRunRecord | null {
  const key = childSessionKey.trim();
  if (!key) {
    return null;
  }

  let latest: SubagentRunRecord | null = null;
  for (const entry of getSubagentRunsSnapshotForRead(subagentRuns).values()) {
    if (entry.childSessionKey !== key) {
      continue;
    }
    if (!latest || isSubagentRunNewer(entry, latest)) {
      latest = entry;
    }
  }

  return latest;
}
