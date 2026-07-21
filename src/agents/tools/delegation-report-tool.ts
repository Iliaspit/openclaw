import { Type, type Static } from "typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  DELEGATION_REPORT_VERSION,
  DELEGATION_VALIDATOR_PROTOCOL,
  type DelegationAssignmentRecord,
  type DelegationWorkerReport,
} from "../delegation/contracts.js";
import {
  bindDelegationEvidenceToAssignment,
  type DelegationEvidenceIdentity,
} from "../delegation/evidence-identity.js";
import { canonicalDelegationJson } from "../delegation/identity.js";
import {
  hashDelegationReportSemantics,
  validateDelegationReportCoverage,
} from "../delegation/ledger.js";
import {
  resolveDelegationGuardPrincipal,
  resolveDelegationWorkerRequiredModel,
} from "../delegation/policy.js";
import {
  createDelegationReportFailureResult,
  DelegationReportContractError,
  normalizeDelegationReportIssues,
  resolveDelegationReportErrorCode,
} from "../delegation/report-result.js";
import { validateDelegationNewlyDiscovered } from "../delegation/report-validation.js";
import {
  assertDelegationAssignmentScopeCurrent,
  assertDelegationWorkerSandbox,
  requireCurrentDelegationCandidate,
  resolveDelegationCallerAgentId,
  resolveDelegationReportCandidate,
  resolveDelegationRuntime,
  type DelegationRuntime,
} from "../delegation/runtime.js";
import { runPinnedDelegationValidator } from "../delegation/validator.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";

const MissReasonSchema = Type.Union([
  Type.Literal("not-assigned"),
  Type.Literal("search-truncated"),
  Type.Literal("search-missed"),
  Type.Literal("dependency-discovered-late"),
  Type.Literal("candidate-drift"),
  Type.Literal("insufficient-evidence"),
]);

const FindingSchema = Type.Object({
  localId: Type.String({ minLength: 1 }),
  severity: Type.Union([Type.Literal("warning"), Type.Literal("blocker")]),
  summary: Type.String({ minLength: 1 }),
  proposedProvenance: Type.Union([
    Type.Literal("baseline-pre-existing"),
    Type.Literal("change-induced"),
    Type.Literal("indeterminate"),
  ]),
  scopeIds: Type.Array(Type.String({ minLength: 1 })),
  evidenceIds: Type.Array(Type.String({ minLength: 1 })),
  discoveryTrigger: Type.String({ minLength: 1 }),
  lateReasonCode: Type.Optional(MissReasonSchema),
});

export const DelegationWorkerReportSchema = Type.Object({
  contractVersion: Type.Literal(DELEGATION_REPORT_VERSION),
  status: Type.Union([
    Type.Literal("completed"),
    Type.Literal("blocked"),
    Type.Literal("findings"),
  ]),
  work: Type.Array(
    Type.Object({
      what: Type.String({ minLength: 1 }),
      why: Type.String({ minLength: 1 }),
    }),
  ),
  scope: Type.Object({
    assigned: Type.Array(Type.String({ minLength: 1 })),
    inspected: Type.Array(
      Type.Object({
        scopeId: Type.String({ minLength: 1 }),
        path: Type.String({ minLength: 1 }),
        purpose: Type.String({ minLength: 1 }),
        evidenceIds: Type.Array(Type.String({ minLength: 1 })),
      }),
    ),
    omitted: Type.Array(
      Type.Object({
        scopeId: Type.String({ minLength: 1 }),
        path: Type.String({ minLength: 1 }),
        reason: Type.String({ minLength: 1 }),
        missReasonCode: MissReasonSchema,
      }),
    ),
    failed: Type.Array(
      Type.Object({
        scopeId: Type.String({ minLength: 1 }),
        path: Type.String({ minLength: 1 }),
        reason: Type.String({ minLength: 1 }),
        evidenceId: Type.Optional(Type.String({ minLength: 1 })),
      }),
    ),
    newlyDiscovered: Type.Array(
      Type.Object({
        scopeId: Type.String({ minLength: 1 }),
        path: Type.String({ minLength: 1 }),
        reason: Type.String({ minLength: 1 }),
        disposition: Type.Union([
          Type.Literal("covered"),
          Type.Literal("follow-up"),
          Type.Literal("not-required"),
        ]),
        evidenceIds: Type.Array(Type.String({ minLength: 1 })),
      }),
    ),
  }),
  commands: Type.Array(
    Type.Object({
      evidenceId: Type.String({ minLength: 1 }),
      purpose: Type.String({ minLength: 1 }),
      command: Type.String({ minLength: 1 }),
      cwd: Type.String({ minLength: 1 }),
      exitCode: Type.Union([Type.Number(), Type.Null()]),
      scopeIds: Type.Array(Type.String({ minLength: 1 })),
      cap: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
      resultCount: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
      truncated: Type.Boolean(),
      artifactSha256: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
      notApplicableReason: Type.Optional(Type.String({ minLength: 1 })),
    }),
  ),
  artifacts: Type.Array(
    Type.Object({
      evidenceId: Type.String({ minLength: 1 }),
      path: Type.Optional(Type.String({ minLength: 1 })),
      sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
      kind: Type.String({ minLength: 1 }),
    }),
  ),
  assumptions: Type.Array(
    Type.Object({
      assumption: Type.String({ minLength: 1 }),
      impact: Type.String({ minLength: 1 }),
    }),
  ),
  remainingRisks: Type.Array(Type.String({ minLength: 1 })),
  findings: Type.Array(FindingSchema),
  coverage: Type.Union([
    Type.Literal("complete"),
    Type.Literal("partial"),
    Type.Literal("blocked"),
  ]),
  conclusionScope: Type.String({ minLength: 1 }),
});

