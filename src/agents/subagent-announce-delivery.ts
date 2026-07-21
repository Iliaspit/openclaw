import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ConversationRef } from "../infra/outbound/session-binding-service.js";
import { normalizeAccountId } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import { isCronSessionKey } from "../sessions/session-key-utils.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import {
  mergeDeliveryContext,
  normalizeDeliveryContext,
  resolveConversationDeliveryTarget,
} from "../utils/delivery-context.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isGatewayMessageChannel,
  isInternalMessageChannel,
  normalizeMessageChannel,
} from "../utils/message-channel.js";
import { buildAnnounceIdempotencyKey, resolveQueueAnnounceId } from "./announce-idempotency.js";
import type { AgentInternalEvent } from "./internal-events.js";
import {
  callGateway,
  createBoundDeliveryRouter,
  getGlobalHookRunner,
  isEmbeddedPiRunActive,
  loadConfig,
  loadSessionStore,
  queueEmbeddedPiMessage,
  resolveActiveEmbeddedRunSessionId,
  resolveAgentIdFromSessionKey,
  resolveConversationIdFromTargets,
  resolveExternalBestEffortDeliveryTarget,
  resolveQueueSettings,
  resolveStorePath,
} from "./subagent-announce-delivery.runtime.js";
import {
  runSubagentAnnounceDispatch,
  type SubagentAnnounceDeliveryResult,
} from "./subagent-announce-dispatch.js";
import { resolveAnnounceOrigin, type DeliveryContext } from "./subagent-announce-origin.js";
import { type AnnounceQueueItem, enqueueAnnounce } from "./subagent-announce-queue.js";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";
import { resolveRequesterStoreKey } from "./subagent-requester-store-key.js";
import type { SpawnSubagentMode } from "./subagent-spawn.types.js";

export { resolveAnnounceOrigin } from "./subagent-announce-origin.js";

const DEFAULT_SUBAGENT_ANNOUNCE_TIMEOUT_MS = 120_000;
const MAX_TIMER_SAFE_TIMEOUT_MS = 2_147_000_000;
const LONG_WAIT_ANNOUNCE_TIMEOUT_MS = 60_000;
const MAX_LONG_WAIT_ANNOUNCE_RETRY_COUNT = 1;

type SubagentAnnounceDeliveryDeps = {
  callGateway: typeof callGateway;
  loadConfig: typeof loadConfig;
  getRequesterSessionActivity: (requesterSessionKey: string) => {
    sessionId?: string;
    isActive: boolean;
  };
  queueEmbeddedPiMessage: typeof queueEmbeddedPiMessage;
};

const defaultSubagentAnnounceDeliveryDeps: SubagentAnnounceDeliveryDeps = {
  callGateway,
  loadConfig,
  getRequesterSessionActivity: (requesterSessionKey: string) => {
    const sessionId =
      resolveActiveEmbeddedRunSessionId(requesterSessionKey) ??
      loadRequesterSessionEntry(requesterSessionKey).entry?.sessionId;
    return {
      sessionId,
      isActive: Boolean(sessionId && isEmbeddedPiRunActive(sessionId)),
    };
  },
  queueEmbeddedPiMessage,
};

let subagentAnnounceDeliveryDeps: SubagentAnnounceDeliveryDeps =
  defaultSubagentAnnounceDeliveryDeps;

function resolveRequesterSessionActivity(requesterSessionKey: string) {
  const activity = subagentAnnounceDeliveryDeps.getRequesterSessionActivity(requesterSessionKey);
  if (activity.sessionId || activity.isActive) {
    return activity;
  }
  const { entry } = loadRequesterSessionEntry(requesterSessionKey);
  const sessionId = entry?.sessionId;
  return {
    sessionId,
    isActive: Boolean(sessionId && isEmbeddedPiRunActive(sessionId)),
  };
}

function resolveDirectAnnounceTransientRetryDelaysMs() {
  return process.env.OPENCLAW_TEST_FAST === "1"
    ? ([8, 16, 32] as const)
    : ([5_000, 10_000, 20_000] as const);
}

export function resolveSubagentAnnounceTimeoutMs(cfg: OpenClawConfig): number {
  const configured = cfg.agents?.defaults?.subagents?.announceTimeoutMs;
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return DEFAULT_SUBAGENT_ANNOUNCE_TIMEOUT_MS;
  }
  return Math.min(Math.max(1, Math.floor(configured)), MAX_TIMER_SAFE_TIMEOUT_MS);
}

