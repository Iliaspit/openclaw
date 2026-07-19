import { describe, expect, it } from "vitest";
import {
  assessSubagentSliceBudget,
  recordSubagentSliceFullE2EGateGreen,
  recordSubagentSliceRouteHealthUnavailable,
  recordSubagentSliceSpawn,
  recordSubagentSliceTerminalOutcome,
} from "./subagent-registry-budget.js";
import type { SubagentRunRecord, SubagentSliceBudgetRecord } from "./subagent-registry.types.js";

function createRunEntry(
  runId: string,
  overrides: Partial<SubagentRunRecord> = {},
): SubagentRunRecord {
  return {
    runId,
    childSessionKey: `agent:implementer:subagent:${runId}`,
    requesterSessionKey: "agent:planner-2:main",
    requesterDisplayKey: "planner-2",
    task: "Recover the Contract V2 E2E gate without broad retries.",
    cleanup: "keep",
    label: "contract-v2-recovery",
    createdAt: 1_000,
    startedAt: 1_000,
    ...overrides,
  };
}

function identityInput() {
  return {
    requesterSessionKey: "agent:planner-2:main",
    targetAgentId: "implementer",
    label: "contract-v2-recovery",
    task: "Recover the Contract V2 E2E gate without broad retries.",
  };
}

function protectedIdentityInput(overrides: {
  delegationAssignmentId: string;
  delegationSliceId: string;
  delegationEpoch: number;
}) {
  return {
    ...identityInput(),
    ...overrides,
  };
}

