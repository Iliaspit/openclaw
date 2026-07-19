import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifySubagentModelCompletion,
  finalizeFrozenResultText,
  reconcileOrphanedRun,
} from "./subagent-registry-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function createRunEntry(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "run-1",
    childSessionKey: "agent:main:subagent:child",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "finish the task",
    cleanup: "keep",
    retainAttachmentsOnKeep: true,
    createdAt: 500,
    startedAt: 1_000,
    ...overrides,
  };
}

describe("reconcileOrphanedRun", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("preserves timing on orphaned error outcomes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(4_000);
    const entry = createRunEntry();
    const runs = new Map([[entry.runId, entry]]);
    const resumedRuns = new Set([entry.runId]);

    expect(
      reconcileOrphanedRun({
        runId: entry.runId,
        entry,
        reason: "missing-session-id",
        source: "resume",
        runs,
        resumedRuns,
      }),
    ).toBe(true);

    expect(entry.endedAt).toBe(4_000);
    expect(entry.outcome).toEqual({
      status: "error",
      error: "orphaned subagent run (missing-session-id)",
      startedAt: 1_000,
      endedAt: 4_000,
      elapsedMs: 3_000,
    });
    expect(runs.has(entry.runId)).toBe(false);
    expect(resumedRuns.has(entry.runId)).toBe(false);
  });
});

describe("frozen subagent result finalization", () => {
  it.each([
    ["stop", "complete"],
    ["end_turn", "complete"],
    ["length", "truncated"],
    ["max_tokens", "truncated"],
    [undefined, "unknown"],
    ["unrecognized", "unknown"],
  ] as const)("classifies %s as %s", (stopReason, expected) => {
    expect(classifySubagentModelCompletion(stopReason)).toBe(expected);
  });

  it("reserves both notices inside the UTF-8 100KB cap and is duplicate-safe", () => {
    const original = "🦞".repeat(30 * 1024);
    const finalized = finalizeFrozenResultText({
      resultText: original,
      rawCompletionStopReason: "max_tokens",
    });

    expect(finalized.modelCompletion).toBe("truncated");
    expect(finalized.runtimeCapped).toBe(true);
    expect(finalized.originalBytes).toBe(Buffer.byteLength(original, "utf8"));
    expect(finalized.resultText).toContain("[incomplete handoff: model output was truncated");
    expect(finalized.resultText).toContain(
      "[truncated: frozen completion output exceeded 100KB",
    );
    expect(Buffer.byteLength(finalized.resultText, "utf8")).toBeLessThanOrEqual(100 * 1024);
    expect(finalized.resultText.includes("�")).toBe(false);

    const duplicate = finalizeFrozenResultText({
      resultText: finalized.resultText,
      rawCompletionStopReason: "max_tokens",
      priorRuntimeCapped: finalized.runtimeCapped,
      originalBytes: finalized.originalBytes,
    });
    expect(duplicate).toEqual(finalized);
    expect(duplicate.resultText.match(/\[incomplete handoff:/g)).toHaveLength(1);
    expect(duplicate.resultText.match(/\[truncated: frozen completion/g)).toHaveLength(1);
  });
});
