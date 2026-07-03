import {
  getAgentRuntimeIssues,
  resetAgentRuntimeHealthForTest,
  type AgentRuntimeIssue,
} from "../infra/agent-runtime-health.js";
import {
  diagnosticLogger as diag,
  logLaneDequeue,
  logLaneEnqueue,
} from "../logging/diagnostic-runtime.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type {
  CommandQueueLaneHealth,
  CommandQueueLaneSnapshot,
  CommandQueuePriority,
  CommandQueueSnapshot,
} from "./command-queue.types.js";
import { CommandLane } from "./lanes.js";
/**
 * Dedicated error type thrown when a queued command is rejected because
 * its lane was cleared.  Callers that fire-and-forget enqueued tasks can
 * catch (or ignore) this specific type to avoid unhandled-rejection noise.
 */
export class CommandLaneClearedError extends Error {
  constructor(lane?: string) {
    super(lane ? `Command lane "${lane}" cleared` : "Command lane cleared");
    this.name = "CommandLaneClearedError";
  }
}

/**
 * Dedicated error type thrown when a new command is rejected because the
 * gateway is currently draining for restart.
 */
export class GatewayDrainingError extends Error {
  constructor() {
    super("Gateway is draining for restart; new tasks are not accepted");
    this.name = "GatewayDrainingError";
  }
}

// Minimal in-process queue to serialize command executions.
// Default lane ("main") preserves the existing behavior. Additional lanes allow
// low-risk parallelism (e.g. cron jobs) without interleaving stdin / logs for
// the main auto-reply workflow.

type QueueEntry = {
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  enqueuedAt: number;
  warnAfterMs: number;
  onWait?: (waitMs: number, queuedAhead: number) => void;
  priority: number;
};

type LaneState = {
  lane: string;
  queue: QueueEntry[];
  activeTaskIds: Set<number>;
  activeTaskStartedAt: Map<number, number>;
  maxConcurrent: number;
  draining: boolean;
  generation: number;
  lastWaitMs: number | null;
  lastDequeuedAt: number | null;
  lastTaskDurationMs: number | null;
  lastCompletedAt: number | null;
  lastErrorAt: number | null;
  lastClearedAt: number | null;
};

type ActiveTaskWaiter = {
  activeTaskIds: Set<number>;
  resolve: (value: { drained: boolean }) => void;
  timeout?: ReturnType<typeof setTimeout>;
};

function isExpectedNonErrorLaneFailure(err: unknown): boolean {
  return err instanceof Error && err.name === "LiveSessionModelSwitchError";
}

/**
 * Keep queue runtime state on globalThis so every bundled entry/chunk shares
 * the same lanes, counters, and draining flag in production builds.
 */
const COMMAND_QUEUE_STATE_KEY = Symbol.for("openclaw.commandQueueState");

function getQueueState() {
  const state = resolveGlobalSingleton(COMMAND_QUEUE_STATE_KEY, () => ({
    gatewayDraining: false,
    lanes: new Map<string, LaneState>(),
    activeTaskWaiters: new Set<ActiveTaskWaiter>(),
    nextTaskId: 1,
  }));
  // Schema migration: the singleton may have been created by an older code
  // version (e.g. v2026.4.2) that did not include `activeTaskWaiters`.  After
  // a SIGUSR1 in-process restart the new code inherits the stale object via
  // `resolveGlobalSingleton` because the Symbol key already exists on
  // globalThis.  Patch the missing field so all downstream consumers see a
  // valid Set instead of `undefined`.
  if (!state.activeTaskWaiters) {
    state.activeTaskWaiters = new Set<ActiveTaskWaiter>();
  }
  return state;
}

function normalizeLane(lane: string): string {
  return lane.trim() || CommandLane.Main;
}

function normalizePriority(priority: CommandQueuePriority | undefined): number {
  return priority === "high" ? 1 : 0;
}

function enqueueLaneEntry(state: LaneState, entry: QueueEntry): void {
  const insertAt = state.queue.findIndex((queued) => queued.priority < entry.priority);
  if (insertAt === -1) {
    state.queue.push(entry);
    return;
  }
  state.queue.splice(insertAt, 0, entry);
}

function getLaneDepth(state: LaneState): number {
  return state.queue.length + state.activeTaskIds.size;
}

