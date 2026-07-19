import { describe, expect, it, vi } from "vitest";
import { createDelegationGuardTool } from "./delegation-guard-tool.js";

const runtimeMocks = vi.hoisted(() => ({
  ledger: {
    getAssignment: vi.fn(),
    acceptedReceiptForAssignment: vi.fn(),
    isAssignmentCompleted: vi.fn(),
    rejectedReceiptForAssignment: vi.fn(),
    latestPreReceiptReportRejection: vi.fn(),
  },
}));

vi.mock("../delegation/runtime.js", () => ({
  assertDelegationWorkerSandbox: vi.fn(),
  requireCurrentDelegationCandidate: vi.fn(),
  resolveDelegationReportCandidate: vi.fn(),
  resolveDelegationRepositoryRoot: vi.fn(),
  requireDelegationController: () => ({
    controllerAgentId: "planner",
    runtime: { ledger: runtimeMocks.ledger },
  }),
}));

describe("delegation guard completion visibility", () => {
  it("retrieves a durable pre-receipt rejection after the worker is gone", async () => {
    runtimeMocks.ledger.getAssignment.mockReturnValue({
      assignmentId: "assignment-1",
      controllerAgentId: "planner",
      controllerSessionKey: "agent:planner:main",
    });
    runtimeMocks.ledger.acceptedReceiptForAssignment.mockReturnValue(undefined);
    runtimeMocks.ledger.isAssignmentCompleted.mockReturnValue(false);
    runtimeMocks.ledger.rejectedReceiptForAssignment.mockReturnValue(undefined);
    runtimeMocks.ledger.latestPreReceiptReportRejection.mockReturnValue({
      auditEventId: "audit-1",
      assignmentId: "assignment-1",
      sliceId: "slice-1",
      routeFamilyId: "route-family-1",
      workerAgentId: "helper",
      errorCode: "newly_discovered_invalid",
      submittedSemanticDigest: "digest-1",
      message: "invalid late dependency",
      reportBytes: 123,
      createdAt: 456,
    });
    const tool = createDelegationGuardTool({
      config: {},
      agentSessionKey: "agent:planner:main",
    });

    const result = await tool.execute("call-1", {
      action: "validate_completion",
      assignmentId: "assignment-1",
    });

    expect(result.details).toEqual({
      status: "report_rejected_before_receipt",
      action: "validate_completion",
      assignmentId: "assignment-1",
      sliceId: "slice-1",
      routeFamilyId: "route-family-1",
      workerAgentId: "helper",
      errorCode: "newly_discovered_invalid",
      submittedSemanticDigest: "digest-1",
      message: "invalid late dependency",
      auditEventId: "audit-1",
      reportBytes: 123,
      createdAt: 456,
    });
  });
});
