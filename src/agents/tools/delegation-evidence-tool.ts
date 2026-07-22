import { Type } from "typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveDelegationGuardPrincipal,
  resolveDelegationWorkerRequiredModel,
} from "../delegation/policy.js";
import {
  captureDelegationRuntimeEvidence,
  resolveDelegationRuntimeEvidenceFailureStage,
} from "../delegation/runtime-evidence.js";
import {
  assertDelegationWorkerSandbox,
  requireCurrentDelegationCandidate,
  resolveDelegationCallerAgentId,
  resolveInitializedDelegationRuntime,
} from "../delegation/runtime.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";

export function createDelegationEvidenceTool(opts: {
  config: OpenClawConfig;
  agentSessionKey?: string;
  requesterAgentIdOverride?: string;
  effectiveThinking?: string;
}): AnyAgentTool {
  return {
    label: "Delegation Runtime Evidence",
    name: "delegation_evidence",
    description:
      "Read the current assignment's bounded, immutable protected-ledger and installed-runtime evidence. This action cannot select another identity or mutate runtime state.",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => {
      try {
        const runtime = resolveInitializedDelegationRuntime(opts.config);
        if (!runtime) {
          return jsonResult({
            status: "error",
            errorCode: "runtime_evidence_unavailable",
            error: "Installed runtime evidence is unavailable.",
          });
        }
        const workerAgentId = resolveDelegationCallerAgentId(opts);
        const worker = resolveDelegationGuardPrincipal(runtime.guard, workerAgentId);
        if (worker?.kind !== "worker" || (worker.role !== "tester" && worker.role !== "reviewer")) {
          return jsonResult({
            status: "forbidden",
            error: "Installed runtime evidence is restricted to guarded tester and reviewer lanes.",
          });
        }
        if (opts.effectiveThinking !== worker.requiredThinking) {
          return jsonResult({
            status: "forbidden",
            error: `Guarded ${worker.role} evidence requires exact ${worker.requiredThinking} thinking.`,
          });
        }
        assertDelegationWorkerSandbox({
          config: opts.config,
          workerAgentId,
          workspaceAccess: worker.workspaceAccess,
        });
        const childSessionKey = opts.agentSessionKey?.trim();
        if (!childSessionKey) {
          return jsonResult({
            status: "forbidden",
            error: "Runtime evidence requires a bound worker session.",
          });
        }
        const assignment = runtime.ledger.resolveAssignmentForChildSession(childSessionKey);
        const requiredModel = resolveDelegationWorkerRequiredModel(opts.config, workerAgentId);
        if (
          !assignment ||
          assignment.workerAgentId !== workerAgentId ||
          assignment.role !== worker.role ||
          assignment.requiredThinking !== worker.requiredThinking ||
          assignment.requiredModel !== requiredModel ||
          assignment.workspaceAccess !== "ro" ||
          !assignment.candidateId ||
          !assignment.waveId
        ) {
          return jsonResult({
            status: "forbidden",
            error: "Worker session is not bound to a current read-only frozen-wave assignment.",
          });
        }
        await requireCurrentDelegationCandidate({
          runtime,
          sliceId: assignment.sliceId,
          candidateId: assignment.candidateId,
        });
        const evidence = await captureDelegationRuntimeEvidence({
          config: opts.config,
          runtime,
          assignmentId: assignment.assignmentId,
          childSessionKey,
        });
        await requireCurrentDelegationCandidate({
          runtime,
          sliceId: assignment.sliceId,
          candidateId: assignment.candidateId,
        });
        return jsonResult({ status: "ok", evidence });
      } catch (error) {
        const failureStage = resolveDelegationRuntimeEvidenceFailureStage(error);
        return jsonResult({
          status: "error",
          errorCode: "runtime_evidence_capture_failed",
          error: "Installed runtime evidence capture failed closed.",
          ...(failureStage ? { failureStage } : {}),
        });
      }
    },
  };
}
