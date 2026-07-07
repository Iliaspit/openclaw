import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../test/helpers/import-fresh.js";
import {
  emitDiagnosticEvent,
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
} from "../infra/diagnostic-events.js";
import {
  diagnosticSessionStates,
  getDiagnosticSessionStateCountForTest,
  getDiagnosticSessionState,
  pruneDiagnosticSessionStates,
  resetDiagnosticSessionStateForTest,
} from "./diagnostic-session-state.js";
import { getDiagnosticStabilitySnapshot } from "./diagnostic-stability.js";
import {
  logSessionStateChange,
  resetDiagnosticStateForTest,
  resolveStuckSessionWarnMs,
  setDiagnosticSessionRuntimeResolverForTest,
  startDiagnosticHeartbeat,
} from "./diagnostic.js";

function createEmitMemorySampleMock() {
  return vi.fn(() => ({
    rssBytes: 100,
    heapTotalBytes: 80,
    heapUsedBytes: 40,
    externalBytes: 10,
    arrayBuffersBytes: 5,
  }));
}

describe("diagnostic session state pruning", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetDiagnosticSessionStateForTest();
  });

  afterEach(() => {
    resetDiagnosticSessionStateForTest();
    vi.useRealTimers();
  });

  it("evicts stale idle session states", () => {
    getDiagnosticSessionState({ sessionId: "stale-1" });
    expect(getDiagnosticSessionStateCountForTest()).toBe(1);

    vi.advanceTimersByTime(31 * 60 * 1000);
    getDiagnosticSessionState({ sessionId: "fresh-1" });

    expect(getDiagnosticSessionStateCountForTest()).toBe(1);
  });

  it("caps tracked session states to a bounded max", () => {
    const now = Date.now();
    for (let i = 0; i < 2001; i += 1) {
      diagnosticSessionStates.set(`session-${i}`, {
        sessionId: `session-${i}`,
        lastActivity: now + i,
        state: "idle",
        queueDepth: 1,
      });
    }
    pruneDiagnosticSessionStates(now + 2002, true);

    expect(getDiagnosticSessionStateCountForTest()).toBe(2000);
  });

  it("reuses keyed session state when later looked up by sessionId", () => {
    const keyed = getDiagnosticSessionState({
      sessionId: "s1",
      sessionKey: "agent:main:demo-channel:channel:c1",
    });
    const bySessionId = getDiagnosticSessionState({ sessionId: "s1" });

    expect(bySessionId).toBe(keyed);
    expect(bySessionId.sessionKey).toBe("agent:main:demo-channel:channel:c1");
    expect(getDiagnosticSessionStateCountForTest()).toBe(1);
  });
});

describe("logger import side effects", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("does not mkdir at import time", async () => {
    vi.useRealTimers();

    const mkdirSpy = vi.spyOn(fs, "mkdirSync");

    await importFreshModule<typeof import("./logger.js")>(
      import.meta.url,
      "./logger.js?scope=diagnostic-mkdir",
    );

    expect(mkdirSpy).not.toHaveBeenCalled();
  });
});

