import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentInternalEvent } from "./internal-events.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import {
  applySubagentResultReceiptToRun,
  buildSubagentResultReceipt,
  hydrateAgentInternalEventResultReceiptsFromRuns,
  persistSubagentResultReceiptForRun,
  resolveSubagentResultReceiptsPath,
} from "./subagent-result-receipts.js";

describe("subagent result receipts", () => {
  it("hydrates required child results from matching subagent run records", () => {
    const receipt = buildSubagentResultReceipt({
      childSessionKey: "agent:main:subagent:worker",
      childRunId: "run-worker",
      resultText: "exact child output",
      capturedAt: 123,
    });
    const events: AgentInternalEvent[] = [
      {
        type: "task_completion",
        source: "subagent",
        childSessionKey: "agent:main:subagent:worker",
        childSessionId: "session-worker",
        announceType: "subagent task",
        taskLabel: "worker task",
        status: "ok",
        statusLabel: "completed successfully",
        result: `Full child result is available in receipt ${receipt.id}.`,
        resultReceipt: receipt,
        replyInstruction: "Continue.",
      },
    ];
    const run: SubagentRunRecord = {
      runId: "run-worker",
      childSessionKey: "agent:main:subagent:worker",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "worker task",
      cleanup: "keep",
      createdAt: 100,
      frozenResultText: "exact child output",
      resultReceiptId: receipt.id,
    };

    const hydrated = hydrateAgentInternalEventResultReceiptsFromRuns(
      events,
      new Map([[run.runId, run]]),
    );

    expect(hydrated?.[0]).toMatchObject({
      result: "exact child output",
      resultReceipt: {
        id: receipt.id,
        hydrated: true,
      },
    });
  });

  it("updates receipt metadata when a completed run result is refreshed", () => {
    const run: SubagentRunRecord = {
      runId: "run-refresh",
      childSessionKey: "agent:main:subagent:worker",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "worker task",
      cleanup: "keep",
      createdAt: 100,
      endedAt: 200,
      frozenResultText: "old child output",
      frozenResultCapturedAt: 201,
    };

    expect(applySubagentResultReceiptToRun(run)).toBe(true);
    const oldSha = run.resultReceiptSha256;
    const oldBytes = run.resultReceiptBytes;

    run.frozenResultText = "new child output with more detail";
    run.frozenResultCapturedAt = 300;

    expect(applySubagentResultReceiptToRun(run)).toBe(true);
    expect(run.resultReceiptBytes).toBe(
      Buffer.byteLength("new child output with more detail", "utf8"),
    );
    expect(run.resultReceiptBytes).not.toBe(oldBytes);
    expect(run.resultReceiptSha256).not.toBe(oldSha);
    expect(run.resultReceiptCapturedAt).toBe(300);
  });

  it("still records a terminal receipt when a run is cancelled or killed without frozen text", () => {
    const run: SubagentRunRecord = {
      runId: "run-cancelled",
      childSessionKey: "agent:main:subagent:worker",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "worker task",
      cleanup: "keep",
      createdAt: 100,
      endedAt: 200,
      frozenResultText: null,
      frozenResultCapturedAt: 250,
    };

    expect(applySubagentResultReceiptToRun(run)).toBe(true);
    expect(run).toMatchObject({
      resultReceiptId: expect.stringMatching(/^scr_/),
      resultReceiptBytes: 0,
      resultReceiptCapturedAt: 250,
    });
    expect(run.resultReceiptSha256).toBeUndefined();
  });

  it("hydrates a durable receipt after the run row is gone", async () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-result-receipts-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    try {
      const run: SubagentRunRecord = {
        runId: "run-durable",
        childSessionKey: "agent:main:subagent:worker",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "worker task",
        cleanup: "delete",
        createdAt: 100,
        endedAt: 200,
        outcome: { status: "ok" },
        frozenResultText: "durable child output",
        frozenResultCapturedAt: 250,
      };
      const persisted = await persistSubagentResultReceiptForRun(run);
      expect(persisted).toMatchObject({ ok: true });
      if (!persisted.ok) {
        throw new Error("expected persisted receipt");
      }

      const events: AgentInternalEvent[] = [
        {
          type: "task_completion",
          source: "subagent",
          childSessionKey: run.childSessionKey,
          childSessionId: "session-worker",
          announceType: "subagent task",
          taskLabel: "worker task",
          status: "ok",
          statusLabel: "completed successfully",
          result: `Full child result is available in receipt ${run.resultReceiptId}.`,
          resultReceipt: persisted.receipt,
          replyInstruction: "Continue.",
        },
      ];

      const hydrated = hydrateAgentInternalEventResultReceiptsFromRuns(events, new Map());
      expect(hydrated?.[0]).toMatchObject({
        result: "durable child output",
        resultReceipt: {
          id: run.resultReceiptId,
          hydrated: true,
        },
      });
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fs.rm(tempStateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("keeps multiple durable receipts written through the shared locked path", async () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-result-receipts-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    try {
      const first: SubagentRunRecord = {
        runId: "run-durable-a",
        childSessionKey: "agent:main:subagent:a",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "worker a",
        cleanup: "delete",
        createdAt: 100,
        endedAt: 200,
        outcome: { status: "ok" },
        frozenResultText: "durable child output a",
        frozenResultCapturedAt: 250,
      };
      const second: SubagentRunRecord = {
        runId: "run-durable-b",
        childSessionKey: "agent:main:subagent:b",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "worker b",
        cleanup: "delete",
        createdAt: 101,
        endedAt: 201,
        outcome: { status: "ok" },
        frozenResultText: "durable child output b",
        frozenResultCapturedAt: 251,
      };

      const [persistedFirst, persistedSecond] = await Promise.all([
        persistSubagentResultReceiptForRun(first),
        persistSubagentResultReceiptForRun(second),
      ]);
      expect(persistedFirst).toMatchObject({ ok: true });
      expect(persistedSecond).toMatchObject({ ok: true });
      if (!persistedFirst.ok || !persistedSecond.ok) {
        throw new Error("expected persisted receipts");
      }

      const persistedStore = JSON.parse(
        await fs.readFile(resolveSubagentResultReceiptsPath(), "utf8"),
      ) as { receipts?: Record<string, unknown> };
      expect(Object.keys(persistedStore.receipts ?? {}).toSorted()).toEqual(
        [persistedFirst.receipt.id, persistedSecond.receipt.id].toSorted(),
      );

      const events: AgentInternalEvent[] = [
        {
          type: "task_completion",
          source: "subagent",
          childSessionKey: first.childSessionKey,
          childSessionId: "session-worker-a",
          announceType: "subagent task",
          taskLabel: first.task,
          status: "ok",
          statusLabel: "completed successfully",
          result: `Full child result is available in receipt ${first.resultReceiptId}.`,
          resultReceipt: persistedFirst.receipt,
          replyInstruction: "Continue.",
        },
        {
          type: "task_completion",
          source: "subagent",
          childSessionKey: second.childSessionKey,
          childSessionId: "session-worker-b",
          announceType: "subagent task",
          taskLabel: second.task,
          status: "ok",
          statusLabel: "completed successfully",
          result: `Full child result is available in receipt ${second.resultReceiptId}.`,
          resultReceipt: persistedSecond.receipt,
          replyInstruction: "Continue.",
        },
      ];

      const hydrated = hydrateAgentInternalEventResultReceiptsFromRuns(events, new Map());
      expect(hydrated?.map((event) => event.result)).toEqual([
        "durable child output a",
        "durable child output b",
      ]);
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fs.rm(tempStateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
