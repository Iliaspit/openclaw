import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { resolveAgentContextLimits } from "../agent-scope.js";
import { acquireSessionWriteLock } from "../session-write-lock.js";
import { log } from "./logger.js";
import { formatContextLimitTruncationNotice } from "./tool-result-context-guard.js";
import { rewriteTranscriptEntriesInSessionManager } from "./transcript-rewrite.js";

/**
 * Maximum share of the context window a single tool result should occupy.
 * This is intentionally conservative – a single tool result should not
 * consume more than 30% of the context window even without other messages.
 */
const MAX_TOOL_RESULT_CONTEXT_SHARE = 0.3;

/**
 * Default hard cap for a single live tool result text block.
 *
 * Pi already truncates tool results aggressively when serializing old history
 * for compaction summaries. For the live request path we still keep a bounded
 * request-local ceiling so oversized tool output cannot dominate the next turn.
 */
export const DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS = 16_000;

/**
 * Backwards-compatible alias for older call sites/tests.
 */
export const HARD_MAX_TOOL_RESULT_CHARS = DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS;

/**
 * Minimum characters to keep when truncating.
 * We always keep at least the first portion so the model understands
 * what was in the content.
 */
const MIN_KEEP_CHARS = 2_000;
const RECOVERY_MIN_KEEP_CHARS = 0;
const DEFAULT_MAX_TOOL_RESULT_DETAILS_CHARS = 4_000;
const MIN_TOOL_RESULT_DETAILS_CHARS = 256;
const TOOL_RESULT_DETAILS_CONTEXT_SHARE = 0.25;
const TOOL_RESULT_DETAILS_ARRAY_SAMPLE_LIMIT = 3;
const TOOL_RESULT_DETAILS_OBJECT_FIELD_LIMIT = 24;
const TOOL_RESULT_DETAILS_SHALLOW_SCALAR_LIMIT = 12;
const TOOL_RESULT_DETAILS_SHALLOW_STRING_MAX_CHARS = 200;
const TOOL_RESULT_DETAILS_STRING_MAX_CHARS = 1_200;
const TOOL_RESULT_DETAILS_TRUNCATION_SUFFIX = "\n\n[tool result details truncated]";
const DUPLICATE_TOOL_RESULT_MIN_TEXT_CHARS = 8_000;
const DUPLICATE_TOOL_RESULT_OMISSION_LABEL = "[tool result duplicate omitted]";

type ToolResultTruncationOptions = {
  suffix?: string | ((truncatedChars: number) => string);
  minKeepChars?: number;
};

type ToolResultPayloadLike = {
  content?: unknown;
  details?: unknown;
};

const DEFAULT_SUFFIX = (truncatedChars: number) =>
  formatContextLimitTruncationNotice(truncatedChars);
export const MIN_TRUNCATED_TEXT_CHARS = MIN_KEEP_CHARS + DEFAULT_SUFFIX(1).length;

function resolveSuffixFactory(
  suffix: ToolResultTruncationOptions["suffix"],
): (truncatedChars: number) => string {
  if (typeof suffix === "function") {
    return suffix;
  }
  if (typeof suffix === "string") {
    return () => suffix;
  }
  return DEFAULT_SUFFIX;
}

function resolveEffectiveMinKeepChars(params: {
  maxChars: number;
  minKeepChars: number;
  suffixFactory: (truncatedChars: number) => string;
}): number {
  const suffixFloor = params.suffixFactory(1).length;
  return Math.max(0, Math.min(params.minKeepChars, Math.max(0, params.maxChars - suffixFloor)));
}

function appendBoundedTruncationSuffix(params: {
  keptText: string;
  originalTextLength: number;
  maxChars: number;
  suffixFactory: (truncatedChars: number) => string;
}): string {
  const build = (keptText: string) =>
    keptText + params.suffixFactory(Math.max(1, params.originalTextLength - keptText.length));

  let keptText = params.keptText;
  while (true) {
    const finalText = build(keptText);
    if (finalText.length <= params.maxChars) {
      return finalText;
    }
    if (keptText.length === 0) {
      return finalText.slice(0, params.maxChars);
    }
    const overflow = finalText.length - params.maxChars;
    const nextKeptText = keptText.slice(0, Math.max(0, keptText.length - overflow));
    keptText = nextKeptText.length < keptText.length ? nextKeptText : keptText.slice(0, -1);
  }
}

/**
 * Marker inserted between head and tail when using head+tail truncation.
 */
const MIDDLE_OMISSION_MARKER =
  "\n\n⚠️ [... middle content omitted — showing head and tail ...]\n\n";

/**
 * Detect whether text likely contains error/diagnostic content near the end,
 * which should be preserved during truncation.
 */
