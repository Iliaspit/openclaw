import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DelegationAssignmentRecord } from "../delegation/contracts.js";
import { resolveDelegationGuardConfig } from "../delegation/policy.js";
import { createDelegationGuardTestConfig } from "../delegation/test-helpers.js";

const mocks = vi.hoisted(() => ({
  assertWorkerSandbox: vi.fn(),
  captureEvidence: vi.fn(),
  requireCurrentCandidate: vi.fn(),
  resolveCaller: vi.fn(),
  resolveInitializedRuntime: vi.fn(),
}));

vi.mock("../delegation/runtime.js", () => ({
  assertDelegationWorkerSandbox: mocks.assertWorkerSandbox,
  requireCurrentDelegationCandidate: mocks.requireCurrentCandidate,
  resolveDelegationCallerAgentId: mocks.resolveCaller,
  resolveInitializedDelegationRuntime: mocks.resolveInitializedRuntime,
}));

vi.mock("../delegation/runtime-evidence.js", () => ({
  captureDelegationRuntimeEvidence: mocks.captureEvidence,
}));

import { createDelegationEvidenceTool } from "./delegation-evidence-tool.js";

function assignment(): DelegationAssignmentRecord {
  return {
    assignmentId: "assignment-evidence",
    sliceId: "slice-evidence",
    candidateId: "candidate-evidence",
    waveId: "wave-evidence",
    controllerAgentId: "planner",
    controllerSessionKey: "agent:planner:main",
    workerAgentId: "tester",
    role: "tester",
    requiredThinking: "medium",
    requiredModel: "openai/gpt-5.4",
    workspaceAccess: "ro",
    scopeUnits: ["src/one.ts"],
    routeFamilyId: "route-family-evidence",
    purpose: "verification",
    epoch: 14,
    issuedAt: 1,
  };
}

function details(result: unknown): Record<string, unknown> {
  return (result as { details: Record<string, unknown> }).details;
}

