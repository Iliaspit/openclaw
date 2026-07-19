import { describe, expect, it } from "vitest";
import { DELEGATION_REPORT_ERROR_CODES } from "../delegation/contracts.js";
import { makeCompleteReport } from "../delegation/ledger.test-helpers.js";
import {
  createDelegationReportFailureResult,
  DelegationReportContractError,
  resolveDelegationReportErrorCode,
} from "../delegation/report-result.js";
import { validateDelegationNewlyDiscovered } from "../delegation/report-validation.js";
import { bindDelegationReportToAssignmentScope } from "./delegation-report-tool.js";

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
