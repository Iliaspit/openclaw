import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeCompleteReport } from "../delegation/ledger.test-helpers.js";
import { createDelegationGuardTool } from "./delegation-guard-tool.js";

const runtimeMocks = vi.hoisted(() => ({
  guard: {
    validator: {
      id: "delegation-test-validator",
      version: "1.0.0",
      sha256: "a".repeat(64),
      entrypoint: "/opt/openclaw/protected/delegation-validator.mjs",
      maxOutputBytes: 64 * 1024,
    },
  },
  ledger: {
    getAssignment: vi.fn(),
    acceptedReceiptForAssignment: vi.fn(),
    isAssignmentCompleted: vi.fn(),
    latestValidationRejectedRouteForAssignment: vi.fn(),
    rejectedReceiptForAssignment: vi.fn(),
    latestPreReceiptReportRejection: vi.fn(),
    adoptCompletedDiscoveryReceipt: vi.fn(),
    appendFormatCorrection: vi.fn(),
    getReceipt: vi.fn(),
    getValidationForReceipt: vi.fn(),
    promoteRecordedTerminalCompletion: vi.fn(),
  },
}));

vi.mock("../delegation/runtime.js", () => ({
  assertDelegationWorkerSandbox: vi.fn(),
  requireCurrentDelegationCandidate: vi.fn(),
  resolveDelegationReportCandidate: vi.fn(),
  resolveDelegationRepositoryRoot: vi.fn(),
  requireDelegationController: () => ({
    controllerAgentId: "planner",
    runtime: { guard: runtimeMocks.guard, ledger: runtimeMocks.ledger },
  }),
}));

