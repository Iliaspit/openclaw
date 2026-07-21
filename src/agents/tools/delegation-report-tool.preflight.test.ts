import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DelegationAssignmentRecord } from "../delegation/contracts.js";
import { hashDelegationReportSemantics } from "../delegation/ledger.js";
import { makeCompleteReport } from "../delegation/ledger.test-helpers.js";
import { resolveDelegationGuardConfig } from "../delegation/policy.js";
import { DelegationReportContractError } from "../delegation/report-result.js";
import { createDelegationGuardTestConfig } from "../delegation/test-helpers.js";

const mocks = vi.hoisted(() => ({
  assertAssignmentScopeCurrent: vi.fn(),
  assertWorkerSandbox: vi.fn(),
  requireCurrentCandidate: vi.fn(),
  resolveCaller: vi.fn(),
  resolveReportCandidate: vi.fn(),
  resolveRuntime: vi.fn(),
  runValidator: vi.fn(),
}));

vi.mock("../delegation/runtime.js", () => ({
  assertDelegationAssignmentScopeCurrent: mocks.assertAssignmentScopeCurrent,
  assertDelegationWorkerSandbox: mocks.assertWorkerSandbox,
  requireCurrentDelegationCandidate: mocks.requireCurrentCandidate,
  resolveDelegationCallerAgentId: mocks.resolveCaller,
  resolveDelegationReportCandidate: mocks.resolveReportCandidate,
  resolveDelegationRuntime: mocks.resolveRuntime,
}));

vi.mock("../delegation/validator.js", () => ({
  runPinnedDelegationValidator: mocks.runValidator,
}));

import { createDelegationReportTool } from "./delegation-report-tool.js";

function assignment(): DelegationAssignmentRecord {
  return {
    assignmentId: "assignment-preflight",
    sliceId: "slice-preflight",
    candidateId: "candidate-preflight",
    waveId: "wave-preflight",
    controllerAgentId: "planner",
    controllerSessionKey: "agent:planner:main",
    workerAgentId: "tester",
    role: "tester",
    requiredThinking: "medium",
    requiredModel: "openai/gpt-5.4",
    workspaceAccess: "ro",
    scopeUnits: ["src/one.ts"],
    routeFamilyId: "route-family-preflight",
    purpose: "verification",
    epoch: 14,
    issuedAt: 1,
  };
}

function toolResultDetails(result: unknown): Record<string, unknown> {
  return (result as { details: Record<string, unknown> }).details;
}

