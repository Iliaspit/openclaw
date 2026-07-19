import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitAgentEvent } from "../infra/agent-events.js";
import {
  recordChildRouteHealthEvent,
  resetChildRouteHealthForTest,
  resolveChildRouteHealthPath,
} from "./child-route-health.js";
import "./test-helpers/fast-core-tools.js";
import {
  getCallGatewayMock,
  getSessionsSpawnTool,
  resetSessionsSpawnAnnounceFlowOverride,
  resetSessionsSpawnCaptureReplyOverride,
  resetSessionsSpawnConfigOverride,
  resetSessionsSpawnHookRunnerOverride,
  setSessionsSpawnCaptureReplyOverride,
  setSessionsSpawnHookRunnerOverride,
  setupSessionsSpawnGatewayMock,
  setSessionsSpawnConfigOverride,
} from "./openclaw-tools.subagents.sessions-spawn.test-harness.js";
import {
  getSubagentSliceBudgetForTests,
  getLatestSubagentRunByChildSessionKey,
  resetSubagentRegistryForTests,
} from "./subagent-registry.js";

const fastModeEnv = vi.hoisted(() => {
  const previous = process.env.OPENCLAW_TEST_FAST;
  process.env.OPENCLAW_TEST_FAST = "1";
  return { previous };
});

const hookRunnerMocks = vi.hoisted(() => ({
  runSubagentSpawning: vi.fn(async (event: unknown) => {
    const input = event as {
      threadRequested?: boolean;
    };
    if (!input.threadRequested) {
      return undefined;
    }
    return {
      status: "ok" as const,
      threadBindingReady: true,
    };
  }),
  runSubagentSpawned: vi.fn(async () => {}),
  runSubagentEnded: vi.fn(async () => {}),
}));

vi.mock("./pi-embedded.js", async () => {
  const actual = await vi.importActual<typeof import("./pi-embedded.js")>("./pi-embedded.js");
  return {
    ...actual,
    isEmbeddedPiRunActive: () => false,
    isEmbeddedPiRunStreaming: () => false,
    queueEmbeddedPiMessage: () => false,
    waitForEmbeddedPiRunEnd: async () => true,
  };
});

vi.mock("./subagent-output-latest-reply.js", () => ({
  readLatestAssistantReply: async () => "done",
}));

const callGatewayMock = getCallGatewayMock();
const RUN_TIMEOUT_SECONDS = 1;
const originalStateDir = process.env.OPENCLAW_STATE_DIR;
let tempStateDir: string | undefined;

function buildDiscordCleanupHooks(onDelete: (key: string | undefined) => void) {
  return {
    onAgentSubagentSpawn: (params: unknown) => {
      const rec = params as { channel?: string; timeout?: number } | undefined;
      expect(rec?.channel).toBe("discord");
      expect(rec?.timeout).toBe(1);
    },
    onSessionsDelete: (params: unknown) => {
      const rec = params as { key?: string } | undefined;
      onDelete(rec?.key);
    },
  };
}

const waitFor = async (label: string, predicate: () => boolean, timeoutMs = 30_000) => {
  await vi.waitFor(
    () => {
      expect(predicate(), label).toBe(true);
    },
    { timeout: timeoutMs, interval: 20 },
  );
};

async function getDiscordGroupSpawnTool() {
  return await getSessionsSpawnTool({
    agentSessionKey: "discord:group:req",
    agentChannel: "discord",
  });
}

async function executeSpawnAndExpectAccepted(params: {
  tool: Awaited<ReturnType<typeof getSessionsSpawnTool>>;
  callId: string;
  cleanup?: "delete" | "keep";
  label?: string;
  expectsCompletionMessage?: boolean;
}) {
  const result = await params.tool.execute(params.callId, {
    task: "do thing",
    runTimeoutSeconds: RUN_TIMEOUT_SECONDS,
    ...(params.cleanup ? { cleanup: params.cleanup } : {}),
    ...(params.label ? { label: params.label } : {}),
    ...(params.expectsCompletionMessage === false ? { expectsCompletionMessage: false } : {}),
  });
  if ((result.details as { status?: unknown }).status !== "accepted") {
    throw new Error(
      `expected accepted spawn, received ${JSON.stringify(result.details, null, 2)}`,
    );
  }
  expect(result.details).toMatchObject({
    status: "accepted",
    runId: expect.any(String),
  });
  return result;
}

