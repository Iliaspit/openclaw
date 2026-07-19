import { Type } from "typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  DelegationAssignmentPurpose,
  DelegationRemediationDisposition,
  DelegationScopeManifest,
  DelegationWorkerReport,
} from "../delegation/contracts.js";
import {
  DELEGATION_SCOPE_VERSION,
  DELEGATION_VALIDATOR_PROTOCOL,
} from "../delegation/contracts.js";
import {
  captureDelegationRepositorySnapshot,
  fingerprintDelegationCandidate,
} from "../delegation/fingerprint.js";
import {
  resolveDelegationGuardPrincipal,
  resolveDelegationWorkerRequiredModel,
} from "../delegation/policy.js";
import {
  assertDelegationWorkerSandbox,
  requireCurrentDelegationCandidate,
  requireDelegationController,
  resolveDelegationReportCandidate,
  resolveDelegationRepositoryRoot,
} from "../delegation/runtime.js";
import { canonicalizeDelegationScope } from "../delegation/scope.js";
import { runPinnedDelegationValidator } from "../delegation/validator.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import {
  DelegationWorkerReportSchema,
  type DelegationWorkerReportInput,
} from "./delegation-report-tool.js";

const WorkerRoles = ["helper", "implementer", "tester", "reviewer", "qa"] as const;

const ScopeManifestSchema = Type.Union([
  Type.Object({
    version: Type.Literal(DELEGATION_SCOPE_VERSION),
    kind: Type.Literal("slice"),
    entries: Type.Array(
      Type.Object({
        path: Type.String({ minLength: 1 }),
        expectation: Type.Union([Type.Literal("existing"), Type.Literal("may-create")]),
      }),
      { minItems: 1 },
    ),
  }),
  Type.Object({
    version: Type.Literal(DELEGATION_SCOPE_VERSION),
    kind: Type.Literal("repository"),
    operatorAuthorized: Type.Literal(true),
  }),
]);

const RemediationDispositionSchema = Type.Object({
  assignmentId: Type.String({ minLength: 1 }),
  localId: Type.String({ minLength: 1 }),
  disposition: Type.Union([
    Type.Literal("fix"),
    Type.Literal("accepted-risk"),
    Type.Literal("not-actionable"),
    Type.Literal("new-slice"),
  ]),
  finalProvenance: Type.Union([
    Type.Literal("baseline-pre-existing"),
    Type.Literal("change-induced"),
    Type.Literal("indeterminate"),
  ]),
  rationale: Type.String({ minLength: 1 }),
});

const DelegationGuardToolSchema = Type.Union([
  Type.Object({
    action: Type.Literal("create_slice"),
    manifest: ScopeManifestSchema,
  }),
  Type.Object({
    action: Type.Literal("issue_assignment"),
    sliceId: Type.String({ minLength: 1 }),
    workerAgentId: Type.String({ minLength: 1 }),
    purpose: Type.Union([
      Type.Literal("discovery"),
      Type.Literal("implementation"),
      Type.Literal("verification"),
      Type.Literal("qa"),
      Type.Literal("remediation"),
      Type.Literal("confirmation"),
    ]),
    candidateId: Type.Optional(Type.String({ minLength: 1 })),
    waveId: Type.Optional(Type.String({ minLength: 1 })),
    routeKind: Type.Optional(
      Type.Union([Type.Literal("spawn"), Type.Literal("send"), Type.Literal("steer")]),
    ),
    targetSessionKey: Type.Optional(Type.String({ minLength: 1 })),
    recoveryOfAssignmentId: Type.Optional(Type.String({ minLength: 1 })),
    remediationRevisionId: Type.Optional(Type.String({ minLength: 1 })),
  }),
  Type.Object({
    action: Type.Literal("freeze_wave"),
    sliceId: Type.String({ minLength: 1 }),
    requiredRoles: Type.Array(
      Type.Union([
        Type.Literal("helper"),
        Type.Literal("implementer"),
        Type.Literal("tester"),
        Type.Literal("reviewer"),
        Type.Literal("qa"),
      ]),
      { minItems: 1 },
    ),
  }),
  Type.Object({
    action: Type.Literal("issue_route_token"),
    assignmentId: Type.String({ minLength: 1 }),
    routeKind: Type.Union([Type.Literal("send"), Type.Literal("steer")]),
    targetSessionKey: Type.String({ minLength: 1 }),
  }),
  Type.Object({
    action: Type.Literal("validate_completion"),
    assignmentId: Type.String({ minLength: 1 }),
  }),
  Type.Object({
    action: Type.Literal("format_correction"),
    assignmentId: Type.String({ minLength: 1 }),
    originalReceiptId: Type.String({ minLength: 1 }),
    report: DelegationWorkerReportSchema,
  }),
  Type.Object({
    action: Type.Literal("consolidated_remediation"),
    sliceId: Type.String({ minLength: 1 }),
    sourceWaveId: Type.String({ minLength: 1 }),
    dispositions: Type.Array(RemediationDispositionSchema, { minItems: 1 }),
  }),
  Type.Object({
    action: Type.Literal("reconcile_unstarted_assignment"),
    assignmentId: Type.String({ minLength: 1 }),
    reason: Type.String({ minLength: 1 }),
  }),
  Type.Object({ action: Type.Literal("rollback"), reason: Type.String({ minLength: 1 }) }),
  Type.Object({ action: Type.Literal("status") }),
]);