describe("guarded delegation runtime evidence tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveCaller.mockReturnValue("tester");
    mocks.requireCurrentCandidate.mockResolvedValue({ candidateId: "candidate-evidence" });
    mocks.captureEvidence.mockResolvedValue({ snapshotDigest: "a".repeat(64) });
  });

  it("uses only the initialized read-only runtime and exact assignment-bound identity", async () => {
    const config = createDelegationGuardTestConfig();
    const guard = resolveDelegationGuardConfig(config);
    if (!guard) {
      throw new Error("test guard is missing");
    }
    const currentAssignment = assignment();
    const ledger = {
      resolveAssignmentForChildSession: vi.fn(() => currentAssignment),
    };
    mocks.resolveInitializedRuntime.mockReturnValue({
      guard,
      policyDigest: "b".repeat(64),
      ledger,
    });
    const tool = createDelegationEvidenceTool({
      config,
      agentSessionKey: "agent:tester:subagent:evidence",
      requesterAgentIdOverride: "tester",
      effectiveThinking: "medium",
    });

    expect(details(await tool.execute("evidence", {}))).toMatchObject({
      status: "ok",
      evidence: { snapshotDigest: "a".repeat(64) },
    });
    expect(ledger.resolveAssignmentForChildSession).toHaveBeenCalledWith(
      "agent:tester:subagent:evidence",
    );
    expect(mocks.captureEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        assignmentId: currentAssignment.assignmentId,
        childSessionKey: "agent:tester:subagent:evidence",
      }),
    );
    expect(mocks.requireCurrentCandidate).toHaveBeenCalledTimes(2);
  });

  it("authorizes an exact reviewer assignment through the same read-only surface", async () => {
    const config = createDelegationGuardTestConfig();
    const guard = resolveDelegationGuardConfig(config);
    if (!guard) {
      throw new Error("test guard is missing");
    }
    const reviewerAssignment: DelegationAssignmentRecord = {
      ...assignment(),
      assignmentId: "assignment-reviewer-evidence",
      workerAgentId: "reviewer",
      role: "reviewer",
      requiredThinking: "high",
    };
    mocks.resolveCaller.mockReturnValue("reviewer");
    mocks.resolveInitializedRuntime.mockReturnValue({
      guard,
      policyDigest: "b".repeat(64),
      ledger: { resolveAssignmentForChildSession: () => reviewerAssignment },
    });
    const tool = createDelegationEvidenceTool({
      config,
      agentSessionKey: "agent:reviewer:subagent:evidence",
      requesterAgentIdOverride: "reviewer",
      effectiveThinking: "high",
    });

    expect(details(await tool.execute("reviewer-evidence", {}))).toMatchObject({ status: "ok" });
  });

  it("fails closed without exposing an internal capture error", async () => {
    const config = createDelegationGuardTestConfig();
    const guard = resolveDelegationGuardConfig(config);
    if (!guard) {
      throw new Error("test guard is missing");
    }
    mocks.resolveInitializedRuntime.mockReturnValue({
      guard,
      policyDigest: "b".repeat(64),
      ledger: { resolveAssignmentForChildSession: () => assignment() },
    });
    mocks.captureEvidence.mockRejectedValue(
      new Error("/host/secret/path delegation.sqlite docker.sock token"),
    );
    const tool = createDelegationEvidenceTool({
      config,
      agentSessionKey: "agent:tester:subagent:evidence",
      requesterAgentIdOverride: "tester",
      effectiveThinking: "medium",
    });

    const result = details(await tool.execute("evidence", {}));
    expect(result).toEqual({
      status: "error",
      errorCode: "runtime_evidence_capture_failed",
      error: "Installed runtime evidence capture failed closed.",
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("rejects a non-verifier principal before reading assignment state", async () => {
    const config = createDelegationGuardTestConfig();
    const guard = resolveDelegationGuardConfig(config);
    if (!guard) {
      throw new Error("test guard is missing");
    }
    mocks.resolveCaller.mockReturnValue("implementer");
    const resolveAssignmentForChildSession = vi.fn();
    mocks.resolveInitializedRuntime.mockReturnValue({
      guard,
      policyDigest: "b".repeat(64),
      ledger: { resolveAssignmentForChildSession },
    });
    const tool = createDelegationEvidenceTool({
      config,
      agentSessionKey: "agent:implementer:subagent:evidence",
      requesterAgentIdOverride: "implementer",
      effectiveThinking: "medium",
    });

    expect(details(await tool.execute("evidence", {}))).toMatchObject({ status: "forbidden" });
    expect(resolveAssignmentForChildSession).not.toHaveBeenCalled();
    expect(mocks.captureEvidence).not.toHaveBeenCalled();
  });

  it("fails closed for missing runtime, wrong thinking, model mismatch, and sandbox failure", async () => {
    const config = createDelegationGuardTestConfig();
    const guard = resolveDelegationGuardConfig(config);
    if (!guard) {
      throw new Error("test guard is missing");
    }
    mocks.resolveInitializedRuntime.mockReturnValue(undefined);
    const baseOptions = {
      config,
      agentSessionKey: "agent:tester:subagent:evidence",
      requesterAgentIdOverride: "tester",
      effectiveThinking: "medium",
    };
    expect(
      details(await createDelegationEvidenceTool(baseOptions).execute("missing-runtime", {})),
    ).toMatchObject({
      status: "error",
      errorCode: "runtime_evidence_unavailable",
    });

    const resolveAssignmentForChildSession = vi.fn(() => assignment());
    mocks.resolveInitializedRuntime.mockReturnValue({
      guard,
      policyDigest: "b".repeat(64),
      ledger: { resolveAssignmentForChildSession },
    });
    expect(
      details(
        await createDelegationEvidenceTool({ ...baseOptions, effectiveThinking: "high" }).execute(
          "wrong-thinking",
          {},
        ),
      ),
    ).toMatchObject({ status: "forbidden" });
    expect(resolveAssignmentForChildSession).not.toHaveBeenCalled();

    resolveAssignmentForChildSession.mockReturnValue({
      ...assignment(),
      requiredModel: "openai/gpt-forged",
    });
    expect(
      details(await createDelegationEvidenceTool(baseOptions).execute("wrong-model", {})),
    ).toMatchObject({ status: "forbidden" });
    expect(mocks.captureEvidence).not.toHaveBeenCalled();

    resolveAssignmentForChildSession.mockReturnValue(assignment());
    mocks.assertWorkerSandbox.mockImplementationOnce(() => {
      throw new Error("/host/private/sandbox/path");
    });
    const sandboxFailure = details(
      await createDelegationEvidenceTool(baseOptions).execute("sandbox-failure", {}),
    );
    expect(sandboxFailure).toMatchObject({
      status: "error",
      errorCode: "runtime_evidence_capture_failed",
    });
    expect(JSON.stringify(sandboxFailure)).not.toContain("private");
  });
});