function hasImportantTail(text: string): boolean {
  // Check last ~2000 chars for error-like patterns
  const tail = normalizeLowercaseStringOrEmpty(text.slice(-2000));
  return (
    /\b(error|exception|failed|fatal|traceback|panic|stack trace|errno|exit code)\b/.test(tail) ||
    // JSON closing — if the output is JSON, the tail has closing structure
    /\}\s*$/.test(tail.trim()) ||
    // Summary/result lines often appear at the end
    /\b(total|summary|result|complete|finished|done)\b/.test(tail)
  );
}

/**
 * Truncate a single text string to fit within maxChars.
 *
 * Uses a head+tail strategy when the tail contains important content
 * (errors, results, JSON structure), otherwise preserves the beginning.
 * This ensures error messages and summaries at the end of tool output
 * aren't lost during truncation.
 */
export function truncateToolResultText(
  text: string,
  maxChars: number,
  options: ToolResultTruncationOptions = {},
): string {
  const suffixFactory = resolveSuffixFactory(options.suffix);
  const minKeepChars = resolveEffectiveMinKeepChars({
    maxChars,
    minKeepChars: options.minKeepChars ?? MIN_KEEP_CHARS,
    suffixFactory,
  });
  if (text.length <= maxChars) {
    return text;
  }
  const defaultSuffix = suffixFactory(Math.max(1, text.length - maxChars));
  const budget = Math.max(minKeepChars, maxChars - defaultSuffix.length);

  // If tail looks important, split budget between head and tail
  if (hasImportantTail(text) && budget > minKeepChars * 2) {
    const tailBudget = Math.min(Math.floor(budget * 0.3), 4_000);
    const headBudget = budget - tailBudget - MIDDLE_OMISSION_MARKER.length;

    if (headBudget > minKeepChars) {
      // Find clean cut points at newline boundaries
      let headCut = headBudget;
      const headNewline = text.lastIndexOf("\n", headBudget);
      if (headNewline > headBudget * 0.8) {
        headCut = headNewline;
      }

      let tailStart = text.length - tailBudget;
      const tailNewline = text.indexOf("\n", tailStart);
      if (tailNewline !== -1 && tailNewline < tailStart + tailBudget * 0.2) {
        tailStart = tailNewline + 1;
      }

      const keptText = text.slice(0, headCut) + MIDDLE_OMISSION_MARKER + text.slice(tailStart);
      return appendBoundedTruncationSuffix({
        keptText,
        originalTextLength: text.length,
        maxChars,
        suffixFactory,
      });
    }
  }

  // Default: keep the beginning
  let cutPoint = budget;
  const lastNewline = text.lastIndexOf("\n", budget);
  if (lastNewline > budget * 0.8) {
    cutPoint = lastNewline;
  }
  const keptText = text.slice(0, cutPoint);
  return appendBoundedTruncationSuffix({
    keptText,
    originalTextLength: text.length,
    maxChars,
    suffixFactory,
  });
}

/**
 * Calculate the maximum allowed characters for a single tool result
 * based on the model's context window tokens.
 *
 * Uses a rough 4 chars ≈ 1 token heuristic (conservative for English text;
 * actual ratio varies by tokenizer).
 */
export function calculateMaxToolResultChars(contextWindowTokens: number): number {
  return calculateMaxToolResultCharsWithCap(
    contextWindowTokens,
    DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS,
  );
}

export function calculateMaxToolResultCharsWithCap(
  contextWindowTokens: number,
  hardCapChars: number,
): number {
  const maxTokens = Math.floor(contextWindowTokens * MAX_TOOL_RESULT_CONTEXT_SHARE);
  // Rough conversion: ~4 chars per token on average
  const maxChars = maxTokens * 4;
  return Math.min(maxChars, Math.max(1, hardCapChars));
}

export function resolveLiveToolResultMaxChars(params: {
  contextWindowTokens: number;
  cfg?: OpenClawConfig;
  agentId?: string | null;
}): number {
  const configuredCap =
    resolveAgentContextLimits(params.cfg, params.agentId)?.toolResultMaxChars ??
    DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS;
  return calculateMaxToolResultCharsWithCap(params.contextWindowTokens, configuredCap);
}

/**
 * Get the total character count of text content blocks in a tool result message.
 */
export function getToolResultTextLength(msg: AgentMessage): number {
  if (!msg || (msg as { role?: string }).role !== "toolResult") {
    return 0;
  }
  return getToolResultPayloadTextLength(msg as ToolResultPayloadLike);
}

function getToolResultPayloadTextLength(payload: ToolResultPayloadLike): number {
  const content = payload.content;
  if (!Array.isArray(content)) {
    return 0;
  }
  let totalLength = 0;
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      const text = (block as TextContent).text;
      if (typeof text === "string") {
        totalLength += text.length;
      }
    }
  }
  return totalLength;
}

