import { describe, expect, it } from "vitest";
import {
  DELEGATION_REPORT_ERROR_CODES,
  type DelegationAssignmentRecord,
} from "../delegation/contracts.js";
import { bindDelegationEvidenceToAssignment } from "../delegation/evidence-identity.js";
import { makeCompleteReport } from "../delegation/ledger.test-helpers.js";
import {
  createDelegationReportFailureResult,
  DelegationReportContractError,
  resolveDelegationReportErrorCode,
} from "../delegation/report-result.js";
import { validateDelegationNewlyDiscovered } from "../delegation/report-validation.js";
import {
  bindDelegationReportToAssignmentScope,
  prepareDelegationReportForAssignment,
} from "./delegation-report-tool.js";

function assignment(assignmentId: string): DelegationAssignmentRecord {
  return {
    assignmentId,
    sliceId: "slice-1",
    candidateId: "candidate-1",
    waveId: "wave-1",
    controllerAgentId: "planner",
    controllerSessionKey: "agent:planner:main",
    workerAgentId: "tester",
    role: "tester",
    requiredThinking: "medium",
    requiredModel: "openai/gpt-5.4",
    workspaceAccess: "ro",
    scopeUnits: ["src/one.ts"],
    routeFamilyId: "route-family-1",
    purpose: "verification",
    epoch: 14,
    issuedAt: 1,
  };
}

describe("delegation assignment-scoped evidence identity", () => {
  it("canonicalizes every reference deterministically without mutating worker-local input", () => {
    const report = makeCompleteReport({ assigned: ["src/one.ts"] });
    report.commands[0].evidenceId = "E1";
    report.scope.inspected[0].evidenceIds = ["E1"];
    report.findings.push({
      localId: "F1",
      severity: "warning",
      summary: "bounded observation",
      proposedProvenance: "indeterminate",
      scopeIds: ["src/one.ts"],
      evidenceIds: ["E1"],
      discoveryTrigger: "targeted inspection",
    });

    const first = bindDelegationEvidenceToAssignment({
      assignment: assignment("assignment-a"),
      report,
    });
    const second = bindDelegationEvidenceToAssignment({
      assignment: assignment("assignment-a"),
      report,
    });
    const canonicalId = first.identity.mapping[0]?.canonicalId;

    expect(first).toEqual(second);
    expect(canonicalId).toMatch(/^evidence_[a-f0-9]{16}_[a-f0-9]{64}$/u);
    expect(first.report.commands[0].evidenceId).toBe(canonicalId);
    expect(first.report.scope.inspected[0].evidenceIds).toEqual([canonicalId]);
    expect(first.report.findings[0].evidenceIds).toEqual([canonicalId]);
    expect(report.commands[0].evidenceId).toBe("E1");
  });

  it("keeps the same local ID distinct across assignments", () => {
    const report = makeCompleteReport({ assigned: ["src/one.ts"] });
    report.commands[0].evidenceId = "E1";
    report.scope.inspected[0].evidenceIds = ["E1"];

    const left = bindDelegationEvidenceToAssignment({
      assignment: assignment("assignment-a"),
      report,
    });
    const right = bindDelegationEvidenceToAssignment({
      assignment: assignment("assignment-b"),
      report,
    });

    expect(left.identity.mapping[0]?.canonicalId).not.toBe(right.identity.mapping[0]?.canonicalId);
  });

  it.each([
    [
      "duplicate producer",
      (report: ReturnType<typeof makeCompleteReport>) =>
        report.artifacts.push({
          evidenceId: report.commands[0].evidenceId,
          sha256: "a".repeat(64),
          kind: "duplicate",
        }),
    ],
    [
      "missing reference",
      (report: ReturnType<typeof makeCompleteReport>) => {
        report.scope.inspected[0].evidenceIds = ["missing"];
      },
    ],
    [
      "forged namespace",
      (report: ReturnType<typeof makeCompleteReport>) => {
        report.commands[0].evidenceId = `evidence_${"a".repeat(16)}_${"b".repeat(64)}`;
        report.scope.inspected[0].evidenceIds = [report.commands[0].evidenceId];
      },
    ],
  ])("fails closed for %s", (_label, mutate) => {
    const report = makeCompleteReport({ assigned: ["src/one.ts"] });
    mutate(report);
    expect(() =>
      bindDelegationEvidenceToAssignment({ assignment: assignment("assignment-a"), report }),
    ).toThrow(
      expect.objectContaining<Partial<DelegationReportContractError>>({
        errorCode: "evidence_identity_invalid",
      }),
    );
  });

  it("uses the same scope and evidence preparation contract for preflight and submit", () => {
    const report = makeCompleteReport({ assigned: ["local-one"] });
    report.scope.inspected[0].path = "src/one.ts";
    report.commands[0].scopeIds = ["local-one"];
    const prepared = prepareDelegationReportForAssignment({
      assignment: assignment("assignment-a"),
      report,
    });
    expect(prepared.report.scope.assigned).toEqual(["src/one.ts"]);
    expect(prepared.report.commands[0].scopeIds).toEqual(["src/one.ts"]);
    expect(prepared.report.commands[0].evidenceId).toBe(
      prepared.evidenceIdentity.mapping[0]?.canonicalId,
    );
  });
});

