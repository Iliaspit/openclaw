import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveChildRouteDeliveryAttemptsPath } from "./child-route-delivery-attempts.js";
import { guardChildRouteForDelivery } from "./child-route-guard.js";
import {
  assessChildRouteHealth,
  classifySessionExpiredRouteHealth,
  recordSessionExpiredRouteHealth,
  recordChildRouteEditFailure,
  recordChildRouteEditSuccess,
  recordChildRouteHealthEvent,
  recordChildRouteHealthEvents,
  readActiveChildRouteAuthBlockers,
  readActiveChildRouteAuthBlockersForRoute,
  registerChildRoutePendingSpawn,
  resolveChildRouteHealthPath,
  resolveChildRouteTarget,
  resetChildRouteHealthForTest,
} from "./child-route-health.js";
import { guardFreshChildSpawnAuth } from "./child-route-spawn-preflight.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function trackedRun(childSessionKey: string): SubagentRunRecord {
  return {
    runId: `run-${childSessionKey.replaceAll(":", "-")}`,
    childSessionKey,
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "child route health test",
    cleanup: "keep",
    createdAt: Date.now(),
  };
}

describe("child route health", () => {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  let tempStateDir: string | undefined;

  beforeEach(async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-route-health-"));
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

  it("allows and consumes the trusted initial pending-spawn delivery", async () => {
    const childSessionKey = "agent:main:subagent:spawned";
    const pending = await registerChildRoutePendingSpawn({
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      childTargetKind: "subagent",
      idempotencyKey: "idem-initial",
      runId: "run-initial",
    });

    expect(pending).toEqual(expect.objectContaining({ ok: true }));
    if (!pending.ok) {
      throw new Error(pending.error);
    }

    const first = await guardChildRouteForDelivery({
      childSessionKey,
      consumePendingSpawn: true,
      context: {
        routeIntent: "initial_spawn",
        targetMethod: "agent",
        requesterSessionKey: "agent:main:main",
        childTargetKind: "subagent",
        idempotencyKey: "idem-initial",
        pendingSpawn: {
          pendingSpawnId: pending.pendingSpawnId,
          requesterSessionKey: "agent:main:main",
          idempotencyKey: "idem-initial",
        },
      },
    });
    expect(first).toEqual({ ok: true });

    const replay = await guardChildRouteForDelivery({
      childSessionKey,
      consumePendingSpawn: true,
      context: {
        routeIntent: "initial_spawn",
        targetMethod: "agent",
        requesterSessionKey: "agent:main:main",
        childTargetKind: "subagent",
        idempotencyKey: "idem-initial",
        pendingSpawn: {
          pendingSpawnId: pending.pendingSpawnId,
          requesterSessionKey: "agent:main:main",
          idempotencyKey: "idem-initial",
        },
      },
    });

    expect(replay).toEqual(
      expect.objectContaining({
        ok: false,
        code: "child_route_health_unavailable",
      }),
    );
    if (replay.ok) {
      throw new Error("expected consumed pending spawn replay to fail closed");
    }
    expect(replay.details).toMatchObject({
      kind: "child_route_health_unavailable",
      errorKind: "child_route_untrusted",
      retryable: false,
    });
  });

  it("rejects unhealthy follow-up delivery and dedupes the rejected attempt", async () => {
    const childSessionKey = "agent:main:subagent:overflowed";
    const recorded = await recordChildRouteHealthEvent({
      code: "context_overflow",
      status: "active",
      source: "context_overflow",
      childSessionKey,
      runId: "run-overflowed",
      observedAt: 1_000,
      reason: "context window exceeded",
    });
    expect(recorded).toEqual(expect.objectContaining({ ok: true }));

    const first = await guardChildRouteForDelivery({
      childSessionKey,
      context: {
        routeIntent: "followup_reuse",
        targetMethod: "sessions_send",
        requesterSessionKey: "agent:main:main",
        childTargetKind: "subagent",
        idempotencyKey: "send-2",
        registryRecord: trackedRun(childSessionKey),
      },
      payloadForHash: { hasMessage: true },
    });

    expect(first).toEqual(
      expect.objectContaining({
        ok: false,
        code: "child_session_unhealthy",
      }),
    );
    if (first.ok) {
      throw new Error("expected unhealthy child delivery to be rejected");
    }
    expect(first.details).toMatchObject({
      kind: "child_route_unhealthy",
      codes: ["context_overflow"],
      recommendedAction: "spawn_fresh",
      stateTransitionRequired: false,
    });

    const second = await guardChildRouteForDelivery({
      childSessionKey,
      context: {
        routeIntent: "followup_reuse",
        targetMethod: "sessions_send",
        requesterSessionKey: "agent:main:main",
        childTargetKind: "subagent",
        idempotencyKey: "send-1",
        registryRecord: trackedRun(childSessionKey),
      },
      payloadForHash: { hasMessage: true },
    });
    if (second.ok) {
      throw new Error("expected repeated unhealthy child delivery to be rejected");
    }

    expect(second.details.deliveryAttemptId).toBe(first.details.deliveryAttemptId);

    const attempts = JSON.parse(
      await fs.readFile(resolveChildRouteDeliveryAttemptsPath(), "utf8"),
    ) as {
      attempts?: Record<string, unknown>;
    };
    expect(Object.keys(attempts.attempts ?? {})).toHaveLength(1);
  });

  it("scopes provider session expiry to the matching target auth scope", async () => {
    const provider = {
      providerId: "openai",
      authProfileKey: "work",
      requesterSessionKey: "agent:main:main",
    };
    const recorded = await recordChildRouteHealthEvent({
      code: "auth_profile_session_expired",
      status: "active",
      source: "provider_error",
      provider,
      observedAt: 2_000,
      reason: "oauth token expired",
    });
    expect(recorded).toEqual(expect.objectContaining({ ok: true }));

    const childSessionKey = "agent:main:subagent:other";
    const rejected = await guardChildRouteForDelivery({
      childSessionKey,
      context: {
        routeIntent: "followup_reuse",
        targetMethod: "chat.send",
        requesterSessionKey: "agent:main:main",
        childTargetKind: "subagent",
        provider,
        registryRecord: trackedRun(childSessionKey),
      },
    });
    expect(rejected).toEqual(
      expect.objectContaining({
        ok: false,
        code: "child_session_unhealthy",
      }),
    );
    if (rejected.ok) {
      throw new Error("expected provider auth expiry to reject child route");
    }
    expect(rejected.details).toMatchObject({
      codes: ["auth_profile_session_expired"],
      recommendedAction: "reauth",
      stateTransitionRequired: true,
    });

    const unrelatedProfile = await guardChildRouteForDelivery({
      childSessionKey,
      context: {
        routeIntent: "followup_reuse",
        targetMethod: "sessions_send",
        requesterSessionKey: "agent:main:main",
        childTargetKind: "subagent",
        provider: {
          providerId: "openai",
          authProfileKey: "personal",
          requesterSessionKey: "agent:main:main",
        },
        registryRecord: trackedRun(childSessionKey),
      },
    });
    expect(unrelatedProfile).toEqual({ ok: true });

    const noProviderContext = await guardChildRouteForDelivery({
      childSessionKey,
      context: {
        routeIntent: "followup_reuse",
        targetMethod: "sessions_send",
        requesterSessionKey: "agent:main:main",
        childTargetKind: "subagent",
        registryRecord: trackedRun(childSessionKey),
      },
    });
    expect(noProviderContext).toEqual({ ok: true });

    await expect(readActiveChildRouteAuthBlockers()).resolves.toEqual({
      ok: true,
      blockers: [],
    });
    await expect(
      readActiveChildRouteAuthBlockers({
        providerId: "openai",
        authProfileKey: "personal",
      }),
    ).resolves.toEqual({
      ok: true,
      blockers: [],
    });
    await expect(readActiveChildRouteAuthBlockers(provider)).resolves.toMatchObject({
      ok: true,
      blockers: [
        expect.objectContaining({
          authScopeKey: "openai:profile:work",
          codes: ["auth_profile_session_expired"],
        }),
      ],
    });

    const cleared = await recordChildRouteHealthEvent({
      code: "auth_profile_session_expired",
      status: "cleared",
      source: "provider_error",
      provider,
      observedAt: 3_000,
      reason: "provider profile was repaired",
    });
    expect(cleared).toEqual(expect.objectContaining({ ok: true }));

    await expect(
      guardChildRouteForDelivery({
        childSessionKey,
        context: {
          routeIntent: "followup_reuse",
          targetMethod: "chat.send",
          requesterSessionKey: "agent:main:main",
          childTargetKind: "subagent",
          provider,
          registryRecord: trackedRun(childSessionKey),
        },
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("blocks shared delivery to fresh-reroute old generations after health clears", async () => {
    const childSessionKey = "agent:main:subagent:fresh-reroute-old";
    const registryRecord: SubagentRunRecord = {
      ...trackedRun(childSessionKey),
      runId: "run-fresh-reroute-old",
      suppressAnnounceReason: "fresh-reroute",
    };

    await expect(
      recordChildRouteHealthEvent({
        code: "context_overflow",
        status: "active",
        source: "context_overflow",
        childSessionKey,
        runId: registryRecord.runId,
      }),
    ).resolves.toEqual(expect.objectContaining({ ok: true }));
    await expect(
      recordChildRouteHealthEvent({
        code: "context_overflow",
        status: "success",
        source: "agent_lifecycle",
        childSessionKey,
        runId: registryRecord.runId,
      }),
    ).resolves.toEqual(expect.objectContaining({ ok: true }));

    for (const targetMethod of ["agent", "chat.send"] as const) {
      const guarded = await guardChildRouteForDelivery({
        childSessionKey,
        context: {
          routeIntent: "followup_reuse",
          targetMethod,
          requesterSessionKey: "agent:main:main",
          childTargetKind: "subagent",
          registryRecord,
        },
        payloadForHash: {
          method: targetMethod,
          message: "do not deliver to superseded old generation",
        },
      });
      expect(guarded).toEqual(
        expect.objectContaining({
          ok: false,
          code: "child_session_unhealthy",
          retryable: false,
        }),
      );
      if (guarded.ok) {
        throw new Error(`expected ${targetMethod} to reject the superseded old generation`);
      }
      expect(guarded.details).toMatchObject({
        codes: ["agent_lifecycle_abandoned"],
        recommendedAction: "stop",
        stateTransitionRequired: true,
      });
    }

    await expect(
      guardChildRouteForDelivery({
        childSessionKey,
        context: {
          routeIntent: "completion_receipt",
          targetMethod: "subagent_completion",
          requesterSessionKey: "agent:main:main",
          childTargetKind: "subagent",
          registryRecord,
        },
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      guardChildRouteForDelivery({
        childSessionKey,
        context: {
          routeIntent: "repair_control",
          targetMethod: "route_repair",
          requesterSessionKey: "agent:main:main",
          childTargetKind: "subagent",
          registryRecord,
        },
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("turns repeated mechanical edit misses across kinds into a transient child-local blocker", async () => {
    const childSessionKey = "agent:main:subagent:editor";
    const runId = "run-editor-1";
    const staleObservedAt = Date.now() - 31 * 60_000;

    await expect(
      recordChildRouteEditFailure({
        childSessionKey,
        runId,
        filePath: "/workspace/demo.ts",
        toolKind: "edit",
        failureKind: "old_text_mismatch",
        observedAt: staleObservedAt,
        threshold: 3,
      }),
    ).resolves.toMatchObject({ ok: true, counted: true, count: 1 });

    await expect(
      recordChildRouteEditFailure({
        childSessionKey,
        runId,
        filePath: "/workspace/demo.ts",
        toolKind: "edit",
        failureKind: "old_text_mismatch",
        threshold: 3,
      }),
    ).resolves.toMatchObject({
      ok: true,
      counted: true,
      count: 1,
      thresholdCrossed: false,
    });

    await expect(
      recordChildRouteEditFailure({
        childSessionKey,
        runId,
        filePath: "/workspace/demo.ts",
        toolKind: "edit",
        failureKind: "ambiguous_old_text",
        threshold: 3,
      }),
    ).resolves.toMatchObject({
      ok: true,
      counted: true,
      count: 2,
      thresholdCrossed: false,
    });

    await expect(
      assessChildRouteHealth(childSessionKey, {
        routeIntent: "followup_reuse",
        targetMethod: "sessions_send",
        requesterSessionKey: "agent:main:main",
        childTargetKind: "subagent",
        registryRecord: trackedRun(childSessionKey),
      }),
    ).resolves.toMatchObject({ status: "ok" });

    await expect(
      recordChildRouteEditFailure({
        childSessionKey,
        runId,
        filePath: "/workspace/demo.ts",
        toolKind: "edit",
        failureKind: "mechanical_edit_failure",
        threshold: 3,
      }),
    ).resolves.toMatchObject({
      ok: true,
      counted: true,
      count: 3,
      thresholdCrossed: true,
    });

    await expect(
      assessChildRouteHealth(childSessionKey, {
        routeIntent: "followup_reuse",
        targetMethod: "sessions_send",
        requesterSessionKey: "agent:main:main",
        childTargetKind: "subagent",
        registryRecord: trackedRun(childSessionKey),
      }),
    ).resolves.toMatchObject({
      status: "unhealthy",
      codes: ["edit_failure_threshold"],
      recommendedAction: "spawn_fresh",
      plannerInstruction: "Inspect surrounding context and use unique edit anchors.",
    });

    await expect(
      recordChildRouteEditSuccess({
        childSessionKey,
        runId,
        filePath: "/workspace/demo.ts",
        toolKind: "edit",
      }),
    ).resolves.toEqual({ ok: true, cleared: true });

    await expect(
      assessChildRouteHealth(childSessionKey, {
        routeIntent: "followup_reuse",
        targetMethod: "sessions_send",
        requesterSessionKey: "agent:main:main",
        childTargetKind: "subagent",
        registryRecord: trackedRun(childSessionKey),
      }),
    ).resolves.toMatchObject({ status: "ok" });
  });

  it("scopes edit-failure threshold by run id and file path", async () => {
    const childSessionKey = "agent:main:subagent:editor-scoped";
    const runPrefix = "run-editor-scoped";
    await expect(
      recordChildRouteEditFailure({
        childSessionKey,
        runId: `${runPrefix}-first`,
        filePath: "/workspace/demo-a.ts",
        toolKind: "edit",
        failureKind: "old_text_mismatch",
        threshold: 2,
      }),
    ).resolves.toMatchObject({ ok: true, counted: true, count: 1, thresholdCrossed: false });
    await expect(
      recordChildRouteEditFailure({
        childSessionKey,
        runId: `${runPrefix}-first`,
        filePath: "/workspace/demo-a.ts",
        toolKind: "edit",
        failureKind: "old_text_mismatch",
        threshold: 2,
      }),
    ).resolves.toMatchObject({ ok: true, counted: true, count: 2, thresholdCrossed: true });

    await expect(
      assessChildRouteHealth(childSessionKey, {
        routeIntent: "followup_reuse",
        targetMethod: "sessions_send",
        requesterSessionKey: "agent:main:main",
        childTargetKind: "subagent",
        registryRecord: { ...trackedRun(childSessionKey), runId: `${runPrefix}-first` },
      }),
    ).resolves.toMatchObject({
      status: "unhealthy",
      codes: ["edit_failure_threshold"],
      recommendedAction: "spawn_fresh",
    });

    await expect(
      assessChildRouteHealth(childSessionKey, {
        routeIntent: "followup_reuse",
        targetMethod: "sessions_send",
        requesterSessionKey: "agent:main:main",
        childTargetKind: "subagent",
        editFailureScope: {
          runId: `${runPrefix}-second`,
          filePath: "/workspace/demo-a.ts",
        },
        registryRecord: { ...trackedRun(childSessionKey), runId: `${runPrefix}-first` },
      }),
    ).resolves.toMatchObject({ status: "ok" });

    await expect(
      assessChildRouteHealth(childSessionKey, {
        routeIntent: "followup_reuse",
        targetMethod: "sessions_send",
        requesterSessionKey: "agent:main:main",
        childTargetKind: "subagent",
        editFailureScope: {
          runId: `${runPrefix}-first`,
          filePath: "/workspace/demo-b.ts",
        },
        registryRecord: { ...trackedRun(childSessionKey), runId: `${runPrefix}-first` },
      }),
    ).resolves.toMatchObject({ status: "ok" });

    for (const attempt of [1, 2]) {
      await expect(
        recordChildRouteEditFailure({
          childSessionKey,
          runId: `${runPrefix}-first`,
          filePath: "/workspace/demo-b.ts",
          toolKind: "edit",
          failureKind: "old_text_mismatch",
          threshold: 2,
        }),
      ).resolves.toMatchObject({
        ok: true,
        counted: true,
        count: attempt,
        thresholdCrossed: attempt === 2,
      });
    }

    await expect(
      recordChildRouteEditSuccess({
        childSessionKey,
        runId: `${runPrefix}-first`,
        filePath: "/workspace/demo-a.ts",
        toolKind: "edit",
      }),
    ).resolves.toEqual({ ok: true, cleared: true });

    await expect(
      assessChildRouteHealth(childSessionKey, {
        routeIntent: "followup_reuse",
        targetMethod: "sessions_send",
        requesterSessionKey: "agent:main:main",
        childTargetKind: "subagent",
        editFailureScope: {
          runId: `${runPrefix}-first`,
          filePath: "/workspace/demo-a.ts",
        },
        registryRecord: { ...trackedRun(childSessionKey), runId: `${runPrefix}-first` },
      }),
    ).resolves.toMatchObject({ status: "ok" });

    await expect(
      assessChildRouteHealth(childSessionKey, {
        routeIntent: "followup_reuse",
        targetMethod: "sessions_send",
        requesterSessionKey: "agent:main:main",
        childTargetKind: "subagent",
        editFailureScope: {
          runId: `${runPrefix}-first`,
          filePath: "/workspace/demo-b.ts",
        },
        registryRecord: { ...trackedRun(childSessionKey), runId: `${runPrefix}-first` },
      }),
    ).resolves.toMatchObject({
      status: "unhealthy",
      codes: ["edit_failure_threshold"],
      recommendedAction: "spawn_fresh",
    });

    await expect(
      recordChildRouteEditFailure({
        childSessionKey,
        runId: `${runPrefix}-first`,
        filePath: "/workspace/demo-b.ts",
        toolKind: "edit",
        failureKind: "old_text_mismatch",
        threshold: 3,
      }),
    ).resolves.toMatchObject({
      ok: true,
      counted: true,
      count: 3,
      thresholdCrossed: true,
    });
  });

  it("scopes edit-failure threshold by edit tool kind", async () => {
    const childSessionKey = "agent:main:subagent:editor-kind";
    const runId = "run-editor-kind";
    await expect(
      recordChildRouteEditFailure({
        childSessionKey,
        runId,
        filePath: "/workspace/demo.ts",
        toolKind: "apply_patch",
        failureKind: "ambiguous_old_text",
        threshold: 2,
      }),
    ).resolves.toMatchObject({ ok: true, counted: true, count: 1, thresholdCrossed: false });
    await expect(
      recordChildRouteEditFailure({
        childSessionKey,
        runId,
        filePath: "/workspace/demo.ts",
        toolKind: "apply_patch",
        failureKind: "ambiguous_old_text",
        threshold: 2,
      }),
    ).resolves.toMatchObject({ ok: true, counted: true, count: 2, thresholdCrossed: true });

    await expect(
      assessChildRouteHealth(childSessionKey, {
        routeIntent: "followup_reuse",
        targetMethod: "sessions_send",
        requesterSessionKey: "agent:main:main",
        childTargetKind: "subagent",
        editFailureScope: {
          runId,
          filePath: "/workspace/demo.ts",
          toolKind: "edit",
        },
        registryRecord: { ...trackedRun(childSessionKey), runId },
      }),
    ).resolves.toMatchObject({ status: "ok" });

    await expect(
      assessChildRouteHealth(childSessionKey, {
        routeIntent: "followup_reuse",
        targetMethod: "sessions_send",
        requesterSessionKey: "agent:main:main",
        childTargetKind: "subagent",
        editFailureScope: {
          runId,
          filePath: "/workspace/demo.ts",
          toolKind: "apply_patch",
        },
        registryRecord: { ...trackedRun(childSessionKey), runId },
      }),
    ).resolves.toMatchObject({
      status: "unhealthy",
      codes: ["edit_failure_threshold"],
      recommendedAction: "spawn_fresh",
    });
  });

  it("classifies raw session_expired errors into closed route-health codes", () => {
    expect(
      classifySessionExpiredRouteHealth({
        message: "session_expired: oauth token was revoked",
        provider: { providerId: "openai" },
      }),
    ).toEqual({
      status: "classified",
      code: "auth_profile_session_expired",
      recommendedAction: "reauth",
      stateTransitionRequired: true,
    });

    expect(
      classifySessionExpiredRouteHealth({
        message: "session_expired: conversation id not found",
      }),
    ).toEqual({
      status: "classified",
      code: "child_conversation_expired",
      recommendedAction: "spawn_fresh",
      stateTransitionRequired: false,
    });

    for (const message of [
      "No conversation found for response id resp_123",
      "HTTP 410: session not found",
      "session invalid: restart required",
    ]) {
      expect(classifySessionExpiredRouteHealth({ message })).toEqual({
        status: "classified",
        code: "child_conversation_expired",
        recommendedAction: "spawn_fresh",
        stateTransitionRequired: false,
      });
    }

    expect(
      classifySessionExpiredRouteHealth({
        message: "session_expired: login token expired",
        provider: { providerId: "openai", fallbackCredentialSelected: true },
      }),
    ).toEqual({
      status: "classified",
      code: "auth_profile_session_expired",
      recommendedAction: "fallback_profile",
      stateTransitionRequired: true,
    });

    expect(classifySessionExpiredRouteHealth({ message: "session_expired" })).toEqual({
      status: "ambiguous",
      recommendedAction: "stop",
      stateTransitionRequired: true,
    });
  });

  it("records auth session expiry as a provider credential-scope blocker", async () => {
    const recorded = await recordSessionExpiredRouteHealth({
      message: "session_expired: oauth token was revoked",
      childSessionKey: "agent:main:subagent:expired-auth-source",
      runId: "run-expired-auth-source",
      requesterSessionKey: "agent:main:main",
      provider: {
        providerId: "openai",
        modelId: "gpt-5.4",
        authProfileKey: "openai:default",
      },
    });

    expect(recorded).toEqual(
      expect.objectContaining({
        recorded: true,
        classification: expect.objectContaining({
          code: "auth_profile_session_expired",
          recommendedAction: "reauth",
        }),
      }),
    );

    await expect(
      assessChildRouteHealth("agent:main:subagent:other-child", {
        routeIntent: "followup_reuse",
        targetMethod: "sessions_send",
        requesterSessionKey: "agent:main:main",
        childTargetKind: "subagent",
        provider: {
          providerId: "openai",
          modelId: "gpt-5.4",
          authProfileKey: "openai:default",
        },
        registryRecord: trackedRun("agent:main:subagent:other-child"),
      }),
    ).resolves.toMatchObject({
      status: "unhealthy",
      codes: ["auth_profile_session_expired"],
      recommendedAction: "reauth",
      stateTransitionRequired: true,
    });
  });

  it("records no-profile auth expiry against the credential source instead of the unknown bucket", async () => {
    await expect(
      recordSessionExpiredRouteHealth({
        message: "session_expired: credential token expired",
        childSessionKey: "agent:main:subagent:env-auth",
        runId: "run-env-auth",
        requesterSessionKey: "agent:main:main",
        provider: {
          providerId: "openai",
          modelId: "gpt-5.4",
          credentialSource: "env: OPENAI_API_KEY",
        },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        recorded: true,
        classification: expect.objectContaining({
          code: "auth_profile_session_expired",
        }),
      }),
    );

    await expect(
      assessChildRouteHealth("agent:main:subagent:env-auth-other", {
        routeIntent: "followup_reuse",
        targetMethod: "sessions_send",
        requesterSessionKey: "agent:main:main",
        childTargetKind: "subagent",
        provider: {
          providerId: "openai",
          modelId: "gpt-5.4",
          credentialSource: "env: OPENAI_API_KEY",
        },
        registryRecord: trackedRun("agent:main:subagent:env-auth-other"),
      }),
    ).resolves.toMatchObject({
      status: "unhealthy",
      codes: ["auth_profile_session_expired"],
      recommendedAction: "reauth",
    });

    await expect(
      assessChildRouteHealth("agent:main:subagent:different-env-auth", {
        routeIntent: "followup_reuse",
        targetMethod: "sessions_send",
        requesterSessionKey: "agent:main:main",
        childTargetKind: "subagent",
        provider: {
          providerId: "openai",
          modelId: "gpt-5.4",
          credentialSource: "env: OPENAI_ALT_KEY",
        },
        registryRecord: trackedRun("agent:main:subagent:different-env-auth"),
      }),
    ).resolves.toMatchObject({ status: "ok" });
  });

  it("matches provider-only auth checks only against the default provider credential scope", async () => {
    await expect(
      recordSessionExpiredRouteHealth({
        message: "session_expired: credential token expired",
        childSessionKey: "agent:main:subagent:provider-only-auth",
        runId: "run-provider-only-auth",
        requesterSessionKey: "agent:main:main",
        provider: {
          providerId: "openai",
          modelId: "gpt-5.4",
          credentialSource: "env: OPENAI_API_KEY",
        },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        recorded: true,
        classification: expect.objectContaining({
          code: "auth_profile_session_expired",
        }),
      }),
    );

    await expect(
      guardFreshChildSpawnAuth({
        providerId: "openai",
        modelId: "gpt-5.4",
        requesterSessionKey: "agent:main:main",
      }),
    ).resolves.toEqual({ ok: true });

    await expect(
      readActiveChildRouteAuthBlockers({
        providerId: "openai",
        modelId: "gpt-5.4",
      }),
    ).resolves.toEqual({
      ok: true,
      blockers: [],
    });

    await expect(
      readActiveChildRouteAuthBlockersForRoute({
        provider: {
          providerId: "openai",
          modelId: "gpt-5.4",
        },
        childSessionKey: "agent:main:subagent:provider-only-auth",
        runId: "run-provider-only-auth",
      }),
    ).resolves.toMatchObject({
      ok: true,
      blockers: [
        expect.objectContaining({
          authScopeKey: "openai:source:env: OPENAI_API_KEY",
          codes: ["auth_profile_session_expired"],
        }),
      ],
    });

    const sourceScopedReuse = await guardChildRouteForDelivery({
      childSessionKey: "agent:main:subagent:provider-only-auth",
      context: {
        routeIntent: "followup_reuse",
        targetMethod: "sessions_send",
        requesterSessionKey: "agent:main:main",
        childTargetKind: "subagent",
        provider: {
          providerId: "openai",
          modelId: "gpt-5.4",
        },
        registryRecord: trackedRun("agent:main:subagent:provider-only-auth"),
      },
    });
    expect(sourceScopedReuse).toEqual(
      expect.objectContaining({
        ok: false,
        code: "child_session_unhealthy",
      }),
    );
    if (sourceScopedReuse.ok) {
      throw new Error(
        "expected same-child source-scoped auth expiry to reject provider-only reuse",
      );
    }
    expect(sourceScopedReuse.details).toMatchObject({
      codes: ["auth_profile_session_expired"],
      recommendedAction: "reauth",
      stateTransitionRequired: true,
    });

    await expect(
      guardFreshChildSpawnAuth(
        {
          providerId: "openai",
          modelId: "gpt-5.4",
          requesterSessionKey: "agent:main:main",
        },
        {
          childSessionKey: "agent:main:subagent:new-default-child",
          includeProviderDefaultCredentialBlockers: true,
        },
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        code: "auth_profile_session_expired",
        authBlockers: [
          expect.objectContaining({
            authScopeKey: "openai:source:env: OPENAI_API_KEY",
          }),
        ],
      }),
    );

    await expect(
      guardFreshChildSpawnAuth({
        providerId: "openai",
        modelId: "gpt-5.4",
        credentialSource: "env: OPENAI_API_KEY",
        requesterSessionKey: "agent:main:main",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        code: "auth_profile_session_expired",
      }),
    );

    await expect(
      readActiveChildRouteAuthBlockers({
        providerId: "openai",
        modelId: "gpt-5.4",
        credentialSource: "env: OPENAI_API_KEY",
      }),
    ).resolves.toMatchObject({
      ok: true,
      blockers: [
        expect.objectContaining({
          authScopeKey: "openai:source:env: OPENAI_API_KEY",
          codes: ["auth_profile_session_expired"],
        }),
      ],
    });

    await expect(
      recordChildRouteHealthEvent({
        code: "auth_profile_session_expired",
        status: "active",
        source: "provider_error",
        provider: {
          providerId: "openai",
          modelId: "gpt-5.4",
        },
        observedAt: 3_000,
        reason: "default credential token expired",
      }),
    ).resolves.toEqual(expect.objectContaining({ ok: true }));

    await expect(
      guardFreshChildSpawnAuth({
        providerId: "openai",
        modelId: "gpt-5.4",
        requesterSessionKey: "agent:main:main",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        code: "auth_profile_session_expired",
      }),
    );

    await expect(
      guardFreshChildSpawnAuth({
        providerId: "anthropic",
        modelId: "sonnet-4.6",
        requesterSessionKey: "agent:main:main",
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("records conversation expiry as child-local and leaves ambiguous session_expired unrecorded", async () => {
    await expect(
      recordSessionExpiredRouteHealth({
        message: "session_expired: conversation id not found",
        childSessionKey: "agent:main:subagent:expired-conversation",
        runId: "run-expired-conversation",
        requesterSessionKey: "agent:main:main",
        provider: { providerId: "openai", modelId: "gpt-5.4" },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        recorded: true,
        classification: expect.objectContaining({
          code: "child_conversation_expired",
          recommendedAction: "spawn_fresh",
        }),
      }),
    );

    await expect(
      assessChildRouteHealth("agent:main:subagent:expired-conversation", {
        routeIntent: "followup_reuse",
        targetMethod: "sessions_send",
        requesterSessionKey: "agent:main:main",
        childTargetKind: "subagent",
        provider: { providerId: "openai", modelId: "gpt-5.4" },
        registryRecord: trackedRun("agent:main:subagent:expired-conversation"),
      }),
    ).resolves.toMatchObject({
      status: "unhealthy",
      codes: ["child_conversation_expired"],
      recommendedAction: "spawn_fresh",
    });

    await expect(
      recordSessionExpiredRouteHealth({
        message: "session_expired",
        childSessionKey: "agent:main:subagent:ambiguous",
        runId: "run-ambiguous",
        requesterSessionKey: "agent:main:main",
        provider: { providerId: "openai", modelId: "gpt-5.4" },
      }),
    ).resolves.toEqual({
      recorded: false,
      classification: {
        status: "ambiguous",
        recommendedAction: "stop",
        stateTransitionRequired: true,
      },
    });

    await expect(
      assessChildRouteHealth("agent:main:subagent:ambiguous", {
        routeIntent: "followup_reuse",
        targetMethod: "sessions_send",
        requesterSessionKey: "agent:main:main",
        childTargetKind: "subagent",
        provider: { providerId: "openai", modelId: "gpt-5.4" },
        registryRecord: trackedRun("agent:main:subagent:ambiguous"),
      }),
    ).resolves.toMatchObject({ status: "ok" });
  });

  it("records child conversation expiry from lineage-derived sessions against the child route", async () => {
    const sourceChildSessionKey = "agent:main:subagent:lineage-expired";
    const derivedSessionKey = "agent:main:dashboard:lineage-branch";
    const recorded = await recordSessionExpiredRouteHealth({
      message: "session_expired: conversation id not found",
      childSessionKey: derivedSessionKey,
      sessionLineage: {
        parentSessionKey: sourceChildSessionKey,
        forkedFromParent: true,
      },
      runId: "run-lineage-expired",
      requesterSessionKey: "agent:main:main",
      provider: { providerId: "openai", modelId: "gpt-5.4" },
    });

    expect(recorded).toEqual(
      expect.objectContaining({
        recorded: true,
        classification: expect.objectContaining({
          code: "child_conversation_expired",
          recommendedAction: "spawn_fresh",
        }),
      }),
    );

    await expect(
      assessChildRouteHealth(sourceChildSessionKey, {
        routeIntent: "followup_reuse",
        targetMethod: "sessions_send",
        requesterSessionKey: "agent:main:main",
        childTargetKind: "subagent",
        provider: { providerId: "openai", modelId: "gpt-5.4" },
        registryRecord: trackedRun(sourceChildSessionKey),
      }),
    ).resolves.toMatchObject({
      status: "unhealthy",
      codes: ["child_conversation_expired"],
      recommendedAction: "spawn_fresh",
    });

    await expect(
      assessChildRouteHealth(sourceChildSessionKey, {
        routeIntent: "followup_reuse",
        targetMethod: "sessions_send",
        requesterSessionKey: "agent:main:main",
        childTargetKind: "subagent",
        sessionLineage: {
          parentSessionKey: sourceChildSessionKey,
          forkedFromParent: true,
        },
      }),
    ).resolves.toMatchObject({
      status: "unhealthy",
      codes: ["child_conversation_expired"],
      recommendedAction: "spawn_fresh",
    });
  });

  it("records auth expiry from lineage-derived sessions against the child route", async () => {
    const sourceChildSessionKey = "agent:main:subagent:lineage-auth-expired";
    const derivedSessionKey = "agent:main:dashboard:lineage-auth-branch";
    const recorded = await recordSessionExpiredRouteHealth({
      message: "session_expired: credential token expired",
      childSessionKey: derivedSessionKey,
      sessionLineage: {
        parentSessionKey: sourceChildSessionKey,
        forkedFromParent: true,
      },
      runId: "run-lineage-auth-expired",
      requesterSessionKey: "agent:main:main",
      provider: {
        providerId: "openai",
        modelId: "gpt-5.4",
        credentialSource: "env: OPENAI_API_KEY",
      },
    });

    expect(recorded).toEqual(
      expect.objectContaining({
        recorded: true,
        classification: expect.objectContaining({
          code: "auth_profile_session_expired",
          recommendedAction: "reauth",
        }),
      }),
    );

    await expect(
      assessChildRouteHealth(sourceChildSessionKey, {
        routeIntent: "followup_reuse",
        targetMethod: "sessions_send",
        requesterSessionKey: "agent:main:main",
        childTargetKind: "subagent",
        provider: { providerId: "openai", modelId: "gpt-5.4" },
        registryRecord: trackedRun(sourceChildSessionKey),
      }),
    ).resolves.toMatchObject({
      status: "unhealthy",
      codes: ["auth_profile_session_expired"],
      recommendedAction: "reauth",
      stateTransitionRequired: true,
    });
  });

  it("maps dashboard branches with child lineage back to the unhealthy child route", async () => {
    const routeTarget = resolveChildRouteTarget({
      sessionKey: "agent:main:dashboard:branch",
      entry: {
        parentSessionKey: "agent:main:subagent:overflowed",
        forkedFromParent: true,
      },
    });
    expect(routeTarget).toEqual({
      sessionKey: "agent:main:dashboard:branch",
      healthSessionKey: "agent:main:subagent:overflowed",
      childTargetKind: "subagent",
      lineageSessionKey: "agent:main:subagent:overflowed",
    });
    if (!routeTarget) {
      throw new Error("expected route target");
    }
    const recorded = await recordChildRouteHealthEvent({
      code: "context_overflow",
      status: "active",
      source: "context_overflow",
      childSessionKey: routeTarget.healthSessionKey,
      runId: "run-lineaged-overflow",
      reason: "lineaged child overflowed",
    });
    expect(recorded).toEqual(expect.objectContaining({ ok: true }));

    const guarded = await guardChildRouteForDelivery({
      childSessionKey: routeTarget.healthSessionKey,
      context: {
        routeIntent: "followup_reuse",
        targetMethod: "sessions.send",
        requesterSessionKey: "agent:main:main",
        childTargetKind: routeTarget.childTargetKind,
        sessionLineage: {
          parentSessionKey: routeTarget.healthSessionKey,
          forkedFromParent: true,
        },
      },
    });
    expect(guarded).toEqual(
      expect.objectContaining({
        ok: false,
        code: "child_session_unhealthy",
      }),
    );
    if (guarded.ok) {
      throw new Error("expected lineaged branch to inherit child route blocker");
    }
    expect(guarded.details).toMatchObject({
      codes: ["context_overflow"],
      recommendedAction: "spawn_fresh",
    });
  });

  it("persists unavailable tombstones on write failure and clears them after repair", async () => {
    const childSessionKey = "agent:main:subagent:poisoned";
    const healthPath = resolveChildRouteHealthPath();
    await fs.mkdir(path.dirname(healthPath), { recursive: true });
    await fs.writeFile(healthPath, "{not-json", "utf8");

    const failed = await recordChildRouteHealthEvent({
      code: "context_overflow",
      status: "active",
      source: "context_overflow",
      childSessionKey,
      runId: "run-poisoned",
      reason: "context overflow while route-health store was corrupt",
    });
    expect(failed).toEqual(expect.objectContaining({ ok: false }));

    await fs.rm(healthPath, { force: true });
    const poisoned = await guardChildRouteForDelivery({
      childSessionKey,
      context: {
        routeIntent: "followup_reuse",
        targetMethod: "sessions.send",
        requesterSessionKey: "agent:main:main",
        childTargetKind: "subagent",
        registryRecord: trackedRun(childSessionKey),
      },
    });
    expect(poisoned).toEqual(
      expect.objectContaining({
        ok: false,
        code: "child_route_health_unavailable",
      }),
    );

    const repaired = await recordChildRouteHealthEvent({
      code: "context_overflow",
      status: "success",
      source: "agent_lifecycle",
      childSessionKey,
      runId: "run-repaired",
      reason: "ordinary execution completed successfully",
    });
    expect(repaired).toEqual(expect.objectContaining({ ok: true }));

    await expect(
      guardChildRouteForDelivery({
        childSessionKey,
        context: {
          routeIntent: "followup_reuse",
          targetMethod: "sessions.send",
          requesterSessionKey: "agent:main:main",
          childTargetKind: "subagent",
          registryRecord: trackedRun(childSessionKey),
        },
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("fails closed with a tombstone when reset-style repair clears cannot be persisted", async () => {
    const childSessionKey = "agent:main:subagent:reset-tombstone";
    const healthPath = resolveChildRouteHealthPath();
    await fs.mkdir(path.dirname(healthPath), { recursive: true });
    await fs.writeFile(healthPath, "{not-json", "utf8");

    const failed = await recordChildRouteHealthEvents(
      [
        {
          code: "child_conversation_expired",
          status: "cleared",
          source: "repair_control",
          childSessionKey,
          reason: "Session reset created a fresh transcript for this child route.",
        },
        {
          code: "context_overflow",
          status: "cleared",
          source: "repair_control",
          childSessionKey,
          reason: "Session reset created a fresh transcript for this child route.",
        },
      ],
      { failClosedOnError: true },
    );
    expect(failed).toEqual(expect.objectContaining({ ok: false }));

    await fs.rm(healthPath, { force: true });
    const guarded = await guardChildRouteForDelivery({
      childSessionKey,
      context: {
        routeIntent: "followup_reuse",
        targetMethod: "sessions.reset-test",
        requesterSessionKey: "agent:main:main",
        childTargetKind: "subagent",
        registryRecord: trackedRun(childSessionKey),
      },
    });
    expect(guarded).toEqual(
      expect.objectContaining({
        ok: false,
        code: "child_route_health_unavailable",
      }),
    );
    if (guarded.ok) {
      throw new Error("expected reset repair write failure to fail closed");
    }
    expect(guarded.details).toMatchObject({
      kind: "child_route_health_unavailable",
      errorKind: "child_route_health_unavailable",
      retryable: true,
    });
  });

  it("keeps existing in-memory unavailable tombstones when repair clears fail to persist", async () => {
    const childSessionKey = "agent:main:subagent:reset-memory-tombstone";
    const healthPath = resolveChildRouteHealthPath();
    const unavailablePath = path.join(path.dirname(healthPath), "route-health-unavailable.json");
    await fs.mkdir(path.dirname(healthPath), { recursive: true });
    await fs.writeFile(healthPath, "{not-json", "utf8");

    const failedActive = await recordChildRouteHealthEvent({
      code: "context_overflow",
      status: "active",
      source: "context_overflow",
      childSessionKey,
      runId: "run-reset-memory-tombstone",
      reason: "context overflow while route-health store was corrupt",
    });
    expect(failedActive).toEqual(expect.objectContaining({ ok: false }));

    await fs.rm(unavailablePath, { force: true });
    await fs.writeFile(healthPath, `${JSON.stringify({ version: 1 })}\n`, "utf8");
    await fs.chmod(healthPath, 0o400);
    const failedClear = await recordChildRouteHealthEvent({
      code: "context_overflow",
      status: "cleared",
      source: "repair_control",
      childSessionKey,
      runId: "run-reset-memory-tombstone",
      reason: "Session reset created a fresh transcript for this child route.",
    });
    await fs.chmod(healthPath, 0o600).catch(() => undefined);
    expect(failedClear).toEqual(expect.objectContaining({ ok: false }));

    const guarded = await guardChildRouteForDelivery({
      childSessionKey,
      context: {
        routeIntent: "followup_reuse",
        targetMethod: "sessions.reset-test",
        requesterSessionKey: "agent:main:main",
        childTargetKind: "subagent",
        registryRecord: trackedRun(childSessionKey),
      },
    });
    expect(guarded).toEqual(
      expect.objectContaining({
        ok: false,
        code: "child_route_health_unavailable",
      }),
    );
  });

  it("reports failure when persisted unavailable tombstones cannot be cleared", async () => {
    const childSessionKey = "agent:main:subagent:stale-persisted-tombstone";
    const healthPath = resolveChildRouteHealthPath();
    const unavailablePath = path.join(path.dirname(healthPath), "route-health-unavailable.json");
    await fs.mkdir(path.dirname(healthPath), { recursive: true });
    await fs.writeFile(healthPath, "{not-json", "utf8");

    const failedActive = await recordChildRouteHealthEvent({
      code: "context_overflow",
      status: "active",
      source: "context_overflow",
      childSessionKey,
      runId: "run-stale-persisted-tombstone",
      reason: "context overflow while route-health store was corrupt",
    });
    expect(failedActive).toEqual(expect.objectContaining({ ok: false }));

    await fs.rm(healthPath, { force: true });
    await fs.rm(unavailablePath, { force: true });
    await fs.mkdir(unavailablePath);
    const repaired = await recordChildRouteHealthEvent({
      code: "context_overflow",
      status: "success",
      source: "agent_lifecycle",
      childSessionKey,
      runId: "run-stale-persisted-tombstone-repaired",
      reason: "ordinary execution completed successfully",
    });
    expect(repaired).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.stringContaining("failed to clear route-health unavailable tombstone"),
      }),
    );
  });

  it("does not clear fail-closed tombstones with unrelated active events", async () => {
    const childSessionKey = "agent:main:subagent:active-event-keeps-tombstone";
    const healthPath = resolveChildRouteHealthPath();
    await fs.mkdir(path.dirname(healthPath), { recursive: true });
    await fs.writeFile(healthPath, "{not-json", "utf8");

    const failedActive = await recordChildRouteHealthEvent({
      code: "context_overflow",
      status: "active",
      source: "context_overflow",
      childSessionKey,
      runId: "run-active-event-keeps-tombstone",
      reason: "context overflow while route-health store was corrupt",
    });
    expect(failedActive).toEqual(expect.objectContaining({ ok: false }));

    await fs.rm(healthPath, { force: true });
    const unrelatedActive = await recordChildRouteHealthEvent({
      code: "edit_failure_threshold",
      status: "active",
      source: "edit_tool",
      childSessionKey,
      runId: "run-active-event-keeps-tombstone",
      reason: "edit failed after storage recovered",
    });
    expect(unrelatedActive).toEqual(expect.objectContaining({ ok: true }));

    const guarded = await guardChildRouteForDelivery({
      childSessionKey,
      context: {
        routeIntent: "followup_reuse",
        targetMethod: "sessions.send",
        requesterSessionKey: "agent:main:main",
        childTargetKind: "subagent",
        registryRecord: trackedRun(childSessionKey),
      },
    });
    expect(guarded).toEqual(
      expect.objectContaining({
        ok: false,
        code: "child_route_health_unavailable",
      }),
    );
  });
});