describe("delegation guard completion visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeMocks.ledger.acceptedReceiptForAssignment.mockReturnValue(undefined);
    runtimeMocks.ledger.isAssignmentCompleted.mockReturnValue(false);
    runtimeMocks.ledger.latestValidationRejectedRouteForAssignment.mockReturnValue(undefined);
    runtimeMocks.ledger.rejectedReceiptForAssignment.mockReturnValue(undefined);
    runtimeMocks.ledger.latestPreReceiptReportRejection.mockReturnValue(undefined);
    runtimeMocks.ledger.appendFormatCorrection.mockReturnValue("receipt-corrected");
    runtimeMocks.ledger.getReceipt.mockReturnValue({
      receiptId: "receipt-corrected",
      assignmentId: "assignment-1",
      semanticDigest: "semantic-digest",
    });
    runtimeMocks.ledger.getValidationForReceipt.mockReturnValue(undefined);
    runtimeMocks.ledger.promoteRecordedTerminalCompletion.mockReturnValue(undefined);
  });

  it("retrieves a durable pre-receipt rejection after the worker is gone", async () => {
    runtimeMocks.ledger.getAssignment.mockReturnValue({
      assignmentId: "assignment-1",
      controllerAgentId: "planner",
      controllerSessionKey: "agent:planner:main",
    });
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

  it("returns terminal completion rejection instead of awaiting an accepted report forever", async () => {
    runtimeMocks.ledger.getAssignment.mockReturnValue({
      assignmentId: "assignment-1",
      controllerAgentId: "planner",
      controllerSessionKey: "agent:planner:main",
    });
    runtimeMocks.ledger.acceptedReceiptForAssignment.mockReturnValue({
      receiptId: "receipt-accepted",
      semanticDigest: "digest-accepted",
    });
    runtimeMocks.ledger.latestValidationRejectedRouteForAssignment.mockReturnValue({
      eventId: "event-terminal-rejection",
      payload: { runId: "run-1", code: "run-timeout-after-report" },
      createdAt: 789,
    });
    const tool = createDelegationGuardTool({
      config: {},
      agentSessionKey: "agent:planner:main",
    });

    const result = await tool.execute("call-2", {
      action: "validate_completion",
      assignmentId: "assignment-1",
    });

    expect(runtimeMocks.ledger.latestValidationRejectedRouteForAssignment).toHaveBeenCalledWith(
      "assignment-1",
      "receipt-accepted",
    );
    expect(result.details).toEqual({
      status: "completion_rejected",
      action: "validate_completion",
      assignmentId: "assignment-1",
      errorCode: "terminal_validation_rejected",
      message: "The worker route ended without a valid protected terminal completion.",
      eventId: "event-terminal-rejection",
      receiptId: "receipt-accepted",
      semanticDigest: "digest-accepted",
      code: "run-timeout-after-report",
      runId: "run-1",
      createdAt: 789,
    });
  });

  it("requires trusted operator authority for discovery receipt adoption", async () => {
    const tool = createDelegationGuardTool({
      config: {},
      agentSessionKey: "agent:planner:main",
      senderIsOwner: false,
    });

    const result = await tool.execute("call-adopt-forbidden", {
      action: "adopt_discovery_receipt",
      targetAssignmentId: "assignment-target",
      sourceReceiptId: "receipt-source",
      sourceBlockingAssignmentId: "assignment-blocking",
      operatorId: "operator@example.com",
      reason: "authorized correction",
      ticket: "OPS-1",
      idempotencyKey: "adopt-1",
    });

    expect(result.details).toEqual({
      status: "forbidden",
      error: "Discovery receipt adoption requires trusted operator authority.",
    });
    expect(runtimeMocks.ledger.adoptCompletedDiscoveryReceipt).not.toHaveBeenCalled();
  });

  it("passes one exact owner-authorized discovery adoption to the protected ledger", async () => {
    runtimeMocks.ledger.adoptCompletedDiscoveryReceipt.mockReturnValue({
      adoptionId: "discovery-receipt-adoption-1",
      targetSliceId: "slice-target",
      targetAssignmentId: "assignment-target",
      sourceReceiptId: "receipt-source",
      sourceBlockingAssignmentId: "assignment-blocking",
      authorizationDigest: "authorization-digest",
      alreadyAdopted: false,
      discoveryPrerequisiteSatisfied: true,
    });
    const tool = createDelegationGuardTool({
      config: {},
      agentSessionKey: "agent:planner:main",
      senderIsOwner: true,
    });

    const result = await tool.execute("call-adopt", {
      action: "adopt_discovery_receipt",
      targetAssignmentId: "assignment-target",
      sourceReceiptId: "receipt-source",
      sourceBlockingAssignmentId: "assignment-blocking",
      operatorId: "operator@example.com",
      reason: "authorized correction",
      ticket: "OPS-1",
      idempotencyKey: "adopt-1",
    });

    expect(runtimeMocks.ledger.adoptCompletedDiscoveryReceipt).toHaveBeenCalledWith({
      targetAssignmentId: "assignment-target",
      sourceReceiptId: "receipt-source",
      sourceBlockingAssignmentId: "assignment-blocking",
      controllerAgentId: "planner",
      controllerSessionKey: "agent:planner:main",
      operator: {
        id: "operator@example.com",
        reason: "authorized correction",
        ticket: "OPS-1",
      },
      idempotencyKey: "adopt-1",
    });
    expect(result.details).toMatchObject({
      status: "ok",
      action: "adopt_discovery_receipt",
      adoptionId: "discovery-receipt-adoption-1",
      authorizationDigest: "authorization-digest",
    });
  });

  it("rejects a correction without a complete report before protected persistence", async () => {
    runtimeMocks.ledger.getAssignment.mockReturnValue({
      assignmentId: "assignment-1",
      controllerAgentId: "planner",
      controllerSessionKey: "agent:planner:main",
    });
    const tool = createDelegationGuardTool({
      config: {},
      agentSessionKey: "agent:planner:main",
    });

    const result = await tool.execute("call-correction-missing-report", {
      action: "format_correction",
      assignmentId: "assignment-1",
      originalReceiptId: "receipt-original",
    });

    expect(result.details).toEqual({
      status: "error",
      error:
        "Format correction requires one complete report payload that satisfies the protected worker-report schema.",
    });
    expect(runtimeMocks.ledger.appendFormatCorrection).not.toHaveBeenCalled();
  });

  it("canonicalizes correction evidence through the assignment-bound report path", async () => {
    const assignment = {
      assignmentId: "assignment-1",
      sliceId: "slice-1",
      candidateId: "candidate-1",
      waveId: "wave-1",
      controllerAgentId: "planner",
      controllerSessionKey: "agent:planner:main",
      workerAgentId: "reviewer",
      role: "reviewer" as const,
      requiredThinking: "high" as const,
      requiredModel: "openai/gpt-5.4",
      workspaceAccess: "ro" as const,
      scopeUnits: ["src/one.ts"],
      routeFamilyId: "route-family-1",
      purpose: "verification" as const,
      epoch: 14,
      issuedAt: 1,
    };
    runtimeMocks.ledger.getAssignment.mockReturnValue(assignment);
    runtimeMocks.ledger.getValidationForReceipt.mockReturnValue({
      validationId: "validation-corrected",
      receiptId: "receipt-corrected",
      outcome: "accepted",
      validatorId: runtimeMocks.guard.validator.id,
      validatorVersion: runtimeMocks.guard.validator.version,
      validatorDigest: runtimeMocks.guard.validator.sha256,
      issues: [],
    });
    runtimeMocks.ledger.promoteRecordedTerminalCompletion.mockReturnValue("terminal-corrected");
    const report = makeCompleteReport({ assigned: ["src/one.ts"] });
    report.commands[0].evidenceId = "E1";
    report.scope.inspected[0].evidenceIds = ["E1"];
    const tool = createDelegationGuardTool({
      config: {},
      agentSessionKey: "agent:planner:main",
    });

    const result = await tool.execute("call-correction", {
      action: "format_correction",
      assignmentId: assignment.assignmentId,
      originalReceiptId: "receipt-original",
      report,
    });

    expect(runtimeMocks.ledger.appendFormatCorrection).toHaveBeenCalledWith({
      assignmentId: assignment.assignmentId,
      originalReceiptId: "receipt-original",
      report: expect.objectContaining({
        commands: [expect.objectContaining({ evidenceId: expect.stringMatching(/^evidence_/) })],
        scope: expect.objectContaining({
          inspected: [
            expect.objectContaining({ evidenceIds: [expect.stringMatching(/^evidence_/)] }),
          ],
        }),
      }),
    });
    const persisted = runtimeMocks.ledger.appendFormatCorrection.mock.calls[0]?.[0].report;
    expect(persisted.commands[0].evidenceId).toBe(persisted.scope.inspected[0].evidenceIds[0]);
    expect(result.details).toMatchObject({
      status: "accepted",
      receiptId: "receipt-corrected",
      validationId: "validation-corrected",
      terminalReceiptId: "terminal-corrected",
      evidenceIdentity: {
        assignmentId: assignment.assignmentId,
        mapping: [
          {
            localId: "E1",
            canonicalId: persisted.commands[0].evidenceId,
          },
        ],
      },
    });
    expect(report.commands[0].evidenceId).toBe("E1");
  });
});