describe("delegation report preflight", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveCaller.mockReturnValue("tester");
  });

  it("runs the exact canonical validator payload without persistence, then submits it", async () => {
    const config = createDelegationGuardTestConfig();
    const guard = resolveDelegationGuardConfig(config);
    if (!guard) {
      throw new Error("test guard is missing");
    }
    const currentAssignment = assignment();
    const appendValidatedReceipt = vi.fn(() => ({
      receiptId: "receipt-preflight",
      validationId: "validation-preflight",
      semanticDigest: "semantic-preflight",
    }));
    const appendPreReceiptReportRejection = vi.fn();
    const runtime = {
      guard,
      policyDigest: "a".repeat(64),
      ledger: {
        resolveAssignmentForChildSession: () => currentAssignment,
        getSliceScope: () => ({
          controllerAgentId: currentAssignment.controllerAgentId,
          controllerSessionKey: currentAssignment.controllerSessionKey,
          epoch: currentAssignment.epoch,
        }),
        currentEpoch: () => currentAssignment.epoch,
        inspectInitialReportSlot: (params: {
          report: Parameters<typeof hashDelegationReportSemantics>[0];
        }) => ({
          state: "open" as const,
          semanticDigest: hashDelegationReportSemantics(params.report),
        }),
        initialReceiptForAssignment: () => undefined,
        appendPreReceiptReportRejection,
        appendValidatedReceipt,
        appendReceipt: vi.fn(),
        appendValidation: vi.fn(),
        appendRouteEvent: vi.fn(),
        getValidationForReceipt: vi.fn(),
      },
    };
    const candidate = {
      candidateId: currentAssignment.candidateId,
      fingerprint: { candidateDigest: "b".repeat(64) },
    };
    mocks.resolveRuntime.mockReturnValue(runtime);
    mocks.resolveReportCandidate.mockResolvedValue(candidate);
    mocks.requireCurrentCandidate.mockResolvedValue(candidate);
    mocks.runValidator.mockResolvedValue({
      protocol: "openclaw-delegation-validator-v1",
      action: "validate_report",
      ok: true,
    });
    const tool = createDelegationReportTool({
      config,
      agentSessionKey: "agent:tester:subagent:preflight",
      requesterAgentIdOverride: "tester",
      effectiveThinking: "medium",
    });
    const report = makeCompleteReport({ assigned: ["src/one.ts"] });
    report.commands[0].evidenceId = "E1";
    report.scope.inspected[0].evidenceIds = ["E1"];

    const preflight = toolResultDetails(
      await tool.execute("preflight", { action: "preflight", report }),
    );
    expect(preflight).toMatchObject({
      status: "ready",
      action: "preflight",
      assignmentId: currentAssignment.assignmentId,
      persisted: false,
    });
    expect(appendPreReceiptReportRejection).not.toHaveBeenCalled();
    expect(appendValidatedReceipt).not.toHaveBeenCalled();
    const preflightRequest = mocks.runValidator.mock.calls[0]?.[0].request;

    const submitted = toolResultDetails(await tool.execute("submit", { action: "submit", report }));
    expect(submitted).toMatchObject({
      status: "accepted",
      assignmentId: currentAssignment.assignmentId,
      receiptId: "receipt-preflight",
      validationId: "validation-preflight",
    });
    expect(appendValidatedReceipt).toHaveBeenCalledOnce();
    const submitRequest = mocks.runValidator.mock.calls[1]?.[0].request;
    expect(submitRequest.payload.report).toEqual(preflightRequest.payload.report);
    expect(submitRequest.payload.semanticDigest).toBe(preflightRequest.payload.semanticDigest);
    expect(submitRequest.payload.report.commands[0].evidenceId).toMatch(
      /^evidence_[a-f0-9]{16}_[a-f0-9]{64}$/u,
    );
  });

  it("reports a correctable within-report collision without any audit or receipt write", async () => {
    const config = createDelegationGuardTestConfig();
    const guard = resolveDelegationGuardConfig(config);
    if (!guard) {
      throw new Error("test guard is missing");
    }
    const currentAssignment = assignment();
    const appendPreReceiptReportRejection = vi.fn();
    const appendValidatedReceipt = vi.fn();
    mocks.resolveRuntime.mockReturnValue({
      guard,
      policyDigest: "a".repeat(64),
      ledger: {
        resolveAssignmentForChildSession: () => currentAssignment,
        getSliceScope: () => ({
          controllerAgentId: currentAssignment.controllerAgentId,
          controllerSessionKey: currentAssignment.controllerSessionKey,
          epoch: currentAssignment.epoch,
        }),
        currentEpoch: () => currentAssignment.epoch,
        inspectInitialReportSlot: (params: {
          report: Parameters<typeof hashDelegationReportSemantics>[0];
        }) => ({
          state: "open" as const,
          semanticDigest: hashDelegationReportSemantics(params.report),
        }),
        initialReceiptForAssignment: () => undefined,
        appendPreReceiptReportRejection,
        appendValidatedReceipt,
      },
    });
    const tool = createDelegationReportTool({
      config,
      agentSessionKey: "agent:tester:subagent:preflight",
      requesterAgentIdOverride: "tester",
      effectiveThinking: "medium",
    });
    const report = makeCompleteReport({ assigned: ["src/one.ts"] });
    report.artifacts.push({
      evidenceId: report.commands[0].evidenceId,
      sha256: "c".repeat(64),
      kind: "duplicate",
    });

    const result = toolResultDetails(
      await tool.execute("preflight-collision", { action: "preflight", report }),
    );
    expect(result).toMatchObject({
      status: "rejected",
      action: "preflight",
      errorCode: "evidence_identity_invalid",
      persisted: false,
    });
    expect(appendPreReceiptReportRejection).not.toHaveBeenCalled();
    expect(appendValidatedReceipt).not.toHaveBeenCalled();
    expect(mocks.runValidator).not.toHaveBeenCalled();
  });

  it("returns an existing byte-identical rejection without rerunning the validator", async () => {
    const config = createDelegationGuardTestConfig();
    const guard = resolveDelegationGuardConfig(config);
    if (!guard) {
      throw new Error("test guard is missing");
    }
    const currentAssignment = assignment();
    mocks.resolveRuntime.mockReturnValue({
      guard,
      policyDigest: "a".repeat(64),
      ledger: {
        resolveAssignmentForChildSession: () => currentAssignment,
        getSliceScope: () => ({
          controllerAgentId: currentAssignment.controllerAgentId,
          controllerSessionKey: currentAssignment.controllerSessionKey,
          epoch: currentAssignment.epoch,
        }),
        currentEpoch: () => currentAssignment.epoch,
        inspectInitialReportSlot: () => ({
          state: "idempotent" as const,
          receiptId: "receipt-stored",
          semanticDigest: "a".repeat(64),
          validation: {
            validationId: "validation-stored",
            outcome: "rejected" as const,
            validatorId: guard.validator.id,
            validatorVersion: guard.validator.version,
            validatorDigest: guard.validator.sha256,
            issues: [{ code: "format", message: "stored rejection" }],
          },
        }),
        initialReceiptForAssignment: () => ({
          receiptId: "receipt-stored",
          assignmentId: currentAssignment.assignmentId,
          semanticDigest: "a".repeat(64),
          reportJson: "{}",
          correctionOf: null,
        }),
      },
    });
    const tool = createDelegationReportTool({
      config,
      agentSessionKey: "agent:tester:subagent:preflight",
      requesterAgentIdOverride: "tester",
      effectiveThinking: "medium",
    });
    const report = makeCompleteReport({ assigned: ["src/one.ts"] });

    expect(
      toolResultDetails(await tool.execute("preflight-stored", { action: "preflight", report })),
    ).toMatchObject({
      status: "rejected",
      action: "preflight",
      receiptId: "receipt-stored",
      validationId: "validation-stored",
      persisted: true,
      idempotent: true,
    });
    expect(mocks.runValidator).not.toHaveBeenCalled();
  });

  it("fails closed when the immutable report slot is closed or conflicting", async () => {
    const config = createDelegationGuardTestConfig();
    const guard = resolveDelegationGuardConfig(config);
    if (!guard) {
      throw new Error("test guard is missing");
    }
    const currentAssignment = assignment();
    mocks.resolveRuntime.mockReturnValue({
      guard,
      policyDigest: "a".repeat(64),
      ledger: {
        resolveAssignmentForChildSession: () => currentAssignment,
        getSliceScope: () => ({
          controllerAgentId: currentAssignment.controllerAgentId,
          controllerSessionKey: currentAssignment.controllerSessionKey,
          epoch: currentAssignment.epoch,
        }),
        currentEpoch: () => currentAssignment.epoch,
        inspectInitialReportSlot: () => {
          throw new DelegationReportContractError(
            "report_slot_conflict",
            "immutable report differs",
          );
        },
      },
    });
    const tool = createDelegationReportTool({
      config,
      agentSessionKey: "agent:tester:subagent:preflight",
      requesterAgentIdOverride: "tester",
      effectiveThinking: "medium",
    });
    const report = makeCompleteReport({ assigned: ["src/one.ts"] });

    expect(
      toolResultDetails(await tool.execute("preflight-conflict", { action: "preflight", report })),
    ).toMatchObject({
      status: "rejected",
      errorCode: "report_slot_conflict",
      persisted: false,
    });
    expect(mocks.runValidator).not.toHaveBeenCalled();
  });

  it.each(["preflight", "submit"] as const)(
    "rejects writable scope drift during the %s validator window",
    async (action) => {
      const config = createDelegationGuardTestConfig();
      const guard = resolveDelegationGuardConfig(config);
      if (!guard) {
        throw new Error("test guard is missing");
      }
      const currentAssignment: DelegationAssignmentRecord = {
        ...assignment(),
        assignmentId: `assignment-${action}-rw-drift`,
        candidateId: undefined,
        waveId: undefined,
        workerAgentId: "implementer",
        role: "implementer",
        requiredThinking: "xhigh",
        workspaceAccess: "rw",
        purpose: "implementation",
      };
      mocks.resolveCaller.mockReturnValue("implementer");
      mocks.assertAssignmentScopeCurrent
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("scope changed during validation"));
      mocks.resolveReportCandidate.mockResolvedValue(undefined);
      mocks.runValidator.mockResolvedValue({
        protocol: "openclaw-delegation-validator-v1",
        action: "validate_report",
        ok: true,
      });
      const appendValidatedReceipt = vi.fn(() => ({
        receiptId: "receipt-rw-drift",
        validationId: "validation-rw-drift",
        semanticDigest: "a".repeat(64),
      }));
      const appendRouteEvent = vi.fn();
      mocks.resolveRuntime.mockReturnValue({
        guard,
        policyDigest: "a".repeat(64),
        ledger: {
          resolveAssignmentForChildSession: () => currentAssignment,
          getSliceScope: () => ({
            controllerAgentId: currentAssignment.controllerAgentId,
            controllerSessionKey: currentAssignment.controllerSessionKey,
            epoch: currentAssignment.epoch,
          }),
          currentEpoch: () => currentAssignment.epoch,
          inspectInitialReportSlot: (params: {
            report: Parameters<typeof hashDelegationReportSemantics>[0];
          }) => ({
            state: "open" as const,
            semanticDigest: hashDelegationReportSemantics(params.report),
          }),
          initialReceiptForAssignment: () => undefined,
          appendPreReceiptReportRejection: vi.fn(),
          appendValidatedReceipt,
          appendRouteEvent,
        },
      });
      const tool = createDelegationReportTool({
        config,
        agentSessionKey: `agent:implementer:subagent:${action}-rw-drift`,
        requesterAgentIdOverride: "implementer",
        effectiveThinking: "xhigh",
      });
      const report = makeCompleteReport({ assigned: ["src/one.ts"] });

      const result = toolResultDetails(await tool.execute(action, { action, report }));
      expect(result).toMatchObject({
        status: "rejected",
        errorCode: "writable_scope_drift",
      });
      expect(mocks.assertAssignmentScopeCurrent).toHaveBeenCalledTimes(2);
      if (action === "preflight") {
        expect(appendValidatedReceipt).not.toHaveBeenCalled();
        expect(appendRouteEvent).not.toHaveBeenCalled();
      } else {
        expect(appendValidatedReceipt).toHaveBeenCalledOnce();
        expect(appendRouteEvent).toHaveBeenCalledWith(
          expect.objectContaining({ kind: "validation_rejected" }),
        );
      }
    },
  );
});
