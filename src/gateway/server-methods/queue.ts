import { getCommandQueueSnapshot } from "../../process/command-queue.js";
import {
  type QueueHealthParams,
  type QueueHealthResult,
  validateQueueHealthParams,
} from "../protocol/index.js";
import { loadSessionEntry, readLatestSessionsYieldStatusFromTranscript } from "../session-utils.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

function resolveSessionKeyFromQueueLane(lane: string | undefined): string | null {
  const prefix = "session:";
  if (!lane?.startsWith(prefix)) {
    return null;
  }
  const sessionKey = lane.slice(prefix.length).trim();
  return sessionKey || null;
}

function attachSelectedLaneWaitHint(
  snapshot: QueueHealthResult,
  params: QueueHealthParams,
): QueueHealthResult {
  const requestedLane = params.lane?.trim();
  const sessionKey = resolveSessionKeyFromQueueLane(requestedLane);
  if (!requestedLane || !sessionKey) {
    return snapshot;
  }
  const laneIndex = snapshot.lanes.findIndex((lane) => lane.lane === requestedLane);
  if (laneIndex === -1) {
    return snapshot;
  }

  try {
    const { entry, storePath } = loadSessionEntry(sessionKey);
    if (!entry?.sessionId) {
      return snapshot;
    }
    const waitStatus = readLatestSessionsYieldStatusFromTranscript(
      entry.sessionId,
      storePath,
      entry.sessionFile,
    );
    if (!waitStatus) {
      return snapshot;
    }
    const lane = snapshot.lanes[laneIndex];
    const lanes = snapshot.lanes.slice();
    lanes[laneIndex] = {
      ...lane,
      waitHint: {
        code: "sessions_yield",
        label: "Waiting on agent",
        detail: waitStatus.message,
        observedAt: waitStatus.observedAt,
      },
    };
    return { ...snapshot, lanes };
  } catch {
    return snapshot;
  }
}

export const queueHandlers: GatewayRequestHandlers = {
  "queue.health": ({ params, respond }) => {
    if (!assertValidParams(params, validateQueueHealthParams, "queue.health", respond)) {
      return;
    }
    const snapshot = getCommandQueueSnapshot(params);
    respond(true, attachSelectedLaneWaitHint(snapshot, params), undefined);
  },
};