export function isInternalAnnounceRequesterSession(sessionKey: string | undefined): boolean {
  return getSubagentDepthFromSessionStore(sessionKey) >= 1 || isCronSessionKey(sessionKey);
}

function formatDeliveryErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || "error";
  }
  if (typeof error === "string") {
    return error;
  }
  if (error === undefined || error === null) {
    return "unknown error";
  }
  try {
    return JSON.stringify(error);
  } catch {
    return "error";
  }
}

function summarizeKnownDeliveryError(message: string): string | undefined {
  const gatewayTimeoutMatch = message.match(/\bgateway timeout after\s+(\d+)ms\b/i);
  if (gatewayTimeoutMatch?.[1]) {
    return `gateway timeout after ${gatewayTimeoutMatch[1]}ms`;
  }
  if (/no active .* listener/i.test(message)) {
    return "no active listener";
  }
  if (/gateway not connected/i.test(message)) {
    return "gateway not connected";
  }
  const gatewayClosedMatch = message.match(/\bgateway closed \((\d+)/i);
  if (gatewayClosedMatch?.[1]) {
    return `gateway closed (${gatewayClosedMatch[1]})`;
  }
  const networkMatch = message.match(
    /\b(econnreset|econnrefused|etimedout|enotfound|ehostunreach|network error)\b/i,
  );
  if (networkMatch?.[1]) {
    return networkMatch[1].toLowerCase();
  }
  if (/\berrorcode=unavailable\b/i.test(message) || /\bUNAVAILABLE\b/.test(message)) {
    return "unavailable";
  }
  if (/\bstatus\s*[:=]\s*"?unavailable\b/i.test(message)) {
    return "status unavailable";
  }
  if (/unsupported channel/i.test(message)) {
    return "unsupported channel";
  }
  if (/unknown channel/i.test(message)) {
    return "unknown channel";
  }
  if (/chat not found/i.test(message)) {
    return "chat not found";
  }
  if (/user not found/i.test(message)) {
    return "user not found";
  }
  if (/outbound not configured for channel/i.test(message)) {
    return "outbound not configured";
  }
  if (/forbidden|bot.*not.*member|bot was blocked|bot was kicked/i.test(message)) {
    return "recipient unavailable";
  }
  return undefined;
}

function summarizeDeliveryError(error: unknown): string {
  const message = formatDeliveryErrorMessage(error);
  return summarizeKnownDeliveryError(message) ?? (error instanceof Error ? error.name : "error");
}

const TRANSIENT_ANNOUNCE_DELIVERY_ERROR_PATTERNS: readonly RegExp[] = [
  /\berrorcode=unavailable\b/i,
  /\bstatus\s*[:=]\s*"?unavailable\b/i,
  /\bUNAVAILABLE\b/,
  /no active .* listener/i,
  /gateway not connected/i,
  /gateway closed \(1006/i,
  /gateway timeout/i,
  /\b(econnreset|econnrefused|etimedout|enotfound|ehostunreach|network error)\b/i,
];

const PERMANENT_ANNOUNCE_DELIVERY_ERROR_PATTERNS: readonly RegExp[] = [
  /unsupported channel/i,
  /unknown channel/i,
  /chat not found/i,
  /user not found/i,
  /bot.*not.*member/i,
  /bot was blocked by the user/i,
  /forbidden: bot was kicked/i,
  /recipient is not a valid/i,
  /outbound not configured for channel/i,
];

function isTransientAnnounceDeliveryError(error: unknown): boolean {
  const message = formatDeliveryErrorMessage(error);
  if (!message) {
    return false;
  }
  if (PERMANENT_ANNOUNCE_DELIVERY_ERROR_PATTERNS.some((re) => re.test(message))) {
    return false;
  }
  return TRANSIENT_ANNOUNCE_DELIVERY_ERROR_PATTERNS.some((re) => re.test(message));
}

function resolveGatewayTimeoutMs(error: unknown): number | undefined {
  const match = formatDeliveryErrorMessage(error).match(/\bgateway timeout after\s+(\d+)ms\b/i);
  if (!match?.[1]) {
    return undefined;
  }
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isLongWaitAnnounceDeliveryError(error: unknown): boolean {
  const timeoutMs = resolveGatewayTimeoutMs(error);
  return timeoutMs != null && timeoutMs >= LONG_WAIT_ANNOUNCE_TIMEOUT_MS;
}

async function waitForAnnounceRetryDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }
  if (!signal) {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
    return;
  }
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runAnnounceDeliveryWithRetry<T>(params: {
  operation: string;
  signal?: AbortSignal;
  run: () => Promise<T>;
}): Promise<T> {
  const retryDelaysMs = resolveDirectAnnounceTransientRetryDelaysMs();
  let retryIndex = 0;
  let longWaitRetryCount = 0;
  for (;;) {
    if (params.signal?.aborted) {
      throw new Error("announce delivery aborted");
    }
    try {
      return await params.run();
    } catch (err) {
      const delayMs = retryDelaysMs[retryIndex];
      const isLongWait = isLongWaitAnnounceDeliveryError(err);
      if (delayMs == null || !isTransientAnnounceDeliveryError(err) || params.signal?.aborted) {
        throw err;
      }
      if (isLongWait && longWaitRetryCount >= MAX_LONG_WAIT_ANNOUNCE_RETRY_COUNT) {
        defaultRuntime.log(
          `[warn] Subagent announce ${params.operation} long-wait retry cap reached attempt=${retryIndex + 1} cap=${MAX_LONG_WAIT_ANNOUNCE_RETRY_COUNT + 1} reason=${summarizeDeliveryError(err)}`,
        );
        throw err;
      }
      const nextAttempt = retryIndex + 2;
      const maxAttempts = retryDelaysMs.length + 1;
      defaultRuntime.log(
        `[warn] Subagent announce ${params.operation} transient failure retrying attempt=${nextAttempt}/${maxAttempts} delaySeconds=${Math.round(delayMs / 1000)} longWaitRetries=${isLongWait ? longWaitRetryCount + 1 : longWaitRetryCount}/${MAX_LONG_WAIT_ANNOUNCE_RETRY_COUNT} reason=${summarizeDeliveryError(err)}`,
      );
      if (isLongWait) {
        longWaitRetryCount += 1;
      }
      retryIndex += 1;
      await waitForAnnounceRetryDelay(delayMs, params.signal);
    }
  }
}

export async function resolveSubagentCompletionOrigin(params: {
  childSessionKey: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  childRunId?: string;
  spawnMode?: SpawnSubagentMode;
  expectsCompletionMessage: boolean;
}): Promise<DeliveryContext | undefined> {
  const requesterOrigin = normalizeDeliveryContext(params.requesterOrigin);
  const channel = normalizeOptionalLowercaseString(requesterOrigin?.channel);
  const to = requesterOrigin?.to?.trim();
  const accountId = normalizeAccountId(requesterOrigin?.accountId);
  const threadId =
    requesterOrigin?.threadId != null && requesterOrigin.threadId !== ""
      ? String(requesterOrigin.threadId).trim()
      : undefined;
  const conversationId =
    threadId ||
    resolveConversationIdFromTargets({
      targets: [to],
    }) ||
    "";
  const requesterConversation: ConversationRef | undefined =
    channel && conversationId ? { channel, accountId, conversationId } : undefined;

  const route = createBoundDeliveryRouter().resolveDestination({
    eventKind: "task_completion",
    targetSessionKey: params.childSessionKey,
    requester: requesterConversation,
    failClosed: false,
  });
  if (route.mode === "bound" && route.binding) {
    const boundTarget = resolveConversationDeliveryTarget({
      channel: route.binding.conversation.channel,
      conversationId: route.binding.conversation.conversationId,
      parentConversationId: route.binding.conversation.parentConversationId,
    });
    return mergeDeliveryContext(
      {
        channel: route.binding.conversation.channel,
        accountId: route.binding.conversation.accountId,
        to: boundTarget.to,
        threadId:
          boundTarget.threadId ??
          (requesterOrigin?.threadId != null && requesterOrigin.threadId !== ""
            ? String(requesterOrigin.threadId)
            : undefined),
      },
      requesterOrigin,
    );
  }

  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("subagent_delivery_target")) {
    return requesterOrigin;
  }
  try {
    const result = await hookRunner.runSubagentDeliveryTarget(
      {
        childSessionKey: params.childSessionKey,
        requesterSessionKey: params.requesterSessionKey,
        requesterOrigin,
        childRunId: params.childRunId,
        spawnMode: params.spawnMode,
        expectsCompletionMessage: params.expectsCompletionMessage,
      },
      {
        runId: params.childRunId,
        childSessionKey: params.childSessionKey,
        requesterSessionKey: params.requesterSessionKey,
      },
    );
    const hookOrigin = normalizeDeliveryContext(result?.origin);
    if (!hookOrigin) {
      return requesterOrigin;
    }
    if (hookOrigin.channel && isInternalMessageChannel(hookOrigin.channel)) {
      return requesterOrigin;
    }
    return mergeDeliveryContext(hookOrigin, requesterOrigin);
  } catch {
    return requesterOrigin;
  }
}

async function sendAnnounce(item: AnnounceQueueItem) {
  const cfg = subagentAnnounceDeliveryDeps.loadConfig();
  const announceTimeoutMs = resolveSubagentAnnounceTimeoutMs(cfg);
  const requesterIsSubagent = isInternalAnnounceRequesterSession(item.sessionKey);
  const origin = item.origin;
  const threadId =
    origin?.threadId != null && origin.threadId !== "" ? String(origin.threadId) : undefined;
  const idempotencyKey = buildAnnounceIdempotencyKey(
    resolveQueueAnnounceId({
      announceId: item.announceId,
      sessionKey: item.sessionKey,
      enqueuedAt: item.enqueuedAt,
    }),
  );
  await subagentAnnounceDeliveryDeps.callGateway({
    method: "agent",
    params: {
      sessionKey: item.sessionKey,
      message: item.prompt,
      channel: requesterIsSubagent ? undefined : origin?.channel,
      accountId: requesterIsSubagent ? undefined : origin?.accountId,
      to: requesterIsSubagent ? undefined : origin?.to,
      threadId: requesterIsSubagent ? undefined : threadId,
      deliver: !requesterIsSubagent,
      internalEvents: item.internalEvents,
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: item.sourceSessionKey,
        sourceChannel: item.sourceChannel ?? INTERNAL_MESSAGE_CHANNEL,
        sourceTool: item.sourceTool ?? "subagent_announce",
      },
      idempotencyKey,
    },
    timeoutMs: announceTimeoutMs,
  });
}