async function emitLifecycleEndAndFlush(params: {
  runId: string;
  startedAt: number;
  endedAt: number;
}) {
  vi.useFakeTimers();
  try {
    emitAgentEvent({
      runId: params.runId,
      stream: "lifecycle",
      data: {
        phase: "end",
        startedAt: params.startedAt,
        endedAt: params.endedAt,
      },
    });

    await vi.runAllTimersAsync();
  } finally {
    vi.useRealTimers();
  }
}

async function waitForRunCleanup(childSessionKey: string) {
  await waitFor("run cleanup bookkeeping", () => {
    const run = getLatestSubagentRunByChildSessionKey(childSessionKey);
    return run?.cleanupCompletedAt != null;
  });
}

describe("openclaw-tools: subagents (sessions_spawn lifecycle)", () => {
  beforeEach(async () => {
    tempStateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-sessions-spawn-lifecycle-"),
    );
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    resetChildRouteHealthForTest();
    resetSessionsSpawnAnnounceFlowOverride();
    resetSessionsSpawnCaptureReplyOverride();
    resetSessionsSpawnHookRunnerOverride();
    resetSessionsSpawnConfigOverride();
    setSessionsSpawnConfigOverride({
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
      messages: {
        queue: {
          debounceMs: 0,
        },
      },
    });
    resetSubagentRegistryForTests({ persist: false });
    hookRunnerMocks.runSubagentSpawning.mockClear();
    hookRunnerMocks.runSubagentSpawned.mockClear();
    hookRunnerMocks.runSubagentEnded.mockClear();
    setSessionsSpawnHookRunnerOverride({
      hasHooks: (hookName: string) =>
        hookName === "subagent_spawning" ||
        hookName === "subagent_spawned" ||
        hookName === "subagent_ended",
      runSubagentSpawning: hookRunnerMocks.runSubagentSpawning,
      runSubagentSpawned: hookRunnerMocks.runSubagentSpawned,
      runSubagentEnded: hookRunnerMocks.runSubagentEnded,
    });
    callGatewayMock.mockClear();
  });

  afterEach(async () => {
    resetSessionsSpawnAnnounceFlowOverride();
    resetSessionsSpawnCaptureReplyOverride();
    resetSessionsSpawnHookRunnerOverride();
    resetSessionsSpawnConfigOverride();
    resetSubagentRegistryForTests({ persist: false });
    resetChildRouteHealthForTest();
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    if (tempStateDir) {
      await fs.rm(tempStateDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
      tempStateDir = undefined;
    }
  });

  afterAll(() => {
    if (fastModeEnv.previous === undefined) {
      delete process.env.OPENCLAW_TEST_FAST;
      return;
    }
    process.env.OPENCLAW_TEST_FAST = fastModeEnv.previous;
  });

  it("sessions_spawn runs cleanup flow after subagent completion", async () => {
    const patchCalls: Array<{ key?: string; label?: string }> = [];

    const ctx = setupSessionsSpawnGatewayMock({
      includeSessionsList: true,
      includeChatHistory: true,
      onSessionsPatch: (params) => {
        const rec = params as { key?: string; label?: string } | undefined;
        patchCalls.push({ key: rec?.key, label: rec?.label });
      },
    });

    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
    });

    await executeSpawnAndExpectAccepted({
      tool,
      callId: "call2",
      label: "my-task",
    });

    const child = ctx.getChild();
    if (!child.runId) {
      throw new Error("missing child runId");
    }
    await waitFor(
      "subagent wait, label patch, and main agent trigger",
      () =>
        ctx.waitCalls.some((call) => call.runId === child.runId) &&
        patchCalls.some((call) => call.label === "my-task") &&
        ctx.calls.filter((call) => call.method === "agent").length >= 2,
    );
    if (!child.sessionKey) {
      throw new Error("missing child sessionKey");
    }
    await waitForRunCleanup(child.sessionKey);

    const childWait = ctx.waitCalls.find((call) => call.runId === child.runId);
    expect(childWait?.timeoutMs).toBe(1000);
    // Cleanup should patch the label
    const labelPatch = patchCalls.find((call) => call.label === "my-task");
    expect(labelPatch?.key).toBe(child.sessionKey);
    expect(labelPatch?.label).toBe("my-task");

    // Two agent calls: subagent spawn + main agent trigger
    const agentCalls = ctx.calls.filter((c) => c.method === "agent");
    expect(agentCalls).toHaveLength(2);

    // First call: subagent spawn
    const first = agentCalls[0]?.params as { lane?: string } | undefined;
    expect(first?.lane).toBe("subagent");

    // Second call: main agent trigger (not "Sub-agent announce step." anymore)
    const second = agentCalls[1]?.params as { sessionKey?: string; message?: string } | undefined;
    expect(second?.sessionKey).toBe("agent:main:main");
    expect(second?.message).toContain("subagent task");

    // No direct send to external channel (main agent handles delivery)
    const sendCalls = ctx.calls.filter((c) => c.method === "send");
    expect(sendCalls.length).toBe(0);
    expect(child.sessionKey?.startsWith("agent:main:subagent:")).toBe(true);
  });

  it("sessions_spawn runs cleanup via lifecycle events", async () => {
    let deletedKey: string | undefined;
    const ctx = setupSessionsSpawnGatewayMock({
      ...buildDiscordCleanupHooks((key) => {
        deletedKey = key;
      }),
    });

    const tool = await getDiscordGroupSpawnTool();
    await executeSpawnAndExpectAccepted({
      tool,
      callId: "call1",
      cleanup: "delete",
    });

    const child = ctx.getChild();
    if (!child.runId) {
      throw new Error("missing child runId");
    }
    await emitLifecycleEndAndFlush({
      runId: child.runId,
      startedAt: 1234,
      endedAt: 2345,
    });

    await waitFor(
      "lifecycle cleanup",
      () => ctx.calls.filter((call) => call.method === "agent").length >= 2 && Boolean(deletedKey),
    );

    const childWait = ctx.waitCalls.find((call) => call.runId === child.runId);
    expect(childWait?.timeoutMs).toBe(1000);

    const agentCalls = ctx.calls.filter((call) => call.method === "agent");
    expect(agentCalls).toHaveLength(2);

    const first = agentCalls[0]?.params as
      | {
          lane?: string;
          deliver?: boolean;
          sessionKey?: string;
          channel?: string;
        }
      | undefined;
    expect(first?.lane).toBe("subagent");
    expect(first?.deliver).toBe(false);
    expect(first?.channel).toBe("discord");
    expect(first?.sessionKey?.startsWith("agent:main:subagent:")).toBe(true);
    expect(child.sessionKey?.startsWith("agent:main:subagent:")).toBe(true);

    const second = agentCalls[1]?.params as
      | {
          sessionKey?: string;
          message?: string;
          deliver?: boolean;
        }
      | undefined;
    expect(second?.sessionKey).toBe("agent:main:discord:group:req");
    expect(second?.deliver).toBe(false);
    expect(second?.message).toContain("subagent task");

    const sendCalls = ctx.calls.filter((c) => c.method === "send");
    expect(sendCalls.length).toBe(0);

    expect(deletedKey?.startsWith("agent:main:subagent:")).toBe(true);
  });

  it("sessions_spawn deletes session when cleanup=delete via agent.wait", async () => {
    let deletedKey: string | undefined;
    const ctx = setupSessionsSpawnGatewayMock({
      includeChatHistory: true,
      ...buildDiscordCleanupHooks((key) => {
        deletedKey = key;
      }),
      agentWaitResult: { status: "ok", startedAt: 3000, endedAt: 4000 },
    });

    const tool = await getDiscordGroupSpawnTool();
    await executeSpawnAndExpectAccepted({
      tool,
      callId: "call1b",
      cleanup: "delete",
    });

    const child = ctx.getChild();
    if (!child.runId) {
      throw new Error("missing child runId");
    }
    await waitFor("agent.wait called for child run", () =>
      ctx.waitCalls.some((call) => call.runId === child.runId),
    );
    await waitFor(
      "main agent cleanup trigger",
      () => ctx.calls.filter((call) => call.method === "agent").length >= 2,
    );
    await waitFor("delete cleanup", () => Boolean(deletedKey));

    const childWait = ctx.waitCalls.find((call) => call.runId === child.runId);
    expect(childWait?.timeoutMs).toBe(1000);
    expect(child.sessionKey?.startsWith("agent:main:subagent:")).toBe(true);

    // Two agent calls: subagent spawn + main agent trigger
    const agentCalls = ctx.calls.filter((call) => call.method === "agent");
    expect(agentCalls).toHaveLength(2);

    // First call: subagent spawn
    const first = agentCalls[0]?.params as { lane?: string } | undefined;
    expect(first?.lane).toBe("subagent");

    // Second call: main agent trigger
    const second = agentCalls[1]?.params as { sessionKey?: string; deliver?: boolean } | undefined;
    expect(second?.sessionKey).toBe("agent:main:discord:group:req");
    expect(second?.deliver).toBe(false);

    // No direct send to external channel (main agent handles delivery)
    const sendCalls = ctx.calls.filter((c) => c.method === "send");
    expect(sendCalls.length).toBe(0);

    // Session should be deleted
    expect(deletedKey?.startsWith("agent:main:subagent:")).toBe(true);
  });

  it("sessions_spawn records timeout when agent.wait returns timeout", async () => {
    const ctx = setupSessionsSpawnGatewayMock({
      includeChatHistory: true,
      chatHistoryText: "still working",
      agentWaitResult: { status: "timeout", startedAt: 6000, endedAt: 7000 },
    });

    const tool = await getDiscordGroupSpawnTool();
    await executeSpawnAndExpectAccepted({
      tool,
      callId: "call-timeout",
      cleanup: "keep",
      expectsCompletionMessage: false,
    });

    const child = ctx.getChild();
    if (!child.runId) {
      throw new Error("missing child runId");
    }
    if (!child.sessionKey) {
      throw new Error("missing child sessionKey");
    }
    const childSessionKey = child.sessionKey;

    await waitFor(
      "timeout outcome",
      () =>
        ctx.waitCalls.some((call) => call.runId === child.runId) &&
        getLatestSubagentRunByChildSessionKey(childSessionKey)?.outcome?.status === "timeout",
      20_000,
    );
    await waitForRunCleanup(childSessionKey);

    const childWait = ctx.waitCalls.find((call) => call.runId === child.runId);
    expect(childWait?.timeoutMs).toBe(1000);
    expect(getLatestSubagentRunByChildSessionKey(childSessionKey)?.outcome?.status).toBe("timeout");
  });

  it("sessions_spawn blocks a same-slice child after two timeout outcomes", async () => {
    const ctx = setupSessionsSpawnGatewayMock({
      includeChatHistory: true,
      chatHistoryText: "still working",
      agentWaitResult: { status: "timeout", startedAt: 6000, endedAt: 7000 },
    });

    const tool = await getDiscordGroupSpawnTool();
    const spawnSameSlice = async (callId: string) =>
      await tool.execute(callId, {
        task: "recover the Contract V2 E2E gate",
        label: "contract-v2-recovery",
        runTimeoutSeconds: RUN_TIMEOUT_SECONDS,
        cleanup: "keep",
        expectsCompletionMessage: false,
      });

    const first = await spawnSameSlice("call-timeout-budget-1");
    expect(first.details).toMatchObject({ status: "accepted" });
    const firstChild = ctx.getChild();
    if (!firstChild.runId || !firstChild.sessionKey) {
      throw new Error("missing first child sessionKey");
    }
    await waitFor(
      "first timeout budget evidence",
      () =>
        getLatestSubagentRunByChildSessionKey(firstChild.sessionKey)?.outcome?.status ===
        "timeout",
      20_000,
    );
    await waitForRunCleanup(firstChild.sessionKey);

    const second = await spawnSameSlice("call-timeout-budget-2");
    expect(second.details).toMatchObject({ status: "accepted" });
    const secondChild = ctx.getChild();
    if (!secondChild.runId || !secondChild.sessionKey) {
      throw new Error("missing second child sessionKey");
    }
    await waitFor(
      "second timeout budget evidence",
      () =>
        getLatestSubagentRunByChildSessionKey(secondChild.sessionKey)?.outcome?.status ===
        "timeout",
      20_000,
    );
    await waitForRunCleanup(secondChild.sessionKey);

    const third = await spawnSameSlice("call-timeout-budget-3");
    expect(third.details).toMatchObject({
      status: "error",
      error: expect.stringContaining("Subagent slice budget exhausted"),
    });
    const blockerError = String((third.details as { error?: unknown }).error);
    expect(blockerError).toContain(firstChild.runId);
    expect(blockerError).toContain(secondChild.runId);
    const subagentAgentCalls = ctx.calls.filter((call) => {
      const params = call.params as { lane?: string } | undefined;
      return call.method === "agent" && params?.lane === "subagent";
    });
    expect(subagentAgentCalls).toHaveLength(2);
  });

  it("sessions_spawn escalates repeated route-health unavailable preflight failures", async () => {
    const ctx = setupSessionsSpawnGatewayMock({});
    const healthPath = resolveChildRouteHealthPath();
    await fs.mkdir(path.dirname(healthPath), { recursive: true });
    await fs.writeFile(healthPath, "{not-json", "utf8");
    const failedHealthWrite = await recordChildRouteHealthEvent({
      code: "context_overflow",
      status: "active",
      source: "context_overflow",
      reason: "route-health store is unavailable during spawn preflight",
    });
    expect(failedHealthWrite).toEqual(expect.objectContaining({ ok: false }));
    await fs.rm(healthPath, { force: true });

    const tool = await getDiscordGroupSpawnTool();
    const spawnSameSlice = async (callId: string) =>
      await tool.execute(callId, {
        task: "recover the Contract V2 E2E gate",
        label: "contract-v2-recovery",
        runTimeoutSeconds: RUN_TIMEOUT_SECONDS,
        cleanup: "keep",
        expectsCompletionMessage: false,
      });

    const first = await spawnSameSlice("call-route-health-budget-1");
    expect(first.details).toMatchObject({
      status: "error",
      error: expect.stringContaining("Auth route health is unavailable"),
    });

    const second = await spawnSameSlice("call-route-health-budget-2");
    expect(second.details).toMatchObject({
      status: "error",
      error: expect.stringContaining("Subagent route/system health blocker"),
    });
    const blockerError = String((second.details as { error?: unknown }).error);
    expect(blockerError).toContain("childRouteHealthUnavailableCount=2");
    expect(blockerError).toContain("routeHealthUnavailableChildSessionKeys=");

    const subagentAgentCalls = ctx.calls.filter((call) => {
      const params = call.params as { lane?: string } | undefined;
      return call.method === "agent" && params?.lane === "subagent";
    });
    expect(subagentAgentCalls).toHaveLength(0);
  });

  it("sessions_spawn opens a bounded review follow-up slice after a green full gate", async () => {
    const ctx = setupSessionsSpawnGatewayMock({});
    setSessionsSpawnCaptureReplyOverride(async () => "full gate passed");
    const tool = await getDiscordGroupSpawnTool();
    const sharedTask = "recover the Contract V2 E2E gate";
    const sharedLabel = "contract-v2-recovery";

    const fullGate = await tool.execute("call-full-gate-budget", {
      task: sharedTask,
      label: sharedLabel,
      sliceRole: "full_gate",
      runTimeoutSeconds: RUN_TIMEOUT_SECONDS,
      cleanup: "keep",
    });
    expect(fullGate.details).toMatchObject({ status: "accepted" });
    const fullGateChild = ctx.getChild();
    if (!fullGateChild.sessionKey) {
      throw new Error("missing full-gate child sessionKey");
    }

    await waitFor("full-gate green slice marker", () => {
      const run = getLatestSubagentRunByChildSessionKey(fullGateChild.sessionKey);
      const budget = run?.sliceBudgetKey
        ? getSubagentSliceBudgetForTests(run.sliceBudgetKey)
        : undefined;
      return run?.outcome?.status === "ok" && budget?.fullE2EGateGreen === true;
    });
    const fullGateRun = getLatestSubagentRunByChildSessionKey(fullGateChild.sessionKey);
    const originalSliceKey = fullGateRun?.sliceBudgetKey;
    if (!originalSliceKey) {
      throw new Error("missing original slice budget key");
    }

    const review = await tool.execute("call-review-followup-budget", {
      task: sharedTask,
      label: sharedLabel,
      sliceRole: "review",
      runTimeoutSeconds: RUN_TIMEOUT_SECONDS,
      cleanup: "keep",
    });
    expect(review.details).toMatchObject({ status: "accepted" });
    const reviewChild = ctx.getChild();
    if (!reviewChild.sessionKey) {
      throw new Error("missing review child sessionKey");
    }

    await waitFor("post-green review follow-up slice", () => {
      const run = getLatestSubagentRunByChildSessionKey(reviewChild.sessionKey);
      const budget = run?.sliceBudgetKey
        ? getSubagentSliceBudgetForTests(run.sliceBudgetKey)
        : undefined;
      return (
        run?.sliceBudgetKey !== originalSliceKey &&
        budget?.sliceBoundary === "post_full_gate_followup" &&
        budget?.sliceRole === "review" &&
        budget?.parentSliceKey === originalSliceKey
      );
    });
  });

  it("sessions_spawn announces with requester accountId", async () => {
    const ctx = setupSessionsSpawnGatewayMock({});

    const tool = await getSessionsSpawnTool({
      agentSessionKey: "main",
      agentChannel: "whatsapp",
      agentAccountId: "kev",
    });

    await executeSpawnAndExpectAccepted({
      tool,
      callId: "call-announce-account",
      cleanup: "keep",
    });

    const child = ctx.getChild();
    if (!child.runId) {
      throw new Error("missing child runId");
    }
    if (!child.sessionKey) {
      throw new Error("missing child sessionKey");
    }
    await emitLifecycleEndAndFlush({
      runId: child.runId,
      startedAt: 1000,
      endedAt: 2000,
    });

    await waitFor(
      "account-aware lifecycle announce",
      () => ctx.calls.filter((call) => call.method === "agent").length >= 2,
    );
    await waitForRunCleanup(child.sessionKey);

    const agentCalls = ctx.calls.filter((call) => call.method === "agent");
    expect(agentCalls).toHaveLength(2);
    const announceParams = agentCalls[1]?.params as
      | { accountId?: string; channel?: string; deliver?: boolean }
      | undefined;
    expect(announceParams?.deliver).toBe(false);
    expect(announceParams?.channel).toBeUndefined();
    expect(announceParams?.accountId).toBeUndefined();
  });
});