function ensureLaneRuntimeFields(state: LaneState): LaneState {
  if (!state.activeTaskStartedAt) {
    state.activeTaskStartedAt = new Map();
  }
  state.lastWaitMs ??= null;
  state.lastDequeuedAt ??= null;
  state.lastTaskDurationMs ??= null;
  state.lastCompletedAt ??= null;
  state.lastErrorAt ??= null;
  state.lastClearedAt ??= null;
  return state;
}

function getLaneState(lane: string): LaneState {
  const queueState = getQueueState();
  const existing = queueState.lanes.get(lane);
  if (existing) {
    return ensureLaneRuntimeFields(existing);
  }
  const created: LaneState = {
    lane,
    queue: [],
    activeTaskIds: new Set(),
    activeTaskStartedAt: new Map(),
    maxConcurrent: 1,
    draining: false,
    generation: 0,
    lastWaitMs: null,
    lastDequeuedAt: null,
    lastTaskDurationMs: null,
    lastCompletedAt: null,
    lastErrorAt: null,
    lastClearedAt: null,
  };
  queueState.lanes.set(lane, created);
  return created;
}

function completeTask(state: LaneState, taskId: number, taskGeneration: number): boolean {
  if (taskGeneration !== state.generation) {
    return false;
  }
  state.activeTaskIds.delete(taskId);
  state.activeTaskStartedAt.delete(taskId);
  return true;
}

function groupRuntimeIssuesByLane(issues: AgentRuntimeIssue[]): Map<string, AgentRuntimeIssue[]> {
  const grouped = new Map<string, AgentRuntimeIssue[]>();
  for (const issue of issues) {
    if (!issue.lane) {
      continue;
    }
    const entries = grouped.get(issue.lane) ?? [];
    entries.push(issue);
    grouped.set(issue.lane, entries);
  }
  return grouped;
}

function resolveLaneHealth(params: {
  queued: number;
  active: number;
  draining: boolean;
  runtimeIssues: AgentRuntimeIssue[];
}): CommandQueueLaneHealth {
  if (params.draining) {
    return "draining";
  }
  if (params.runtimeIssues.some((issue) => issue.severity === "error")) {
    return "blocked";
  }
  if (params.runtimeIssues.length > 0) {
    return "degraded";
  }
  if (params.queued > 0) {
    return "waiting";
  }
  if (params.active > 0) {
    return "running";
  }
  return "idle";
}

function isLaneOverloaded(params: {
  queued: number;
  active: number;
  maxConcurrent: number;
}): boolean {
  return params.queued > 0 && params.active >= params.maxConcurrent;
}

function toLaneSnapshot(
  state: LaneState,
  now: number,
  runtimeIssues: AgentRuntimeIssue[] = [],
): CommandQueueLaneSnapshot {
  ensureLaneRuntimeFields(state);
  const oldestQueuedAt =
    state.queue.length > 0 ? Math.min(...state.queue.map((entry) => entry.enqueuedAt)) : null;
  const activeStartedValues = Array.from(state.activeTaskStartedAt.values());
  const oldestActiveStartedAt =
    activeStartedValues.length > 0 ? Math.min(...activeStartedValues) : null;
  const queued = state.queue.length;
  const active = state.activeTaskIds.size;
  const isOverloaded = isLaneOverloaded({
    queued,
    active,
    maxConcurrent: state.maxConcurrent,
  });
  return {
    lane: state.lane,
    health: resolveLaneHealth({
      queued,
      active,
      draining: state.draining,
      runtimeIssues,
    }),
    queued,
    active,
    depth: getLaneDepth(state),
    maxConcurrent: state.maxConcurrent,
    isOverloaded,
    draining: state.draining,
    oldestQueuedAt,
    oldestQueuedMs: oldestQueuedAt == null ? null : Math.max(0, now - oldestQueuedAt),
    oldestActiveStartedAt,
    oldestActiveMs: oldestActiveStartedAt == null ? null : Math.max(0, now - oldestActiveStartedAt),
    lastWaitMs: state.lastWaitMs,
    lastDequeuedAt: state.lastDequeuedAt,
    lastTaskDurationMs: state.lastTaskDurationMs,
    lastCompletedAt: state.lastCompletedAt,
    lastErrorAt: state.lastErrorAt,
    lastClearedAt: state.lastClearedAt,
    runtimeIssues,
  };
}

