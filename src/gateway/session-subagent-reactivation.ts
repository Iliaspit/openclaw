import { guardChildRouteForDelivery } from "../agents/child-route-guard.js";
import { resolveChildRouteProviderContextFromSession } from "../agents/child-route-provider-context.js";
import { getLatestSubagentRunByChildSessionKey } from "../agents/subagent-registry-read.js";
import { loadSessionEntry } from "./session-utils.js";

async function loadSessionSubagentReactivationRuntime() {
  return import("./session-subagent-reactivation.runtime.js");
}

export async function reactivateCompletedSubagentSession(params: {
  sessionKey: string;
  runId?: string;
}): Promise<boolean> {
  const runId = params.runId?.trim();
  if (!runId) {
    return false;
  }
  const existing = getLatestSubagentRunByChildSessionKey(params.sessionKey);
  if (!existing || typeof existing.endedAt !== "number") {
    return false;
  }
  if (existing.suppressAnnounceReason === "fresh-reroute") {
    return false;
  }
  const requesterSessionKey = existing.controllerSessionKey ?? existing.requesterSessionKey;
  const sessionEntry = loadSessionEntry(params.sessionKey);
  const routeGuard = await guardChildRouteForDelivery({
    childSessionKey: params.sessionKey,
    context: {
      routeIntent: "reactivation",
      targetMethod: "subagent_reactivation",
      idempotencyKey: runId,
      requesterSessionKey,
      childTargetKind: "subagent",
      registryRecord: existing,
      provider: resolveChildRouteProviderContextFromSession({
        cfg: sessionEntry.cfg,
        sessionKey: sessionEntry.canonicalKey,
        entry: sessionEntry.entry,
        requesterSessionKey,
      }),
    },
    payloadForHash: {
      method: "subagent_reactivation",
      previousRunId: existing.runId,
    },
  });
  if (!routeGuard.ok) {
    return false;
  }
  const { replaceSubagentRunAfterSteer } = await loadSessionSubagentReactivationRuntime();
  return replaceSubagentRunAfterSteer({
    previousRunId: existing.runId,
    nextRunId: runId,
    fallback: existing,
    runTimeoutSeconds: existing.runTimeoutSeconds ?? 0,
  });
}
