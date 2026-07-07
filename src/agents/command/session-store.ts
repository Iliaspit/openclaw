import {
  mergeSessionEntry,
  setSessionRuntimeModel,
  type SessionEntry,
  updateSessionStore,
} from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { recordAgentRuntimeIssue } from "../../infra/agent-runtime-health.js";
import { isSubagentSessionKey } from "../../routing/session-key.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { clearCliSession, setCliSessionBinding, setCliSessionId } from "../cli-session.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { isCliProvider } from "../model-selection.js";
import { deriveSessionTotalTokens, hasNonzeroUsage } from "../usage.js";

type RunResult = Awaited<ReturnType<(typeof import("../pi-embedded.js"))["runEmbeddedPiAgent"]>>;

let usageFormatModulePromise: Promise<typeof import("../../utils/usage-format.js")> | undefined;
let contextModulePromise: Promise<typeof import("../context.js")> | undefined;

async function getUsageFormatModule() {
  usageFormatModulePromise ??= import("../../utils/usage-format.js");
  return await usageFormatModulePromise;
}

async function getContextModule() {
  contextModulePromise ??= import("../context.js");
  return await contextModulePromise;
}

const CHILD_CONTEXT_WINDOW_DANGER_RATIO = 0.9;
const CHILD_TOOL_CALL_GUARDRAIL_LIMIT = 80;

function resolveNonNegativeNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isChildSession(
  sessionKey: string,
  entry: Pick<SessionEntry, "spawnedBy" | "parentSessionKey">,
) {
  return Boolean(
    normalizeOptionalString(entry.spawnedBy) ||
    normalizeOptionalString(entry.parentSessionKey) ||
    isSubagentSessionKey(sessionKey),
  );
}

function recordChildRunGuardrails(params: {
  runId?: string;
  sessionKey: string;
  entry: SessionEntry;
  result: RunResult;
  currentRunTotalTokens?: number;
  contextTokens?: number;
}) {
  if (!params.runId || !isChildSession(params.sessionKey, params.entry)) {
    return;
  }

  const totalTokens = resolveNonNegativeNumber(params.currentRunTotalTokens);
  const contextTokens = resolveNonNegativeNumber(params.contextTokens);
  if (
    totalTokens !== undefined &&
    contextTokens !== undefined &&
    contextTokens > 0 &&
    totalTokens >= contextTokens * CHILD_CONTEXT_WINDOW_DANGER_RATIO
  ) {
    recordAgentRuntimeIssue({
      runId: params.runId,
      code: "context_overflow",
      severity: "error",
      message: `Child session context is near its model window (${totalTokens}/${contextTokens} tokens). Spawn a fresh child before assigning follow-up work.`,
      sessionKey: params.sessionKey,
    });
  }

  const toolCalls = resolveNonNegativeNumber(params.result.meta.toolSummary?.calls);
  if (toolCalls !== undefined && toolCalls >= CHILD_TOOL_CALL_GUARDRAIL_LIMIT) {
    recordAgentRuntimeIssue({
      runId: params.runId,
      code: "agent_lifecycle_blocked",
      severity: "error",
      message: `Child run used ${toolCalls} tool calls, reaching the ${CHILD_TOOL_CALL_GUARDRAIL_LIMIT}-call guardrail. Spawn a fresh child before assigning follow-up work.`,
      sessionKey: params.sessionKey,
      livenessState: "blocked",
    });
  }
}

