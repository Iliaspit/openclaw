import type {
  DelegationGuardConfig,
  DelegationGuardThinkingLevel,
  DelegationGuardWorkerRole,
} from "../../config/types.agents.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { hashDelegationIdentity } from "./identity.js";

export type DelegationGuardPrincipal =
  | { kind: "controller"; agentId: string; requiredThinking: "xhigh" }
  | {
      kind: "worker";
      agentId: string;
      role: DelegationGuardWorkerRole;
      requiredThinking: DelegationGuardThinkingLevel;
      workspaceAccess: "ro" | "rw";
    };

export function resolveDelegationPolicyDigest(guard: DelegationGuardConfig): string {
  return hashDelegationIdentity("delegation-policy-v1", guard);
}

export function resolveDelegationGuardConfig(
  config: OpenClawConfig,
): DelegationGuardConfig | undefined {
  const guard = config.agents?.delegationGuard;
  return guard?.enabled ? guard : undefined;
}

export function resolveDelegationGuardPrincipal(
  guard: DelegationGuardConfig,
  agentId: string,
): DelegationGuardPrincipal | undefined {
  const normalized = normalizeAgentId(agentId);
  const controller = guard.controllers.find(
    (entry) => normalizeAgentId(entry.agentId) === normalized,
  );
  if (controller) {
    return { kind: "controller", agentId: normalized, requiredThinking: "xhigh" };
  }
  const worker = guard.workers.find((entry) => normalizeAgentId(entry.agentId) === normalized);
  if (!worker) {
    return undefined;
  }
  return {
    kind: "worker",
    agentId: normalized,
    role: worker.role,
    requiredThinking: worker.requiredThinking,
    workspaceAccess: worker.workspaceAccess,
  };
}

export function resolveDelegationWorkerRequiredModel(
  config: OpenClawConfig,
  workerAgentId: string,
): string {
  const normalized = normalizeAgentId(workerAgentId);
  const entry = config.agents?.list?.find((agent) => normalizeAgentId(agent.id) === normalized);
  const model = typeof entry?.model === "string" ? entry.model : entry?.model?.primary;
  if (!model?.trim() || !model.includes("/")) {
    throw new Error(
      `Guarded worker ${workerAgentId} requires one explicit provider/model primary.`,
    );
  }
  if (typeof entry?.model !== "string" && (entry?.model?.fallbacks?.length ?? 0) > 0) {
    throw new Error(`Guarded worker ${workerAgentId} cannot configure model fallbacks.`);
  }
  return model.trim();
}

export function assertDelegationController(params: {
  guard: DelegationGuardConfig;
  agentId: string;
  effectiveThinking?: string;
}): Extract<DelegationGuardPrincipal, { kind: "controller" }> {
  const principal = resolveDelegationGuardPrincipal(params.guard, params.agentId);
  if (principal?.kind !== "controller") {
    throw new Error(`Agent ${params.agentId} is not a guarded delegation controller.`);
  }
  if (params.effectiveThinking !== "xhigh") {
    throw new Error("Guarded controller operations require exact xhigh thinking.");
  }
  return principal;
}

export function assertDelegationWorker(params: {
  guard: DelegationGuardConfig;
  agentId: string;
  role?: DelegationGuardWorkerRole;
  effectiveThinking?: string;
}): Extract<DelegationGuardPrincipal, { kind: "worker" }> {
  const principal = resolveDelegationGuardPrincipal(params.guard, params.agentId);
  if (principal?.kind !== "worker") {
    throw new Error(`Agent ${params.agentId} is not a guarded delegation worker.`);
  }
  if (params.role && principal.role !== params.role) {
    throw new Error(`Agent ${params.agentId} is not assigned the ${params.role} role.`);
  }
  if (params.effectiveThinking !== principal.requiredThinking) {
    throw new Error(
      `Guarded ${principal.role} operations require exact ${principal.requiredThinking} thinking.`,
    );
  }
  return principal;
}
