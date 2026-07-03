import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { guardChildRouteForDelivery } from "../agents/child-route-guard.js";
import {
  recordChildRouteHealthEvent,
  resetChildRouteHealthForTest,
} from "../agents/child-route-health.js";
import type { SubagentRunRecord } from "../agents/subagent-registry.types.js";
import {
  clearAgentRunContext,
  emitAgentEvent,
  getAgentRunContext,
  onAgentEvent,
  registerAgentRunContext,
  resetAgentEventsForTest,
  resetAgentRunContextForTest,
  sweepStaleRunContexts,
} from "./agent-events.js";
import { getAgentRuntimeIssues } from "./agent-runtime-health.js";

type AgentEventsModule = typeof import("./agent-events.js");

const agentEventsModuleUrl = new URL("./agent-events.ts", import.meta.url).href;

async function importAgentEventsModule(cacheBust: string): Promise<AgentEventsModule> {
  return (await import(`${agentEventsModuleUrl}?t=${cacheBust}`)) as AgentEventsModule;
}

describe("agent-events sequencing", () => {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;

  beforeEach(() => {
    resetAgentEventsForTest();
  });

  afterEach(() => {
    resetChildRouteHealthForTest();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
  });

  test("stores and clears run context", async () => {
    registerAgentRunContext("run-1", { sessionKey: "main" });
    expect(getAgentRunContext("run-1")?.sessionKey).toBe("main");
    clearAgentRunContext("run-1");
    expect(getAgentRunContext("run-1")).toBeUndefined();
  });

  test("maintains monotonic seq per runId", async () => {
    const seen: Record<string, number[]> = {};
    const stop = onAgentEvent((evt) => {
      const list = seen[evt.runId] ?? [];
      seen[evt.runId] = list;
      list.push(evt.seq);
    });

    emitAgentEvent({ runId: "run-1", stream: "lifecycle", data: {} });
    emitAgentEvent({ runId: "run-1", stream: "lifecycle", data: {} });
    emitAgentEvent({ runId: "run-2", stream: "lifecycle", data: {} });
    emitAgentEvent({ runId: "run-1", stream: "lifecycle", data: {} });

    stop();

    expect(seen["run-1"]).toEqual([1, 2, 3]);
    expect(seen["run-2"]).toEqual([1]);
  });

  test("preserves compaction ordering on the event bus", async () => {
    const phases: Array<string> = [];
    const stop = onAgentEvent((evt) => {
      if (evt.runId !== "run-1") {
        return;
      }
      if (evt.stream !== "compaction") {
        return;
      }
      if (typeof evt.data?.phase === "string") {
        phases.push(evt.data.phase);
      }
    });

    emitAgentEvent({ runId: "run-1", stream: "compaction", data: { phase: "start" } });
    emitAgentEvent({
      runId: "run-1",
      stream: "compaction",
      data: { phase: "end", willRetry: false },
    });

    stop();

    expect(phases).toEqual(["start", "end"]);
  });

  test("records context overflow lifecycle errors as runtime health issues", async () => {
    registerAgentRunContext("run-overflow", { sessionKey: "agent:planner-4:main" });

    emitAgentEvent({
      runId: "run-overflow",
      stream: "lifecycle",
      data: {
        phase: "error",
        error: "Context overflow: estimated context size exceeds safe threshold during tool loop.",
        livenessState: "blocked",
      },
    });

    expect(getAgentRuntimeIssues()).toEqual([
      expect.objectContaining({
        runId: "run-overflow",
        code: "context_overflow",
        severity: "error",
        sessionKey: "agent:planner-4:main",
        lane: "session:agent:planner-4:main",
        livenessState: "blocked",
      }),
    ]);
  });

  test("clears runtime health issues on a clean lifecycle end", async () => {
    registerAgentRunContext("run-recovered", { sessionKey: "agent:planner-4:main" });
    emitAgentEvent({
      runId: "run-recovered",
      stream: "lifecycle",
      data: {
        phase: "error",
        error: "Context overflow: prompt too large for the model.",
      },
    });
    expect(getAgentRuntimeIssues()).toHaveLength(1);

    emitAgentEvent({
      runId: "run-recovered",
      stream: "lifecycle",
      data: { phase: "end" },
    });

    expect(getAgentRuntimeIssues()).toEqual([]);
  });

  test("keeps blocked lifecycle ends visible in runtime health", async () => {
    registerAgentRunContext("run-blocked", { sessionKey: "agent:planner-4:main" });

    emitAgentEvent({
      runId: "run-blocked",
      stream: "lifecycle",
      data: { phase: "end", livenessState: "blocked" },
    });

    expect(getAgentRuntimeIssues({ lane: "session:agent:planner-4:main" })).toEqual([
      expect.objectContaining({
        runId: "run-blocked",
        code: "agent_lifecycle_blocked",
        severity: "error",
      }),
    ]);
  });

  test("does not clear child route blockers on paused lifecycle ends", async () => {
    const tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-events-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    const childSessionKey = "agent:planner:subagent:paused";
    const trackedRun: SubagentRunRecord = {
      runId: "run-paused",
      childSessionKey,
      requesterSessionKey: "agent:planner:main",
      requesterDisplayKey: "main",
      task: "paused lifecycle regression",
      cleanup: "keep",
      createdAt: Date.now(),
    };

    try {
      const recorded = await recordChildRouteHealthEvent({
        code: "context_overflow",
        status: "active",
        source: "context_overflow",
        childSessionKey,
        runId: trackedRun.runId,
        reason: "context overflow before paused end",
      });
      expect(recorded).toEqual(expect.objectContaining({ ok: true }));

      registerAgentRunContext(trackedRun.runId, { sessionKey: childSessionKey });
      emitAgentEvent({
        runId: trackedRun.runId,
        stream: "lifecycle",
        data: { phase: "end", livenessState: "paused", replayInvalid: true },
      });
      await Promise.resolve();
      await Promise.resolve();

      const routeGuard = await guardChildRouteForDelivery({
        childSessionKey,
        context: {
          routeIntent: "followup_reuse",
          targetMethod: "sessions.send",
          requesterSessionKey: "agent:planner:main",
          childTargetKind: "subagent",
          registryRecord: trackedRun,
        },
      });
      expect(routeGuard).toEqual(
        expect.objectContaining({
          ok: false,
          code: "child_session_unhealthy",
        }),
      );
      if (routeGuard.ok) {
        throw new Error("expected paused lifecycle end to preserve child route blocker");
      }
      expect(routeGuard.details).toMatchObject({
        codes: ["context_overflow"],
        recommendedAction: "spawn_fresh",
      });
    } finally {
      await fs.rm(tempStateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test("omits sessionKey for runs hidden from Control UI", async () => {
    resetAgentRunContextForTest();
    registerAgentRunContext("run-hidden", {
      sessionKey: "session-imessage",
      isControlUiVisible: false,
    });

    let receivedSessionKey: string | undefined;
    const stop = onAgentEvent((evt) => {
      receivedSessionKey = evt.sessionKey;
    });
    emitAgentEvent({
      runId: "run-hidden",
      stream: "assistant",
      data: { text: "hi" },
      sessionKey: "session-imessage",
    });
    stop();

    expect(receivedSessionKey).toBeUndefined();
  });

  test("merges later run context updates into existing runs", async () => {
    resetAgentRunContextForTest();
    registerAgentRunContext("run-ctx", {
      sessionKey: "session-main",
      isControlUiVisible: true,
    });
    registerAgentRunContext("run-ctx", {
      verboseLevel: "full",
      isHeartbeat: true,
    });

    expect(getAgentRunContext("run-ctx")).toMatchObject({
      sessionKey: "session-main",
      verboseLevel: "full",
      isHeartbeat: true,
      isControlUiVisible: true,
    });
  });

  test("falls back to registered sessionKey when event sessionKey is blank", async () => {
    resetAgentRunContextForTest();
    registerAgentRunContext("run-ctx", { sessionKey: "session-main" });

    let receivedSessionKey: string | undefined;
    const stop = onAgentEvent((evt) => {
      receivedSessionKey = evt.sessionKey;
    });
    emitAgentEvent({
      runId: "run-ctx",
      stream: "assistant",
      data: { text: "hi" },
      sessionKey: "   ",
    });
    stop();

    expect(receivedSessionKey).toBe("session-main");
  });

  test("keeps notifying later listeners when one throws", async () => {
    const seen: string[] = [];
    const stopBad = onAgentEvent(() => {
      throw new Error("boom");
    });
    const stopGood = onAgentEvent((evt) => {
      seen.push(evt.runId);
    });

    expect(() =>
      emitAgentEvent({
        runId: "run-safe",
        stream: "assistant",
        data: { text: "hi" },
      }),
    ).not.toThrow();

    stopGood();
    stopBad();

    expect(seen).toEqual(["run-safe"]);
  });

  test("shares run context, listeners, and sequence state across duplicate module instances", async () => {
    const first = await importAgentEventsModule(`first-${Date.now()}`);
    const second = await importAgentEventsModule(`second-${Date.now()}`);

    first.resetAgentEventsForTest();
    first.registerAgentRunContext("run-dup", { sessionKey: "session-dup" });

    const seen: Array<{ seq: number; sessionKey?: string }> = [];
    const stop = first.onAgentEvent((evt) => {
      if (evt.runId === "run-dup") {
        seen.push({ seq: evt.seq, sessionKey: evt.sessionKey });
      }
    });

    second.emitAgentEvent({
      runId: "run-dup",
      stream: "assistant",
      data: { text: "from second" },
      sessionKey: "   ",
    });
    first.emitAgentEvent({
      runId: "run-dup",
      stream: "assistant",
      data: { text: "from first" },
      sessionKey: "   ",
    });

    stop();

    expect(second.getAgentRunContext("run-dup")).toMatchObject({ sessionKey: "session-dup" });
    expect(seen).toEqual([
      { seq: 1, sessionKey: "session-dup" },
      { seq: 2, sessionKey: "session-dup" },
    ]);

    first.resetAgentEventsForTest();
  });

  test("sweeps stale run contexts and clears their sequence state", async () => {
    const stop = vi.spyOn(Date, "now");
    stop.mockReturnValue(100);
    registerAgentRunContext("run-stale", { sessionKey: "session-stale", registeredAt: 100 });
    registerAgentRunContext("run-active", { sessionKey: "session-active", registeredAt: 100 });

    stop.mockReturnValue(200);
    emitAgentEvent({ runId: "run-stale", stream: "assistant", data: { text: "stale" } });

    stop.mockReturnValue(900);
    emitAgentEvent({ runId: "run-active", stream: "assistant", data: { text: "active" } });

    stop.mockReturnValue(1_000);
    expect(sweepStaleRunContexts(500)).toBe(1);
    expect(getAgentRunContext("run-stale")).toBeUndefined();
    expect(getAgentRunContext("run-active")).toMatchObject({ sessionKey: "session-active" });

    const seen: Array<{ runId: string; seq: number }> = [];
    const unsubscribe = onAgentEvent((evt) => {
      if (evt.runId === "run-stale" || evt.runId === "run-active") {
        seen.push({ runId: evt.runId, seq: evt.seq });
      }
    });

    emitAgentEvent({ runId: "run-stale", stream: "assistant", data: { text: "restarted" } });
    emitAgentEvent({ runId: "run-active", stream: "assistant", data: { text: "continued" } });

    unsubscribe();
    stop.mockRestore();

    expect(seen).toEqual([
      { runId: "run-stale", seq: 1 },
      { runId: "run-active", seq: 2 },
    ]);
  });
});

test("clearAgentRunContext also cleans up seqByRun to prevent memory leak (#63643)", () => {
  // Regression test: seqByRun entries were never deleted when a run ended,
  // causing unbounded growth over time.
  registerAgentRunContext("run-leak", { sessionKey: "main" });
  emitAgentEvent({ runId: "run-leak", stream: "lifecycle", data: {} });
  emitAgentEvent({ runId: "run-leak", stream: "lifecycle", data: {} });

  // After clearing run context, the sequence counter should also be removed.
  clearAgentRunContext("run-leak");

  // Emitting a new event on the same runId should start seq from 1 again,
  // proving the old entry was deleted.
  const seqs: number[] = [];
  const stop = onAgentEvent((evt) => {
    if (evt.runId === "run-leak") {
      seqs.push(evt.seq);
    }
  });
  emitAgentEvent({ runId: "run-leak", stream: "lifecycle", data: {} });
  stop();

  expect(seqs).toEqual([1]);
});