describe("delegation report scope binding", () => {
  it("binds unambiguous worker-local scope labels to protected canonical paths", () => {
    const report = makeCompleteReport({
      assigned: [".openclaw/delegation-runtime-canary.txt (expectation may-create)"],
    });
    report.scope.inspected[0].scopeId = "canary-file";
    report.scope.inspected[0].path = ".openclaw/delegation-runtime-canary.txt";
    report.commands[0].scopeIds = ["canary-file"];

    const bound = bindDelegationReportToAssignmentScope({
      report,
      scopeUnits: [".openclaw/delegation-runtime-canary.txt"],
    });

    expect(bound.scope.assigned).toEqual([".openclaw/delegation-runtime-canary.txt"]);
    expect(bound.scope.inspected[0].scopeId).toBe(".openclaw/delegation-runtime-canary.txt");
    expect(bound.commands[0].scopeIds).toEqual([".openclaw/delegation-runtime-canary.txt"]);
    expect(report.scope.assigned).toEqual([
      ".openclaw/delegation-runtime-canary.txt (expectation may-create)",
    ]);
  });

  it("rejects local labels that do not map one-to-one to protected paths", () => {
    const report = makeCompleteReport({ assigned: ["canary-file"] });
    report.scope.inspected[0].path = "src/outside.ts";

    expect(() =>
      bindDelegationReportToAssignmentScope({
        report,
        scopeUnits: [".openclaw/delegation-runtime-canary.txt"],
      }),
    ).toThrow(
      expect.objectContaining<Partial<DelegationReportContractError>>({
        errorCode: "scope_path_outside_assignment",
      }),
    );
  });

  it("classifies ambiguous IDs and incomplete partitions with closed codes", () => {
    const ambiguous = makeCompleteReport({ assigned: ["one", "two"] });
    ambiguous.scope.inspected[0].scopeId = "same";
    ambiguous.scope.inspected[1].scopeId = "same";
    expect(() =>
      bindDelegationReportToAssignmentScope({
        report: ambiguous,
        scopeUnits: ["one", "two"],
      }),
    ).toThrow(
      expect.objectContaining<Partial<DelegationReportContractError>>({
        errorCode: "scope_id_ambiguous",
      }),
    );

    const incomplete = makeCompleteReport({ assigned: ["one"] });
    incomplete.scope.assigned.push("invented");
    expect(() =>
      bindDelegationReportToAssignmentScope({ report: incomplete, scopeUnits: ["one"] }),
    ).toThrow(
      expect.objectContaining<Partial<DelegationReportContractError>>({
        errorCode: "scope_partition_mismatch",
      }),
    );
  });
});

