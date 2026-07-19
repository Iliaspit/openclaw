import { parseAgentSessionKey } from "../../../src/routing/session-key.js";
import type { SessionRunStatus } from "./types.ts";

type TerminalRunStatus = Exclude<SessionRunStatus, "running">;

const TERMINAL_RUN_STATUSES = new Set<TerminalRunStatus>(["done", "failed", "killed", "timeout"]);
const PLANNER_NOTIFICATION_AUTO_DISMISS_MS = 10_000;
const MAX_SEEN_NOTIFICATION_IDS = 200;

export type PlannerCompletionNotification = {
  id: string;
  sessionKey: string;
  runId?: string;
  title: string;
  body: string;
  status: TerminalRunStatus;
  createdAt: number;
};

export type PlannerNotificationHost = {
  plannerCompletionNotification: PlannerCompletionNotification | null;
  plannerCompletionNotificationDismissTimer: ReturnType<typeof setTimeout> | null;
  plannerCompletionNotificationSeenIds: Set<string>;
};

type PlannerLifecyclePayload = {
  sessionKey?: unknown;
  phase?: unknown;
  runId?: unknown;
  status?: unknown;
  label?: unknown;
  displayName?: unknown;
  parentSessionKey?: unknown;
  spawnedBy?: unknown;
  spawnDepth?: unknown;
  subagentRole?: unknown;
  runtimeMs?: unknown;
  endedAt?: unknown;
  ts?: unknown;
};

type WindowWithWebkitAudio = Window & {
  webkitAudioContext?: typeof AudioContext;
};

let plannerAudioContext: AudioContext | null = null;

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readTerminalStatus(value: unknown, phase: "end" | "error"): TerminalRunStatus {
  return typeof value === "string" && TERMINAL_RUN_STATUSES.has(value as TerminalRunStatus)
    ? (value as TerminalRunStatus)
    : phase === "error"
      ? "failed"
      : "done";
}

function isPlannerAgentId(agentId: string): boolean {
  return /^planner(?:-\d+)?$/i.test(agentId.trim());
}

function isTopLevelPlannerLifecycle(
  payload: PlannerLifecyclePayload,
): payload is PlannerLifecyclePayload & {
  sessionKey: string;
  phase: "end" | "error";
} {
  const phase = payload.phase === "end" || payload.phase === "error" ? payload.phase : null;
  const sessionKey = normalizeOptionalString(payload.sessionKey);
  if (!phase || !sessionKey) {
    return false;
  }
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed || !isPlannerAgentId(parsed.agentId)) {
    return false;
  }
  if (sessionKey.toLowerCase().includes(":subagent:")) {
    return false;
  }
  if (normalizeOptionalString(payload.parentSessionKey)) {
    return false;
  }
  if (normalizeOptionalString(payload.subagentRole)) {
    return false;
  }
  const spawnDepth = readFiniteNumber(payload.spawnDepth);
  return spawnDepth === undefined || spawnDepth <= 0;
}

function formatPlannerAgentName(sessionKey: string): string {
  const parsed = parseAgentSessionKey(sessionKey);
  const agentId = parsed?.agentId ?? "planner";
  const match = agentId.match(/^planner(?:-(\d+))?$/i);
  if (!match) {
    return agentId;
  }
  return match[1] ? `Planner ${match[1]}` : "Planner";
}

function resolvePlannerDisplayName(payload: PlannerLifecyclePayload & { sessionKey: string }) {
  const explicit =
    normalizeOptionalString(payload.displayName) ?? normalizeOptionalString(payload.label);
  if (explicit && explicit !== payload.sessionKey && explicit.toLowerCase() !== "main") {
    return explicit;
  }
  return formatPlannerAgentName(payload.sessionKey);
}

