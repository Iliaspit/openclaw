import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  callGatewayMock,
  resetSubagentsConfigOverride,
  setSubagentsConfigOverride,
} from "./openclaw-tools.subagents.test-harness.js";
import { addSubagentRunForTests, resetSubagentRegistryForTests } from "./subagent-registry.js";
import "./test-helpers/fast-core-tools.js";
import { createPerSenderSessionConfig } from "./test-helpers/session-config.js";
import { createSubagentsTool } from "./tools/subagents-tool.js";

function writeStore(storePath: string, store: Record<string, unknown>) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2), "utf-8");
}

function seedLeafOwnedChildSession(storePath: string, leafKey = "agent:main:subagent:leaf") {
  const childKey = `${leafKey}:subagent:child`;
  writeStore(storePath, {
    [leafKey]: {
      sessionId: "leaf-session",
      updatedAt: Date.now(),
      spawnedBy: "agent:main:main",
      subagentRole: "leaf",
      subagentControlScope: "none",
    },
    [childKey]: {
      sessionId: "child-session",
      updatedAt: Date.now(),
      spawnedBy: leafKey,
      subagentRole: "leaf",
      subagentControlScope: "none",
    },
  });

  addSubagentRunForTests({
    runId: "run-child",
    childSessionKey: childKey,
    controllerSessionKey: leafKey,
    requesterSessionKey: leafKey,
    requesterDisplayKey: leafKey,
    task: "impossible child",
    cleanup: "keep",
    createdAt: Date.now() - 30_000,
    startedAt: Date.now() - 30_000,
  });

  return {
    childKey,
    tool: createSubagentsTool({ agentSessionKey: leafKey }),
  };
}

async function expectLeafSubagentControlForbidden(params: {
  storePath: string;
  action: "kill" | "steer";
  callId: string;
  message?: string;
}) {
  const { childKey, tool } = seedLeafOwnedChildSession(params.storePath);
  const result = await tool.execute(params.callId, {
    action: params.action,
    target: childKey,
    ...(params.message ? { message: params.message } : {}),
  });

  expect(result.details).toMatchObject({
    status: "forbidden",
    error: "Leaf subagents cannot control other sessions.",
  });
  expect(callGatewayMock).not.toHaveBeenCalled();
}

