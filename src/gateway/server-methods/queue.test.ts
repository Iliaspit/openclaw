import { beforeEach, describe, expect, it, vi } from "vitest";
import { queueHandlers } from "./queue.js";

const { getCommandQueueSnapshotMock } = vi.hoisted(() => ({
  getCommandQueueSnapshotMock: vi.fn(),
}));

vi.mock("../../process/command-queue.js", () => ({
  getCommandQueueSnapshot: getCommandQueueSnapshotMock,
}));

describe("queueHandlers", () => {
  beforeEach(() => {
    getCommandQueueSnapshotMock.mockReset();
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