function toMissingLaneSnapshot(
  lane: string,
  now: number,
  runtimeIssues: AgentRuntimeIssue[] = [],
): CommandQueueLaneSnapshot {
  return {
    lane,
    health: resolveLaneHealth({
      queued: 0,
      active: 0,
      draining: false,
      runtimeIssues,
    }),
    queued: 0,
    active: 0,
    depth: 0,
    maxConcurrent: 1,
    isOverloaded: false,
    draining: false,
    oldestQueuedAt: null,
    oldestQueuedMs: null,
    oldestActiveStartedAt: null,
    oldestActiveMs: null,
    lastWaitMs: null,
    lastDequeuedAt: null,
    lastTaskDurationMs: null,
    lastCompletedAt: null,
    lastErrorAt: null,
    lastClearedAt: null,
    runtimeIssues,
  };
}

function hasPendingActiveTasks(taskIds: Set<number>): boolean {
  const queueState = getQueueState();
  for (const state of queueState.lanes.values()) {
    for (const taskId of state.activeTaskIds) {
      if (taskIds.has(taskId)) {
        return true;
      }
    }
  }
  return false;
}

function resolveActiveTaskWaiter(waiter: ActiveTaskWaiter, result: { drained: boolean }): void {
  const queueState = getQueueState();
  if (!queueState.activeTaskWaiters.delete(waiter)) {
    return;
  }
  if (waiter.timeout) {
    clearTimeout(waiter.timeout);
  }
  waiter.resolve(result);
}

function notifyActiveTaskWaiters(): void {
  const queueState = getQueueState();
  for (const waiter of Array.from(queueState.activeTaskWaiters)) {
    if (waiter.activeTaskIds.size === 0 || !hasPendingActiveTasks(waiter.activeTaskIds)) {
      resolveActiveTaskWaiter(waiter, { drained: true });
    }
  }
}

function drainLane(lane: string) {
  const state = getLaneState(lane);
  if (state.draining) {
    if (state.activeTaskIds.size === 0 && state.queue.length > 0) {
      diag.warn(
        `drainLane blocked: lane=${lane} draining=true active=0 queue=${state.queue.length}`,
      );
    }
    return;
  }
  state.draining = true;

  const pump = () => {
    try {
      while (state.activeTaskIds.size < state.maxConcurrent && state.queue.length > 0) {
        const entry = state.queue.shift() as QueueEntry;
        const waitedMs = Date.now() - entry.enqueuedAt;
        state.lastWaitMs = waitedMs;
        state.lastDequeuedAt = Date.now();
        if (waitedMs >= entry.warnAfterMs) {
          try {
            entry.onWait?.(waitedMs, state.queue.length);
          } catch (err) {
            diag.error(`lane onWait callback failed: lane=${lane} error="${String(err)}"`);
          }
          diag.warn(
            `lane wait exceeded: lane=${lane} waitedMs=${waitedMs} queueAhead=${state.queue.length}`,
          );
        }
        logLaneDequeue(lane, waitedMs, state.queue.length);
        const taskId = getQueueState().nextTaskId++;
        const taskGeneration = state.generation;
        state.activeTaskIds.add(taskId);
        state.activeTaskStartedAt.set(taskId, Date.now());
        void (async () => {
          const startTime = Date.now();
          try {
            const result = await entry.task();
            const completedCurrentGeneration = completeTask(state, taskId, taskGeneration);
            if (completedCurrentGeneration) {
              state.lastTaskDurationMs = Date.now() - startTime;
              state.lastCompletedAt = Date.now();
              notifyActiveTaskWaiters();
              diag.debug(
                `lane task done: lane=${lane} durationMs=${Date.now() - startTime} active=${state.activeTaskIds.size} queued=${state.queue.length}`,
              );
              pump();
            }
            entry.resolve(result);
          } catch (err) {
            const completedCurrentGeneration = completeTask(state, taskId, taskGeneration);
            const taskDurationMs = Date.now() - startTime;
            if (completedCurrentGeneration) {
              state.lastTaskDurationMs = taskDurationMs;
              state.lastErrorAt = Date.now();
            }
            const isProbeLane = lane.startsWith("auth-probe:") || lane.startsWith("session:probe-");
            if (!isProbeLane && !isExpectedNonErrorLaneFailure(err)) {
              diag.error(
                `lane task error: lane=${lane} durationMs=${Date.now() - startTime} error="${String(err)}"`,
              );
            } else if (!isProbeLane) {
              diag.debug(
                `lane task interrupted: lane=${lane} durationMs=${Date.now() - startTime} reason="${String(err)}"`,
              );
            }
            if (completedCurrentGeneration) {
              notifyActiveTaskWaiters();
              pump();
            }
            entry.reject(err);
          }
        })();
      }
    } finally {
      state.draining = false;
    }
  };

  pump();
}