describe("stuck session diagnostics threshold", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetDiagnosticStateForTest();
    resetDiagnosticEventsForTest();
  });

  afterEach(() => {
    resetDiagnosticEventsForTest();
    resetDiagnosticStateForTest();
    vi.useRealTimers();
  });

  it("uses the configured diagnostics.stuckSessionWarnMs threshold", () => {
    const events: Array<{ type: string }> = [];
    const unsubscribe = onDiagnosticEvent((event) => {
      events.push({ type: event.type });
    });
    try {
      startDiagnosticHeartbeat({
        diagnostics: {
          enabled: true,
          stuckSessionWarnMs: 30_000,
        },
      });
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
      vi.advanceTimersByTime(61_000);
    } finally {
      unsubscribe();
    }

    expect(events.filter((event) => event.type === "session.stuck")).toHaveLength(1);
  });

  it("clears stale processing before stuck warnings when the durable session is terminal", () => {
    setDiagnosticSessionRuntimeResolverForTest(() => ({
      activeRun: false,
      queueActive: 0,
      queueQueued: 0,
      queueDepth: 0,
      sessionStatus: "done",
    }));
    const events: Array<{ type: string; state?: string; reason?: string }> = [];
    const unsubscribe = onDiagnosticEvent((event) => {
      if (event.type === "session.state" || event.type === "session.stuck") {
        events.push({
          type: event.type,
          state: event.state,
          reason: event.type === "session.state" ? event.reason : undefined,
        });
      }
    });
    try {
      startDiagnosticHeartbeat({
        diagnostics: {
          enabled: true,
          stuckSessionWarnMs: 30_000,
        },
      });
      logSessionStateChange({
        sessionId: "terminal-session",
        sessionKey: "agent:main:subagent:terminal",
        state: "processing",
      });
      vi.advanceTimersByTime(61_000);
    } finally {
      unsubscribe();
    }

    expect(events.filter((event) => event.type === "session.stuck")).toHaveLength(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.state",
        state: "idle",
        reason: "stale_reconciled_terminal",
      }),
    );
    expect(
      getDiagnosticSessionState({
        sessionId: "terminal-session",
        sessionKey: "agent:main:subagent:terminal",
      }).state,
    ).toBe("idle");
  });

  it("keeps processing while an active run exists even when the durable session is terminal", () => {
    setDiagnosticSessionRuntimeResolverForTest(() => ({
      activeRun: true,
      queueActive: 0,
      queueQueued: 0,
      queueDepth: 0,
      sessionStatus: "done",
    }));

    startDiagnosticHeartbeat({
      diagnostics: {
        enabled: true,
        stuckSessionWarnMs: 30_000,
      },
    });
    logSessionStateChange({
      sessionId: "active-terminal-session",
      sessionKey: "agent:main:subagent:active-terminal",
      state: "processing",
    });
    vi.advanceTimersByTime(30_000);

    expect(
      getDiagnosticSessionState({
        sessionId: "active-terminal-session",
        sessionKey: "agent:main:subagent:active-terminal",
      }).state,
    ).toBe("processing");
  });

  it("clears stale processing when no active run record remains and the runtime queue is empty", () => {
    setDiagnosticSessionRuntimeResolverForTest(() => ({
      activeRun: false,
      queueActive: 0,
      queueQueued: 0,
      queueDepth: 0,
    }));
    const events: Array<{ type: string; state?: string; reason?: string }> = [];
    const unsubscribe = onDiagnosticEvent((event) => {
      if (event.type === "session.state") {
        events.push({
          type: event.type,
          state: event.state,
          reason: event.reason,
        });
      }
    });
    try {
      startDiagnosticHeartbeat({
        diagnostics: {
          enabled: true,
          stuckSessionWarnMs: 30_000,
        },
      });
      logSessionStateChange({
        sessionId: "orphaned-session",
        sessionKey: "agent:main:subagent:orphaned",
        state: "processing",
      });
      vi.advanceTimersByTime(30_000);
    } finally {
      unsubscribe();
    }

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.state",
        state: "idle",
        reason: "stale_reconciled_no_active_run",
      }),
    );
    expect(
      getDiagnosticSessionState({
        sessionId: "orphaned-session",
        sessionKey: "agent:main:subagent:orphaned",
      }).state,
    ).toBe("idle");
  });

  it("keeps processing when the runtime queue still has work", () => {
    setDiagnosticSessionRuntimeResolverForTest(() => ({
      activeRun: false,
      queueActive: 1,
      queueQueued: 0,
      queueDepth: 1,
      sessionStatus: "done",
    }));

    startDiagnosticHeartbeat({
      diagnostics: {
        enabled: true,
        stuckSessionWarnMs: 30_000,
      },
    });
    logSessionStateChange({
      sessionId: "queued-session",
      sessionKey: "agent:main:subagent:queued",
      state: "processing",
    });
    vi.advanceTimersByTime(30_000);

    expect(
      getDiagnosticSessionState({
        sessionId: "queued-session",
        sessionKey: "agent:main:subagent:queued",
      }).state,
    ).toBe("processing");
  });

  it("does not clear session-key-only processing solely because no active run is known", () => {
    setDiagnosticSessionRuntimeResolverForTest(() => ({
      activeRun: false,
      queueActive: 0,
      queueQueued: 0,
      queueDepth: 0,
    }));

    startDiagnosticHeartbeat({
      diagnostics: {
        enabled: true,
        stuckSessionWarnMs: 30_000,
      },
    });
    logSessionStateChange({
      sessionKey: "agent:main:dispatch-only",
      state: "processing",
    });
    vi.advanceTimersByTime(30_000);

    expect(getDiagnosticSessionState({ sessionKey: "agent:main:dispatch-only" }).state).toBe(
      "processing",
    );
  });

  it("starts and stops the stability recorder with the heartbeat lifecycle", () => {
    startDiagnosticHeartbeat({
      diagnostics: {
        enabled: true,
      },
    });
    logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });

    expect(getDiagnosticStabilitySnapshot({ limit: 10 }).events).toContainEqual(
      expect.objectContaining({
        type: "session.state",
        outcome: "processing",
      }),
    );
    const [event] = getDiagnosticStabilitySnapshot({ limit: 10 }).events;
    expect(event).not.toHaveProperty("sessionId");
    expect(event).not.toHaveProperty("sessionKey");

    resetDiagnosticStateForTest();
    emitDiagnosticEvent({ type: "webhook.received", channel: "telegram" });

    expect(getDiagnosticStabilitySnapshot({ limit: 10 }).events).toEqual([]);
  });

  it("does not track session state when diagnostics are disabled", () => {
    const events: string[] = [];
    const unsubscribe = onDiagnosticEvent((event) => events.push(event.type));
    try {
      setDiagnosticsEnabledForProcess(false);
      logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
    } finally {
      unsubscribe();
    }

    expect(events).toEqual([]);
    expect(getDiagnosticSessionStateCountForTest()).toBe(0);
  });

  it("checks memory pressure every tick without recording idle samples", () => {
    const emitMemorySample = createEmitMemorySampleMock();

    startDiagnosticHeartbeat(
      {
        diagnostics: {
          enabled: true,
        },
      },
      { emitMemorySample },
    );

    vi.advanceTimersByTime(30_000);
    expect(emitMemorySample).toHaveBeenLastCalledWith({ emitSample: false });

    logSessionStateChange({ sessionId: "s1", sessionKey: "main", state: "processing" });
    vi.advanceTimersByTime(30_000);

    expect(emitMemorySample).toHaveBeenLastCalledWith({ emitSample: true });
  });

  it("does not start the heartbeat when diagnostics are disabled by config", () => {
    const emitMemorySample = createEmitMemorySampleMock();

    startDiagnosticHeartbeat(
      {
        diagnostics: {
          enabled: false,
        },
      },
      { emitMemorySample },
    );
    vi.advanceTimersByTime(30_000);

    expect(emitMemorySample).not.toHaveBeenCalled();
  });

  it("falls back to default threshold when config is absent", () => {
    const events: Array<{ type: string }> = [];
    const unsubscribe = onDiagnosticEvent((event) => {
      events.push({ type: event.type });
    });
    try {
      startDiagnosticHeartbeat();
      logSessionStateChange({ sessionId: "s2", sessionKey: "main", state: "processing" });
      vi.advanceTimersByTime(31_000);
    } finally {
      unsubscribe();
    }

    expect(events.filter((event) => event.type === "session.stuck")).toHaveLength(0);
  });

  it("uses default threshold for invalid values", () => {
    expect(resolveStuckSessionWarnMs({ diagnostics: { stuckSessionWarnMs: -1 } })).toBe(120_000);
    expect(resolveStuckSessionWarnMs({ diagnostics: { stuckSessionWarnMs: 0 } })).toBe(120_000);
    expect(resolveStuckSessionWarnMs()).toBe(120_000);
  });
});