export function loadRequesterSessionEntry(requesterSessionKey: string) {
  const cfg = subagentAnnounceDeliveryDeps.loadConfig();
  const canonicalKey = resolveRequesterStoreKey(cfg, requesterSessionKey);
  const agentId = resolveAgentIdFromSessionKey(canonicalKey);
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  const store = loadSessionStore(storePath);
  const entry = store[canonicalKey];
  return { cfg, entry, canonicalKey };
}

export function loadSessionEntryByKey(sessionKey: string) {
  const cfg = subagentAnnounceDeliveryDeps.loadConfig();
  const agentId = resolveAgentIdFromSessionKey(sessionKey);
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  const store = loadSessionStore(storePath);
  return store[sessionKey];
}

function buildAnnounceQueueKey(sessionKey: string, origin?: DeliveryContext): string {
  const accountId = normalizeAccountId(origin?.accountId);
  if (!accountId) {
    return sessionKey;
  }
  return `${sessionKey}:acct:${accountId}`;
}

async function maybeQueueSubagentAnnounce(params: {
  requesterSessionKey: string;
  announceId?: string;
  triggerMessage: string;
  steerMessage: string;
  summaryLine?: string;
  requesterOrigin?: DeliveryContext;
  sourceSessionKey?: string;
  sourceChannel?: string;
  sourceTool?: string;
  internalEvents?: AgentInternalEvent[];
  signal?: AbortSignal;
}): Promise<"steered" | "queued" | "none" | "dropped"> {
  if (params.signal?.aborted) {
    return "none";
  }
  const { cfg, entry } = loadRequesterSessionEntry(params.requesterSessionKey);
  const canonicalKey = resolveRequesterStoreKey(cfg, params.requesterSessionKey);
  const { sessionId, isActive } = resolveRequesterSessionActivity(canonicalKey);
  if (!sessionId) {
    return "none";
  }

  const queueSettings = resolveQueueSettings({
    cfg,
    channel: entry?.channel ?? entry?.lastChannel ?? entry?.origin?.provider,
    sessionEntry: entry,
  });

  const shouldSteer = queueSettings.mode === "steer" || queueSettings.mode === "steer-backlog";
  if (shouldSteer) {
    const steered = subagentAnnounceDeliveryDeps.queueEmbeddedPiMessage(
      sessionId,
      params.steerMessage,
    );
    if (steered) {
      return "steered";
    }
  }

  const shouldFollowup =
    queueSettings.mode === "followup" ||
    queueSettings.mode === "collect" ||
    queueSettings.mode === "steer-backlog" ||
    queueSettings.mode === "interrupt";
  if (isActive && (shouldFollowup || queueSettings.mode === "steer")) {
    const origin = resolveAnnounceOrigin(entry, params.requesterOrigin);
    const didQueue = enqueueAnnounce({
      key: buildAnnounceQueueKey(canonicalKey, origin),
      item: {
        announceId: params.announceId,
        prompt: params.triggerMessage,
        summaryLine: params.summaryLine,
        internalEvents: params.internalEvents,
        enqueuedAt: Date.now(),
        sessionKey: canonicalKey,
        origin,
        sourceSessionKey: params.sourceSessionKey,
        sourceChannel: params.sourceChannel,
        sourceTool: params.sourceTool,
      },
      settings: queueSettings,
      send: sendAnnounce,
    });
    return didQueue ? "queued" : "dropped";
  }

  return "none";
}