describe("openclaw-tools: subagents scope isolation", () => {
  let storePath = "";

  beforeEach(() => {
    resetSubagentRegistryForTests();
    resetSubagentsConfigOverride();
    callGatewayMock.mockReset();
    storePath = path.join(
      os.tmpdir(),
      `openclaw-subagents-scope-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
    );
    setSubagentsConfigOverride({
      session: createPerSenderSessionConfig({ store: storePath }),
    });
    writeStore(storePath, {});
  });

  it("leaf subagents do not inherit parent sibling control scope", async () => {
    const leafKey = "agent:main:subagent:leaf";
    const siblingKey = "agent:main:subagent:unsandboxed";

    writeStore(storePath, {
      [leafKey]: {
        sessionId: "leaf-session",
        updatedAt: Date.now(),
        spawnedBy: "agent:main:main",
      },
      [siblingKey]: {
        sessionId: "sibling-session",
        updatedAt: Date.now(),
        spawnedBy: "agent:main:main",
      },
    });

    addSubagentRunForTests({
      runId: "run-leaf",
      childSessionKey: leafKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "sandboxed leaf",
      cleanup: "keep",
      createdAt: Date.now() - 30_000,
      startedAt: Date.now() - 30_000,
    });
    addSubagentRunForTests({
      runId: "run-sibling",
      childSessionKey: siblingKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "unsandboxed sibling",
      cleanup: "keep",
      createdAt: Date.now() - 20_000,
      startedAt: Date.now() - 20_000,
    });

    const tool = createSubagentsTool({ agentSessionKey: leafKey });
    const result = await tool.execute("call-leaf-list", { action: "list" });

    expect(result.details).toMatchObject({
      status: "ok",
      requesterSessionKey: leafKey,
      callerSessionKey: leafKey,
      callerIsSubagent: true,
      total: 0,
      active: [],
      recent: [],
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("orchestrator subagents still see children they spawned", async () => {
    const orchestratorKey = "agent:main:subagent:orchestrator";
    const workerKey = `${orchestratorKey}:subagent:worker`;
    const siblingKey = "agent:main:subagent:sibling";

    writeStore(storePath, {
      [orchestratorKey]: {
        sessionId: "orchestrator-session",
        updatedAt: Date.now(),
        spawnedBy: "agent:main:main",
      },
      [workerKey]: {
        sessionId: "worker-session",
        updatedAt: Date.now(),
        spawnedBy: orchestratorKey,
      },
      [siblingKey]: {
        sessionId: "sibling-session",
        updatedAt: Date.now(),
        spawnedBy: "agent:main:main",
      },
    });

    addSubagentRunForTests({
      runId: "run-worker",
      childSessionKey: workerKey,
      requesterSessionKey: orchestratorKey,
      requesterDisplayKey: orchestratorKey,
      task: "worker child",
      cleanup: "keep",
      createdAt: Date.now() - 30_000,
      startedAt: Date.now() - 30_000,
    });
    addSubagentRunForTests({
      runId: "run-sibling",
      childSessionKey: siblingKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "sibling of orchestrator",
      cleanup: "keep",
      createdAt: Date.now() - 20_000,
      startedAt: Date.now() - 20_000,
    });

    const tool = createSubagentsTool({ agentSessionKey: orchestratorKey });
    const result = await tool.execute("call-orchestrator-list", { action: "list" });
    const details = result.details as {
      status?: string;
      requesterSessionKey?: string;
      total?: number;
      active?: Array<{ sessionKey?: string }>;
    };

    expect(details.status).toBe("ok");
    expect(details.requesterSessionKey).toBe(orchestratorKey);
    expect(details.total).toBe(1);
    expect(details.active).toEqual([
      expect.objectContaining({
        sessionKey: workerKey,
      }),
    ]);
  });

  it("leaf subagents cannot kill even explicitly-owned child sessions", async () => {
    await expectLeafSubagentControlForbidden({
      storePath,
      action: "kill",
      callId: "call-leaf-kill",
    });
  });

  it("leaf subagents cannot steer even explicitly-owned child sessions", async () => {
    await expectLeafSubagentControlForbidden({
      storePath,
      action: "steer",
      callId: "call-leaf-steer",
      message: "continue",
    });
  });

  it("top-level orchestrators can compact a controlled child through sessions.compact", async () => {
    const childKey = "agent:main:subagent:worker";
    writeStore(storePath, {
      [childKey]: {
        sessionId: "worker-session",
        updatedAt: Date.now(),
        spawnedBy: "agent:main:main",
      },
    });
    addSubagentRunForTests({
      runId: "run-worker",
      childSessionKey: childKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "worker child",
      cleanup: "keep",
      createdAt: Date.now() - 30_000,
      startedAt: Date.now() - 30_000,
    });
    callGatewayMock.mockResolvedValueOnce({
      ok: true,
      key: childKey,
      compacted: true,
      routeHealthRepairStatus: "cleared",
      result: {
        checkpointId: "checkpoint-child",
        tokensBefore: 123,
        tokensAfter: 45,
      },
    });

    const tool = createSubagentsTool({ agentSessionKey: "agent:main:main" });
    const result = await tool.execute("call-compact-child", {
      action: "compact",
      target: "1",
    });

    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "sessions.compact",
      params: { key: childKey },
    });
    expect(result.details).toMatchObject({
      status: "ok",
      action: "compact",
      target: "1",
      sessionKey: childKey,
      key: childKey,
      compacted: true,
      checkpointId: "checkpoint-child",
      tokensBefore: 123,
      tokensAfter: 45,
      routeHealthRepairStatus: "cleared",
    });
  });

  it("leaf subagents cannot compact even explicitly-owned child sessions", async () => {
    const { childKey, tool } = seedLeafOwnedChildSession(storePath);
    const result = await tool.execute("call-leaf-compact", {
      action: "compact",
      target: childKey,
    });

    expect(result.details).toMatchObject({
      status: "forbidden",
      action: "compact",
      target: childKey,
      sessionKey: childKey,
      reason: "Leaf subagents cannot control other sessions.",
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("self target compacts the caller session without child ownership", async () => {
    const leafKey = "agent:main:subagent:leaf";
    writeStore(storePath, {
      [leafKey]: {
        sessionId: "leaf-session",
        updatedAt: Date.now(),
        spawnedBy: "agent:main:main",
        subagentRole: "leaf",
        subagentControlScope: "none",
      },
    });
    callGatewayMock.mockResolvedValueOnce({
      ok: true,
      key: leafKey,
      compacted: true,
      result: {
        tokensBefore: 90,
        tokensAfter: 30,
      },
    });

    const tool = createSubagentsTool({ agentSessionKey: leafKey });
    const result = await tool.execute("call-self-compact", {
      action: "compact",
      target: "self",
    });

    expect(callGatewayMock).toHaveBeenCalledTimes(1);
    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "sessions.compact",
      params: { key: leafKey },
    });
    expect(result.details).toMatchObject({
      status: "ok",
      action: "compact",
      target: "self",
      sessionKey: leafKey,
      key: leafKey,
      compacted: true,
      tokensBefore: 90,
      tokensAfter: 30,
    });
  });

  it("compact response strips nested payloads while preserving scalar compaction evidence", async () => {
    const hugeSummary = "large compaction summary ".repeat(500);
    callGatewayMock.mockResolvedValueOnce({
      ok: true,
      key: "agent:main:main",
      compacted: true,
      result: {
        checkpointId: "checkpoint-safe",
        tokensBefore: 120,
        tokensAfter: 80,
        summary: hugeSummary,
        details: {
          nested: hugeSummary,
        },
      },
    });

    const tool = createSubagentsTool({ agentSessionKey: "agent:main:main" });
    const result = await tool.execute("call-strip-compact", {
      action: "compact",
      target: "caller",
    });
    const details = result.details as Record<string, unknown>;

    expect(details).toMatchObject({
      status: "ok",
      action: "compact",
      target: "caller",
      sessionKey: "agent:main:main",
      key: "agent:main:main",
      compacted: true,
      checkpointId: "checkpoint-safe",
      tokensBefore: 120,
      tokensAfter: 80,
    });
    expect(details).not.toHaveProperty("result");
    expect(details).not.toHaveProperty("summary");
    expect(details).not.toHaveProperty("details");
    expect(JSON.stringify(details)).not.toContain(hugeSummary.slice(0, 80));
    expect(String(details.text)).not.toContain(hugeSummary.slice(0, 80));
  });
});
