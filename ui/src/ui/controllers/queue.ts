import type { GatewayBrowserClient } from "../gateway.ts";
import type { QueueHealthResult } from "../types.ts";

export type QueueHealthState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionKey?: string | null;
  queueHealthLoading: boolean;
  queueHealthError: string | null;
  queueHealthResult: QueueHealthResult | null;
};

function resolveQueueLaneKey(sessionKey: string | null | undefined): string {
  const trimmed = sessionKey?.trim() || "main";
  return trimmed.startsWith("session:") ? trimmed : `session:${trimmed}`;
}

export async function loadQueueHealth(
  state: QueueHealthState,
  opts?: { quiet?: boolean },
): Promise<void> {
  if (!state.client || !state.connected) {
    return;
  }
  if (!opts?.quiet) {
    state.queueHealthLoading = true;
    state.queueHealthError = null;
  }
  try {
    state.queueHealthResult = await state.client.request<QueueHealthResult>("queue.health", {
      lane: resolveQueueLaneKey(state.sessionKey),
    });
    state.queueHealthError = null;
  } catch (err) {
    if (!opts?.quiet) {
      state.queueHealthError = String(err);
    }
  } finally {
    if (!opts?.quiet) {
      state.queueHealthLoading = false;
    }
  }
}
