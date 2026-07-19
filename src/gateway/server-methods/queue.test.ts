import { beforeEach, describe, expect, it, vi } from "vitest";
import { queueHandlers } from "./queue.js";

const {
  getCommandQueueSnapshotMock,
  loadSessionEntryMock,
  readLatestSessionsYieldStatusFromTranscriptMock,
} = vi.hoisted(() => ({
  getCommandQueueSnapshotMock: vi.fn(),
  loadSessionEntryMock: vi.fn(),
  readLatestSessionsYieldStatusFromTranscriptMock: vi.fn(),
}));

vi.mock("../../process/command-queue.js", () => ({
  getCommandQueueSnapshot: getCommandQueueSnapshotMock,
}));

vi.mock("../session-utils.js", () => ({
  loadSessionEntry: loadSessionEntryMock,
  readLatestSessionsYieldStatusFromTranscript: readLatestSessionsYieldStatusFromTranscriptMock,
}));

describe("queueHandlers", () => {
  beforeEach(() => {
    getCommandQueueSnapshotMock.mockReset();
    loadSessionEntryMock.mockReset();
    readLatestSessionsYieldStatusFromTranscriptMock.mockReset();
  });

  it("returns a command queue snapshot", async () => {
    getCommandQueueSnapshotMock.mockReturnValueOnce({
      ts: 123,
      gatewayDraining: false,
      totalQueued: 1,
      totalActive: 1,
      totalDepth: 2,
      totalRuntimeIssues: 0,
      runtimeIssues: [],
      lanes: [],
    });
    const respond = vi.fn();

    await queueHandlers["queue.health"]({
      params: {},
      respond,
    } as never);

    expect(getCommandQueueSnapshotMock).toHaveBeenCalledWith({});
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        ts: 123,
        gatewayDraining: false,
        totalQueued: 1,
        totalActive: 1,
        totalDepth: 2,
        totalRuntimeIssues: 0,
        runtimeIssues: [],
        lanes: [],
      },
      undefined,
    );
  });

  it("attaches a selected-lane wait hint from the latest sessions_yield status", async () => {
    getCommandQueueSnapshotMock.mockReturnValueOnce({
      ts: 123,
      gatewayDraining: false,
      totalQueued: 0,
      totalActive: 0,
      totalDepth: 0,
      totalRuntimeIssues: 0,
      runtimeIssues: [],
      lanes: [
        {
          lane: "session:agent:planner-4:main",
          health: "idle",
          queued: 0,
          active: 0,
          depth: 0,
          maxConcurrent: 1,
          isOverloaded: false,
          draining: false,
          oldestQueuedAt: null,
          oldestQueuedMs: null,
          oldestActiveStartedAt: null,
          oldestActiveMs: null,
          lastWaitMs: null,
          lastDequeuedAt: null,
          lastTaskDurationMs: null,
          lastCompletedAt: null,
          lastErrorAt: null,
          lastClearedAt: null,
          runtimeIssues: [],
        },
      ],
    });
    loadSessionEntryMock.mockReturnValueOnce({
      entry: {
        sessionId: "session-planner-4",
        sessionFile: "/tmp/session-planner-4.jsonl",
      },
      storePath: "/tmp/sessions.json",
    });
    readLatestSessionsYieldStatusFromTranscriptMock.mockReturnValueOnce({
      message: "Current status: waiting for tester.",
      observedAt: 100,
    });
    const respond = vi.fn();

    await queueHandlers["queue.health"]({
      params: { lane: "session:agent:planner-4:main" },
      respond,
    } as never);

    expect(getCommandQueueSnapshotMock).toHaveBeenCalledWith({
      lane: "session:agent:planner-4:main",
    });
    expect(loadSessionEntryMock).toHaveBeenCalledWith("agent:planner-4:main");
    expect(readLatestSessionsYieldStatusFromTranscriptMock).toHaveBeenCalledWith(
      "session-planner-4",
      "/tmp/sessions.json",
      "/tmp/session-planner-4.jsonl",
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        lanes: [
          expect.objectContaining({
            lane: "session:agent:planner-4:main",
            waitHint: {
              code: "sessions_yield",
              label: "Waiting on agent",
              detail: "Current status: waiting for tester.",
              observedAt: 100,
            },
          }),
        ],
      }),
      undefined,
    );
  });

  it("rejects invalid params", async () => {
    const respond = vi.fn();

    await queueHandlers["queue.health"]({
      params: { extra: true },
      respond,
    } as never);

    expect(getCommandQueueSnapshotMock).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: expect.any(String) }),
    );
  });
});
