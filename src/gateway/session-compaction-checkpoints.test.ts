import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage, UserMessage } from "@mariozechner/pi-ai";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import { loadSessionStore } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  captureCompactionCheckpointSnapshot,
  cleanupCompactionCheckpointSnapshot,
  persistSessionCompactionCheckpoint,
} from "./session-compaction-checkpoints.js";
import {
  resolveFreshestSessionStoreMatchFromStoreKeys,
  resolveGatewaySessionStoreTarget,
} from "./session-utils.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("session-compaction-checkpoints", () => {
  test("capture stores the copied pre-compaction transcript path and cleanup removes only the copy", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-checkpoint-"));
    tempDirs.push(dir);

    const session = SessionManager.create(dir, dir);
    const userMessage: UserMessage = {
      role: "user",
      content: "before compaction",
      timestamp: Date.now(),
    };
    const assistantMessage: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "working on it" }],
      api: "responses",
      provider: "openai",
      model: "gpt-test",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    session.appendMessage(userMessage);
    session.appendMessage(assistantMessage);

    const sessionFile = session.getSessionFile();
    const leafId = session.getLeafId();
    expect(sessionFile).toBeTruthy();
    expect(leafId).toBeTruthy();

    const originalBefore = await fs.readFile(sessionFile!, "utf-8");
    const snapshot = captureCompactionCheckpointSnapshot({
      sessionManager: session,
      sessionFile: sessionFile!,
    });

    expect(snapshot).not.toBeNull();
    expect(snapshot?.leafId).toBe(leafId);
    expect(snapshot?.sessionFile).not.toBe(sessionFile);
    expect(snapshot?.sessionFile).toContain(".checkpoint.");
    expect(fsSync.existsSync(snapshot!.sessionFile)).toBe(true);
    expect(await fs.readFile(snapshot!.sessionFile, "utf-8")).toBe(originalBefore);

    session.appendCompaction("checkpoint summary", leafId!, 123, { ok: true });

    expect(await fs.readFile(snapshot!.sessionFile, "utf-8")).toBe(originalBefore);
    expect(await fs.readFile(sessionFile!, "utf-8")).not.toBe(originalBefore);

    await cleanupCompactionCheckpointSnapshot(snapshot);

    expect(fsSync.existsSync(snapshot!.sessionFile)).toBe(false);
    expect(fsSync.existsSync(sessionFile!)).toBe(true);
  });

  test("persist raises checkpoint high-water without preserving a stale paired context window", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-checkpoint-store-"));
    tempDirs.push(dir);

    const sessionKey = "agent:main:explicit:checkpoint-high-water";
    const sessionId = "checkpoint-high-water-session";
    const cfg = {
      session: {
        store: path.join(dir, "agents", "{agentId}", "sessions", "sessions.json"),
        mainKey: "main",
      },
      agents: { list: [{ id: "main", default: true }] },
    } as OpenClawConfig;
    const target = resolveGatewaySessionStoreTarget({
      cfg,
      key: sessionKey,
    });
    await fs.mkdir(path.dirname(target.storePath), { recursive: true });
    await fs.writeFile(
      target.storePath,
      JSON.stringify(
        {
          [target.canonicalKey]: {
            sessionId,
            updatedAt: Date.now(),
            contextHighWaterTokens: 40_000,
            contextHighWaterContextTokens: 200_000,
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const checkpoint = await persistSessionCompactionCheckpoint({
      cfg,
      sessionKey,
      sessionId,
      reason: "manual",
      snapshot: {
        sessionId: "pre-compaction-session",
        sessionFile: path.join(dir, "pre-compaction.jsonl"),
        leafId: "pre-leaf",
      },
      tokensBefore: 120_000,
      tokensAfter: 12_000,
      createdAt: 2,
    });

    expect(checkpoint?.tokensBefore).toBe(120_000);

    const persistedStore = loadSessionStore(target.storePath, { skipCache: true });
    const persisted = resolveFreshestSessionStoreMatchFromStoreKeys(
      persistedStore,
      target.storeKeys,
    )?.entry;
    expect(persisted?.contextHighWaterTokens).toBe(120_000);
    expect(persisted?.contextHighWaterContextTokens).toBeUndefined();
    expect(persisted?.compactionCheckpoints?.[0]?.tokensBefore).toBe(120_000);
  });
});