/**
 * Mark gateway as draining for restart so new enqueues fail fast with
 * `GatewayDrainingError` instead of being silently killed on shutdown.
 */
export function markGatewayDraining(): void {
  getQueueState().gatewayDraining = true;
}

export function setCommandLaneConcurrency(lane: string, maxConcurrent: number) {
  const cleaned = normalizeLane(lane);
  const state = getLaneState(cleaned);
  state.maxConcurrent = Math.max(1, Math.floor(maxConcurrent));
  drainLane(cleaned);
}

export function enqueueCommandInLane<T>(
  lane: string,
  task: () => Promise<T>,
  opts?: {
    warnAfterMs?: number;
    onWait?: (waitMs: number, queuedAhead: number) => void;
    priority?: CommandQueuePriority;
  },
): Promise<T> {
  const queueState = getQueueState();
  if (queueState.gatewayDraining) {
    return Promise.reject(new GatewayDrainingError());
  }
  const cleaned = normalizeLane(lane);
  const warnAfterMs = opts?.warnAfterMs ?? 2_000;
  const state = getLaneState(cleaned);
  return new Promise<T>((resolve, reject) => {
    enqueueLaneEntry(state, {
      task: () => task(),
      resolve: (value) => resolve(value as T),
      reject,
      enqueuedAt: Date.now(),
      warnAfterMs,
      onWait: opts?.onWait,
      priority: normalizePriority(opts?.priority),
    });
    logLaneEnqueue(cleaned, getLaneDepth(state));
    drainLane(cleaned);
  });
}

export function enqueueCommand<T>(
  task: () => Promise<T>,
  opts?: {
    warnAfterMs?: number;
    onWait?: (waitMs: number, queuedAhead: number) => void;
    priority?: CommandQueuePriority;
  },
): Promise<T> {
  return enqueueCommandInLane(CommandLane.Main, task, opts);
}

export function getQueueSize(lane: string = CommandLane.Main) {
  const resolved = normalizeLane(lane);
  const state = getQueueState().lanes.get(resolved);
  if (!state) {
    return 0;
  }
  return getLaneDepth(state);
}

export function getTotalQueueSize() {
  let total = 0;
  for (const s of getQueueState().lanes.values()) {
    ensureLaneRuntimeFields(s);
    total += getLaneDepth(s);
  }
  return total;
}

export function getCommandQueueSnapshot(opts?: { lane?: string }): CommandQueueSnapshot {
  const queueState = getQueueState();
  const now = Date.now();
  const requestedLane = opts?.lane ? normalizeLane(opts.lane) : null;
  const runtimeIssues = getAgentRuntimeIssues(requestedLane ? { lane: requestedLane } : undefined);
  const runtimeIssuesByLane = groupRuntimeIssuesByLane(runtimeIssues);
  const lanes = requestedLane
    ? [
        queueState.lanes.has(requestedLane)
          ? toLaneSnapshot(
              queueState.lanes.get(requestedLane) as LaneState,
              now,
              runtimeIssuesByLane.get(requestedLane) ?? [],
            )
          : toMissingLaneSnapshot(requestedLane, now, runtimeIssuesByLane.get(requestedLane) ?? []),
      ]
    : Array.from(queueState.lanes.values()).map((state) =>
        toLaneSnapshot(state, now, runtimeIssuesByLane.get(state.lane) ?? []),
      );
  if (!requestedLane) {
    const knownLanes = new Set(lanes.map((lane) => lane.lane));
    for (const [lane, issues] of runtimeIssuesByLane.entries()) {
      if (!knownLanes.has(lane)) {
        lanes.push(toMissingLaneSnapshot(lane, now, issues));
      }
    }
  }
  lanes.sort(
    (a, b) =>
      b.runtimeIssues.length - a.runtimeIssues.length ||
      b.depth - a.depth ||
      a.lane.localeCompare(b.lane),
  );
  return {
    ts: now,
    gatewayDraining: Boolean(queueState.gatewayDraining),
    totalQueued: lanes.reduce((sum, lane) => sum + lane.queued, 0),
    totalActive: lanes.reduce((sum, lane) => sum + lane.active, 0),
    totalDepth: lanes.reduce((sum, lane) => sum + lane.depth, 0),
    totalRuntimeIssues: runtimeIssues.length,
    runtimeIssues,
    lanes,
  };
}

