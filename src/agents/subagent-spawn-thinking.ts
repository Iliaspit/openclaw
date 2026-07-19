import { normalizeThinkLevel } from "../auto-reply/thinking.shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DelegationGuardThinkingLevel } from "../config/types.agents.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function readString(value: Record<string, unknown>, key: string): string | undefined {
  const raw = value[key];
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

export function resolveSubagentThinkingOverride(params: {
  cfg: OpenClawConfig;
  targetAgentConfig?: unknown;
  thinkingOverrideRaw?: string;
  requiredThinking?: DelegationGuardThinkingLevel;
}) {
  const targetSubagents = asRecord(asRecord(params.targetAgentConfig)?.subagents);
  const defaultSubagents = asRecord(params.cfg.agents?.defaults?.subagents);
  const resolvedThinkingDefaultRaw =
    readString(targetSubagents ?? {}, "thinking") ?? readString(defaultSubagents ?? {}, "thinking");

  const explicitThinking = params.thinkingOverrideRaw
    ? normalizeThinkLevel(params.thinkingOverrideRaw)
    : undefined;
  if (
    params.requiredThinking &&
    params.thinkingOverrideRaw &&
    explicitThinking !== params.requiredThinking
  ) {
    return {
      status: "error" as const,
      thinkingCandidateRaw: params.thinkingOverrideRaw,
      error: `Guarded delegation requires exact ${params.requiredThinking} thinking; conflicting overrides are not allowed.`,
    };
  }

  const thinkingCandidateRaw =
    params.requiredThinking ?? params.thinkingOverrideRaw ?? resolvedThinkingDefaultRaw;
  if (!thinkingCandidateRaw) {
    return {
      status: "ok" as const,
      thinkingOverride: undefined,
      initialSessionPatch: {},
    };
  }

  const normalizedThinking = normalizeThinkLevel(thinkingCandidateRaw);
  if (!normalizedThinking) {
    return {
      status: "error" as const,
      thinkingCandidateRaw,
    };
  }

  return {
    status: "ok" as const,
    thinkingOverride: normalizedThinking,
    initialSessionPatch: {
      thinkingLevel: normalizedThinking === "off" ? null : normalizedThinking,
    },
  };
}
