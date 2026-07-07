import { type QueueDropPolicy, type QueueMode } from "../auto-reply/reply/queue.js";
import { defaultRuntime } from "../runtime.js";
import { deliveryContextKey, normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import {
  applyQueueRuntimeSettings,
  applyQueueDropPolicy,
  beginQueueDrain,
  buildCollectPrompt,
  clearQueueSummaryState,
  drainCollectQueueStep,
  drainNextQueueItem,
  hasCrossChannelItems,
  previewQueueSummaryPrompt,
  waitForQueueDebounce,
} from "../utils/queue-helpers.js";
import type { AgentInternalEvent } from "./internal-events.js";

export type AnnounceQueueItem = {
  // Stable announce identity shared by direct + queued delivery paths.
  // Optional for backward compatibility with previously queued items.
  announceId?: string;
  prompt: string;
  summaryLine?: string;
  internalEvents?: AgentInternalEvent[];
  enqueuedAt: number;
  sessionKey: string;
  origin?: DeliveryContext;
  originKey?: string;
  sourceSessionKey?: string;
  sourceChannel?: string;
  sourceTool?: string;
};

export type AnnounceQueueSettings = {
  mode: QueueMode;
  debounceMs?: number;
  cap?: number;
  dropPolicy?: QueueDropPolicy;
};

type AnnounceQueueState = {
  items: AnnounceQueueItem[];
  draining: boolean;
  lastEnqueuedAt: number;
  mode: QueueMode;
  debounceMs: number;
  cap: number;
  dropPolicy: QueueDropPolicy;
  droppedCount: number;
  summaryLines: string[];
  send: (item: AnnounceQueueItem) => Promise<void>;
  /** Consecutive drain failures — drives exponential backoff on errors. */
  consecutiveFailures: number;
  retryReadyAt?: number;
};

const ANNOUNCE_QUEUES = new Map<string, AnnounceQueueState>();
const MAX_ANNOUNCE_QUEUE_DRAIN_FAILURES = 3;

export function resetAnnounceQueuesForTests() {
  // Test isolation: other suites may leave a draining queue behind in the worker.
  // Clearing the map alone isn't enough because drain loops capture `queue` by reference.
  for (const queue of ANNOUNCE_QUEUES.values()) {
    queue.items.length = 0;
    queue.summaryLines.length = 0;
    queue.droppedCount = 0;
    queue.lastEnqueuedAt = 0;
    queue.retryReadyAt = undefined;
  }
  ANNOUNCE_QUEUES.clear();
}

function getAnnounceQueue(
  key: string,
  settings: AnnounceQueueSettings,
  send: (item: AnnounceQueueItem) => Promise<void>,
) {
  const existing = ANNOUNCE_QUEUES.get(key);
  if (existing) {
    applyQueueRuntimeSettings({
      target: existing,
      settings,
    });
    existing.send = send;
    return existing;
  }
  const created: AnnounceQueueState = {
    items: [],
    draining: false,
    lastEnqueuedAt: 0,
    mode: settings.mode,
    debounceMs: typeof settings.debounceMs === "number" ? Math.max(0, settings.debounceMs) : 1000,
    cap: typeof settings.cap === "number" && settings.cap > 0 ? Math.floor(settings.cap) : 20,
    dropPolicy: settings.dropPolicy ?? "summarize",
    droppedCount: 0,
    summaryLines: [],
    send,
    consecutiveFailures: 0,
    retryReadyAt: undefined,
  };
  applyQueueRuntimeSettings({
    target: created,
    settings,
  });
  ANNOUNCE_QUEUES.set(key, created);
  return created;
}

function hasAnnounceCrossChannelItems(items: AnnounceQueueItem[]): boolean {
  return hasCrossChannelItems(items, (item) => {
    if (!item.origin) {
      return {};
    }
    if (!item.originKey) {
      return { cross: true };
    }
    return { key: item.originKey };
  });
}

function summarizeAnnounceQueueError(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : error === undefined || error === null
          ? ""
          : "non-error thrown";
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
  if (/\bunavailable\b/i.test(message)) {
    return "unavailable";
  }
  return error instanceof Error ? error.name : "error";
}

async function waitForAnnounceRetryReady(queue: AnnounceQueueState): Promise<void> {
  const retryReadyAt = queue.retryReadyAt;
  if (retryReadyAt == null) {
    return;
  }
  const waitMs = retryReadyAt - Date.now();
  if (waitMs <= 0) {
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
}

function scheduleAnnounceDrain(key: string) {
  const queue = beginQueueDrain(ANNOUNCE_QUEUES, key);
  if (!queue) {
    return;
  }
  void (async () => {
    try {
      const collectState = { forceIndividualCollect: false };
      for (;;) {
        if (queue.items.length === 0 && queue.droppedCount === 0) {
          break;
        }
        await waitForAnnounceRetryReady(queue);
        await waitForQueueDebounce(queue);
        if (queue.mode === "collect") {
          const collectDrainResult = await drainCollectQueueStep({
            collectState,
            isCrossChannel: hasAnnounceCrossChannelItems(queue.items),
            items: queue.items,
            run: async (item) => await queue.send(item),
          });
          if (collectDrainResult === "empty") {
            break;
          }
          if (collectDrainResult === "drained") {
            continue;
          }
          const items = queue.items.slice();
          const summary = previewQueueSummaryPrompt({ state: queue, noun: "announce" });
          const prompt = buildCollectPrompt({
            title: "[Queued announce messages while agent was busy]",
            items,
            summary,
            renderItem: (item, idx) => `---\nQueued #${idx + 1}\n${item.prompt}`.trim(),
          });
          const internalEvents = items.flatMap((item) => item.internalEvents ?? []);
          const last = items.at(-1);
          if (!last) {
            break;
          }
          await queue.send({
            ...last,
            prompt,
            internalEvents: internalEvents.length > 0 ? internalEvents : last.internalEvents,
          });
          queue.items.splice(0, items.length);
          if (summary) {
            clearQueueSummaryState(queue);
          }
          continue;
        }

        const summaryPrompt = previewQueueSummaryPrompt({ state: queue, noun: "announce" });
        if (summaryPrompt) {
          if (
            !(await drainNextQueueItem(
              queue.items,
              async (item) => await queue.send({ ...item, prompt: summaryPrompt }),
            ))
          ) {
            break;
          }
          clearQueueSummaryState(queue);
          continue;
        }

        if (!(await drainNextQueueItem(queue.items, async (item) => await queue.send(item)))) {
          break;
        }
      }
      // Drain succeeded — reset failure counter.
      queue.consecutiveFailures = 0;
      queue.retryReadyAt = undefined;
    } catch (err) {
      queue.consecutiveFailures++;
      const errorSummary = summarizeAnnounceQueueError(err);
      if (queue.consecutiveFailures >= MAX_ANNOUNCE_QUEUE_DRAIN_FAILURES) {
        const pendingItems = queue.items.length;
        const droppedCount = queue.droppedCount;
        queue.items.length = 0;
        clearQueueSummaryState(queue);
        queue.retryReadyAt = undefined;
        defaultRuntime.error?.(
          `announce queue drain capped for ${key} failures=${queue.consecutiveFailures}/${MAX_ANNOUNCE_QUEUE_DRAIN_FAILURES} pending=${pendingItems} dropped=${droppedCount} reason=${errorSummary}`,
        );
        return;
      }
      // Exponential backoff on consecutive failures: 2s, 4s, 8s, ... capped at 60s.
      const errorBackoffMs = Math.min(1000 * 2 ** queue.consecutiveFailures, 60_000);
      queue.retryReadyAt = Date.now() + errorBackoffMs;
      defaultRuntime.error?.(
        `announce queue drain failed for ${key} failures=${queue.consecutiveFailures}/${MAX_ANNOUNCE_QUEUE_DRAIN_FAILURES} retrySeconds=${Math.round(errorBackoffMs / 1000)} reason=${errorSummary}`,
      );
    } finally {
      queue.draining = false;
      if (queue.items.length === 0 && queue.droppedCount === 0) {
        ANNOUNCE_QUEUES.delete(key);
      } else {
        scheduleAnnounceDrain(key);
      }
    }
  })();
}

function coalesceDuplicateAnnounceItem(
  queue: AnnounceQueueState,
  item: AnnounceQueueItem,
): boolean {
  const announceId = item.announceId?.trim();
  if (!announceId) {
    return false;
  }
  const existingIndex = queue.items.findIndex((queued) => queued.announceId?.trim() === announceId);
  if (existingIndex === -1) {
    return false;
  }
  const existing = queue.items[existingIndex];
  if (!existing) {
    return false;
  }
  const origin = normalizeDeliveryContext(item.origin);
  const originKey = deliveryContextKey(origin);
  queue.items[existingIndex] = {
    ...existing,
    ...item,
    enqueuedAt: existing.enqueuedAt,
    origin,
    originKey,
  };
  return true;
}

export function enqueueAnnounce(params: {
  key: string;
  item: AnnounceQueueItem;
  settings: AnnounceQueueSettings;
  send: (item: AnnounceQueueItem) => Promise<void>;
}): boolean {
  const queue = getAnnounceQueue(params.key, params.settings, params.send);
  // Preserve debounce timing across closely spaced enqueues.
  queue.lastEnqueuedAt = Math.max(queue.lastEnqueuedAt, Date.now());

  if (coalesceDuplicateAnnounceItem(queue, params.item)) {
    scheduleAnnounceDrain(params.key);
    return true;
  }

  const shouldEnqueue = applyQueueDropPolicy({
    queue,
    summarize: (item) => item.summaryLine?.trim() || item.prompt.trim(),
  });
  if (!shouldEnqueue) {
    if (queue.dropPolicy === "new") {
      scheduleAnnounceDrain(params.key);
    }
    return false;
  }

  const origin = normalizeDeliveryContext(params.item.origin);
  const originKey = deliveryContextKey(origin);
  queue.items.push({ ...params.item, origin, originKey });
  scheduleAnnounceDrain(params.key);
  return true;
}
