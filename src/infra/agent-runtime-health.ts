import type { ChildRouteHealthCode } from "../agents/child-route-health-contract.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export type AgentRuntimeIssueCode =
  | "context_overflow"
  | "agent_lifecycle_error"
  | "agent_lifecycle_blocked"
  | "agent_lifecycle_abandoned";

export type AgentRuntimeIssueSeverity = "warning" | "error";

export type AgentRuntimeIssue = {
  runId: string;
  code: AgentRuntimeIssueCode;
  severity: AgentRuntimeIssueSeverity;
  message: string;
  observedAt: number;
  lastUpdatedAt: number;
  count: number;
  sessionKey?: string;
  lane?: string;
  livenessState?: string;
};

type AgentRuntimeHealthState = {
  issuesByRunId: Map<string, AgentRuntimeIssue>;
};

type AgentRuntimeLifecycleEvent = {
  runId: string;
  stream: string;
  ts: number;
  data: Record<string, unknown>;
  sessionKey?: string;
};

const AGENT_RUNTIME_HEALTH_STATE_KEY = Symbol.for("openclaw.agentRuntimeHealth.state");
const MAX_RUNTIME_ISSUES = 100;
const MAX_RUNTIME_ISSUE_MESSAGE_CHARS = 240;

function getAgentRuntimeHealthState(): AgentRuntimeHealthState {
  return resolveGlobalSingleton<AgentRuntimeHealthState>(AGENT_RUNTIME_HEALTH_STATE_KEY, () => ({
    issuesByRunId: new Map(),
  }));
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function truncateIssueMessage(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_RUNTIME_ISSUE_MESSAGE_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_RUNTIME_ISSUE_MESSAGE_CHARS - 3)}...`;
}

function resolveSessionLane(sessionKey: string | undefined): string | undefined {
  if (!sessionKey) {
    return undefined;
  }
  return sessionKey.startsWith("session:") ? sessionKey : `session:${sessionKey}`;
}

function classifyLifecycleError(message: string): AgentRuntimeIssueCode {
  const lower = message.toLowerCase();
  if (
    lower.includes("context overflow") ||
    lower.includes("context window exceeded") ||
    lower.includes("prompt too large") ||
    lower.includes("prompt is too long")
  ) {
    return "context_overflow";
  }
  return "agent_lifecycle_error";
}

function recordRouteHealthIssue(issue: {
  runId: string;
  code: ChildRouteHealthCode;
  message: string;
  sessionKey?: string;
  observedAt?: number;
}): void {
  const sessionKey = normalizeOptionalString(issue.sessionKey);
  if (!sessionKey) {
    return;
  }
  void import("../agents/child-route-health.js")
    .then(({ recordChildRouteHealthEvent, resolveChildTargetKind }) => {
      if (!resolveChildTargetKind(sessionKey)) {
        return undefined;
      }
      return recordChildRouteHealthEvent({
        code: issue.code,
        status: "active",
        source: issue.code === "context_overflow" ? "context_overflow" : "agent_lifecycle",
        childSessionKey: sessionKey,
        runId: issue.runId,
        observedAt: issue.observedAt,
        reason: issue.message,
      });
    })
    .catch(() => undefined);
}

function recordRouteHealthSuccess(event: AgentRuntimeLifecycleEvent): void {
  const sessionKey = normalizeOptionalString(event.sessionKey);
  if (!sessionKey) {
    return;
  }
  const livenessState = normalizeOptionalString(event.data.livenessState);
  const replayInvalid = event.data.replayInvalid === true;
  const willRetry = event.data.willRetry === true;
  const explicitlyIncomplete = event.data.completed === false;
  if (
    replayInvalid ||
    willRetry ||
    explicitlyIncomplete ||
    (livenessState && livenessState !== "working")
  ) {
    return;
  }
  void import("../agents/child-route-health.js")
    .then(({ recordChildRouteHealthEvent, resolveChildTargetKind }) => {
      if (!resolveChildTargetKind(sessionKey)) {
        return undefined;
      }
      return recordChildRouteHealthEvent({
        code: "agent_lifecycle_error",
        status: "success",
        source: "agent_lifecycle",
        childSessionKey: sessionKey,
        runId: event.runId,
        observedAt: event.ts,
        reason: "ordinary execution completed successfully",
      });
    })
    .catch(() => undefined);
}

function trimRuntimeIssues(state: AgentRuntimeHealthState): void {
  if (state.issuesByRunId.size <= MAX_RUNTIME_ISSUES) {
    return;
  }
  const sorted = Array.from(state.issuesByRunId.entries()).toSorted(
    (left, right) => left[1].lastUpdatedAt - right[1].lastUpdatedAt,
  );
  for (const [runId] of sorted.slice(0, Math.max(0, sorted.length - MAX_RUNTIME_ISSUES))) {
    state.issuesByRunId.delete(runId);
  }
}

export function recordAgentRuntimeIssue(issue: {
  runId: string;
  code: AgentRuntimeIssueCode;
  severity: AgentRuntimeIssueSeverity;
  message: string;
  sessionKey?: string;
  livenessState?: string;
  observedAt?: number;
}): void {
  const runId = issue.runId.trim();
  if (!runId) {
    return;
  }
  const state = getAgentRuntimeHealthState();
  const now = issue.observedAt ?? Date.now();
  const existing = state.issuesByRunId.get(runId);
  const sessionKey = normalizeOptionalString(issue.sessionKey);
  const message = truncateIssueMessage(issue.message || issue.code);
  state.issuesByRunId.set(runId, {
    runId,
    code: issue.code,
    severity: issue.severity,
    message,
    observedAt: existing?.observedAt ?? now,
    lastUpdatedAt: now,
    count: (existing?.count ?? 0) + 1,
    ...(sessionKey ? { sessionKey, lane: resolveSessionLane(sessionKey) } : {}),
    ...(issue.livenessState ? { livenessState: issue.livenessState } : {}),
  });
  recordRouteHealthIssue({
    runId,
    code: issue.code,
    message,
    sessionKey,
    observedAt: now,
  });
  trimRuntimeIssues(state);
}

export function clearAgentRuntimeIssue(runId: string): void {
  const cleaned = runId.trim();
  if (!cleaned) {
    return;
  }
  getAgentRuntimeHealthState().issuesByRunId.delete(cleaned);
}

export function clearAgentRuntimeIssuesForSession(sessionKey: string | undefined): void {
  const cleaned = normalizeOptionalString(sessionKey);
  if (!cleaned) {
    return;
  }
  const lane = resolveSessionLane(cleaned);
  const state = getAgentRuntimeHealthState();
  for (const [runId, issue] of state.issuesByRunId.entries()) {
    if (issue.sessionKey === cleaned || issue.lane === lane) {
      state.issuesByRunId.delete(runId);
    }
  }
}

export function updateAgentRuntimeHealthFromEvent(event: AgentRuntimeLifecycleEvent): void {
  if (event.stream !== "lifecycle") {
    return;
  }
  const phase = normalizeOptionalString(event.data.phase);
  if (!phase) {
    return;
  }
  if (phase === "start") {
    clearAgentRuntimeIssue(event.runId);
    clearAgentRuntimeIssuesForSession(event.sessionKey);
    return;
  }
  const livenessState = normalizeOptionalString(event.data.livenessState);
  if (phase === "end") {
    if (livenessState === "blocked" || livenessState === "abandoned") {
      clearAgentRuntimeIssuesForSession(event.sessionKey);
      recordAgentRuntimeIssue({
        runId: event.runId,
        code:
          livenessState === "abandoned" ? "agent_lifecycle_abandoned" : "agent_lifecycle_blocked",
        severity: livenessState === "abandoned" ? "warning" : "error",
        message:
          livenessState === "abandoned"
            ? "Agent ended without a visible reply after replay-invalid work."
            : "Agent ended in a blocked lifecycle state.",
        sessionKey: event.sessionKey,
        livenessState,
        observedAt: event.ts,
      });
      return;
    }
    recordRouteHealthSuccess(event);
    clearAgentRuntimeIssue(event.runId);
    clearAgentRuntimeIssuesForSession(event.sessionKey);
    return;
  }
  if (phase !== "error") {
    return;
  }
  const message =
    normalizeOptionalString(event.data.error) ??
    normalizeOptionalString(event.data.message) ??
    "Agent lifecycle error.";
  clearAgentRuntimeIssuesForSession(event.sessionKey);
  recordAgentRuntimeIssue({
    runId: event.runId,
    code: classifyLifecycleError(message),
    severity: "error",
    message,
    sessionKey: event.sessionKey,
    livenessState,
    observedAt: event.ts,
  });
}

export function getAgentRuntimeIssues(opts?: { lane?: string }): AgentRuntimeIssue[] {
  const lane = normalizeOptionalString(opts?.lane);
  return Array.from(getAgentRuntimeHealthState().issuesByRunId.values())
    .filter((issue) => !lane || issue.lane === lane)
    .toSorted((left, right) => right.lastUpdatedAt - left.lastUpdatedAt);
}

export function resetAgentRuntimeHealthForTest(): void {
  getAgentRuntimeHealthState().issuesByRunId.clear();
}