function stringifyToolResultDetails(details: unknown): string {
  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
}

export function getToolResultDetailsLength(msg: AgentMessage): number {
  if (!msg || (msg as { role?: string }).role !== "toolResult") {
    return 0;
  }
  const details = (msg as { details?: unknown }).details;
  return details === undefined ? 0 : stringifyToolResultDetails(details).length;
}

export function getToolResultContextLength(msg: AgentMessage): number {
  if (!msg || (msg as { role?: string }).role !== "toolResult") {
    return 0;
  }
  return getToolResultTextLength(msg) + getToolResultDetailsLength(msg);
}

function resolveDetailsBudget(maxChars: number): number {
  return Math.max(
    1,
    Math.min(
      DEFAULT_MAX_TOOL_RESULT_DETAILS_CHARS,
      Math.max(
        MIN_TOOL_RESULT_DETAILS_CHARS,
        Math.floor(maxChars * TOOL_RESULT_DETAILS_CONTEXT_SHARE),
      ),
    ),
  );
}

function summarizeToolResultDetailValue(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return value.length > TOOL_RESULT_DETAILS_STRING_MAX_CHARS
      ? truncateToolResultText(value, TOOL_RESULT_DETAILS_STRING_MAX_CHARS, {
          suffix: TOOL_RESULT_DETAILS_TRUNCATION_SUFFIX,
          minKeepChars: 0,
        })
      : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "symbol") {
    return value.description ? `Symbol(${value.description})` : "Symbol()";
  }
  if (typeof value === "function") {
    return value.name ? `[Function ${value.name}]` : "[Function]";
  }
  if (typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const sample = value
      .slice(0, TOOL_RESULT_DETAILS_ARRAY_SAMPLE_LIMIT)
      .map((entry) => summarizeToolResultDetailValue(entry, depth + 1, seen));
    return {
      truncated: value.length > sample.length,
      originalItems: value.length,
      sample,
    };
  }

  const record = value as Record<string, unknown>;
  const entries = Object.entries(record);
  const result: Record<string, unknown> = {};
  for (const [key, entryValue] of entries.slice(0, TOOL_RESULT_DETAILS_OBJECT_FIELD_LIMIT)) {
    result[key] = summarizeToolResultDetailValue(entryValue, depth + 1, seen);
  }
  if (entries.length > TOOL_RESULT_DETAILS_OBJECT_FIELD_LIMIT) {
    result.truncatedFields = entries.length - TOOL_RESULT_DETAILS_OBJECT_FIELD_LIMIT;
  }
  return result;
}

function collectShallowToolResultDetailsMetadata(details: unknown): Record<string, unknown> {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return {};
  }

  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details).slice(
    0,
    TOOL_RESULT_DETAILS_OBJECT_FIELD_LIMIT,
  )) {
    if (Object.keys(metadata).length >= TOOL_RESULT_DETAILS_SHALLOW_SCALAR_LIMIT) {
      break;
    }
    if (typeof value === "string") {
      if (value.length <= TOOL_RESULT_DETAILS_SHALLOW_STRING_MAX_CHARS) {
        metadata[key] = value;
      }
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean" || value === null) {
      metadata[key] = value;
    }
  }
  return metadata;
}

function truncateToolResultDetails(
  details: unknown,
  maxChars: number,
): {
  details: unknown;
  truncated: boolean;
} {
  if (details === undefined) {
    return { details, truncated: false };
  }
  const serialized = stringifyToolResultDetails(details);
  if (serialized.length <= maxChars) {
    return { details, truncated: false };
  }

  const summarized = summarizeToolResultDetailValue(details);
  const summarizedDetails =
    summarized && typeof summarized === "object" && !Array.isArray(summarized)
      ? {
          ...summarized,
          detailsTruncated: true,
          originalDetailsChars: serialized.length,
        }
      : {
          detailsTruncated: true,
          originalDetailsChars: serialized.length,
          value: summarized,
        };
  if (stringifyToolResultDetails(summarizedDetails).length <= maxChars) {
    return { details: summarizedDetails, truncated: true };
  }

  const fallbackBase: Record<string, unknown> = {
    ...collectShallowToolResultDetailsMetadata(details),
    detailsTruncated: true,
    originalDetailsChars: serialized.length,
  };
  for (const key of Object.keys(fallbackBase).toReversed()) {
    if (key === "detailsTruncated" || key === "originalDetailsChars") {
      continue;
    }
    if (stringifyToolResultDetails({ ...fallbackBase, preview: "" }).length <= maxChars) {
      break;
    }
    delete fallbackBase[key];
  }
  const emptyPreviewLength = stringifyToolResultDetails({ ...fallbackBase, preview: "" }).length;
  const previewBudget = Math.max(0, maxChars - emptyPreviewLength);
  return {
    details:
      previewBudget > 0
        ? {
            ...fallbackBase,
            preview: truncateToolResultText(serialized, previewBudget, {
              suffix: TOOL_RESULT_DETAILS_TRUNCATION_SUFFIX,
              minKeepChars: 0,
            }),
          }
        : fallbackBase,
    truncated: true,
  };
}

