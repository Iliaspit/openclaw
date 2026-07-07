import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { estimateTokens } from "@mariozechner/pi-coding-agent";
import { SAFETY_MARGIN, estimateMessagesTokens } from "../../compaction.js";
import {
  MIN_PROMPT_BUDGET_RATIO,
  MIN_PROMPT_BUDGET_TOKENS,
} from "../../pi-compaction-constants.js";
import {
  calculateToolResultContextGuardMaxChars,
  estimateToolResultContextPressure,
} from "../tool-result-context-guard.js";
import { estimateToolResultReductionPotential } from "../tool-result-truncation.js";
import type { PreemptiveCompactionRoute } from "./preemptive-compaction.types.js";

export const PREEMPTIVE_OVERFLOW_ERROR_TEXT =
  "Context overflow: prompt too large for the model (precheck).";

const ESTIMATED_CHARS_PER_TOKEN = 4;
const TRUNCATION_ROUTE_BUFFER_TOKENS = 512;

export type { PreemptiveCompactionRoute } from "./preemptive-compaction.types.js";

export function estimatePrePromptTokens(params: {
  messages: AgentMessage[];
  systemPrompt?: string;
  prompt: string;
}): number {
  const { messages, systemPrompt, prompt } = params;
  const syntheticMessages: AgentMessage[] = [];
  if (typeof systemPrompt === "string" && systemPrompt.trim().length > 0) {
    syntheticMessages.push({
      role: "system",
      content: systemPrompt,
      timestamp: 0,
    } as unknown as AgentMessage);
  }
  syntheticMessages.push({ role: "user", content: prompt, timestamp: 0 } as AgentMessage);

  const estimated =
    estimateMessagesTokens(messages) +
    syntheticMessages.reduce((sum, message) => sum + estimateTokens(message), 0);
  return Math.max(0, Math.ceil(estimated * SAFETY_MARGIN));
}

export function calculatePreemptivePromptBudgetBeforeReserve(params: {
  contextTokenBudget: number;
  reserveTokens: number;
}): {
  contextTokenBudget: number;
  promptBudgetBeforeReserve: number;
  effectiveReserveTokens: number;
} {
  const contextTokenBudget = Math.max(1, Math.floor(params.contextTokenBudget));
  const requestedReserveTokens = Math.max(0, Math.floor(params.reserveTokens));
  const minPromptBudget = Math.min(
    MIN_PROMPT_BUDGET_TOKENS,
    Math.max(1, Math.floor(contextTokenBudget * MIN_PROMPT_BUDGET_RATIO)),
  );
  const effectiveReserveTokens = Math.min(
    requestedReserveTokens,
    Math.max(0, contextTokenBudget - minPromptBudget),
  );
  return {
    contextTokenBudget,
    promptBudgetBeforeReserve: Math.max(1, contextTokenBudget - effectiveReserveTokens),
    effectiveReserveTokens,
  };
}

export function shouldPreemptivelyCompactBeforePrompt(params: {
  messages: AgentMessage[];
  systemPrompt?: string;
  prompt: string;
  contextTokenBudget: number;
  reserveTokens: number;
  toolResultMaxChars?: number;
}): {
  route: PreemptiveCompactionRoute;
  shouldCompact: boolean;
  estimatedPromptTokens: number;
  promptBudgetBeforeReserve: number;
  overflowTokens: number;
  promptOverflowTokens: number;
  toolResultContextOverflowTokens: number;
  toolResultReducibleChars: number;
  totalToolResultChars: number;
  toolResultCount: number;
  toolResultContextEstimatedChars: number;
  toolResultContextMaxChars: number;
  toolResultContextRatio: number;
  effectiveReserveTokens: number;
} {
  const estimatedPromptTokens = estimatePrePromptTokens(params);
  const { contextTokenBudget, promptBudgetBeforeReserve, effectiveReserveTokens } =
    calculatePreemptivePromptBudgetBeforeReserve(params);
  const promptOverflowTokens = Math.max(0, estimatedPromptTokens - promptBudgetBeforeReserve);
  const toolResultPotential = estimateToolResultReductionPotential({
    messages: params.messages,
    contextWindowTokens: params.contextTokenBudget,
    maxCharsOverride: params.toolResultMaxChars,
  });
  const promptSideChars = Math.max(
    0,
    (typeof params.systemPrompt === "string" ? params.systemPrompt.length : 0) +
      params.prompt.length,
  );
  const toolResultContextPressure = estimateToolResultContextPressure({
    messages: params.messages,
    maxContextChars: calculateToolResultContextGuardMaxChars(promptBudgetBeforeReserve),
    additionalContextChars: promptSideChars,
  });
  const toolResultContextOverflowTokens =
    toolResultPotential.maxReducibleChars > 0 &&
    toolResultContextPressure.toolResultOverflowChars > 0
      ? Math.ceil(toolResultContextPressure.toolResultOverflowChars / ESTIMATED_CHARS_PER_TOKEN)
      : 0;
  const overflowTokens = Math.max(promptOverflowTokens, toolResultContextOverflowTokens);
  const overflowChars = promptOverflowTokens * ESTIMATED_CHARS_PER_TOKEN;
  const truncationBufferChars = TRUNCATION_ROUTE_BUFFER_TOKENS * ESTIMATED_CHARS_PER_TOKEN;
  const truncateOnlyThresholdChars = Math.max(
    overflowChars + truncationBufferChars,
    Math.ceil(overflowChars * 1.5),
  );
  const toolResultReducibleChars = toolResultPotential.maxReducibleChars;

  let route: PreemptiveCompactionRoute = "fits";
  if (promptOverflowTokens > 0) {
    if (toolResultReducibleChars <= 0) {
      route = "compact_only";
    } else if (toolResultReducibleChars >= truncateOnlyThresholdChars) {
      route = "truncate_tool_results_only";
    } else {
      route = "compact_then_truncate";
    }
  } else if (toolResultContextOverflowTokens > 0) {
    route = "compact_then_truncate";
  }
  return {
    route,
    shouldCompact: route === "compact_only" || route === "compact_then_truncate",
    estimatedPromptTokens,
    promptBudgetBeforeReserve,
    overflowTokens,
    promptOverflowTokens,
    toolResultContextOverflowTokens,
    toolResultReducibleChars,
    totalToolResultChars: toolResultPotential.totalToolResultChars,
    toolResultCount: toolResultPotential.toolResultCount,
    toolResultContextEstimatedChars: toolResultContextPressure.estimatedContextChars,
    toolResultContextMaxChars: toolResultContextPressure.maxContextChars,
    toolResultContextRatio: toolResultContextPressure.ratio,
    effectiveReserveTokens,
  };
}
