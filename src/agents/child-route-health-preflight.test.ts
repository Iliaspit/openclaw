import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifySessionExpiredRouteHealth,
  preflightChildRouteAssignment,
  readLatestChildRouteContextHeadroomSnapshot,
  recordChildRouteContextHeadroomSnapshot,
  recordChildRouteHealthEvent,
  resetChildRouteHealthForTest,
} from "./child-route-health.js";

describe("child route assignment preflight", () => {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  let tempStateDir: string | undefined;

  beforeEach(async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-route-preflight-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    resetChildRouteHealthForTest();
  });

  afterEach(async () => {
    resetChildRouteHealthForTest();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      tempStateDir = undefined;
    }
  });

  it("persists scalar context-headroom telemetry keyed by child and run", async () => {
    await expect(
      recordChildRouteContextHeadroomSnapshot({
        childSessionKey: "agent:planner:subagent:worker",
        runId: "run-worker-1",
        estimatedPromptTokens: 80_000,
        modelContextLimitTokens: 100_000,
        headroomTokens: 20_000,
        headroomPercent: 20,
        estimateSource: "actual_request",
        lastCompactionStatus: "none",
        observedAt: Date.now(),
      }),
    ).resolves.toEqual({ ok: true });

    await expect(
      readLatestChildRouteContextHeadroomSnapshot({
        childSessionKey: "agent:planner:subagent:worker",
      }),
    ).resolves.toEqual({
      ok: true,
      snapshot: expect.objectContaining({
        childSessionKey: "agent:planner:subagent:worker",
        runId: "run-worker-1",
        estimatedPromptTokens: 80_000,
        modelContextLimitTokens: 100_000,
        headroomTokens: 20_000,
        headroomPercent: 20,
        estimateSource: "actual_request",
        lastCompactionStatus: "none",
      }),
    });

    await expect(
      readLatestChildRouteContextHeadroomSnapshot({ runId: "run-worker-1" }),
    ).resolves.toEqual({
      ok: true,
      snapshot: expect.objectContaining({
        childSessionKey: "agent:planner:subagent:worker",
        runId: "run-worker-1",
      }),
    });
  });

  it("prunes stale scalar context-headroom telemetry without transcript reconstruction", async () => {
    const childSessionKey = "agent:planner:subagent:worker";
    await recordChildRouteContextHeadroomSnapshot({
      childSessionKey,
      runId: "run-stale",
      estimatedPromptTokens: 90_000,
      modelContextLimitTokens: 100_000,
      headroomTokens: 10_000,
      headroomPercent: 10,
      estimateSource: "actual_request",
      lastCompactionStatus: "none",
      observedAt: Date.now() - 25 * 60 * 60_000,
    });
    await recordChildRouteContextHeadroomSnapshot({
      childSessionKey: "agent:planner:subagent:fresh-worker",
      runId: "run-fresh",
      estimatedPromptTokens: 20_000,
      modelContextLimitTokens: 100_000,
      headroomTokens: 80_000,
      headroomPercent: 80,
      estimateSource: "actual_request",
      lastCompactionStatus: "none",
    });

    await expect(
      readLatestChildRouteContextHeadroomSnapshot({ runId: "run-stale" }),
    ).resolves.toEqual({
      ok: true,
      snapshot: undefined,
    });
    await expect(
      readLatestChildRouteContextHeadroomSnapshot({ runId: "run-fresh" }),
    ).resolves.toEqual({
      ok: true,
      snapshot: expect.objectContaining({ childSessionKey: "agent:planner:subagent:fresh-worker" }),
    });
  });

  it("fails closed for substantial work when headroom is missing but allows healthy clarification reuse", async () => {
    const context = {
      routeIntent: "followup_reuse" as const,
      targetMethod: "planner_assignment",
      requesterSessionKey: "agent:planner:main",
      childTargetKind: "subagent" as const,
      registryRecord: {
        childSessionKey: "agent:planner:subagent:implementer",
        runId: "run-implementer-1",
      },
    };

    await expect(
      preflightChildRouteAssignment({
        childSessionKey: "agent:planner:subagent:implementer",
        assignmentKind: "implementation",
        context,
        latestLifecycleOutcome: "healthy",
      }),
    ).resolves.toMatchObject({
      status: "unavailable",
      reason: "context_headroom",
    });

    await expect(
      preflightChildRouteAssignment({
        childSessionKey: "agent:planner:subagent:implementer",
        assignmentKind: "small_clarification",
        context,
        latestLifecycleOutcome: "healthy",
      }),
    ).resolves.toMatchObject({
      status: "reuse",
    });

    await expect(
      preflightChildRouteAssignment({
        childSessionKey: "agent:planner:subagent:implementer",
        assignmentKind: "small_clarification",
        context,
        latestLifecycleOutcome: "blocked",
      }),
    ).resolves.toMatchObject({
      status: "reroute",
      reason: "lifecycle",
      recommendedAction: "spawn_fresh",
    });
  });

  it("reroutes substantial work on low headroom or failed compaction", async () => {
    const childSessionKey = "agent:planner:subagent:tester";
    const context = {
      routeIntent: "followup_reuse" as const,
      targetMethod: "planner_assignment",
      requesterSessionKey: "agent:planner:main",
      childTargetKind: "subagent" as const,
      registryRecord: { childSessionKey, runId: "run-tester-1" },
    };
    await recordChildRouteContextHeadroomSnapshot({
      childSessionKey,
      runId: "run-tester-1",
      estimatedPromptTokens: 99_000,
      modelContextLimitTokens: 100_000,
      headroomTokens: 1_000,
      headroomPercent: 1,
      estimateSource: "actual_request",
      lastCompactionStatus: "none",
    });

    await expect(
      preflightChildRouteAssignment({
        childSessionKey,
        assignmentKind: "testing",
        context,
        latestLifecycleOutcome: "healthy",
        hardHeadroomPercentThreshold: 5,
      }),
    ).resolves.toMatchObject({
      status: "reroute",
      reason: "context_headroom",
      recommendedAction: "spawn_fresh",
    });

    await recordChildRouteContextHeadroomSnapshot({
      childSessionKey,
      runId: "run-tester-1",
      estimatedPromptTokens: 50_000,
      modelContextLimitTokens: 100_000,
      headroomTokens: 50_000,
      headroomPercent: 50,
      estimateSource: "actual_request",
      lastCompactionStatus: "failed",
    });

    await expect(
      preflightChildRouteAssignment({
        childSessionKey,
        assignmentKind: "testing",
        context,
        latestLifecycleOutcome: "healthy",
        hardHeadroomPercentThreshold: 5,
      }),
    ).resolves.toMatchObject({
      status: "reroute",
      reason: "compaction",
      recommendedAction: "spawn_fresh",
    });
  });

  it("does not let nominal headroom override route-health or lifecycle blockers", async () => {
    const childSessionKey = "agent:planner:subagent:reviewer";
    const context = {
      routeIntent: "followup_reuse" as const,
      targetMethod: "planner_assignment",
      requesterSessionKey: "agent:planner:main",
      childTargetKind: "subagent" as const,
      registryRecord: { childSessionKey, runId: "run-reviewer-1" },
    };
    await recordChildRouteContextHeadroomSnapshot({
      childSessionKey,
      runId: "run-reviewer-1",
      estimatedPromptTokens: 10_000,
      modelContextLimitTokens: 100_000,
      headroomTokens: 90_000,
      headroomPercent: 90,
      estimateSource: "actual_request",
      lastCompactionStatus: "none",
    });
    await recordChildRouteHealthEvent({
      code: "context_overflow",
      status: "active",
      source: "context_overflow",
      childSessionKey,
      runId: "run-reviewer-1",
    });

    await expect(
      preflightChildRouteAssignment({
        childSessionKey,
        assignmentKind: "review",
        context,
        latestLifecycleOutcome: "healthy",
        hardHeadroomPercentThreshold: 5,
      }),
    ).resolves.toMatchObject({
      status: "reroute",
      reason: "route_health",
      codes: ["context_overflow"],
    });

    await recordChildRouteHealthEvent({
      code: "context_overflow",
      status: "cleared",
      source: "repair_control",
      childSessionKey,
      runId: "run-reviewer-1",
    });

    await expect(
      preflightChildRouteAssignment({
        childSessionKey,
        assignmentKind: "review",
        context,
        latestLifecycleOutcome: "no_final",
        hardHeadroomPercentThreshold: 5,
      }),
    ).resolves.toMatchObject({
      status: "reroute",
      reason: "lifecycle",
    });
  });

  it("keeps bare HTTP 404 or 410 session expiry ambiguous without source evidence", () => {
    expect(classifySessionExpiredRouteHealth({ statusCode: 404 })).toEqual({
      status: "ambiguous",
      recommendedAction: "stop",
      stateTransitionRequired: true,
    });
    expect(classifySessionExpiredRouteHealth({ statusCode: 410 })).toEqual({
      status: "ambiguous",
      recommendedAction: "stop",
      stateTransitionRequired: true,
    });
    expect(
      classifySessionExpiredRouteHealth({
        statusCode: 410,
        message: "session_expired: conversation id not found",
      }),
    ).toEqual({
      status: "classified",
      code: "child_conversation_expired",
      recommendedAction: "spawn_fresh",
      stateTransitionRequired: false,
    });
  });
});
