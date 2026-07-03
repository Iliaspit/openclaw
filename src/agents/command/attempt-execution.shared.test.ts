import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentInternalEvent } from "../internal-events.js";
import type { SubagentRunRecord } from "../subagent-registry.types.js";
import { persistSubagentResultReceiptForRun } from "../subagent-result-receipts.js";
import { prependInternalEventContext } from "./attempt-execution.shared.js";

describe("attempt execution internal event context", () => {
  it("hydrates durable subagent receipts before rendering requester prompt context", async () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-receipt-prompt-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    try {
      const run: SubagentRunRecord = {
        runId: "run-prompt-receipt",
        childSessionKey: "agent:main:subagent:worker",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "worker task",
        cleanup: "delete",
        createdAt: 100,
        endedAt: 200,
        outcome: { status: "ok" },
        frozenResultText: "durable result visible to requester",
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
          taskLabel: run.task,
          status: "ok",
          statusLabel: "completed successfully",
          result: `Full child result is available in receipt ${run.resultReceiptId}.`,
          resultReceipt: persisted.receipt,
          replyInstruction: "Continue.",
        },
      ];

      const prompt = prependInternalEventContext("Parent follow-up", events);
      expect(prompt).toContain("durable result visible to requester");
      expect(prompt).not.toContain("Full child result is available in receipt");
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