export type DelegationWorkerReportInput = Static<typeof DelegationWorkerReportSchema>;

const DelegationReportToolSchema = Type.Object({
  action: Type.Optional(Type.Union([Type.Literal("preflight"), Type.Literal("submit")])),
  report: DelegationWorkerReportSchema,
});

type PreparedDelegationReport = {
  report: DelegationWorkerReport;
  evidenceIdentity: DelegationEvidenceIdentity;
};

function boundedPreflightMessage(error: unknown, fallback: string): string {
  return (
    normalizeDelegationReportIssues([
      { code: "preflight", message: error instanceof Error ? error.message : fallback },
    ])[0]?.message ?? fallback
  );
}

export function prepareDelegationReportForAssignment(params: {
  assignment: DelegationAssignmentRecord;
  report: DelegationWorkerReport;
}): PreparedDelegationReport {
  const scopeBound = bindDelegationReportToAssignmentScope({
    report: params.report,
    scopeUnits: params.assignment.scopeUnits,
  });
  const evidenceBound = bindDelegationEvidenceToAssignment({
    assignment: params.assignment,
    report: scopeBound,
  });
  validateDelegationNewlyDiscovered({
    report: evidenceBound.report,
    assignedScope: params.assignment.scopeUnits,
  });
  try {
    validateDelegationReportCoverage(evidenceBound.report);
  } catch (error) {
    throw new DelegationReportContractError(
      "report_structure_invalid",
      error instanceof Error ? error.message : "Delegation report structure is invalid.",
    );
  }
  return {
    report: evidenceBound.report,
    evidenceIdentity: evidenceBound.identity,
  };
}

async function resolveDelegationValidationCandidate(params: {
  runtime: DelegationRuntime;
  assignment: DelegationAssignmentRecord;
}) {
  if (params.assignment.purpose === "discovery") {
    const baselineCandidate = params.runtime.ledger.latestCandidateRecordForSlice(
      params.assignment.sliceId,
    );
    if (!baselineCandidate) {
      throw new Error("Discovery report has no protected baseline candidate.");
    }
    await requireCurrentDelegationCandidate({
      runtime: params.runtime,
      sliceId: params.assignment.sliceId,
      candidateId: baselineCandidate.candidateId,
    });
  }
  return await resolveDelegationReportCandidate(params);
}

async function runDelegationReportValidator(params: {
  runtime: DelegationRuntime;
  assignment: DelegationAssignmentRecord;
  scopeUnits: Array<{ scopeId: string; path: string }>;
  candidate: Awaited<ReturnType<typeof resolveDelegationReportCandidate>>;
  report: DelegationWorkerReport;
  semanticDigest: string;
}) {
  return await runPinnedDelegationValidator({
    validator: params.runtime.guard.validator,
    request: {
      protocol: DELEGATION_VALIDATOR_PROTOCOL,
      action: "validate_report",
      payload: {
        assignment: params.assignment,
        scopeUnits: params.scopeUnits,
        candidate: params.candidate
          ? {
              candidateId: params.candidate.candidateId,
              fingerprint: params.candidate.fingerprint,
            }
          : undefined,
        report: params.report,
        semanticDigest: params.semanticDigest,
      },
    },
  });
}