function truncateToolResultContentBlocks(params: {
  content: unknown[];
  totalTextChars: number;
  maxChars: number;
  options: ToolResultTruncationOptions;
}): { content: unknown[]; truncated: boolean } {
  const suffixFactory = resolveSuffixFactory(params.options.suffix);
  const minKeepChars = resolveEffectiveMinKeepChars({
    maxChars: params.maxChars,
    minKeepChars: params.options.minKeepChars ?? MIN_KEEP_CHARS,
    suffixFactory,
  });

  if (params.totalTextChars <= params.maxChars) {
    return { content: params.content, truncated: false };
  }

  let truncated = false;
  const content = params.content.map((block: unknown) => {
    if (!block || typeof block !== "object" || (block as { type?: string }).type !== "text") {
      return block; // Keep non-text blocks (images) as-is.
    }
    const textBlock = block as TextContent;
    if (typeof textBlock.text !== "string") {
      return block;
    }
    const blockShare = textBlock.text.length / params.totalTextChars;
    const defaultSuffix = suffixFactory(
      Math.max(1, textBlock.text.length - Math.floor(params.maxChars * blockShare)),
    );
    const proportionalBudget = Math.floor(params.maxChars * blockShare);
    const blockBudget = Math.max(
      1,
      Math.min(params.maxChars, Math.max(minKeepChars + defaultSuffix.length, proportionalBudget)),
    );
    const nextText = truncateToolResultText(textBlock.text, blockBudget, {
      suffix: suffixFactory,
      minKeepChars,
    });
    if (nextText !== textBlock.text) {
      truncated = true;
    }
    return Object.assign({}, textBlock, {
      text: nextText,
    });
  });

  return { content, truncated };
}

export function truncateToolResultPayload<T extends ToolResultPayloadLike>(
  payload: T,
  maxChars: number,
  options: ToolResultTruncationOptions = {},
): T {
  const maxCharsSafe = Math.max(1, maxChars);
  const originalDetails = payload.details;
  const originalDetailsLength =
    originalDetails === undefined ? 0 : stringifyToolResultDetails(originalDetails).length;
  const originalTextLength = getToolResultPayloadTextLength(payload);
  if (originalTextLength + originalDetailsLength <= maxCharsSafe) {
    return payload;
  }

  const detailsBudget =
    originalDetailsLength > 0
      ? Math.min(originalDetailsLength, resolveDetailsBudget(maxCharsSafe))
      : 0;
  const detailsResult =
    originalDetailsLength > 0
      ? truncateToolResultDetails(originalDetails, detailsBudget)
      : { details: originalDetails, truncated: false };
  const nextDetailsLength =
    detailsResult.details === undefined
      ? 0
      : stringifyToolResultDetails(detailsResult.details).length;
  const contentBudget = Math.max(1, maxCharsSafe - nextDetailsLength);
  const content = payload.content;
  let nextContent = content;
  let contentTruncated = false;

  if (Array.isArray(content) && originalTextLength > contentBudget) {
    const result = truncateToolResultContentBlocks({
      content,
      totalTextChars: originalTextLength,
      maxChars: contentBudget,
      options,
    });
    nextContent = result.content;
    contentTruncated = result.truncated;
  }

  if (!contentTruncated && !detailsResult.truncated) {
    return payload;
  }

  return {
    ...payload,
    ...(nextContent !== undefined ? { content: nextContent } : {}),
    ...(originalDetails !== undefined ? { details: detailsResult.details } : {}),
  };
}

/**
 * Truncate a tool result message's text content blocks to fit within maxChars.
 * Returns a new message (does not mutate the original).
 */
export function truncateToolResultMessage(
  msg: AgentMessage,
  maxChars: number,
  options: ToolResultTruncationOptions = {},
): AgentMessage {
  if ((msg as { role?: string }).role !== "toolResult") {
    return msg;
  }
  return truncateToolResultPayload(
    msg as AgentMessage & ToolResultPayloadLike,
    maxChars,
    options,
  ) as AgentMessage;
}

/**
 * Truncate oversized tool results in an array of messages (in-memory).
 * Returns a new array with truncated messages.
 *
 * This is used as a pre-emptive guard before sending messages to the LLM,
 * without modifying the session file.
 */
