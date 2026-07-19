import { Type, type Static } from "typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  DELEGATION_REPORT_VERSION,
  DELEGATION_VALIDATOR_PROTOCOL,
  type DelegationWorkerReport,
} from "../delegation/contracts.js";
import {
  hashDelegationReportSemantics,
  validateDelegationReportCoverage,
} from "../delegation/ledger.js";
import {
  resolveDelegationGuardPrincipal,
  resolveDelegationWorkerRequiredModel,
} from "../delegation/policy.js";
import {
  assertDelegationAssignmentScopeCurrent,
  assertDelegationWorkerSandbox,
  requireCurrentDelegationCandidate,
  resolveDelegationCallerAgentId,
  resolveDelegationReportCandidate,
  resolveDelegationRuntime,
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

const DelegationReportToolSchema = Type.Object({ report: DelegationWorkerReportSchema });

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
      throw new Error(`Report scope path is outside the protected assignment: ${entry.path}`);
    }
    const existing = localIdToCanonical.get(entry.scopeId);
    if (existing && existing !== entry.path) {
      throw new Error(`Report scope ID maps to multiple protected paths: ${entry.scopeId}`);
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
    throw new Error(
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
      "Submit the current guarded assignment's finite evidence report to the protected delegation ledger. This is the authoritative worker-to-planner handoff.",
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
      const submittedReport = (args as { report: DelegationWorkerReportInput })
        .report as DelegationWorkerReport;
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
      let report: DelegationWorkerReport;
      try {
        report = bindDelegationReportToAssignmentScope({
          report: submittedReport,
          scopeUnits: assignment.scopeUnits,
        });
      } catch (error) {
        return jsonResult({
          status: "rejected",
          error:
            error instanceof Error
              ? error.message
              : "Report scope could not be bound to the protected assignment.",
        });
      }
      const existingReceipt = runtime.ledger.initialReceiptForAssignment(assignment.assignmentId);
      if (
        !existingReceipt &&
        assignment.workspaceAccess === "rw" &&
        (assignment.purpose === "implementation" || assignment.purpose === "remediation")
      ) {
        try {
          await assertDelegationAssignmentScopeCurrent({ runtime, assignment });
        } catch (error) {
          return jsonResult({
            status: "rejected",
            error:
              error instanceof Error
                ? error.message
                : "Writable assignment changed repository state outside its protected scope.",
          });
        }
      }
      try {
        validateDelegationReportCoverage(report);
      } catch (error) {
        const issue = {
          code: "report-structure-invalid",
          message:
            error instanceof Error ? error.message : "Delegation report structure is invalid.",
        };
        try {
          const rejected = runtime.ledger.appendRejectedReceipt({
            assignmentId: assignment.assignmentId,
            report,
            issues: [issue],
          });
          runtime.ledger.appendRouteEvent({
            assignmentId: assignment.assignmentId,
            kind: "validation_rejected",
            payload: {
              receiptId: rejected.receiptId,
              validationId: rejected.validationId,
              code: issue.code,
            },
          });
          return jsonResult({
            status: "rejected",
            assignmentId: assignment.assignmentId,
            receiptId: rejected.receiptId,
            validationId: rejected.validationId,
            semanticDigest: rejected.semanticDigest,
            issues: [issue],
          });
        } catch (persistenceError) {
          return jsonResult({
            status: "error",
            error:
              persistenceError instanceof Error
                ? persistenceError.message
                : "Structurally rejected delegation report could not be persisted.",
          });
        }
      }
      let receiptId: string | undefined;
      let semanticDigest = hashDelegationReportSemantics(report);
      const initialReceipt = runtime.ledger.initialReceiptForAssignment(assignment.assignmentId);
      if (initialReceipt) {
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
        semanticDigest = initialReceipt.semanticDigest;
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
        return jsonResult({
          status: existingValidation.outcome,
          assignmentId: assignment.assignmentId,
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
        if (assignment.purpose === "discovery") {
          const baselineCandidate = runtime.ledger.latestCandidateRecordForSlice(
            assignment.sliceId,
          );
          if (!baselineCandidate) {
            throw new Error("Discovery report has no protected baseline candidate.");
          }
          await requireCurrentDelegationCandidate({
            runtime,
            sliceId: assignment.sliceId,
            candidateId: baselineCandidate.candidateId,
          });
        }
        candidate = await resolveDelegationReportCandidate({ runtime, assignment });
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
          payload: { receiptId: persisted.receiptId, validationId, code: issue.code },
        });
        return jsonResult({
          status: "rejected",
          receiptId: persisted.receiptId,
          validationId,
          issues: [issue],
        });
      }
      let validatorResponse;
      try {
        validatorResponse = await runPinnedDelegationValidator({
          validator: runtime.guard.validator,
          request: {
            protocol: DELEGATION_VALIDATOR_PROTOCOL,
            action: "validate_report",
            payload: {
              assignment,
              scopeUnits,
              candidate: candidate
                ? {
                    candidateId: candidate.candidateId,
                    fingerprint: candidate.fingerprint,
                  }
                : undefined,
              report,
              semanticDigest,
            },
          },
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
            code: issue.code,
          },
        });
        return jsonResult({
          status: "blocked",
          receiptId: persisted.receiptId,
          validationId: persisted.validationId,
          issues: [issue],
        });
      }
      if (validatorResponse.ok && assignment.candidateId && assignment.workspaceAccess === "ro") {
        try {
          await requireCurrentDelegationCandidate({
            runtime,
            sliceId: assignment.sliceId,
            candidateId: assignment.candidateId,
          });
        } catch (error) {
          const issue = {
            code: "candidate-drift",
            message:
              error instanceof Error
                ? error.message
                : "Candidate changed during report validation.",
          };
          const persisted = persistValidation("rejected", [issue]);
          const validationId = persisted.validationId;
          runtime.ledger.appendRouteEvent({
            assignmentId: assignment.assignmentId,
            kind: "validation_rejected",
            payload: { receiptId: persisted.receiptId, validationId, code: issue.code },
          });
          return jsonResult({
            status: "rejected",
            receiptId: persisted.receiptId,
            validationId,
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
          payload: { receiptId: persisted.receiptId, validationId },
        });
        return jsonResult({
          status: "rejected",
          receiptId: persisted.receiptId,
          validationId,
          issues: validatorResponse.issues ?? [],
        });
      }
      return jsonResult({
        status: "accepted",
        assignmentId: assignment.assignmentId,
        receiptId: persisted.receiptId,
        validationId,
        semanticDigest,
      });
    },
  };
}