async function assertAssignmentStillCurrentAfterValidation(params: {
  runtime: DelegationRuntime;
  assignment: DelegationAssignmentRecord;
}): Promise<void> {
  if (
    params.assignment.workspaceAccess === "rw" &&
    (params.assignment.purpose === "implementation" || params.assignment.purpose === "remediation")
  ) {
    await assertDelegationAssignmentScopeCurrent(params);
    return;
  }
  if (params.assignment.candidateId && params.assignment.workspaceAccess === "ro") {
    await requireCurrentDelegationCandidate({
      runtime: params.runtime,
      sliceId: params.assignment.sliceId,
      candidateId: params.assignment.candidateId,
    });
  }
}

export function bindDelegationReportToAssignmentScope(params: {
  report: DelegationWorkerReport;
  scopeUnits: string[];
}): DelegationWorkerReport {
  const authoritativeScope = new Set(params.scopeUnits);
  const localIdToCanonical = new Map<string, string>();
  const reportedPartition = [
    ...params.report.scope.inspected,
    ...params.report.scope.omitted,
    ...params.report.scope.failed,
  ];

  for (const entry of reportedPartition) {
    if (!authoritativeScope.has(entry.path)) {
      throw new DelegationReportContractError(
        "scope_path_outside_assignment",
        `Report scope path is outside the protected assignment: ${entry.path}`,
      );
    }
    const existing = localIdToCanonical.get(entry.scopeId);
    if (existing && existing !== entry.path) {
      throw new DelegationReportContractError(
        "scope_id_ambiguous",
        `Report scope ID maps to multiple protected paths: ${entry.scopeId}`,
      );
    }
    localIdToCanonical.set(entry.scopeId, entry.path);
  }

  const partitionPaths = new Set(reportedPartition.map((entry) => entry.path));
  if (
    params.report.scope.assigned.length !== new Set(params.report.scope.assigned).size ||
    params.report.scope.assigned.length !== authoritativeScope.size ||
    partitionPaths.size !== authoritativeScope.size ||
    [...authoritativeScope].some((scopeId) => !partitionPaths.has(scopeId))
  ) {
    throw new DelegationReportContractError(
      "scope_partition_mismatch",
      "Report scope partition must map one-to-one onto the runtime-owned canonical slice scope.",
    );
  }

  const bindKnownScopeId = (scopeId: string): string =>
    authoritativeScope.has(scopeId) ? scopeId : (localIdToCanonical.get(scopeId) ?? scopeId);
  return {
    ...params.report,
    scope: {
      ...params.report.scope,
      assigned: [...params.scopeUnits],
      inspected: params.report.scope.inspected.map((entry) => ({
        ...entry,
        scopeId: entry.path,
      })),
      omitted: params.report.scope.omitted.map((entry) => ({
        ...entry,
        scopeId: entry.path,
      })),
      failed: params.report.scope.failed.map((entry) => ({
        ...entry,
        scopeId: entry.path,
      })),
    },
    commands: params.report.commands.map((command) => ({
      ...command,
      scopeIds: command.scopeIds.map(bindKnownScopeId),
    })),
    findings: params.report.findings.map((finding) => ({
      ...finding,
      scopeIds: finding.scopeIds.map(bindKnownScopeId),
    })),
  };
}

export function createDelegationScopeUnits(scope: {
  manifest: { kind: "slice" | "repository" };
  paths: string[];
}): Array<{ scopeId: string; path: string }> {
  return scope.manifest.kind === "slice"
    ? scope.paths.map((path) => ({ scopeId: path, path }))
    : [{ scopeId: "<repository>", path: "<repository>" }];
}