export function truncateOversizedToolResultsInMessages(
  messages: AgentMessage[],
  contextWindowTokens: number,
  maxCharsOverride?: number,
): { messages: AgentMessage[]; truncatedCount: number } {
  const maxChars = Math.max(
    1,
    maxCharsOverride ?? calculateMaxToolResultChars(contextWindowTokens),
  );
  let truncatedCount = 0;

  const result = messages.map((msg) => {
    if ((msg as { role?: string }).role !== "toolResult") {
      return msg;
    }
    const contextLength = getToolResultContextLength(msg);
    if (contextLength <= maxChars) {
      return msg;
    }
    truncatedCount++;
    return truncateToolResultMessage(msg, maxChars);
  });

  return { messages: result, truncatedCount };
}

function calculateRecoveryAggregateToolResultChars(
  contextWindowTokens: number,
  maxCharsOverride?: number,
): number {
  return Math.max(1, maxCharsOverride ?? calculateMaxToolResultChars(contextWindowTokens));
}

export type ToolResultReductionPotential = {
  maxChars: number;
  aggregateBudgetChars: number;
  toolResultCount: number;
  totalToolResultChars: number;
  oversizedCount: number;
  duplicateCount: number;
  oversizedReducibleChars: number;
  duplicateReducibleChars: number;
  aggregateReducibleChars: number;
  maxReducibleChars: number;
};

type ToolResultBranchEntry = {
  id: string;
  type: string;
  message?: AgentMessage;
};

type ToolResultReplacement = {
  entryId: string;
  message: AgentMessage;
};

type DuplicateLargeToolResultReplacementPlan = {
  replacements: ToolResultReplacement[];
  preservedEntryIds: ReadonlySet<string>;
};

type LargeDuplicateCandidate = {
  index: number;
  entryId: string;
  message: AgentMessage;
  duplicateKey: string;
  textLength: number;
};

function getToolResultToolCallId(message: AgentMessage): unknown {
  return (message as { toolCallId?: unknown }).toolCallId;
}

function formatDuplicateNoticeToolCallId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return null;
  }
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function getLargeTextDuplicateCandidate(params: {
  entry: ToolResultBranchEntry;
  index: number;
  minTextChars: number;
}): LargeDuplicateCandidate | null {
  const { entry, index, minTextChars } = params;
  if (entry.type !== "message" || !entry.message) {
    return null;
  }
  const message = entry.message;
  if ((message as { role?: string }).role !== "toolResult") {
    return null;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) {
    return null;
  }

  const textBlocks: string[] = [];
  let textLength = 0;
  for (const block of content) {
    if (!block || typeof block !== "object" || (block as { type?: string }).type !== "text") {
      return null;
    }
    const text = (block as TextContent).text;
    if (typeof text !== "string") {
      return null;
    }
    textBlocks.push(text);
    textLength += text.length;
  }
  if (textLength < minTextChars) {
    return null;
  }

  return {
    index,
    entryId: entry.id,
    message,
    duplicateKey: JSON.stringify(textBlocks),
    textLength,
  };
}

function formatDuplicateToolResultNotice(params: {
  originalTextChars: number;
  preservedToolCallId: unknown;
}): string {
  const preservedToolCallId = formatDuplicateNoticeToolCallId(params.preservedToolCallId);
  const preservedReference = preservedToolCallId
    ? ` Newest matching tool result is preserved at toolCallId=${preservedToolCallId}.`
    : " Newest matching tool result is preserved later in this branch.";
  return (
    `${DUPLICATE_TOOL_RESULT_OMISSION_LABEL}\n\n` +
    `This older tool result repeated identical large text output ` +
    `(${params.originalTextChars} chars).${preservedReference}`
  );
}

function compactDuplicateToolResultMessage(params: {
  message: AgentMessage;
  originalTextChars: number;
  preservedToolCallId: unknown;
}): AgentMessage {
  return {
    ...params.message,
    content: [
      {
        type: "text",
        text: formatDuplicateToolResultNotice({
          originalTextChars: params.originalTextChars,
          preservedToolCallId: params.preservedToolCallId,
        }),
      },
    ],
  } as AgentMessage;
}

function buildDuplicateLargeToolResultReplacements(params: {
  branch: ToolResultBranchEntry[];
  minTextChars?: number;
}): DuplicateLargeToolResultReplacementPlan {
  const minTextChars = params.minTextChars ?? DUPLICATE_TOOL_RESULT_MIN_TEXT_CHARS;
  const candidates = params.branch
    .map((entry, index) => getLargeTextDuplicateCandidate({ entry, index, minTextChars }))
    .filter((candidate): candidate is LargeDuplicateCandidate => candidate !== null);

  if (candidates.length < 2) {
    return { replacements: [], preservedEntryIds: new Set<string>() };
  }

  const newestByDuplicateKey = new Map<string, LargeDuplicateCandidate>();
  const preservedEntryIds = new Set<string>();
  const replacements: ToolResultReplacement[] = [];
  for (const candidate of candidates.toSorted((a, b) => b.index - a.index)) {
    const newest = newestByDuplicateKey.get(candidate.duplicateKey);
    if (!newest) {
      newestByDuplicateKey.set(candidate.duplicateKey, candidate);
      continue;
    }

    const message = compactDuplicateToolResultMessage({
      message: candidate.message,
      originalTextChars: candidate.textLength,
      preservedToolCallId: getToolResultToolCallId(newest.message),
    });
    if (getToolResultContextLength(message) >= getToolResultContextLength(candidate.message)) {
      continue;
    }
    preservedEntryIds.add(newest.entryId);
    replacements.push({ entryId: candidate.entryId, message });
  }

  return { replacements, preservedEntryIds };
}