export function clearCommandLane(lane: string = CommandLane.Main) {
  const cleaned = normalizeLane(lane);
  const state = getQueueState().lanes.get(cleaned);
  if (!state) {
    return 0;
  }
  const removed = state.queue.length;
  const pending = state.queue.splice(0);
  for (const entry of pending) {
    entry.reject(new CommandLaneClearedError(cleaned));
  }
  state.lastClearedAt = Date.now();
  return removed;
}

/**
 * Test-only hard reset that discards all queue state, including preserved
 * queued work from previous generations. Use this when a suite needs an
 * isolated baseline across shared-worker runs.
 */
export function resetCommandQueueStateForTest(): void {
  const queueState = getQueueState();
  queueState.gatewayDraining = false;
  queueState.lanes.clear();
  resetAgentRuntimeHealthForTest();
  for (const waiter of Array.from(queueState.activeTaskWaiters)) {
    resolveActiveTaskWaiter(waiter, { drained: true });
  }
  queueState.nextTaskId = 1;
}

/**
 * Reset all lane runtime state to idle. Used after SIGUSR1 in-process
 * restarts where interrupted tasks' finally blocks may not run, leaving
 * stale active task IDs that permanently block new work from draining.
 *
 * Bumps lane generation and clears execution counters so stale completions
 * from old in-flight tasks are ignored. Queued entries are intentionally
 * preserved — they represent pending user work that should still execute
 * after restart.
 *
 * After resetting, drains any lanes that still have queued entries so
 * preserved work is pumped immediately rather than waiting for a future
 * `enqueueCommandInLane()` call (which may never come).
 */
export function resetAllLanes(): void {
  const queueState = getQueueState();
  queueState.gatewayDraining = false;
  const lanesToDrain: string[] = [];
  for (const state of queueState.lanes.values()) {
    state.generation += 1;
    state.activeTaskIds.clear();
    ensureLaneRuntimeFields(state).activeTaskStartedAt.clear();
    state.draining = false;
    if (state.queue.length > 0) {
      lanesToDrain.push(state.lane);
    }
  }
  // Drain after the full reset pass so all lanes are in a clean state first.
  for (const lane of lanesToDrain) {
    drainLane(lane);
  }
  notifyActiveTaskWaiters();
}

/**
 * Returns the total number of actively executing tasks across all lanes
 * (excludes queued-but-not-started entries).
 */
export function getActiveTaskCount(): number {
  const queueState = getQueueState();
  let total = 0;
  for (const s of queueState.lanes.values()) {
    total += s.activeTaskIds.size;
  }
  return total;
}

/**
 * Wait for all currently active tasks across all lanes to finish.
 * Polls at a short interval; resolves when no tasks are active or
 * when `timeoutMs` elapses (whichever comes first).
 *
 * New tasks enqueued after this call are ignored — only tasks that are
 * already executing are waited on.
 */
export function waitForActiveTasks(timeoutMs: number): Promise<{ drained: boolean }> {
  const queueState = getQueueState();
  const activeAtStart = new Set<number>();
  for (const state of queueState.lanes.values()) {
    for (const taskId of state.activeTaskIds) {
      activeAtStart.add(taskId);
    }
  }

  if (activeAtStart.size === 0) {
    return Promise.resolve({ drained: true });
  }
  if (timeoutMs <= 0) {
    return Promise.resolve({ drained: false });
  }

  return new Promise((resolve) => {
    const waiter: ActiveTaskWaiter = {
      activeTaskIds: activeAtStart,
      resolve,
    };
    waiter.timeout = setTimeout(() => {
      resolveActiveTaskWaiter(waiter, { drained: false });
    }, timeoutMs);
    queueState.activeTaskWaiters.add(waiter);
    notifyActiveTaskWaiters();
  });
}