describe("subagent registry slice budgets", () => {
  it("blocks a planner slice before another child after two same-slice timeouts", () => {
    const budgets = new Map<string, SubagentSliceBudgetRecord>();
    const first = createRunEntry("run-timeout-1", {
      endedAt: 31_000,
      outcome: { status: "timeout" },
    });
    const second = createRunEntry("run-timeout-2", {
      endedAt: 62_000,
      outcome: { status: "timeout" },
    });

    recordSubagentSliceSpawn({ budgets, entry: first, observedAt: 1_000 });
    recordSubagentSliceTerminalOutcome({
      budgets,
      entry: first,
      observedAt: 31_000,
      evidenceGapKind: "timeout",
    });
    expect(assessSubagentSliceBudget({ budgets, identityInput: identityInput() }).ok).toBe(true);

    recordSubagentSliceSpawn({ budgets, entry: second, observedAt: 32_000 });
    recordSubagentSliceTerminalOutcome({
      budgets,
      entry: second,
      observedAt: 62_000,
      evidenceGapKind: "timeout",
    });

    const assessment = assessSubagentSliceBudget({ budgets, identityInput: identityInput() });
    expect(assessment.ok).toBe(false);
    if (!assessment.ok) {
      expect(assessment.kind).toBe("timeout_limit");
      expect(assessment.error).toContain("run-timeout-1");
      expect(assessment.error).toContain("run-timeout-2");
      expect(assessment.error).toContain("taskSha256=");
      expect(assessment.error).not.toContain("Recover the Contract V2");
    }
  });

  it("does not reset timeout counters after later no-final or successful outcomes", () => {
    const budgets = new Map<string, SubagentSliceBudgetRecord>();
    const timeout = createRunEntry("run-timeout", {
      endedAt: 31_000,
      outcome: { status: "timeout" },
    });
    const noFinal = createRunEntry("run-no-final", {
      endedAt: 45_000,
      outcome: { status: "error", error: "no visible final reply" },
    });
    const success = createRunEntry("run-success", {
      endedAt: 55_000,
      outcome: { status: "ok" },
    });

    for (const entry of [timeout, noFinal, success]) {
      recordSubagentSliceSpawn({ budgets, entry, observedAt: entry.createdAt });
      recordSubagentSliceTerminalOutcome({
        budgets,
        entry,
        observedAt: entry.endedAt,
        evidenceGapKind:
          entry.runId === "run-timeout"
            ? "timeout"
            : entry.runId === "run-no-final"
              ? "no_visible_final"
              : undefined,
      });
    }

    const assessment = assessSubagentSliceBudget({ budgets, identityInput: identityInput() });
    expect(assessment.ok).toBe(true);
    expect(assessment.budget).toMatchObject({
      childSpawnCount: 3,
      childTimeoutCount: 1,
      terminalEvidenceGapCount: 2,
      fullE2EGateGreen: "unknown",
      fullE2EGateSignal: "unavailable",
    });
  });

  it("escalates repeated structured route-health unavailable evidence", () => {
    const budgets = new Map<string, SubagentSliceBudgetRecord>();

    const first = recordSubagentSliceRouteHealthUnavailable({
      budgets,
      identityInput: identityInput(),
      childSessionKey: "agent:implementer:subagent:route-1",
      observedAt: 1_000,
    });
    expect(first.ok).toBe(true);

    const second = recordSubagentSliceRouteHealthUnavailable({
      budgets,
      identityInput: identityInput(),
      childSessionKey: "agent:implementer:subagent:route-2",
      observedAt: 2_000,
    });

    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.kind).toBe("route_health_unavailable_limit");
      expect(second.error).toContain("route/system health blocker");
      expect(second.error).toContain("childRouteHealthUnavailableCount=2");
      expect(second.error).toContain("route-1");
      expect(second.error).toContain("route-2");
    }
  });

  it("retains historical protected failures without admitting them into a fresh assignment", () => {
    const budgets = new Map<string, SubagentSliceBudgetRecord>();
    const historical = protectedIdentityInput({
      delegationAssignmentId: "assignment_historical",
      delegationSliceId: "slice_historical",
      delegationEpoch: 9,
    });
    const fresh = protectedIdentityInput({
      delegationAssignmentId: "assignment_fresh",
      delegationSliceId: "slice_fresh",
      delegationEpoch: 11,
    });

    recordSubagentSliceRouteHealthUnavailable({
      budgets,
      identityInput: historical,
      childSessionKey: "agent:implementer:subagent:historical-1",
      observedAt: 1_784_195_005_700,
    });
    const historicalBlock = recordSubagentSliceRouteHealthUnavailable({
      budgets,
      identityInput: historical,
      childSessionKey: "agent:implementer:subagent:historical-2",
      observedAt: 1_784_195_072_359,
    });
    expect(historicalBlock.ok).toBe(false);

    const freshAdmission = assessSubagentSliceBudget({
      budgets,
      identityInput: fresh,
    });
    expect(freshAdmission.ok).toBe(true);
    expect(freshAdmission.sliceKey).not.toBe(historicalBlock.sliceKey);
    expect(budgets.size).toBe(1);

    recordSubagentSliceRouteHealthUnavailable({
      budgets,
      identityInput: fresh,
      childSessionKey: "agent:implementer:subagent:fresh-1",
      observedAt: 1_784_300_000_000,
    });
    const freshBlock = recordSubagentSliceRouteHealthUnavailable({
      budgets,
      identityInput: fresh,
      childSessionKey: "agent:implementer:subagent:fresh-2",
      observedAt: 1_784_300_001_000,
    });

    expect(freshBlock.ok).toBe(false);
    if (!freshBlock.ok) {
      expect(freshBlock.error).toContain("delegationAssignmentId=assignment_fresh");
      expect(freshBlock.error).toContain("delegationSliceId=slice_fresh");
      expect(freshBlock.error).toContain("delegationEpoch=11");
      expect(freshBlock.error).toContain("fresh-1");
      expect(freshBlock.error).toContain("fresh-2");
      expect(freshBlock.error).toContain("firstObservedAt=1784300000000");
      expect(freshBlock.error).not.toContain("assignment_historical");
      expect(freshBlock.error).not.toContain("historical-1");
      expect(freshBlock.error).not.toContain("1784195005700");
    }

    const nextEpochAdmission = assessSubagentSliceBudget({
      budgets,
      identityInput: protectedIdentityInput({
        delegationAssignmentId: "assignment_next",
        delegationSliceId: "slice_next",
        delegationEpoch: 12,
      }),
    });
    expect(nextEpochAdmission.ok).toBe(true);
    expect(nextEpochAdmission.sliceKey).not.toBe(freshBlock.sliceKey);
    expect(budgets.size).toBe(2);
  });

  it("fails closed when protected budget scope is only partially supplied", () => {
    expect(() =>
      assessSubagentSliceBudget({
        budgets: new Map(),
        identityInput: {
          ...identityInput(),
          delegationAssignmentId: "assignment_partial",
        },
      }),
    ).toThrow("requires exact assignment, slice, and epoch");
  });

  it("records protected run lifecycle evidence only under its exact protected identity", () => {
    const budgets = new Map<string, SubagentSliceBudgetRecord>();
    const protectedRun = createRunEntry("run-protected", {
      delegationAssignmentId: "assignment_run",
      delegationSliceId: "slice_run",
      delegationEpoch: 11,
    });

    recordSubagentSliceSpawn({
      budgets,
      entry: protectedRun,
      observedAt: 10_000,
    });
    const protectedAssessment = assessSubagentSliceBudget({
      budgets,
      identityInput: protectedIdentityInput({
        delegationAssignmentId: "assignment_run",
        delegationSliceId: "slice_run",
        delegationEpoch: 11,
      }),
    });
    expect(protectedAssessment.ok).toBe(true);
    expect(protectedAssessment.budget).toMatchObject({
      delegationAssignmentId: "assignment_run",
      delegationSliceId: "slice_run",
      delegationEpoch: 11,
      childSpawnCount: 1,
    });

    const legacyAssessment = assessSubagentSliceBudget({
      budgets,
      identityInput: identityInput(),
    });
    expect(legacyAssessment.ok).toBe(true);
    expect(legacyAssessment.budget).toBeUndefined();
    expect(legacyAssessment.sliceKey).not.toBe(protectedAssessment.sliceKey);
  });

  it("moves post-green review work into a follow-up slice unless explicitly continued", () => {
    const budgets = new Map<string, SubagentSliceBudgetRecord>();
    const fullGate = createRunEntry("run-full-gate", {
      sliceRole: "full_gate",
      endedAt: 20_000,
      outcome: { status: "ok" },
    });

    recordSubagentSliceSpawn({ budgets, entry: fullGate, observedAt: 1_000 });
    expect(
      recordSubagentSliceFullE2EGateGreen({
        budgets,
        entry: fullGate,
        observedAt: 20_000,
      }),
    ).toBe(true);
    const originalSliceKey = fullGate.sliceBudgetKey;
    expect(originalSliceKey).toBeTruthy();
    expect(budgets.get(originalSliceKey ?? "")).toMatchObject({
      fullE2EGateGreen: true,
      fullE2EGateSignal: "observed",
    });

    const review = createRunEntry("run-review", {
      sliceRole: "review",
      createdAt: 21_000,
      startedAt: 21_000,
    });
    recordSubagentSliceSpawn({ budgets, entry: review, observedAt: 21_000 });
    expect(review.sliceBudgetKey).toBeTruthy();
    expect(review.sliceBudgetKey).not.toBe(originalSliceKey);
    expect(budgets.get(review.sliceBudgetKey ?? "")).toMatchObject({
      sliceRole: "review",
      sliceBoundary: "post_full_gate_followup",
      parentSliceKey: originalSliceKey,
      childSpawnCount: 1,
    });

    const explicitContinuation = assessSubagentSliceBudget({
      budgets,
      identityInput: {
        ...identityInput(),
        sliceRole: "review",
        sliceContinuation: "same",
      },
    });
    expect(explicitContinuation.sliceKey).toBe(originalSliceKey);
    expect(explicitContinuation.budget).toMatchObject({
      fullE2EGateGreen: true,
      fullE2EGateSignal: "observed",
    });
  });
});