describe("delegation report result contract", () => {
  it.each(DELEGATION_REPORT_ERROR_CODES)("returns exactly one closed errorCode for %s", (code) => {
    const result = createDelegationReportFailureResult({
      phase: "pre_receipt",
      assignmentId: "assignment-1",
      errorCode: code,
      message: "rejected",
      auditEventId: "audit-1",
    });
    expect(result).toMatchObject({
      status: "rejected",
      assignmentId: "assignment-1",
      errorCode: code,
      auditEventId: "audit-1",
    });
    expect(Object.keys(result).filter((key) => key === "errorCode")).toHaveLength(1);
  });

  it("keeps receipt replay distinct from pre-receipt audit evidence", () => {
    const result = createDelegationReportFailureResult({
      phase: "receipt",
      assignmentId: "assignment-1",
      outcome: "blocked",
      errorCode: "validator_execution_failed",
      message: "validator unavailable",
      receiptId: "receipt-1",
      validationId: "validation-1",
      semanticDigest: "digest-1",
      issues: [{ code: "validator-execution-failed", message: "validator unavailable" }],
    });
    expect(result).toEqual({
      status: "blocked",
      assignmentId: "assignment-1",
      errorCode: "validator_execution_failed",
      message: "validator unavailable",
      receiptId: "receipt-1",
      validationId: "validation-1",
      semanticDigest: "digest-1",
      issues: [{ code: "validator-execution-failed", message: "validator unavailable" }],
    });
    expect(result).not.toHaveProperty("auditEventId");
    expect(
      resolveDelegationReportErrorCode({
        fallback: "validator_rejected",
        issues: [{ code: "candidate-drift", message: "changed" }],
      }),
    ).toBe("candidate_drift");
  });

  it("bounds messages by UTF-8 bytes without splitting a multibyte character", () => {
    const result = createDelegationReportFailureResult({
      phase: "pre_receipt",
      assignmentId: "assignment-1",
      errorCode: "report_structure_invalid",
      message: "🦞".repeat(400),
      auditEventId: "audit-1",
    });
    expect(Buffer.byteLength(result.message, "utf8")).toBeLessThanOrEqual(1024);
    expect(result.message.endsWith("🦞")).toBe(true);
  });
});

describe("delegation newly discovered validation", () => {
  it("accepts a canonical follow-up and covered path-bound evidence", () => {
    const report = makeCompleteReport({ assigned: ["src/one.ts"] });
    report.scope.newlyDiscovered.push({
      scopeId: "src/late.ts",
      path: "src/late.ts",
      reason: "late dependency",
      disposition: "covered",
      evidenceIds: ["late-command"],
    });
    report.commands.push({
      evidenceId: "late-command",
      purpose: "inspect late dependency",
      command: "inspect src/late.ts",
      cwd: "/workspace",
      exitCode: 0,
      scopeIds: ["src/late.ts"],
      cap: null,
      resultCount: 1,
      truncated: false,
    });
    expect(() =>
      validateDelegationNewlyDiscovered({ report, assignedScope: ["src/one.ts"] }),
    ).not.toThrow();
  });

  it.each([
    [
      "noncanonical path",
      (report: ReturnType<typeof makeCompleteReport>) => {
        report.scope.newlyDiscovered.push({
          scopeId: "src/../late.ts",
          path: "src/../late.ts",
          reason: "late",
          disposition: "follow-up",
          evidenceIds: [],
        });
      },
    ],
    [
      "assigned collision",
      (report: ReturnType<typeof makeCompleteReport>) => {
        report.scope.newlyDiscovered.push({
          scopeId: "src/one.ts",
          path: "src/one.ts",
          reason: "late",
          disposition: "follow-up",
          evidenceIds: [],
        });
      },
    ],
    [
      "missing evidence",
      (report: ReturnType<typeof makeCompleteReport>) => {
        report.scope.newlyDiscovered.push({
          scopeId: "src/late.ts",
          path: "src/late.ts",
          reason: "late",
          disposition: "covered",
          evidenceIds: ["missing"],
        });
      },
    ],
    [
      "unknown command scope",
      (report: ReturnType<typeof makeCompleteReport>) => {
        report.commands[0].scopeIds = ["src/unreported.ts"];
      },
    ],
  ])("rejects %s before persistence", (_label, mutate) => {
    const report = makeCompleteReport({ assigned: ["src/one.ts"] });
    mutate(report);
    expect(() =>
      validateDelegationNewlyDiscovered({ report, assignedScope: ["src/one.ts"] }),
    ).toThrow(
      expect.objectContaining<Partial<DelegationReportContractError>>({
        errorCode: "newly_discovered_invalid",
      }),
    );
  });
});
