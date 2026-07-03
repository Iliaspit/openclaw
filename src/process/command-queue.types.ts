import type { AgentRuntimeIssue } from "../infra/agent-runtime-health.js";

export type CommandQueuePriority = "normal" | "high";
export type CommandQueueLaneHealth =
  | "idle"
  | "running"
  | "waiting"
  | "degraded"
  | "blocked"
  | "draining";

export type CommandQueueRuntimeIssue = AgentRuntimeIssue;

export type CommandQueueLaneSnapshot = {
  lane: string;
  health: CommandQueueLaneHealth;
  queued: number;
  active: number;
  depth: number;
  maxConcurrent: number;
  isOverloaded: boolean;
  draining: boolean;
  oldestQueuedAt: number | null;
  oldestQueuedMs: number | null;
  oldestActiveStartedAt: number | null;
  oldestActiveMs: number | null;
  lastWaitMs: number | null;
  lastDequeuedAt: number | null;
  lastTaskDurationMs: number | null;
  lastCompletedAt: number | null;
  lastErrorAt: number | null;
  lastClearedAt: number | null;
  runtimeIssues: CommandQueueRuntimeIssue[];
};

export type CommandQueueSnapshot = {
  ts: number;
  gatewayDraining: boolean;
  totalQueued: number;
  totalActive: number;
  totalDepth: number;
  totalRuntimeIssues: number;
  runtimeIssues: CommandQueueRuntimeIssue[];
  lanes: CommandQueueLaneSnapshot[];
};

export type CommandQueueEnqueueFn = <T>(
  task: () => Promise<T>,
  opts?: {
    warnAfterMs?: number;
    onWait?: (waitMs: number, queuedAhead: number) => void;
    priority?: CommandQueuePriority;
  },
) => Promise<T>;