async function sendSubagentAnnounceDirectly(params: {
  targetRequesterSessionKey: string;
  triggerMessage: string;
  internalEvents?: AgentInternalEvent[];
  expectsCompletionMessage: boolean;
  bestEffortDeliver?: boolean;
  directIdempotencyKey: string;
  completionDirectOrigin?: DeliveryContext;
  directOrigin?: DeliveryContext;
  requesterSessionOrigin?: DeliveryContext;
  sourceSessionKey?: string;
  sourceChannel?: string;
  sourceTool?: string;
  requesterIsSubagent: boolean;
  signal?: AbortSignal;
}): Promise<SubagentAnnounceDeliveryResult> {
  if (params.signal?.aborted) {
    return {
      delivered: false,
      path: "none",
    };
  }
  const cfg = subagentAnnounceDeliveryDeps.loadConfig();
  const announceTimeoutMs = resolveSubagentAnnounceTimeoutMs(cfg);
  const canonicalRequesterSessionKey = resolveRequesterStoreKey(
    cfg,
    params.targetRequesterSessionKey,
  );
  try {
    const completionDirectOrigin = normalizeDeliveryContext(params.completionDirectOrigin);
    const directOrigin = normalizeDeliveryContext(params.directOrigin);
    const requesterSessionOrigin = normalizeDeliveryContext(params.requesterSessionOrigin);
    // Merge completionDirectOrigin with directOrigin so that missing fields
    // (channel, to, accountId) fall back to the originating session's
    // lastChannel / lastTo. Without this, a completion origin that carries a
    // channel but not a `to` would prevent external delivery.
    const effectiveDirectOrigin =
      params.expectsCompletionMessage && completionDirectOrigin
        ? mergeDeliveryContext(completionDirectOrigin, directOrigin)
        : directOrigin;
    const sessionOnlyOrigin = effectiveDirectOrigin?.channel
      ? effectiveDirectOrigin
      : requesterSessionOrigin;
    const deliveryTarget = !params.requesterIsSubagent
      ? resolveExternalBestEffortDeliveryTarget({
          channel: effectiveDirectOrigin?.channel,
          to: effectiveDirectOrigin?.to,
          accountId: effectiveDirectOrigin?.accountId,
          threadId: effectiveDirectOrigin?.threadId,
        })
      : { deliver: false };
    const normalizedSessionOnlyOriginChannel = !params.requesterIsSubagent
      ? normalizeMessageChannel(sessionOnlyOrigin?.channel)
      : undefined;
    const sessionOnlyOriginChannel =
      normalizedSessionOnlyOriginChannel &&
      isGatewayMessageChannel(normalizedSessionOnlyOriginChannel)
        ? normalizedSessionOnlyOriginChannel
        : undefined;
    const requesterActivity = resolveRequesterSessionActivity(canonicalRequesterSessionKey);
    if (params.expectsCompletionMessage && requesterActivity.isActive) {
      const woke = requesterActivity.sessionId
        ? subagentAnnounceDeliveryDeps.queueEmbeddedPiMessage(
            requesterActivity.sessionId,
            params.triggerMessage,
          )
        : false;
      if (woke) {
        return {
          delivered: true,
          path: "steered",
        };
      }
      return {
        delivered: false,
        path: "direct",
        error: "active requester session could not be woken",
      };
    }
    if (params.signal?.aborted) {
      return {
        delivered: false,
        path: "none",
      };
    }
    // A session-only completion is handed off once the gateway accepts the
    // idempotent parent turn. Waiting for that turn's final response couples
    // child cleanup to arbitrary follow-up work performed by the parent and
    // can turn a successful callback into a 120s timeout. External delivery
    // still waits for the final response so channel delivery remains proven.
    const expectFinal = !params.expectsCompletionMessage || deliveryTarget.deliver;
    await runAnnounceDeliveryWithRetry({
      operation: params.expectsCompletionMessage
        ? "completion direct announce agent call"
        : "direct announce agent call",
      signal: params.signal,
      run: async () =>
        await subagentAnnounceDeliveryDeps.callGateway({
          method: "agent",
          params: {
            sessionKey: canonicalRequesterSessionKey,
            message: params.triggerMessage,
            deliver: deliveryTarget.deliver,
            bestEffortDeliver: params.bestEffortDeliver,
            internalEvents: params.internalEvents,
            channel: deliveryTarget.deliver ? deliveryTarget.channel : sessionOnlyOriginChannel,
            accountId: deliveryTarget.deliver
              ? deliveryTarget.accountId
              : sessionOnlyOriginChannel
                ? sessionOnlyOrigin?.accountId
                : undefined,
            to: deliveryTarget.deliver
              ? deliveryTarget.to
              : sessionOnlyOriginChannel
                ? sessionOnlyOrigin?.to
                : undefined,
            threadId: deliveryTarget.deliver
              ? deliveryTarget.threadId
              : sessionOnlyOriginChannel
                ? sessionOnlyOrigin?.threadId
                : undefined,
            inputProvenance: {
              kind: "inter_session",
              sourceSessionKey: params.sourceSessionKey,
              sourceChannel: params.sourceChannel ?? INTERNAL_MESSAGE_CHANNEL,
              sourceTool: params.sourceTool ?? "subagent_announce",
            },
            idempotencyKey: params.directIdempotencyKey,
          },
          expectFinal,
          timeoutMs: announceTimeoutMs,
        }),
    });

    return {
      delivered: true,
      path: "direct",
    };
  } catch (err) {
    return {
      delivered: false,
      path: "direct",
      error: summarizeDeliveryError(err),
    };
  }
}