export function createDelegationReportTool(opts: {
  config: OpenClawConfig;
  agentSessionKey?: string;
  requesterAgentIdOverride?: string;
  effectiveThinking?: string;
}): AnyAgentTool {
  return {
    label: "Delegation Report",
    name: "delegation_report",
    description:
      "Preflight or submit the current guarded assignment's finite evidence report. Worker-local evidence IDs are deterministically bound to the protected assignment before validation.",
    parameters: DelegationReportToolSchema,
    execute: async (_toolCallId, args) => {
      const runtime = resolveDelegationRuntime(opts.config);
      if (!runtime) {
        return jsonResult({ status: "error", error: "Delegation guard is not enabled." });
      }
      let workerAgentId: string;
      try {
        workerAgentId = resolveDelegationCallerAgentId(opts);
      } catch (error) {
        return jsonResult({
          status: "forbidden",
          error: error instanceof Error ? error.message : "Worker authorization failed.",
        });
      }
      const worker = resolveDelegationGuardPrincipal(runtime.guard, workerAgentId);
      if (worker?.kind !== "worker") {
        return jsonResult({
          status: "forbidden",
          error: `Agent ${workerAgentId} is not a guarded delegation worker.`,
        });
      }
      if (opts.effectiveThinking !== worker.requiredThinking) {
        return jsonResult({
          status: "forbidden",
          error: `Guarded ${worker.role} reports require exact ${worker.requiredThinking} thinking.`,
        });
      }
      try {
        assertDelegationWorkerSandbox({
          config: opts.config,
          workerAgentId,
          workspaceAccess: worker.workspaceAccess,
        });
      } catch (error) {
        return jsonResult({
          status: "forbidden",
          error: error instanceof Error ? error.message : "Worker sandbox policy failed.",
        });
      }
      const sessionKey = opts.agentSessionKey?.trim();
      if (!sessionKey) {
        return jsonResult({
          status: "forbidden",
          error: "Delegation report requires a bound worker session.",
        });
      }
      const assignment = runtime.ledger.resolveAssignmentForChildSession(sessionKey);
      const requiredModel = resolveDelegationWorkerRequiredModel(opts.config, workerAgentId);
      if (
        !assignment ||
        assignment.workerAgentId !== workerAgentId ||
        assignment.role !== worker.role ||
        assignment.requiredThinking !== worker.requiredThinking ||
        assignment.requiredModel !== requiredModel ||
        assignment.workspaceAccess !== worker.workspaceAccess
      ) {
        return jsonResult({
          status: "forbidden",
          error: "Worker session is not bound to a current guarded assignment.",
        });
      }
      const input = args as {
        action?: "preflight" | "submit";
        report: DelegationWorkerReportInput;
      };
      const action = input.action ?? "submit";
      const submittedReport = input.report as DelegationWorkerReport;
      const scope = runtime.ledger.getSliceScope(assignment.sliceId);
      if (
        !scope ||
        scope.controllerAgentId !== assignment.controllerAgentId ||
        scope.controllerSessionKey !== assignment.controllerSessionKey ||
        scope.epoch !== runtime.ledger.currentEpoch()
      ) {
        return jsonResult({ status: "error", error: "Assignment slice is missing or stale." });
      }
      const scopeUnits = assignment.scopeUnits.map((scopeId) => ({ scopeId, path: scopeId }));
      const submittedSemanticDigest = hashDelegationReportSemantics(submittedReport);
      const submittedReportBytes = Buffer.byteLength(
        canonicalDelegationJson(submittedReport),
        "utf8",
      );
      const rejectBeforeReceipt = (
        errorCode: DelegationReportContractError["errorCode"],
        message: string,
        issues: unknown[] = [],
      ) => {
        try {
          const rejection = runtime.ledger.appendPreReceiptReportRejection({
            assignmentId: assignment.assignmentId,
            errorCode,
            submittedSemanticDigest,
            reportBytes: submittedReportBytes,
            message,
          });
          return jsonResult(
            createDelegationReportFailureResult({
              phase: "pre_receipt",
              assignmentId: assignment.assignmentId,
              errorCode,
              message,
              auditEventId: rejection.auditEventId,
              issues,
            }),
          );
        } catch (error) {
          return jsonResult({
            status: "error",
            assignmentId: assignment.assignmentId,
            error:
              error instanceof Error
                ? error.message
                : "Pre-receipt report rejection could not be persisted.",
          });
        }
      };
      let prepared: PreparedDelegationReport;
      try {
        prepared = prepareDelegationReportForAssignment({
          assignment,
          report: submittedReport,
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Report scope could not be bound to the protected assignment.";
        const errorCode =
          error instanceof DelegationReportContractError
            ? error.errorCode
            : "scope_partition_mismatch";
        if (action === "preflight") {
          return jsonResult({
            status: "rejected",
            action,
            assignmentId: assignment.assignmentId,
            errorCode,
            message,
            persisted: false,
          });
        }
        return rejectBeforeReceipt(errorCode, message);
      }
      const { report, evidenceIdentity } = prepared;
      let reportSlot: ReturnType<typeof runtime.ledger.inspectInitialReportSlot>;
      try {
        reportSlot = runtime.ledger.inspectInitialReportSlot({
          assignmentId: assignment.assignmentId,
          report,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Protected report slot is unavailable.";
        const errorCode =
          error instanceof DelegationReportContractError ? error.errorCode : "report_slot_closed";
        return jsonResult({
          status: "rejected",
          action,
          assignmentId: assignment.assignmentId,
          errorCode,
          message,
          persisted: false,
        });
      }
      const existingReceipt =
        reportSlot.state === "idempotent"
          ? runtime.ledger.initialReceiptForAssignment(assignment.assignmentId)
          : undefined;
      if (
        reportSlot.state === "open" &&
        assignment.workspaceAccess === "rw" &&
        (assignment.purpose === "implementation" || assignment.purpose === "remediation")
      ) {
        try {
          await assertDelegationAssignmentScopeCurrent({ runtime, assignment });
        } catch (error) {
          if (action === "preflight") {
            return jsonResult({
              status: "rejected",
              action,
              assignmentId: assignment.assignmentId,
              errorCode: "writable_scope_drift",
              message:
                error instanceof Error
                  ? error.message
                  : "Writable assignment changed repository state outside its protected scope.",
              persisted: false,
            });
          }
          return rejectBeforeReceipt(
            "writable_scope_drift",
            error instanceof Error
              ? error.message
              : "Writable assignment changed repository state outside its protected scope.",
          );
        }
      }
      const preflightSemanticDigest = reportSlot.semanticDigest;
      if (action === "preflight") {
        if (reportSlot.state === "idempotent" && reportSlot.validation) {
          const validation = reportSlot.validation;
          const issues = normalizeDelegationReportIssues(validation.issues);
          const storedBase = {
            action,
            assignmentId: assignment.assignmentId,
            receiptId: reportSlot.receiptId,
            validationId: validation.validationId,
            semanticDigest: reportSlot.semanticDigest,
            evidenceIdentity,
            persisted: true,
            idempotent: true,
          };
          if (validation.outcome === "accepted") {
            return jsonResult({ status: "accepted", ...storedBase });
          }
          return jsonResult({
            status: validation.outcome,
            ...storedBase,
            errorCode: resolveDelegationReportErrorCode({
              fallback:
                validation.outcome === "blocked"
                  ? "validator_execution_failed"
                  : "validator_rejected",
              issues,
            }),
            message:
              issues[0]?.message ?? "Stored delegation report validation rejected the report.",
            issues,
          });
        }
        let candidate: Awaited<ReturnType<typeof resolveDelegationReportCandidate>>;
        try {
          candidate = await resolveDelegationValidationCandidate({ runtime, assignment });
        } catch (error) {
          return jsonResult({
            status: "rejected",
            action,
            assignmentId: assignment.assignmentId,
            errorCode: "candidate_drift",
            message: boundedPreflightMessage(
              error,
              "Assignment candidate could not be revalidated.",
            ),
            persisted: false,
          });
        }
        let validatorResponse;
        try {
          validatorResponse = await runDelegationReportValidator({
            runtime,
            assignment,
            scopeUnits,
            candidate,
            report,
            semanticDigest: preflightSemanticDigest,
          });
        } catch (error) {
          return jsonResult({
            status: "blocked",
            action,
            assignmentId: assignment.assignmentId,
            errorCode: "validator_execution_failed",
            message: boundedPreflightMessage(error, "Delegation validator failed."),
            persisted: false,
          });
        }
        if (validatorResponse.ok) {
          try {
            await assertAssignmentStillCurrentAfterValidation({ runtime, assignment });
          } catch (error) {
            const writableDrift = assignment.workspaceAccess === "rw";
            return jsonResult({
              status: "rejected",
              action,
              assignmentId: assignment.assignmentId,
              errorCode: writableDrift ? "writable_scope_drift" : "candidate_drift",
              message: boundedPreflightMessage(
                error,
                writableDrift
                  ? "Writable assignment scope changed during report validation."
                  : "Candidate changed during report validation.",
              ),
              persisted: false,
            });
          }
        }
        if (!validatorResponse.ok) {
          const issues = normalizeDelegationReportIssues(validatorResponse.issues ?? []);
          return jsonResult({
            status: "rejected",
            action,
            assignmentId: assignment.assignmentId,
            errorCode: resolveDelegationReportErrorCode({
              fallback: "validator_rejected",
              issues,
            }),
            message: issues[0]?.message ?? "Delegation validator rejected the report.",
            issues,
            persisted: reportSlot.state === "idempotent",
            idempotent: reportSlot.state === "idempotent",
          });
        }
        return jsonResult({
          status: "ready",
          action,
          assignmentId: assignment.assignmentId,
          candidateId: candidate?.candidateId,
          semanticDigest: preflightSemanticDigest,
          evidenceIdentity,
          persisted: reportSlot.state === "idempotent",
          idempotent: reportSlot.state === "idempotent",
        });
      }
      let receiptId: string | undefined;
      let semanticDigest = hashDelegationReportSemantics(report);
      const rejectWithReceipt = (params: {
        outcome: "rejected" | "blocked";
        errorCode: DelegationReportContractError["errorCode"];
        message: string;
        receiptId: string;
        validationId: string;
        semanticDigest: string;
        issues?: unknown[];
      }) =>
        jsonResult(
          createDelegationReportFailureResult({
            phase: "receipt",
            assignmentId: assignment.assignmentId,
            ...params,
          }),
        );
      if (existingReceipt) {
        try {
          receiptId = runtime.ledger.appendReceipt({
            assignmentId: assignment.assignmentId,
            report,
          });
        } catch (error) {
          return jsonResult({
            status: "error",
            error: error instanceof Error ? error.message : "Delegation report persistence failed.",
          });
        }
        semanticDigest = existingReceipt.semanticDigest;
      }
      const existingValidation = receiptId
        ? runtime.ledger.getValidationForReceipt(receiptId)
        : undefined;
      if (existingValidation && receiptId) {
        if (
          existingValidation.validatorId !== runtime.guard.validator.id ||
          existingValidation.validatorVersion !== runtime.guard.validator.version ||
          existingValidation.validatorDigest !== runtime.guard.validator.sha256
        ) {
          return jsonResult({
            status: "error",
            error: "Protected receipt validation does not match the active validator identity.",
          });
        }
        if (existingValidation.outcome === "accepted") {
          return jsonResult({
            status: "accepted",
            assignmentId: assignment.assignmentId,
            receiptId,
            validationId: existingValidation.validationId,
            semanticDigest,
            evidenceIdentity,
          });
        }
        const errorCode = resolveDelegationReportErrorCode({
          fallback:
            existingValidation.outcome === "blocked"
              ? "validator_execution_failed"
              : "validator_rejected",
          issues: existingValidation.issues,
        });
        const firstIssue = existingValidation.issues[0] as { message?: unknown } | undefined;
        return rejectWithReceipt({
          outcome: existingValidation.outcome,
          errorCode,
          message:
            typeof firstIssue?.message === "string"
              ? firstIssue.message
              : "Stored delegation report validation rejected the report.",
          receiptId,
          validationId: existingValidation.validationId,
          semanticDigest,
          issues: existingValidation.issues,
        });
      }

      const persistValidation = (
        outcome: "accepted" | "rejected" | "blocked",
        issues: unknown[],
      ) => {
        if (receiptId) {
          return {
            receiptId,
            validationId: runtime.ledger.appendValidation({ receiptId, outcome, issues }),
            semanticDigest,
          };
        }
        const persisted = runtime.ledger.appendValidatedReceipt({
          assignmentId: assignment.assignmentId,
          report,
          outcome,
          issues,
        });
        receiptId = persisted.receiptId;
        semanticDigest = persisted.semanticDigest;
        return persisted;
      };

      let candidate: Awaited<ReturnType<typeof resolveDelegationReportCandidate>>;
      try {
        candidate = await resolveDelegationValidationCandidate({ runtime, assignment });
      } catch (error) {
        const issue = {
          code: "candidate-drift",
          message:
            error instanceof Error
              ? error.message
              : "Assignment candidate could not be revalidated.",
        };
        const persisted = persistValidation("rejected", [issue]);
        const validationId = persisted.validationId;
        runtime.ledger.appendRouteEvent({
          assignmentId: assignment.assignmentId,
          kind: "validation_rejected",
          payload: {
            receiptId: persisted.receiptId,
            validationId,
            errorCode: "candidate_drift",
          },
        });
        return rejectWithReceipt({
          outcome: "rejected",
          errorCode: "candidate_drift",
          message: issue.message,
          receiptId: persisted.receiptId,
          validationId,
          semanticDigest: persisted.semanticDigest,
          issues: [issue],
        });
      }
      let validatorResponse;
      try {
        validatorResponse = await runDelegationReportValidator({
          runtime,
          assignment,
          scopeUnits,
          candidate,
          report,
          semanticDigest,
        });
      } catch (error) {
        const issue = {
          code: "validator-execution-failed",
          message: error instanceof Error ? error.message : "Delegation validator failed.",
        };
        const persisted = persistValidation("blocked", [issue]);
        runtime.ledger.appendRouteEvent({
          assignmentId: assignment.assignmentId,
          kind: "validation_rejected",
          payload: {
            receiptId: persisted.receiptId,
            validationId: persisted.validationId,
            errorCode: "validator_execution_failed",
          },
        });
        return rejectWithReceipt({
          outcome: "blocked",
          errorCode: "validator_execution_failed",
          message: issue.message,
          receiptId: persisted.receiptId,
          validationId: persisted.validationId,
          semanticDigest: persisted.semanticDigest,
          issues: [issue],
        });
      }
      if (validatorResponse.ok) {
        try {
          await assertAssignmentStillCurrentAfterValidation({ runtime, assignment });
        } catch (error) {
          const writableDrift = assignment.workspaceAccess === "rw";
          const issue = {
            code: writableDrift ? "writable-scope-drift" : "candidate-drift",
            message:
              error instanceof Error
                ? error.message
                : writableDrift
                  ? "Writable assignment scope changed during report validation."
                  : "Candidate changed during report validation.",
          };
          const persisted = persistValidation("rejected", [issue]);
          const validationId = persisted.validationId;
          runtime.ledger.appendRouteEvent({
            assignmentId: assignment.assignmentId,
            kind: "validation_rejected",
            payload: {
              receiptId: persisted.receiptId,
              validationId,
              errorCode: writableDrift ? "writable_scope_drift" : "candidate_drift",
            },
          });
          return rejectWithReceipt({
            outcome: "rejected",
            errorCode: writableDrift ? "writable_scope_drift" : "candidate_drift",
            message: issue.message,
            receiptId: persisted.receiptId,
            validationId,
            semanticDigest: persisted.semanticDigest,
            issues: [issue],
          });
        }
      }
      const outcome = validatorResponse.ok ? "accepted" : "rejected";
      const persisted = persistValidation(outcome, validatorResponse.issues ?? []);
      const validationId = persisted.validationId;
      if (!validatorResponse.ok) {
        runtime.ledger.appendRouteEvent({
          assignmentId: assignment.assignmentId,
          kind: "validation_rejected",
          payload: {
            receiptId: persisted.receiptId,
            validationId,
            errorCode: "validator_rejected",
          },
        });
        const issues = validatorResponse.issues ?? [];
        const firstIssue = issues[0];
        return rejectWithReceipt({
          outcome: "rejected",
          errorCode: "validator_rejected",
          message: firstIssue?.message ?? "Delegation validator rejected the report.",
          receiptId: persisted.receiptId,
          validationId,
          semanticDigest: persisted.semanticDigest,
          issues,
        });
      }
      return jsonResult({
        status: "accepted",
        assignmentId: assignment.assignmentId,
        receiptId: persisted.receiptId,
        validationId,
        semanticDigest,
        evidenceIdentity,
      });
    },
  };
}
