import { formatThinkingLevels, isThinkingLevelSupported } from "../auto-reply/thinking.js";
import type { DelegationGuardThinkingLevel } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSubagentSpawnModelSelection } from "./model-selection.js";
import { resolveSubagentThinkingOverride } from "./subagent-spawn-thinking.js";

export function splitModelRef(ref?: string) {
  if (!ref) {
    return { provider: undefined, model: undefined };
  }
  const trimmed = ref.trim();
  if (!trimmed) {
    return { provider: undefined, model: undefined };
  }
  const separator = trimmed.indexOf("/");
  if (separator > 0 && separator < trimmed.length - 1) {
    return {
      provider: trimmed.slice(0, separator),
      model: trimmed.slice(separator + 1),
    };
  }
  return { provider: undefined, model: trimmed };
}

export function resolveConfiguredSubagentRunTimeoutSeconds(params: {
  cfg: OpenClawConfig;
  runTimeoutSeconds?: number;
}) {
  const cfgSubagentTimeout =
    typeof params.cfg?.agents?.defaults?.subagents?.runTimeoutSeconds === "number" &&
    Number.isFinite(params.cfg.agents.defaults.subagents.runTimeoutSeconds)
      ? Math.max(0, Math.floor(params.cfg.agents.defaults.subagents.runTimeoutSeconds))
      : 0;
  return typeof params.runTimeoutSeconds === "number" && Number.isFinite(params.runTimeoutSeconds)
    ? Math.max(0, Math.floor(params.runTimeoutSeconds))
    : cfgSubagentTimeout;
}

export function resolveSubagentModelAndThinkingPlan(params: {
  cfg: OpenClawConfig;
  targetAgentId: string;
  targetAgentConfig?: unknown;
  modelOverride?: string;
  thinkingOverrideRaw?: string;
  requiredThinking?: DelegationGuardThinkingLevel;
}) {
  const resolvedModel = resolveSubagentSpawnModelSelection({
    cfg: params.cfg,
    agentId: params.targetAgentId,
    modelOverride: params.modelOverride,
  });

  const thinkingPlan = resolveSubagentThinkingOverride({
    cfg: params.cfg,
    targetAgentConfig: params.targetAgentConfig,
    thinkingOverrideRaw: params.thinkingOverrideRaw,
    requiredThinking: params.requiredThinking,
  });
  if (thinkingPlan.status === "error") {
    if ("error" in thinkingPlan && thinkingPlan.error) {
      return {
        status: "error" as const,
        resolvedModel,
        error: thinkingPlan.error,
      };
    }
    const { provider, model } = splitModelRef(resolvedModel);
    const hint = formatThinkingLevels(provider, model);
    return {
      status: "error" as const,
      resolvedModel,
      error: `Invalid thinking level "${thinkingPlan.thinkingCandidateRaw}". Use one of: ${hint}.`,
    };
  }

  if (params.requiredThinking) {
    const { provider, model } = splitModelRef(resolvedModel);
    if (!isThinkingLevelSupported({ provider, model, level: params.requiredThinking })) {
      return {
        status: "error" as const,
        resolvedModel,
        error: `Guarded delegation requires exact ${params.requiredThinking} thinking, which is not supported for ${resolvedModel}. Use a model that supports the required level.`,
      };
    }
  }

  return {
    status: "ok" as const,
    resolvedModel,
    modelApplied: Boolean(resolvedModel),
    thinkingOverride: thinkingPlan.thinkingOverride,
    initialSessionPatch: {
      ...(resolvedModel ? { model: resolvedModel } : {}),
      ...thinkingPlan.initialSessionPatch,
    },
  };
}
