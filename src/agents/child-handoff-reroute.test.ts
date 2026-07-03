import { describe, expect, it } from "vitest";
import {
  attachChildCompletionToGeneration,
  buildChildHandoffPacket,
  decideFreshChildReroute,
} from "./child-handoff-reroute.js";
import type { ChildRouteUnhealthyDetails } from "./child-route-health-contract.js";

const unhealthySpawnFresh: ChildRouteUnhealthyDetails = {
  kind: "child_route_unhealthy",
  childSessionKey: "agent:planner:subagent:old-implementer",
  requesterSessionKey: "agent:planner:main",
  deliveryAttemptId: "attempt-old",
  codes: ["context_overflow"],
  recommendedAction: "spawn_fresh",
  stateTransitionRequired: false,
  plannerInstruction: "Start a fresh child with a bounded handoff packet.",
};

describe("child handoff reroute helpers", () => {
  it("builds a bounded redacted handoff packet without raw transcript fields", () => {
    const packet = buildChildHandoffPacket({
      semantic: {
        originalTask: "Finish the stale-child handoff implementation.",
        desiredOutcome: "Planner can continue safely.",
        acceptanceCriteria: Array.from({ length: 30 }, (_, index) => `criterion ${index}`),
        findings: Array.from({ length: 30 }, (_, index) => `finding ${index}`),
        filesInspected: Array.from({ length: 40 }, (_, index) => `src/file-${index}.ts`),
        commandsInspected: Array.from(
          { length: 25 },
          (_, index) => `pnpm test ${index} API_KEY=secret-${index}`,
        ),
        logExcerpts: Array.from(
          { length: 20 },
          (_, index) => `log ${index} token=secret-token-${index} ${"x".repeat(4096)}`,
        ),
        currentNextStep: "Spawn a fresh child.",
        nonGoals: ["Do not ask the old child to summarize."],
      },
      envelope: {
        requesterSessionKey: "agent:planner:main",
        originalChildSessionKey: "agent:planner:subagent:old-implementer",
        oldChildRunId: "run-old",
        recommendedAction: "spawn_fresh",
        targetAgentId: "implementer",
        authProfileKey: "profile-secret",
        credentialSource: "env",
        credentialBucket: "unknown/default",
        oldUnderlyingSessionId: "old-session-id",
        acpBackendOptions: [
          { key: "apiKey", value: "sk-acp-secret", replaySafe: true },
          { key: "credential", value: "credential-secret", replaySafe: true },
          { key: "privateKey", value: "private-key-secret", replaySafe: true },
          { key: "key", value: "generic-key-secret", replaySafe: true },
          { key: "profile", value: "non-secret-profile", replaySafe: true },
        ],
        timestamp: 1_000,
        extra: {
          rawTranscript: ["must not be copied"],
          apiKey: "secret-value",
          nested: { token: "secret-token" },
        },
      },
    });

    const serializedBytes = Buffer.byteLength(JSON.stringify(packet), "utf8");
    expect(serializedBytes).toBeLessThanOrEqual(32 * 1024);
    expect(packet.metadata.bytes).toBe(serializedBytes);
    expect(packet.metadata.semanticBytes).toBeLessThanOrEqual(24 * 1024);
    expect(packet.metadata.envelopeBytes).toBeLessThanOrEqual(8 * 1024);
    expect(packet.metadata.truncated).toBe(true);
    expect(packet.metadata.dropped.filesInspected).toBe(10);
    expect(packet.metadata.dropped.findings).toBe(10);
    expect(packet.metadata.dropped.redactedFields).toBeGreaterThan(0);
    expect(packet.envelope.credentialSource).toBe("env");
    expect(packet.envelope.credentialBucket).toBe("unknown/default");
    expect(packet.envelope.acpBackendOptions?.[0]).toMatchObject({
      key: "apiKey",
      value: "[redacted]",
      replaySafe: false,
    });
    expect(packet.envelope.acpBackendOptions?.[1]).toMatchObject({
      key: "credential",
      value: "[redacted]",
      replaySafe: false,
    });
    expect(packet.envelope.acpBackendOptions?.[2]).toMatchObject({
      key: "privateKey",
      value: "[redacted]",
      replaySafe: false,
    });
    expect(packet.envelope.acpBackendOptions?.[3]).toMatchObject({
      key: "key",
      value: "[redacted]",
      replaySafe: false,
    });
    expect(packet.envelope.acpBackendOptions?.[4]).toMatchObject({
      key: "profile",
      value: "non-secret-profile",
      replaySafe: true,
    });
    expect(JSON.stringify(packet)).not.toContain("must not be copied");
    expect(JSON.stringify(packet)).not.toContain("secret-value");
    expect(JSON.stringify(packet)).not.toContain("secret-token");
    expect(JSON.stringify(packet)).not.toContain("secret-0");
    expect(JSON.stringify(packet)).not.toContain("secret-token-0");
    expect(JSON.stringify(packet)).not.toContain("sk-acp-secret");
    expect(JSON.stringify(packet)).not.toContain("credential-secret");
    expect(JSON.stringify(packet)).not.toContain("private-key-secret");
    expect(JSON.stringify(packet)).not.toContain("generic-key-secret");
  });

  it("reports extra semantic drops after final packet shrinking", () => {
    const findings = Array.from(
      { length: 30 },
      (_, index) => `finding ${index} ${"x".repeat(1500)}`,
    );
    const packet = buildChildHandoffPacket({
      semantic: {
        originalTask: "x".repeat(12 * 1024),
        findings,
        commandsInspected: Array.from({ length: 20 }, (_, index) => `command ${index}`),
        logExcerpts: Array.from({ length: 10 }, (_, index) => `log ${index}`),
      },
      envelope: {
        requesterSessionKey: "agent:planner:main",
        originalChildSessionKey: "agent:planner:subagent:old-reviewer",
        recommendedAction: "spawn_fresh",
        timestamp: 1_000,
      },
    });

    expect(Buffer.byteLength(JSON.stringify(packet), "utf8")).toBeLessThanOrEqual(32 * 1024);
    expect(packet.metadata.dropped.findings).toBe(
      findings.length - (packet.semantic.findings?.length ?? 0),
    );
    expect(packet.metadata.dropped.findings).toBeGreaterThan(10);
  });

  it("creates a fresh-child reroute decision that preserves role but changes generation", () => {
    const decision = decideFreshChildReroute({
      failure: unhealthySpawnFresh,
      semantic: {
        originalTask: "Continue implementation",
        currentNextStep: "Patch tests",
      },
      envelope: {
        requesterSessionKey: "agent:planner:main",
        originalChildSessionKey: "agent:planner:subagent:old-implementer",
        oldChildRunId: "run-old",
        recommendedAction: "spawn_fresh",
        targetAgentId: "implementer",
        oldUnderlyingSessionId: "old-session-id",
        timestamp: 1_000,
      },
      replacement: {
        role: "implementer",
        childSessionKey: "agent:planner:subagent:fresh-implementer",
        runId: "run-fresh",
        underlyingSessionId: "fresh-session-id",
      },
    });

    expect(decision).toMatchObject({
      status: "fresh_child_spawned",
      rejectedOldChild: {
        childSessionKey: "agent:planner:subagent:old-implementer",
        deliveryAttemptId: "attempt-old",
        generation: "run-old",
      },
      freshChild: {
        role: "implementer",
        childSessionKey: "agent:planner:subagent:fresh-implementer",
        runId: "run-fresh",
        underlyingSessionId: "fresh-session-id",
      },
    });
  });

  it("rejects non-spawn actions and same underlying session replacement", () => {
    expect(
      decideFreshChildReroute({
        failure: {
          ...unhealthySpawnFresh,
          codes: ["auth_profile_session_expired"],
          recommendedAction: "reauth",
          stateTransitionRequired: true,
        },
        semantic: { originalTask: "continue" },
        envelope: {
          requesterSessionKey: "agent:planner:main",
          originalChildSessionKey: "agent:planner:subagent:old",
          recommendedAction: "reauth",
          timestamp: 1_000,
        },
        replacement: {
          role: "implementer",
          childSessionKey: "agent:planner:subagent:fresh",
          runId: "run-fresh",
        },
      }),
    ).toMatchObject({
      status: "not_reroutable",
      action: "reauth",
    });

    expect(
      decideFreshChildReroute({
        failure: unhealthySpawnFresh,
        semantic: { originalTask: "continue" },
        envelope: {
          requesterSessionKey: "agent:planner:main",
          originalChildSessionKey: "agent:planner:subagent:old",
          recommendedAction: "spawn_fresh",
          oldUnderlyingSessionId: "same-session",
          timestamp: 1_000,
        },
        replacement: {
          role: "implementer",
          childSessionKey: "agent:planner:subagent:fresh",
          runId: "run-fresh",
          underlyingSessionId: "same-session",
        },
      }),
    ).toMatchObject({
      status: "not_reroutable",
      action: "stop",
    });
  });

  it("attaches late old-child completions only to the old generation", () => {
    expect(
      attachChildCompletionToGeneration({
        completionRunId: "run-old",
        completionChildSessionKey: "agent:planner:subagent:old",
        freshRunId: "run-fresh",
        freshChildSessionKey: "agent:planner:subagent:fresh",
      }),
    ).toEqual({
      status: "old_generation_completion",
      runId: "run-old",
      childSessionKey: "agent:planner:subagent:old",
    });

    expect(
      attachChildCompletionToGeneration({
        completionRunId: "run-fresh",
        completionChildSessionKey: "agent:planner:subagent:fresh",
        freshRunId: "run-fresh",
        freshChildSessionKey: "agent:planner:subagent:fresh",
      }),
    ).toEqual({
      status: "fresh_child_completion",
      runId: "run-fresh",
      childSessionKey: "agent:planner:subagent:fresh",
    });
  });
});
