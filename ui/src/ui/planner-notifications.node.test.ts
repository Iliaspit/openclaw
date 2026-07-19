// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildPlannerCompletionNotification,
  handlePlannerCompletionLifecycleEvent,
  type PlannerNotificationHost,
} from "./planner-notifications.ts";

function createHost(): PlannerNotificationHost {
  return {
    plannerCompletionNotification: null,
    plannerCompletionNotificationDismissTimer: null,
    plannerCompletionNotificationSeenIds: new Set<string>(),
  };
}

describe("planner completion notifications", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds a done notification for top-level planner lifecycle completion", () => {
    const notification = buildPlannerCompletionNotification({
      sessionKey: "agent:planner-2:main",
      phase: "end",
      runId: "run-planner-2",
      status: "done",
      runtimeMs: 123_000,
      endedAt: 1_000,
    });

    expect(notification).toMatchObject({
      id: "run:run-planner-2",
      runId: "run-planner-2",
      sessionKey: "agent:planner-2:main",
      title: "Planner 2 is done",
      body: "agent:planner-2:main - 2m 3s",
      status: "done",
      createdAt: 1_000,
    });
  });

  it("does not notify for planner-owned subagents or non-planner agents", () => {
    expect(
      buildPlannerCompletionNotification({
        sessionKey: "agent:planner-2:subagent:worker",
        phase: "end",
        runId: "run-worker",
        status: "done",
      }),
    ).toBeNull();
    expect(
      buildPlannerCompletionNotification({
        sessionKey: "agent:implementer:main",
        phase: "end",
        runId: "run-implementer",
        status: "done",
      }),
    ).toBeNull();
    expect(
      buildPlannerCompletionNotification({
        sessionKey: "agent:planner-3:main",
        parentSessionKey: "agent:planner:main",
        phase: "end",
        runId: "run-child",
        status: "done",
      }),
    ).toBeNull();
  });

  it("dedupes repeated lifecycle events by run id and auto-dismisses the toast", async () => {
    vi.useFakeTimers();
    const host = createHost();
    const payload = {
      sessionKey: "agent:planner:main",
      phase: "end",
      runId: "run-planner",
      status: "done",
    };

    expect(handlePlannerCompletionLifecycleEvent(host, payload)).toBe(true);
    expect(handlePlannerCompletionLifecycleEvent(host, payload)).toBe(false);
    expect(host.plannerCompletionNotification?.title).toBe("Planner is done");
    expect(host.plannerCompletionNotificationSeenIds.has("run:run-planner")).toBe(true);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(host.plannerCompletionNotification).toBeNull();
  });
});