function formatDuration(runtimeMs: number | undefined): string | undefined {
  if (runtimeMs === undefined || runtimeMs < 0) {
    return undefined;
  }
  const totalSeconds = Math.max(0, Math.round(runtimeMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) {
    return `${seconds}s`;
  }
  if (seconds === 0) {
    return `${minutes}m`;
  }
  return `${minutes}m ${seconds}s`;
}

function titleForStatus(name: string, status: TerminalRunStatus): string {
  switch (status) {
    case "done":
      return `${name} is done`;
    case "failed":
      return `${name} failed`;
    case "killed":
      return `${name} stopped`;
    case "timeout":
      return `${name} timed out`;
  }
  throw new Error("Unsupported terminal run status");
}

function notificationIdForPayload(payload: PlannerLifecyclePayload & { sessionKey: string }) {
  const runId = normalizeOptionalString(payload.runId);
  if (runId) {
    return `run:${runId}`;
  }
  const endedAt = readFiniteNumber(payload.endedAt) ?? readFiniteNumber(payload.ts) ?? Date.now();
  return `session:${payload.sessionKey}:${endedAt}`;
}

function rememberNotificationId(host: PlannerNotificationHost, id: string) {
  host.plannerCompletionNotificationSeenIds.add(id);
  while (host.plannerCompletionNotificationSeenIds.size > MAX_SEEN_NOTIFICATION_IDS) {
    const oldest = host.plannerCompletionNotificationSeenIds.values().next().value;
    if (!oldest) {
      break;
    }
    host.plannerCompletionNotificationSeenIds.delete(oldest);
  }
}

export function buildPlannerCompletionNotification(
  rawPayload: unknown,
): PlannerCompletionNotification | null {
  const payload =
    rawPayload && typeof rawPayload === "object"
      ? (rawPayload as PlannerLifecyclePayload)
      : undefined;
  if (!payload || !isTopLevelPlannerLifecycle(payload)) {
    return null;
  }
  const status = readTerminalStatus(payload.status, payload.phase);
  const name = resolvePlannerDisplayName(payload);
  const runtime = formatDuration(readFiniteNumber(payload.runtimeMs));
  const bodyParts = [payload.sessionKey, runtime].filter((part): part is string => Boolean(part));
  return {
    id: notificationIdForPayload(payload),
    sessionKey: payload.sessionKey,
    ...(normalizeOptionalString(payload.runId)
      ? { runId: normalizeOptionalString(payload.runId) }
      : {}),
    title: titleForStatus(name, status),
    body: bodyParts.join(" - "),
    status,
    createdAt: readFiniteNumber(payload.endedAt) ?? readFiniteNumber(payload.ts) ?? Date.now(),
  };
}

function playTone(ctx: AudioContext, frequency: number, startAt: number, durationSeconds: number) {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(frequency, startAt);
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(0.045, startAt + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + durationSeconds);
  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + durationSeconds + 0.02);
}

export function playPlannerCompletionChime(): void {
  if (typeof window === "undefined") {
    return;
  }
  const AudioContextCtor =
    window.AudioContext ?? (window as WindowWithWebkitAudio).webkitAudioContext;
  if (!AudioContextCtor) {
    return;
  }
  try {
    if (!plannerAudioContext || plannerAudioContext.state === "closed") {
      plannerAudioContext = new AudioContextCtor();
    }
    const ctx = plannerAudioContext;
    const play = () => {
      if (ctx.state === "closed") {
        return;
      }
      const now = ctx.currentTime + 0.03;
      playTone(ctx, 659.25, now, 0.14);
      playTone(ctx, 880, now + 0.12, 0.18);
    };
    if (ctx.state === "suspended") {
      void ctx
        .resume()
        .then(play)
        .catch(() => undefined);
      return;
    }
    play();
  } catch {
    // Browser autoplay and audio-device policies should never break UI updates.
  }
}

export function dismissPlannerCompletionNotification(
  host: PlannerNotificationHost,
  notificationId?: string,
): void {
  if (
    notificationId &&
    host.plannerCompletionNotification &&
    host.plannerCompletionNotification.id !== notificationId
  ) {
    return;
  }
  if (host.plannerCompletionNotificationDismissTimer) {
    clearTimeout(host.plannerCompletionNotificationDismissTimer);
    host.plannerCompletionNotificationDismissTimer = null;
  }
  host.plannerCompletionNotification = null;
}

export function handlePlannerCompletionLifecycleEvent(
  host: PlannerNotificationHost,
  payload: unknown,
): boolean {
  const notification = buildPlannerCompletionNotification(payload);
  if (!notification || host.plannerCompletionNotificationSeenIds.has(notification.id)) {
    return false;
  }
  rememberNotificationId(host, notification.id);
  if (host.plannerCompletionNotificationDismissTimer) {
    clearTimeout(host.plannerCompletionNotificationDismissTimer);
  }
  host.plannerCompletionNotification = notification;
  playPlannerCompletionChime();
  host.plannerCompletionNotificationDismissTimer = setTimeout(() => {
    dismissPlannerCompletionNotification(host, notification.id);
  }, PLANNER_NOTIFICATION_AUTO_DISMISS_MS);
  return true;
}