export async function deliverSubagentAnnouncement(params: {
  requesterSessionKey: string;
  announceId?: string;
  triggerMessage: string;
  steerMessage: string;
  internalEvents?: AgentInternalEvent[];
  summaryLine?: string;
  requesterSessionOrigin?: DeliveryContext;
  requesterOrigin?: DeliveryContext;
  completionDirectOrigin?: DeliveryContext;
  directOrigin?: DeliveryContext;
  sourceSessionKey?: string;
  sourceChannel?: string;
  sourceTool?: string;
  targetRequesterSessionKey: string;
  requesterIsSubagent: boolean;
  expectsCompletionMessage: boolean;
  bestEffortDeliver?: boolean;
  directIdempotencyKey: string;
  signal?: AbortSignal;
}): Promise<SubagentAnnounceDeliveryResult> {
  return await runSubagentAnnounceDispatch({
    expectsCompletionMessage: params.expectsCompletionMessage,
    preferQueueFirst: params.requesterIsSubagent,
    signal: params.signal,
    queue: async () =>
      await maybeQueueSubagentAnnounce({
        requesterSessionKey: params.requesterSessionKey,
        announceId: params.announceId,
        triggerMessage: params.triggerMessage,
        steerMessage: params.steerMessage,
        summaryLine: params.summaryLine,
        requesterOrigin: params.requesterOrigin,
        sourceSessionKey: params.sourceSessionKey,
        sourceChannel: params.sourceChannel,
        sourceTool: params.sourceTool,
        internalEvents: params.internalEvents,
        signal: params.signal,
      }),
    direct: async () =>
      await sendSubagentAnnounceDirectly({
        targetRequesterSessionKey: params.targetRequesterSessionKey,
        triggerMessage: params.triggerMessage,
        internalEvents: params.internalEvents,
        directIdempotencyKey: params.directIdempotencyKey,
        completionDirectOrigin: params.completionDirectOrigin,
        directOrigin: params.directOrigin,
        requesterSessionOrigin: params.requesterSessionOrigin,
        sourceSessionKey: params.sourceSessionKey,
        sourceChannel: params.sourceChannel,
        sourceTool: params.sourceTool,
        requesterIsSubagent: params.requesterIsSubagent,
        expectsCompletionMessage: params.expectsCompletionMessage,
        signal: params.signal,
        bestEffortDeliver: params.bestEffortDeliver,
      }),
  });
}

export const __testing = {
  setDepsForTest(overrides?: Partial<SubagentAnnounceDeliveryDeps>) {
    subagentAnnounceDeliveryDeps = overrides
      ? {
          ...defaultSubagentAnnounceDeliveryDeps,
          ...overrides,
        }
      : defaultSubagentAnnounceDeliveryDeps;
  },
};
