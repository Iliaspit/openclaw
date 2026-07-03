import { describe, expect, it, vi } from "vitest";
import { loadQueueHealth, type QueueHealthState } from "./queue.ts";

describe("loadQueueHealth", () => {
  it("requests queue health for the selected session lane only", async () => {
    const request = vi.fn(async () => ({
      ts: 123,
      gatewayDraining: false,
      totalQueued: 0,
      totalActive: 0,
      totalDepth: 0,
      totalRuntimeIssues: 0,
      runtimeIssues: [],
      lanes: [],
    }));
    const state: QueueHealthState = {
      client: { request } as never,
      connected: true,
      sessionKey: "agent:planner-4:main",
      queueHealthLoading: false,
      queueHealthError: null,
      queueHealthResult: null,
    };

    await loadQueueHealth(state);

    expect(request).toHaveBeenCalledWith("queue.health", {
      lane: "session:agent:planner-4:main",
    });
  });
});