export async function updateSessionStoreAfterAgentRun(params: {
  cfg: OpenClawConfig;
  contextTokensOverride?: number;
  runId?: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
  sessionStore: Record<string, SessionEntry>;
  defaultProvider: string;
  defaultModel: string;
  fallbackProvider?: string;
  fallbackModel?: string;
  result: RunResult;
}) {
  const {
    cfg,
    sessionId,
    sessionKey,
    storePath,
    sessionStore,
    defaultProvider,
    defaultModel,
    fallbackProvider,
    fallbackModel,
    result,
  } = params;

  const usage = result.meta.agentMeta?.usage;
  const promptTokens = result.meta.agentMeta?.promptTokens;
  const compactionsThisRun = Math.max(0, result.meta.agentMeta?.compactionCount ?? 0);
  const modelUsed = result.meta.agentMeta?.model ?? fallbackModel ?? defaultModel;
  const providerUsed = result.meta.agentMeta?.provider ?? fallbackProvider ?? defaultProvider;
  const agentHarnessId = normalizeOptionalString(result.meta.agentMeta?.agentHarnessId);
  const contextTokens =
    typeof params.contextTokensOverride === "number" && params.contextTokensOverride > 0
      ? params.contextTokensOverride
      : ((await getContextModule()).resolveContextTokensForModel({
          cfg,
          provider: providerUsed,
          model: modelUsed,
          fallbackContextTokens: DEFAULT_CONTEXT_TOKENS,
          allowAsyncLoad: false,
        }) ?? DEFAULT_CONTEXT_TOKENS);

  const entry = sessionStore[sessionKey] ?? {
    sessionId,
    updatedAt: Date.now(),
  };
  const next: SessionEntry = {
    ...entry,
    sessionId,
    updatedAt: Date.now(),
    contextTokens,
  };
  setSessionRuntimeModel(next, {
    provider: providerUsed,
    model: modelUsed,
  });
  if (agentHarnessId) {
    next.agentHarnessId = agentHarnessId;
  } else if (result.meta.executionTrace?.runner === "cli") {
    next.agentHarnessId = undefined;
  }
  if (isCliProvider(providerUsed, cfg)) {
    const cliSessionBinding = result.meta.agentMeta?.cliSessionBinding;
    if (cliSessionBinding?.sessionId?.trim()) {
      setCliSessionBinding(next, providerUsed, cliSessionBinding);
    } else {
      const cliSessionId = result.meta.agentMeta?.sessionId?.trim();
      if (cliSessionId) {
        setCliSessionId(next, providerUsed, cliSessionId);
      }
    }
  }
  next.abortedLastRun = result.meta.aborted ?? false;
  if (result.meta.systemPromptReport) {
    next.systemPromptReport = result.meta.systemPromptReport;
  }
  const totalTokens = deriveSessionTotalTokens({
    usage: promptTokens ? undefined : usage,
    contextTokens,
    promptTokens,
  });
  if (hasNonzeroUsage(usage)) {
    const { estimateUsageCost, resolveModelCostConfig } = await getUsageFormatModule();
    const input = usage.input ?? 0;
    const output = usage.output ?? 0;
    const runEstimatedCostUsd = resolveNonNegativeNumber(
      estimateUsageCost({
        usage,
        cost: resolveModelCostConfig({
          provider: providerUsed,
          model: modelUsed,
          config: cfg,
        }),
      }),
    );
    next.inputTokens = input;
    next.outputTokens = output;
    if (typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens > 0) {
      next.totalTokens = totalTokens;
      next.totalTokensFresh = true;
    } else {
      next.totalTokens = undefined;
      next.totalTokensFresh = false;
    }
    next.cacheRead = usage.cacheRead ?? 0;
    next.cacheWrite = usage.cacheWrite ?? 0;
    // Snapshot cost like tokens (runEstimatedCostUsd is already computed from
    // cumulative run usage, so assign directly instead of accumulating).
    // Fixes #69347: cost was inflated 1x-72x by accumulating on every persist.
    if (runEstimatedCostUsd !== undefined) {
      next.estimatedCostUsd = runEstimatedCostUsd;
    }
  } else if (typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens > 0) {
    next.totalTokens = totalTokens;
    next.totalTokensFresh = true;
  } else if (
    typeof entry.totalTokens === "number" &&
    Number.isFinite(entry.totalTokens) &&
    entry.totalTokens > 0
  ) {
    next.totalTokens = entry.totalTokens;
    next.totalTokensFresh = false;
  }
  if (compactionsThisRun > 0) {
    next.compactionCount = (entry.compactionCount ?? 0) + compactionsThisRun;
  }
  const persisted = await updateSessionStore(storePath, (store) => {
    const merged = mergeSessionEntry(store[sessionKey], next);
    store[sessionKey] = merged;
    return merged;
  });
  sessionStore[sessionKey] = persisted;
  recordChildRunGuardrails({
    runId: params.runId,
    sessionKey,
    entry: persisted,
    result,
    currentRunTotalTokens: totalTokens,
    contextTokens,
  });
}

export async function clearCliSessionInStore(params: {
  provider: string;
  sessionKey: string;
  sessionStore: Record<string, SessionEntry>;
  storePath: string;
}): Promise<SessionEntry | undefined> {
  const { provider, sessionKey, sessionStore, storePath } = params;
  const entry = sessionStore[sessionKey];
  if (!entry) {
    return undefined;
  }

  const next = { ...entry };
  clearCliSession(next, provider);
  next.updatedAt = Date.now();

  const persisted = await updateSessionStore(storePath, (store) => {
    const merged = mergeSessionEntry(store[sessionKey], next);
    store[sessionKey] = merged;
    return merged;
  });
  sessionStore[sessionKey] = persisted;
  return persisted;
}