function buildAggregateToolResultReplacements(params: {
  branch: ToolResultBranchEntry[];
  aggregateBudgetChars: number;
  minKeepChars?: number;
  skipEntryIds?: ReadonlySet<string>;
}): ToolResultReplacement[] {
  const minKeepChars = params.minKeepChars ?? MIN_KEEP_CHARS;
  const minTruncatedTextChars = minKeepChars + DEFAULT_SUFFIX(1).length;
  const candidates = params.branch
    .map((entry, index) => ({ entry, index }))
    .filter(
      (
        item,
      ): item is {
        entry: { id: string; type: string; message: AgentMessage };
        index: number;
      } =>
        item.entry.type === "message" &&
        Boolean(item.entry.message) &&
        !params.skipEntryIds?.has(item.entry.id) &&
        (item.entry.message as { role?: string }).role === "toolResult",
    )
    .map((item) => ({
      index: item.index,
      entryId: item.entry.id,
      message: item.entry.message,
      contextLength: getToolResultContextLength(item.entry.message),
    }))
    .filter((item) => item.contextLength > 0);

  if (candidates.length < 2) {
    return [];
  }

  const totalChars = candidates.reduce((sum, item) => sum + item.contextLength, 0);
  if (totalChars <= params.aggregateBudgetChars) {
    return [];
  }

  let remainingReduction = totalChars - params.aggregateBudgetChars;
  const replacements: Array<{ entryId: string; message: AgentMessage }> = [];

  for (const candidate of candidates.toSorted((a, b) => {
    if (a.index !== b.index) {
      return b.index - a.index;
    }
    return b.contextLength - a.contextLength;
  })) {
    if (remainingReduction <= 0) {
      break;
    }
    const reducibleChars = Math.max(0, candidate.contextLength - minTruncatedTextChars);
    if (reducibleChars <= 0) {
      continue;
    }

    const requestedReduction = Math.min(reducibleChars, remainingReduction);
    const targetChars = Math.max(
      minTruncatedTextChars,
      candidate.contextLength - requestedReduction,
    );
    const truncatedMessage = truncateToolResultMessage(candidate.message, targetChars, {
      minKeepChars,
    });
    const newLength = getToolResultContextLength(truncatedMessage);
    const actualReduction = Math.max(0, candidate.contextLength - newLength);
    if (actualReduction <= 0) {
      continue;
    }

    replacements.push({ entryId: candidate.entryId, message: truncatedMessage });
    remainingReduction -= actualReduction;
  }

  return replacements;
}

function buildOversizedToolResultReplacements(params: {
  branch: ToolResultBranchEntry[];
  maxChars: number;
  minKeepChars?: number;
  skipEntryIds?: ReadonlySet<string>;
}): ToolResultReplacement[] {
  const minKeepChars = params.minKeepChars ?? MIN_KEEP_CHARS;
  const replacements: ToolResultReplacement[] = [];

  for (const entry of params.branch) {
    if (entry.type !== "message" || !entry.message) {
      continue;
    }
    if (params.skipEntryIds?.has(entry.id)) {
      continue;
    }
    const msg = entry.message;
    if ((msg as { role?: string }).role !== "toolResult") {
      continue;
    }
    if (getToolResultContextLength(msg) <= params.maxChars) {
      continue;
    }
    replacements.push({
      entryId: entry.id,
      message: truncateToolResultMessage(msg, params.maxChars, {
        minKeepChars,
      }),
    });
  }

  return replacements;
}

function calculateReplacementReduction(
  branch: ToolResultBranchEntry[],
  replacements: ToolResultReplacement[],
): number {
  if (replacements.length === 0) {
    return 0;
  }
  const branchById = new Map(branch.map((entry) => [entry.id, entry]));
  let reduction = 0;

  for (const replacement of replacements) {
    const entry = branchById.get(replacement.entryId);
    if (!entry?.message) {
      continue;
    }
    reduction += Math.max(
      0,
      getToolResultContextLength(entry.message) - getToolResultContextLength(replacement.message),
    );
  }

  return reduction;
}