function errorResult(error: unknown) {
  return jsonResult({
    status: "error",
    error: error instanceof Error ? error.message : "Delegation guard operation failed.",
  });
}

async function delegationFingerprintRemainsCurrent(
  params: Parameters<typeof fingerprintDelegationCandidate>[0] & {
    expectedCandidateDigest: string;
    expectedContextDigest: string;
  },
): Promise<boolean> {
  const { expectedCandidateDigest, expectedContextDigest, ...fingerprintParams } = params;
  const current = await fingerprintDelegationCandidate(fingerprintParams);
  return (
    current.candidateDigest === expectedCandidateDigest &&
    current.contextDigest === expectedContextDigest
  );
}

export function createDelegationGuardTool(opts: {
  config: OpenClawConfig;
  agentSessionKey?: string;
  requesterAgentIdOverride?: string;
  effectiveThinking?: string;
  senderIsOwner?: boolean;
  authorityWorkspaceDir?: string;
}): AnyAgentTool {
  return {
    label: "Delegation Guard",
    name: "delegation_guard",
    description:
      "Controller-only authority for guarded slices, immutable assignments and route tokens, verification waves, consolidated remediation, operator reconciliation of provably unstarted assignments, rollback, and bounded status.",
    parameters: DelegationGuardToolSchema,
    execute: async (_toolCallId, rawArgs) => {
      let controller;
      try {
        controller = requireDelegationController(opts);
      } catch (error) {
        return jsonResult({
          status: "forbidden",
          error: error instanceof Error ? error.message : "Controller authorization failed.",
        });
      }
      const args = rawArgs as Record<string, unknown>;
      const action = args.action;
      const { runtime, controllerAgentId } = controller;
      try {
        if (action === "create_slice") {
          const manifest = args.manifest as DelegationScopeManifest;
          if (manifest.kind === "repository" && opts.senderIsOwner !== true) {
            return jsonResult({
              status: "forbidden",
              error: "Repository-wide delegation scope requires trusted operator authorization.",
            });
          }
          const scope = canonicalizeDelegationScope(manifest);
          const authorityWorkspaceDir = opts.authorityWorkspaceDir?.trim();
          if (!authorityWorkspaceDir) {
            return jsonResult({
              status: "forbidden",
              error: "Guarded slice creation requires a runtime-owned authority workspace.",
            });
          }
          const repositoryRoot = await resolveDelegationRepositoryRoot(authorityWorkspaceDir);
          const fingerprint = await fingerprintDelegationCandidate({
            repoPath: repositoryRoot,
            scope,
            guard: runtime.guard,
            policyDigest: runtime.policyDigest,
            epoch: runtime.ledger.currentEpoch(),
          });
          const repositorySnapshot = await captureDelegationRepositorySnapshot({
            repoPath: repositoryRoot,
          });
          const validator = await runPinnedDelegationValidator({
            validator: runtime.guard.validator,
            request: {
              protocol: DELEGATION_VALIDATOR_PROTOCOL,
              action: "fingerprint",
              payload: {
                repoRoot: repositoryRoot,
                scope,
                epoch: runtime.ledger.currentEpoch(),
                policyDigest: runtime.policyDigest,
                fingerprint,
              },
            },
          });
          if (!validator.ok) {
            return jsonResult({ status: "rejected", action, issues: validator.issues ?? [] });
          }
          if (
            !(await delegationFingerprintRemainsCurrent({
              repoPath: repositoryRoot,
              scope,
              guard: runtime.guard,
              policyDigest: runtime.policyDigest,
              epoch: runtime.ledger.currentEpoch(),
              expectedCandidateDigest: fingerprint.candidateDigest,
              expectedContextDigest: fingerprint.contextDigest,
            }))
          ) {
            return jsonResult({
              status: "rejected",
              action,
              issues: [
                {
                  code: "candidate-drift",
                  message: "Repository state changed during baseline fingerprint validation.",
                },
              ],
            });
          }
          if (!opts.agentSessionKey?.trim()) {
            return jsonResult({
              status: "forbidden",
              error: "Guarded slice creation requires an exact controller session.",
            });
          }
          const baseline = runtime.ledger.createSliceWithBaseline({
            controllerAgentId,
            controllerSessionKey: opts.agentSessionKey,
            repositoryRoot,
            scope,
            fingerprint,
            repositorySnapshot,
          });
          return jsonResult({
            status: "ok",
            action,
            sliceId: baseline.sliceId,
            scopeDigest: scope.scopeDigest,
            baselineId: baseline.baselineId,
            candidateId: baseline.candidateId,
            candidateDigest: fingerprint.candidateDigest,
          });
        }

        if (action === "issue_assignment") {
          const sliceId = args.sliceId as string;
          const slice = runtime.ledger.getSliceScope(sliceId);
          if (
            !slice ||
            slice.controllerAgentId !== controllerAgentId ||
            slice.controllerSessionKey !== opts.agentSessionKey
          ) {
            return jsonResult({
              status: "forbidden",
              error: "Controller does not own this current delegation slice.",
            });
          }
          if (slice.epoch !== runtime.ledger.currentEpoch()) {
            return jsonResult({ status: "error", error: "Delegation slice is stale." });
          }
          const workerAgentId = args.workerAgentId as string;
          const worker = resolveDelegationGuardPrincipal(runtime.guard, workerAgentId);
          if (worker?.kind !== "worker") {
            return jsonResult({
              status: "error",
              error: `Agent ${workerAgentId} is not a configured guarded worker.`,
            });
          }
          assertDelegationWorkerSandbox({
            config: opts.config,
            workerAgentId: worker.agentId,
            workspaceAccess: worker.workspaceAccess,
          });
          const requestedCandidateId = args.candidateId as string | undefined;
          const waveId = args.waveId as string | undefined;
          const purpose = args.purpose as DelegationAssignmentPurpose;
          const candidateId = requestedCandidateId;
          if (
            (purpose === "discovery" || purpose === "implementation") &&
            (candidateId || waveId)
          ) {
            return jsonResult({
              status: "error",
              error: `${purpose} assignments use the protected baseline and cannot bind a candidate or wave.`,
            });
          }
          if (purpose === "discovery" || purpose === "implementation") {
            const baselineCandidate = runtime.ledger.latestCandidateRecordForSlice(sliceId);
            if (!baselineCandidate) {
              return jsonResult({
                status: "error",
                error: `${purpose} assignment requires a protected baseline candidate.`,
              });
            }
            await requireCurrentDelegationCandidate({
              runtime,
              sliceId,
              candidateId: baselineCandidate.candidateId,
            });
          }
          if (
            (purpose === "verification" ||
              purpose === "qa" ||
              purpose === "remediation" ||
              purpose === "confirmation") &&
            (!candidateId || !waveId)
          ) {
            return jsonResult({
              status: "error",
              error: `${purpose} assignments require an immutable candidateId and waveId.`,
            });
          }
          if (
            (purpose === "verification" ||
              purpose === "qa" ||
              purpose === "remediation" ||
              purpose === "confirmation") &&
            candidateId
          ) {
            await requireCurrentDelegationCandidate({ runtime, sliceId, candidateId });
          }
          const remediationRevisionId = args.remediationRevisionId as string | undefined;
          if (purpose === "remediation" && !remediationRevisionId) {
            return jsonResult({
              status: "error",
              error: "A consolidated remediation assignment requires remediationRevisionId.",
            });
          }
          if (!opts.agentSessionKey?.trim()) {
            return jsonResult({
              status: "forbidden",
              error: "Guarded assignment issuance requires an exact controller session.",
            });
          }
          const initialRouteKind =
            args.routeKind === "send" || args.routeKind === "steer" ? args.routeKind : "spawn";
          const targetSessionKey =
            typeof args.targetSessionKey === "string"
              ? args.targetSessionKey.trim() || undefined
              : undefined;
          if (
            (initialRouteKind === "spawn" && targetSessionKey) ||
            (initialRouteKind !== "spawn" && !targetSessionKey)
          ) {
            return jsonResult({
              status: "error",
              error:
                "Assignment routeKind=spawn cannot bind a target session; send/steer require targetSessionKey.",
            });
          }
          const issued = runtime.ledger.issueAssignment({
            sliceId,
            ...(candidateId ? { candidateId } : {}),
            ...(waveId ? { waveId } : {}),
            controllerAgentId,
            controllerSessionKey: opts.agentSessionKey,
            workerAgentId: worker.agentId,
            role: worker.role,
            requiredThinking: worker.requiredThinking,
            requiredModel: resolveDelegationWorkerRequiredModel(opts.config, worker.agentId),
            workspaceAccess: worker.workspaceAccess,
            purpose,
            initialRouteKind,
            ...(targetSessionKey ? { targetSessionKey } : {}),
            ...(remediationRevisionId ? { remediationRevisionId } : {}),
            ...(typeof args.recoveryOfAssignmentId === "string"
              ? { recoveryOfAssignmentId: args.recoveryOfAssignmentId }
              : {}),
          });
          return jsonResult({
            status: "ok",
            action,
            routeKind: initialRouteKind,
            ...(targetSessionKey ? { targetSessionKey } : {}),
            ...issued,
          });
        }

        if (action === "issue_route_token") {
          if (!opts.agentSessionKey?.trim()) {
            return jsonResult({
              status: "forbidden",
              error: "Guarded follow-up routing requires an exact controller session.",
            });
          }
          const assignmentId = args.assignmentId as string;
          const assignment = runtime.ledger.getAssignment(assignmentId);
          if (
            !assignment ||
            assignment.controllerAgentId !== controllerAgentId ||
            assignment.controllerSessionKey !== opts.agentSessionKey
          ) {
            return jsonResult({
              status: "forbidden",
              error: "Controller does not own this current delegation assignment.",
            });
          }
          const routeKind = args.routeKind as "send" | "steer";
          const targetSessionKey = (args.targetSessionKey as string).trim();
          if (!targetSessionKey) {
            return jsonResult({
              status: "error",
              error: "Follow-up route token requires a non-empty targetSessionKey.",
            });
          }
          const delegationToken = runtime.ledger.issueRouteToken({
            assignmentId,
            controllerAgentId,
            controllerSessionKey: opts.agentSessionKey,
            routeKind,
            targetSessionKey,
          });
          return jsonResult({
            status: "ok",
            action,
            assignmentId,
            routeKind,
            targetSessionKey,
            delegationToken,
          });
        }

        if (action === "freeze_wave") {
          const sliceId = args.sliceId as string;
          const slice = runtime.ledger.getSliceScope(sliceId);
          if (
            !slice ||
            slice.controllerAgentId !== controllerAgentId ||
            slice.controllerSessionKey !== opts.agentSessionKey
          ) {
            return jsonResult({
              status: "forbidden",
              error: "Controller does not own this delegation slice.",
            });
          }
          const fingerprint = await fingerprintDelegationCandidate({
            repoPath: slice.repositoryRoot,
            scope: slice.scope,
            guard: runtime.guard,
            policyDigest: runtime.policyDigest,
            epoch: runtime.ledger.currentEpoch(),
          });
          const repositorySnapshot = await captureDelegationRepositorySnapshot({
            repoPath: slice.repositoryRoot,
          });
          const validator = await runPinnedDelegationValidator({
            validator: runtime.guard.validator,
            request: {
              protocol: DELEGATION_VALIDATOR_PROTOCOL,
              action: "fingerprint",
              payload: {
                repoRoot: slice.repositoryRoot,
                scope: slice.scope,
                epoch: runtime.ledger.currentEpoch(),
                policyDigest: runtime.policyDigest,
                fingerprint,
              },
            },
          });
          if (!validator.ok) {
            return jsonResult({
              status: "rejected",
              action,
              issues: validator.issues ?? [],
            });
          }
          if (
            !(await delegationFingerprintRemainsCurrent({
              repoPath: slice.repositoryRoot,
              scope: slice.scope,
              guard: runtime.guard,
              policyDigest: runtime.policyDigest,
              epoch: runtime.ledger.currentEpoch(),
              expectedCandidateDigest: fingerprint.candidateDigest,
              expectedContextDigest: fingerprint.contextDigest,
            }))
          ) {
            return jsonResult({
              status: "rejected",
              action,
              issues: [
                {
                  code: "candidate-drift",
                  message: "Repository state changed during candidate fingerprint validation.",
                },
              ],
            });
          }
          const frozen = runtime.ledger.recordCandidateAndFreezeWave({
            sliceId,
            fingerprint,
            repositorySnapshot,
            requiredRoles: args.requiredRoles as Array<(typeof WorkerRoles)[number]>,
          });
          return jsonResult({
            status: "ok",
            action,
            candidateId: frozen.candidateId,
            candidateDigest: fingerprint.candidateDigest,
            waveId: frozen.waveId,
            fingerprint,
          });
        }

        if (action === "validate_completion") {
          const assignmentId = args.assignmentId as string;
          const assignment = runtime.ledger.getAssignment(assignmentId);
          if (
            !assignment ||
            assignment.controllerAgentId !== controllerAgentId ||
            assignment.controllerSessionKey !== opts.agentSessionKey
          ) {
            return jsonResult({
              status: "forbidden",
              error: "Controller does not own this delegation assignment.",
            });
          }
          const receipt = runtime.ledger.acceptedReceiptForAssignment(assignmentId);
          const completed = runtime.ledger.isAssignmentCompleted(assignmentId);
          return receipt && completed
            ? jsonResult({
                status: "completed",
                action,
                assignmentId,
                receiptId: receipt.receiptId,
                semanticDigest: receipt.semanticDigest,
              })
            : receipt
              ? jsonResult({
                  status: "awaiting_terminal_receipt",
                  action,
                  assignmentId,
                  receiptId: receipt.receiptId,
                  semanticDigest: receipt.semanticDigest,
                })
              : jsonResult({ status: "pending", action, assignmentId });
        }

        if (action === "format_correction") {
          const assignmentId = args.assignmentId as string;
          const assignment = runtime.ledger.getAssignment(assignmentId);
          if (
            !assignment ||
            assignment.controllerAgentId !== controllerAgentId ||
            assignment.controllerSessionKey !== opts.agentSessionKey
          ) {
            return jsonResult({
              status: "forbidden",
              error: "Controller does not own this delegation assignment.",
            });
          }
          const originalReceiptId =
            typeof args.originalReceiptId === "string" ? args.originalReceiptId.trim() : "";
          if (!originalReceiptId) {
            return jsonResult({
              status: "error",
              error:
                "Format correction requires originalReceiptId from a protected rejected or blocked receipt. A report rejected before receipt persistence cannot be format-corrected.",
            });
          }
          const report = args.report as DelegationWorkerReportInput as DelegationWorkerReport;
          const receiptId = runtime.ledger.appendFormatCorrection({
            assignmentId,
            originalReceiptId,
            report,
          });
          const storedReceipt = runtime.ledger.getReceipt(receiptId);
          if (!storedReceipt || storedReceipt.assignmentId !== assignmentId) {
            return jsonResult({
              status: "error",
              error: "Protected corrected receipt could not be read back after persistence.",
            });
          }
          const semanticDigest = storedReceipt.semanticDigest;
          const existingValidation = runtime.ledger.getValidationForReceipt(receiptId);
          if (existingValidation) {
            if (
              existingValidation.validatorId !== runtime.guard.validator.id ||
              existingValidation.validatorVersion !== runtime.guard.validator.version ||
              existingValidation.validatorDigest !== runtime.guard.validator.sha256
            ) {
              return jsonResult({
                status: "error",
                error:
                  "Protected correction validation does not match the active validator identity.",
              });
            }
            const terminalReceiptId =
              existingValidation.outcome === "accepted"
                ? runtime.ledger.promoteRecordedTerminalCompletion({ assignmentId })
                : undefined;
            return jsonResult({
              status: existingValidation.outcome,
              action,
              receiptId,
              validationId: existingValidation.validationId,
              semanticDigest,
              ...(terminalReceiptId ? { terminalReceiptId } : {}),
              issues: existingValidation.issues,
            });
          }
          let candidate: Awaited<ReturnType<typeof resolveDelegationReportCandidate>>;
          try {
            candidate = await resolveDelegationReportCandidate({ runtime, assignment });
          } catch (error) {
            const issue = {
              code: "candidate-drift",
              message:
                error instanceof Error
                  ? error.message
                  : "Assignment candidate could not be revalidated.",
            };
            const validationId = runtime.ledger.appendValidation({
              receiptId,
              outcome: "rejected",
              issues: [issue],
            });
            runtime.ledger.appendRouteEvent({
              assignmentId,
              kind: "validation_rejected",
              payload: { receiptId, validationId, code: issue.code, correction: true },
            });
            return jsonResult({
              status: "rejected",
              action,
              receiptId,
              validationId,
              issues: [issue],
            });
          }
          let validation: Awaited<ReturnType<typeof runPinnedDelegationValidator>>;
          try {
            validation = await runPinnedDelegationValidator({
              validator: runtime.guard.validator,
              request: {
                protocol: DELEGATION_VALIDATOR_PROTOCOL,
                action: "validate_report",
                payload: {
                  assignment,
                  scopeUnits: assignment.scopeUnits.map((scopeId) => ({ scopeId, path: scopeId })),
                  candidate: candidate
                    ? {
                        candidateId: candidate.candidateId,
                        fingerprint: candidate.fingerprint,
                      }
                    : undefined,
                  report,
                  semanticDigest,
                  correctionOf: args.originalReceiptId,
                },
              },
            });
          } catch (error) {
            const issue = {
              code: "validator-execution-failed",
              message: error instanceof Error ? error.message : "Delegation validator failed.",
            };
            const validationId = runtime.ledger.appendValidation({
              receiptId,
              outcome: "blocked",
              issues: [issue],
            });
            return jsonResult({
              status: "blocked",
              action,
              receiptId,
              validationId,
              issues: [issue],
            });
          }
          if (validation.ok && assignment.candidateId && assignment.workspaceAccess === "ro") {
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
                    : "Candidate changed during corrected-report validation.",
              };
              const validationId = runtime.ledger.appendValidation({
                receiptId,
                outcome: "rejected",
                issues: [issue],
              });
              runtime.ledger.appendRouteEvent({
                assignmentId,
                kind: "validation_rejected",
                payload: { receiptId, validationId, code: issue.code, correction: true },
              });
              return jsonResult({
                status: "rejected",
                action,
                receiptId,
                validationId,
                issues: [issue],
              });
            }
          }
          const validationId = runtime.ledger.appendValidation({
            receiptId,
            outcome: validation.ok ? "accepted" : "rejected",
            issues: validation.issues,
          });
          if (!validation.ok) {
            runtime.ledger.appendRouteEvent({
              assignmentId,
              kind: "validation_rejected",
              payload: { receiptId, validationId, correction: true },
            });
          }
          const terminalReceiptId = validation.ok
            ? runtime.ledger.promoteRecordedTerminalCompletion({ assignmentId })
            : undefined;
          return jsonResult({
            status: validation.ok ? "accepted" : "rejected",
            action,
            receiptId,
            validationId,
            semanticDigest,
            ...(terminalReceiptId ? { terminalReceiptId } : {}),
            issues: validation.issues ?? [],
          });
        }

        if (action === "consolidated_remediation") {
          const sliceId = args.sliceId as string;
          const slice = runtime.ledger.getSliceScope(sliceId);
          if (
            !slice ||
            slice.controllerAgentId !== controllerAgentId ||
            slice.controllerSessionKey !== opts.agentSessionKey
          ) {
            return jsonResult({
              status: "forbidden",
              error: "Controller does not own this delegation slice.",
            });
          }
          runtime.ledger.assertWaveSettledForRemediation(args.sourceWaveId as string);
          const candidate = runtime.ledger.latestCandidateRecordForSlice(sliceId);
          if (!candidate) {
            return jsonResult({
              status: "error",
              error: "Consolidated remediation requires a protected candidate.",
            });
          }
          await requireCurrentDelegationCandidate({
            runtime,
            sliceId,
            candidateId: candidate.candidateId,
          });
          const dispositions = args.dispositions as DelegationRemediationDisposition[];
          const revision = runtime.ledger.nextRemediationOrdinal(sliceId);
          const validation = await runPinnedDelegationValidator({
            validator: runtime.guard.validator,
            request: {
              protocol: DELEGATION_VALIDATOR_PROTOCOL,
              action: "validate_ledger",
              payload: {
                candidateId: candidate.candidateId,
                ledger: {
                  sliceId,
                  sourceWaveId: args.sourceWaveId,
                  revision,
                  dispositions,
                },
              },
            },
          });
          if (!validation.ok) {
            return jsonResult({
              status: "rejected",
              action,
              issues: validation.issues ?? [],
            });
          }
          await requireCurrentDelegationCandidate({
            runtime,
            sliceId,
            candidateId: candidate.candidateId,
          });
          const revisionId = runtime.ledger.appendRemediationRevision({
            sliceId,
            sourceWaveId: args.sourceWaveId as string,
            dispositions,
          });
          return jsonResult({ status: "ok", action, revisionId });
        }

        if (action === "reconcile_unstarted_assignment") {
          if (opts.senderIsOwner !== true) {
            return jsonResult({
              status: "forbidden",
              error: "Unstarted assignment reconciliation requires trusted operator authority.",
            });
          }
          if (!opts.agentSessionKey?.trim()) {
            return jsonResult({
              status: "forbidden",
              error: "Unstarted assignment reconciliation requires an exact controller session.",
            });
          }
          const assignmentId = args.assignmentId as string;
          runtime.ledger.rejectUnstartedAssignment({
            assignmentId,
            controllerAgentId,
            controllerSessionKey: opts.agentSessionKey,
            reason: args.reason as string,
          });
          return jsonResult({
            status: "ok",
            action,
            assignmentId,
          });
        }

        if (action === "rollback") {
          const epoch = runtime.ledger.rollback({
            actorAgentId: controllerAgentId,
            reason: args.reason as string,
          });
          return jsonResult({ status: "ok", action, epoch });
        }

        if (action === "status") {
          return jsonResult({ status: "ok", action, ledger: runtime.ledger.status() });
        }

        return jsonResult({ status: "error", error: "Unsupported delegation guard action." });
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}
