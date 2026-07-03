import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentConfig } from "./agent-scope.js";
import { sanitizeForPromptLiteral } from "./sanitize-for-prompt.js";

function trimNonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveSystemPromptOverride(params: {
  config?: OpenClawConfig;
  agentId?: string;
  workspaceDir?: string;
}): string | undefined {
  const workspaceOverride = buildRuntimeWorkspaceOverride(params.workspaceDir);
  const config = params.config;
  if (!config) {
    return workspaceOverride;
  }
  const agentOverride = trimNonEmpty(
    params.agentId ? resolveAgentConfig(config, params.agentId)?.systemPromptOverride : undefined,
  );
  if (agentOverride) {
    return [workspaceOverride, agentOverride].filter(Boolean).join("\n\n");
  }
  const defaultOverride = trimNonEmpty(config.agents?.defaults?.systemPromptOverride);
  if (defaultOverride) {
    return [workspaceOverride, defaultOverride].filter(Boolean).join("\n\n");
  }
  return workspaceOverride;
}

function buildRuntimeWorkspaceOverride(workspaceDir?: string): string | undefined {
  const trimmed = trimNonEmpty(workspaceDir);
  if (!trimmed) {
    return undefined;
  }
  const literalWorkspaceDir = sanitizeForPromptLiteral(trimmed);
  return [
    "## Runtime Workspace Override",
    `Current session workspace (authoritative): ${literalWorkspaceDir}`,
    "Use this current session workspace for file operations, AGENTS/rules lookups, and exec/bash workdir selection unless the user explicitly directs a different path.",
    "If any later agent-specific prompt text mentions a fixed workspace such as /workspace/astino or /Users/iliaspittas/astino, treat that as stale example text and follow the current session workspace instead.",
  ].join("\n");
}