function applyToolResultReplacementsToBranch(
  branch: ToolResultBranchEntry[],
  replacements: ToolResultReplacement[],
): ToolResultBranchEntry[] {
  if (replacements.length === 0) {
    return branch;
  }
  const replacementsById = new Map(
    replacements.map((replacement) => [replacement.entryId, replacement]),
  );
  return branch.map((entry) => {
    const replacement = replacementsById.get(entry.id);
    if (!replacement || entry.type !== "message") {
      return entry;
    }
    return {
      ...entry,
      message: replacement.message,
    };
  });
}

function buildToolResultReplacementPlan(params: {
  branch: ToolResultBranchEntry[];
  maxChars: number;
  aggregateBudgetChars: number;
  minKeepChars?: number;
}): {
  replacements: ToolResultReplacement[];
  oversizedReplacementCount: number;
  duplicateReplacementCount: number;
  aggregateReplacementCount: number;
  oversizedReducibleChars: number;
  duplicateReducibleChars: number;
  aggregateReducibleChars: number;
} {
  const minKeepChars = params.minKeepChars ?? MIN_KEEP_CHARS;
  const duplicatePlan = buildDuplicateLargeToolResultReplacements({
    branch: params.branch,
  });
  const duplicateReplacements = duplicatePlan.replacements;
  const duplicateReducibleChars = calculateReplacementReduction(
    params.branch,
    duplicateReplacements,
  );
  const duplicateTrimmedBranch = applyToolResultReplacementsToBranch(
    params.branch,
    duplicateReplacements,
  );
  const oversizedReplacements = buildOversizedToolResultReplacements({
    branch: duplicateTrimmedBranch,
    maxChars: params.maxChars,
    minKeepChars,
    skipEntryIds: duplicatePlan.preservedEntryIds,
  });
  const oversizedReducibleChars = calculateReplacementReduction(
    duplicateTrimmedBranch,
    oversizedReplacements,
  );
  const oversizedTrimmedBranch = applyToolResultReplacementsToBranch(
    duplicateTrimmedBranch,
    oversizedReplacements,
  );
  const aggregateReplacements = buildAggregateToolResultReplacements({
    branch: oversizedTrimmedBranch,
    aggregateBudgetChars: params.aggregateBudgetChars,
    minKeepChars,
    skipEntryIds: duplicatePlan.preservedEntryIds,
  });
  const aggregateReducibleChars = calculateReplacementReduction(
    oversizedTrimmedBranch,
    aggregateReplacements,
  );

  return {
    replacements: [...duplicateReplacements, ...oversizedReplacements, ...aggregateReplacements],
    oversizedReplacementCount: oversizedReplacements.length,
    duplicateReplacementCount: duplicateReplacements.length,
    aggregateReplacementCount: aggregateReplacements.length,
    oversizedReducibleChars,
    duplicateReducibleChars,
    aggregateReducibleChars,
  };
}
export function estimateToolResultReductionPotential(params: {
  messages: AgentMessage[];
  contextWindowTokens: number;
  maxCharsOverride?: number;
}): ToolResultReductionPotential {
  const { messages, contextWindowTokens } = params;
  const maxChars = Math.max(
    1,
    params.maxCharsOverride ?? calculateMaxToolResultChars(contextWindowTokens),
  );
  const aggregateBudgetChars = calculateRecoveryAggregateToolResultChars(
    contextWindowTokens,
    maxChars,
  );
  const branch = messages.map((message, index) => ({
    id: `message-${index}`,
    type: "message",
    message,
  }));

  let toolResultCount = 0;
  let totalToolResultChars = 0;
  for (const msg of messages) {
    if ((msg as { role?: string }).role !== "toolResult") {
      continue;
    }
    const contextLength = getToolResultContextLength(msg);
    if (contextLength <= 0) {
      continue;
    }
    toolResultCount += 1;
    totalToolResultChars += contextLength;
  }
  const plan = buildToolResultReplacementPlan({
    branch,
    maxChars,
    aggregateBudgetChars,
    minKeepChars: RECOVERY_MIN_KEEP_CHARS,
  });
  const maxReducibleChars =
    plan.duplicateReducibleChars + plan.oversizedReducibleChars + plan.aggregateReducibleChars;

  return {
    maxChars,
    aggregateBudgetChars,
    toolResultCount,
    totalToolResultChars,
    oversizedCount: plan.oversizedReplacementCount,
    duplicateCount: plan.duplicateReplacementCount,
    oversizedReducibleChars: plan.oversizedReducibleChars,
    duplicateReducibleChars: plan.duplicateReducibleChars,
    aggregateReducibleChars: plan.aggregateReducibleChars,
    maxReducibleChars,
  };
}

