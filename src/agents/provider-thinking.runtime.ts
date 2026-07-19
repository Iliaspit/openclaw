import type { ThinkLevel } from "../auto-reply/thinking.js";
import { normalizeThinkLevel } from "../auto-reply/thinking.js";
import { THINKING_LEVEL_RANKS } from "../auto-reply/thinking.shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveProviderHookPlugin } from "../plugins/provider-hook-runtime.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

type RuntimeProviderThinkingParams = {
  provider: string;
  model: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
};

function resolveRuntimeProviderThinkingProfile(params: RuntimeProviderThinkingParams) {
  return resolveProviderHookPlugin({
    provider: params.provider,
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  })?.resolveThinkingProfile?.({
    provider: params.provider,
    modelId: params.model,
  });
}

export function resolveRuntimeProviderThinkingLevelSupport(
  params: RuntimeProviderThinkingParams & {
  level: ThinkLevel;
  },
): boolean | undefined {
  const profile = resolveRuntimeProviderThinkingProfile(params);
  if (!profile) {
    return undefined;
  }
  return profile.levels.some((entry) => normalizeThinkLevel(entry.id) === params.level);
}

export function resolveRuntimeProviderThinkingLevelLabels(
  params: RuntimeProviderThinkingParams,
): string[] | undefined {
  const profile = resolveRuntimeProviderThinkingProfile(params);
  if (!profile) {
    return undefined;
  }
  const byId = new Map<ThinkLevel, { label: string; rank: number }>();
  for (const entry of profile.levels) {
    const id = normalizeThinkLevel(entry.id);
    if (!id) {
      continue;
    }
    byId.set(id, {
      label: normalizeOptionalString(entry.label) ?? id,
      rank: Number.isFinite(entry.rank) ? (entry.rank as number) : THINKING_LEVEL_RANKS[id],
    });
  }
  return [...byId.values()].toSorted((a, b) => a.rank - b.rank).map((entry) => entry.label);
}