function truncateOversizedToolResultsInExistingSessionManager(params: {
  sessionManager: SessionManager;
  contextWindowTokens: number;
  maxCharsOverride?: number;
  sessionFile?: string;
  sessionId?: string;
  sessionKey?: string;
}): { truncated: boolean; truncatedCount: number; reason?: string } {
  const { sessionManager, contextWindowTokens } = params;
  const maxChars = Math.max(
    1,
    params.maxCharsOverride ?? calculateMaxToolResultChars(contextWindowTokens),
  );
  const aggregateBudgetChars = calculateRecoveryAggregateToolResultChars(
    contextWindowTokens,
    maxChars,
  );
  const branch = sessionManager.getBranch() as ToolResultBranchEntry[];

  if (branch.length === 0) {
    return { truncated: false, truncatedCount: 0, reason: "empty session" };
  }

  const plan = buildToolResultReplacementPlan({
    branch,
    maxChars,
    aggregateBudgetChars,
    minKeepChars: RECOVERY_MIN_KEEP_CHARS,
  });
  if (plan.replacements.length === 0) {
    return {
      truncated: false,
      truncatedCount: 0,
      reason: "no oversized, duplicate, or aggregate tool results",
    };
  }
  const rewriteResult = rewriteTranscriptEntriesInSessionManager({
    sessionManager,
    replacements: plan.replacements,
  });
  if (rewriteResult.changed && params.sessionFile) {
    emitSessionTranscriptUpdate(params.sessionFile);
  }

  log.info(
    `[tool-result-truncation] Truncated ${rewriteResult.rewrittenEntries} tool result(s) in session ` +
      `(contextWindow=${contextWindowTokens} maxChars=${maxChars} aggregateBudgetChars=${aggregateBudgetChars} ` +
      `oversized=${plan.oversizedReplacementCount} duplicate=${plan.duplicateReplacementCount} ` +
      `aggregate=${plan.aggregateReplacementCount}) ` +
      `sessionKey=${params.sessionKey ?? params.sessionId ?? "unknown"}`,
  );

  return {
    truncated: rewriteResult.changed,
    truncatedCount: rewriteResult.rewrittenEntries,
    reason: rewriteResult.reason,
  };
}

export function truncateOversizedToolResultsInSessionManager(params: {
  sessionManager: SessionManager;
  contextWindowTokens: number;
  maxCharsOverride?: number;
  sessionFile?: string;
  sessionId?: string;
  sessionKey?: string;
}): { truncated: boolean; truncatedCount: number; reason?: string } {
  try {
    return truncateOversizedToolResultsInExistingSessionManager(params);
  } catch (err) {
    const errMsg = formatErrorMessage(err);
    log.warn(`[tool-result-truncation] Failed to truncate: ${errMsg}`);
    return { truncated: false, truncatedCount: 0, reason: errMsg };
  }
}

export async function truncateOversizedToolResultsInSession(params: {
  sessionFile: string;
  contextWindowTokens: number;
  maxCharsOverride?: number;
  sessionId?: string;
  sessionKey?: string;
}): Promise<{ truncated: boolean; truncatedCount: number; reason?: string }> {
  const { sessionFile, contextWindowTokens } = params;
  let sessionLock: Awaited<ReturnType<typeof acquireSessionWriteLock>> | undefined;

  try {
    sessionLock = await acquireSessionWriteLock({ sessionFile });
    const sessionManager = SessionManager.open(sessionFile);
    return truncateOversizedToolResultsInExistingSessionManager({
      sessionManager,
      contextWindowTokens,
      maxCharsOverride: params.maxCharsOverride,
      sessionFile,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
    });
  } catch (err) {
    const errMsg = formatErrorMessage(err);
    log.warn(`[tool-result-truncation] Failed to truncate: ${errMsg}`);
    return { truncated: false, truncatedCount: 0, reason: errMsg };
  } finally {
    await sessionLock?.release();
  }
}

/**
 * Check if a tool result message exceeds the size limit for a given context window.
 */
export function isOversizedToolResult(
  msg: AgentMessage,
  contextWindowTokens: number,
  maxCharsOverride?: number,
): boolean {
  if ((msg as { role?: string }).role !== "toolResult") {
    return false;
  }
  const maxChars = Math.max(
    1,
    maxCharsOverride ?? calculateMaxToolResultChars(contextWindowTokens),
  );
  return getToolResultContextLength(msg) > maxChars;
}

export function sessionLikelyHasOversizedToolResults(params: {
  messages: AgentMessage[];
  contextWindowTokens: number;
  maxCharsOverride?: number;
}): boolean {
  const estimate = estimateToolResultReductionPotential(params);
  return (
    estimate.oversizedCount > 0 ||
    estimate.duplicateReducibleChars > 0 ||
    estimate.aggregateReducibleChars > 0
  );
}
