import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelMessagingAdapter } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  addSubagentRunForTests,
  getLatestSubagentRunByChildSessionKey,
  resetSubagentRegistryForTests,
} from "./subagent-registry.js";

const callGatewayMock = vi.fn();
const hookRunnerState = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));
vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("../plugins/hook-runner-global.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/hook-runner-global.js")>(
    "../plugins/hook-runner-global.js",
  );
  return {
    ...actual,
    getGlobalHookRunner: () => hookRunnerState.current,
  };
});

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    loadConfig: () => ({
      session: {
        mainKey: "main",
        scope: "per-sender",
        agentToAgent: { maxPingPongTurns: 2 },
      },
      tools: {
        // Keep sessions tools permissive in this suite; dedicated visibility tests cover defaults.
        sessions: { visibility: "all" },
        agentToAgent: { enabled: true },
      },
    }),
    resolveGatewayPort: () => 18789,
  };
});

import "./test-helpers/fast-openclaw-tools-sessions.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import {
  resolveChildRouteDeliveryAttemptsPath,
  withChildRouteDeliveryAttemptsStateDirForTest,
} from "./child-route-delivery-attempts.js";
import {
  recordChildRouteContextHeadroomSnapshot,
  recordChildRouteHealthEvent,
  resetChildRouteHealthForTest,
  withChildRouteHealthStateDirForTest,
} from "./child-route-health.js";
import { __testing as agentStepTesting } from "./tools/agent-step.js";
import { createSessionsHistoryTool } from "./tools/sessions-history-tool.js";
import { createSessionsListTool } from "./tools/sessions-list-tool.js";
import { __testing as sessionsResolutionTesting } from "./tools/sessions-resolution.js";
import { __testing as sessionsSendA2ATesting } from "./tools/sessions-send-tool.a2a.js";
import {
  __testing as sessionsSendTesting,
  createSessionsSendTool,
} from "./tools/sessions-send-tool.js";

const TEST_CONFIG = {
  session: {
    mainKey: "main",
    scope: "per-sender",
    agentToAgent: { maxPingPongTurns: 2 },
  },
  tools: {
    sessions: { visibility: "all" },
    agentToAgent: { enabled: true },
  },
} as OpenClawConfig;

const resolveSessionConversationStub: NonNullable<
  ChannelMessagingAdapter["resolveSessionConversation"]
> = ({ rawId }) => ({
  id: rawId,
});
const resolveSessionTargetStub: NonNullable<ChannelMessagingAdapter["resolveSessionTarget"]> = ({
  kind,
  id,
  threadId,
}) => (threadId ? `${kind}:${id}:thread:${threadId}` : `${kind}:${id}`);

function installMessagingTestRegistry() {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "discord",
        source: "test",
        plugin: {
          id: "discord",
          meta: {
            id: "discord",
            label: "Discord",
            selectionLabel: "Discord",
            docsPath: "/channels/discord",
            blurb: "Discord test stub.",
          },
          capabilities: { chatTypes: ["direct", "channel", "thread"] },
          messaging: {
            resolveSessionConversation: resolveSessionConversationStub,
            resolveSessionTarget: resolveSessionTargetStub,
          },
          config: {
            listAccountIds: () => ["default"],
            resolveAccount: () => ({}),
          },
        },
      },
      {
        pluginId: "whatsapp",
        source: "test",
        plugin: {
          id: "whatsapp",
          meta: {
            id: "whatsapp",
            label: "WhatsApp",
            selectionLabel: "WhatsApp",
            docsPath: "/channels/whatsapp",
            blurb: "WhatsApp test stub.",
            preferSessionLookupForAnnounceTarget: true,
          },
          capabilities: { chatTypes: ["direct", "group"] },
          messaging: {
            resolveSessionConversation: resolveSessionConversationStub,
            resolveSessionTarget: resolveSessionTargetStub,
          },
          config: {
            listAccountIds: () => ["default"],
            resolveAccount: () => ({}),
          },
        },
      },
    ]),
  );
}

function createOpenClawTools(options?: {
  agentSessionKey?: string;
  agentChannel?: string;
  sandboxed?: boolean;
  config?: OpenClawConfig;
}) {
  const config = options?.config ?? TEST_CONFIG;
  const gatewayCall = (opts: unknown) => callGatewayMock(opts);
  return [
    createSessionsListTool({
      agentSessionKey: options?.agentSessionKey,
      sandboxed: options?.sandboxed,
      config,
      callGateway: gatewayCall,
    }),
    createSessionsHistoryTool({
      agentSessionKey: options?.agentSessionKey,
      sandboxed: options?.sandboxed,
      config,
      callGateway: gatewayCall,
    }),
    createSessionsSendTool({
      agentSessionKey: options?.agentSessionKey,
      agentChannel: options?.agentChannel as never,
      sandboxed: options?.sandboxed,
      config,
      callGateway: gatewayCall,
    }),
  ];
}

const waitForCalls = async (getCount: () => number, count: number, timeoutMs = 2000) => {
  await vi.waitFor(
    () => {
      expect(getCount()).toBeGreaterThanOrEqual(count);
    },
    { timeout: timeoutMs, interval: 5 },
  );
};

async function recordHealthyChildHeadroom(childSessionKey: string, runId: string) {
  await expect(
    recordChildRouteContextHeadroomSnapshot({
      childSessionKey,
      runId,
      estimatedPromptTokens: 10_000,
      modelContextLimitTokens: 100_000,
      headroomTokens: 90_000,
      headroomPercent: 90,
      estimateSource: "actual_request",
      lastCompactionStatus: "none",
    }),
  ).resolves.toEqual({ ok: true });
}

async function writeSessionToolStore(
  agentId: string,
  entries: Record<string, Record<string, unknown>>,
) {
  const storePath = resolveStorePath(TEST_CONFIG.session?.store, { agentId });
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
}

describe("sessions tools", () => {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  let tempStateDir: string | undefined;

  beforeEach(async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sessions-tools-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    resetSubagentRegistryForTests({ persist: false });
    resetChildRouteHealthForTest();
    sessionsSendTesting.resetFreshChildReroutesForTest();
    callGatewayMock.mockClear();
    installMessagingTestRegistry();
    agentStepTesting.setDepsForTest({
      callGateway: (opts: unknown) => callGatewayMock(opts),
    });
    sessionsResolutionTesting.setDepsForTest({
      callGateway: (opts: unknown) => callGatewayMock(opts),
    });
    sessionsSendA2ATesting.setDepsForTest({
      callGateway: (opts: unknown) => callGatewayMock(opts),
    });
    hookRunnerState.current = null;
  });

  async function withPinnedSessionToolState<T>(fn: () => Promise<T>): Promise<T> {
    if (!tempStateDir) {
      return await fn();
    }
    return await withChildRouteHealthStateDirForTest(tempStateDir, () =>
      withChildRouteDeliveryAttemptsStateDirForTest(tempStateDir!, fn),
    );
  }

  afterEach(async () => {
    resetSubagentRegistryForTests({ persist: false });
    resetChildRouteHealthForTest();
    sessionsSendTesting.resetFreshChildReroutesForTest();
    hookRunnerState.current = null;
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      tempStateDir = undefined;
    }
  });

  it("describes sessions_list as discovery/debugging instead of subagent closeout", () => {
    const tool = createOpenClawTools().find((candidate) => candidate.name === "sessions_list");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_list tool");
    }

    expect(tool.description).toContain("debugging/intervention");
    expect(tool.description).toContain("targeted sessions_history over broad session listings");
  });

  it("uses number (not integer) in tool schemas for Gemini compatibility", () => {
    const tools = createOpenClawTools();
    const byName = (name: string) => {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool).toBeDefined();
      if (!tool) {
        throw new Error(`missing ${name} tool`);
      }
      return tool;
    };

    const schemaProp = (toolName: string, prop: string) => {
      const tool = byName(toolName);
      const schema = tool.parameters as {
        anyOf?: unknown;
        oneOf?: unknown;
        properties?: Record<string, unknown>;
      };
      expect(schema.anyOf).toBeUndefined();
      expect(schema.oneOf).toBeUndefined();

      const properties = schema.properties ?? {};
      const value = properties[prop] as { type?: unknown } | undefined;
      expect(value).toBeDefined();
      if (!value) {
        throw new Error(`missing ${toolName} schema prop: ${prop}`);
      }
      return value;
    };

    expect(schemaProp("sessions_history", "limit").type).toBe("number");
    expect(schemaProp("sessions_list", "limit").type).toBe("number");
    expect(schemaProp("sessions_list", "activeMinutes").type).toBe("number");
    expect(schemaProp("sessions_list", "messageLimit").type).toBe("number");
    expect(schemaProp("sessions_send", "timeoutSeconds").type).toBe("number");
  });

  it("sessions_list filters kinds and includes messages", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            {
              key: "main",
              kind: "direct",
              sessionId: "s-main",
              updatedAt: 10,
              lastChannel: "whatsapp",
            },
            {
              key: "discord:group:dev",
              kind: "group",
              sessionId: "s-group",
              updatedAt: 11,
              channel: "discord",
              displayName: "discord:g-dev",
              status: "running",
              startedAt: 100,
              runtimeMs: 42,
              estimatedCostUsd: 0.0042,
              childSessions: ["agent:main:subagent:worker"],
            },
            {
              key: "agent:main:dashboard:child",
              kind: "direct",
              sessionId: "s-dashboard-child",
              updatedAt: 12,
              parentSessionKey: "agent:main:main",
            },
            {
              key: "agent:main:subagent:worker",
              kind: "direct",
              sessionId: "s-subagent-worker",
              updatedAt: 13,
              spawnedBy: "agent:main:main",
            },
            {
              key: "cron:job-1",
              kind: "direct",
              sessionId: "s-cron",
              updatedAt: 9,
            },
            { key: "global", kind: "global" },
            { key: "unknown", kind: "unknown" },
          ],
        };
      }
      if (request.method === "chat.history") {
        return {
          messages: [
            { role: "toolResult", content: [] },
            {
              role: "assistant",
              content: [{ type: "text", text: "hi" }],
            },
          ],
        };
      }
      return {};
    });

    const tool = createOpenClawTools().find((candidate) => candidate.name === "sessions_list");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_list tool");
    }

    const result = await tool.execute("call1", { messageLimit: 1 });
    const details = result.details as {
      sessions?: Array<{
        key?: string;
        channel?: string;
        spawnedBy?: string;
        status?: string;
        startedAt?: number;
        runtimeMs?: number;
        estimatedCostUsd?: number;
        childSessions?: string[];
        parentSessionKey?: string;
        messages?: Array<{ role?: string }>;
      }>;
    };
    expect(details.sessions).toHaveLength(5);
    const main = details.sessions?.find((s) => s.key === "main");
    expect(main?.channel).toBe("whatsapp");
    expect(main?.messages?.length).toBe(1);
    expect(main?.messages?.[0]?.role).toBe("assistant");

    const group = details.sessions?.find((s) => s.key === "discord:group:dev");
    expect(group?.status).toBe("running");
    expect(group?.startedAt).toBe(100);
    expect(group?.runtimeMs).toBe(42);
    expect(group?.estimatedCostUsd).toBe(0.0042);
    expect(group?.childSessions).toEqual(["agent:main:subagent:worker"]);

    const dashboardChild = details.sessions?.find((s) => s.key === "agent:main:dashboard:child");
    expect(dashboardChild?.parentSessionKey).toBe("agent:main:main");

    const subagentWorker = details.sessions?.find((s) => s.key === "agent:main:subagent:worker");
    expect(subagentWorker?.spawnedBy).toBe("agent:main:main");

    const cronOnly = await tool.execute("call2", { kinds: ["cron"] });
    const cronDetails = cronOnly.details as {
      sessions?: Array<Record<string, unknown>>;
    };
    expect(cronDetails.sessions).toHaveLength(1);
    expect(cronDetails.sessions?.[0]?.kind).toBe("cron");
  });

  it("sessions_list resolves transcriptPath from agent state dir for multi-store listings", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "(multiple)",
          sessions: [
            {
              key: "main",
              kind: "direct",
              sessionId: "sess-main",
              updatedAt: 12,
            },
          ],
        };
      }
      return {};
    });

    const tool = createOpenClawTools().find((candidate) => candidate.name === "sessions_list");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_list tool");
    }

    const result = await tool.execute("call2b", {});
    const details = result.details as {
      sessions?: Array<{
        key?: string;
        transcriptPath?: string;
      }>;
    };
    const main = details.sessions?.find((session) => session.key === "main");
    expect(typeof main?.transcriptPath).toBe("string");
    expect(main?.transcriptPath).not.toContain("(multiple)");
    expect(main?.transcriptPath).toContain(
      path.join("agents", "main", "sessions", "sess-main.jsonl"),
    );
  });

  it("sessions_history filters tool messages by default", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "chat.history") {
        return {
          messages: [
            { role: "toolResult", content: [] },
            { role: "assistant", content: [{ type: "text", text: "ok" }] },
          ],
        };
      }
      return {};
    });

    const tool = createOpenClawTools().find((candidate) => candidate.name === "sessions_history");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_history tool");
    }

    const result = await tool.execute("call3", { sessionKey: "main" });
    const details = result.details as { messages?: Array<{ role?: string }> };
    expect(details.messages).toHaveLength(1);
    expect(details.messages?.[0]?.role).toBe("assistant");

    const withTools = await tool.execute("call4", {
      sessionKey: "main",
      includeTools: true,
    });
    const withToolsDetails = withTools.details as { messages?: unknown[] };
    expect(withToolsDetails.messages).toHaveLength(2);
  });

  it("sessions_history caps oversized payloads and strips heavy fields", async () => {
    const oversized = Array.from({ length: 80 }, (_, idx) => ({
      role: "assistant",
      content: [
        {
          type: "text",
          text: `${String(idx)}:${"x".repeat(5000)}`,
        },
        {
          type: "thinking",
          thinking: "y".repeat(7000),
          thinkingSignature: "sig".repeat(4000),
        },
      ],
      details: {
        giant: "z".repeat(12000),
      },
      usage: {
        input: 1,
        output: 1,
      },
    }));
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "chat.history") {
        return { messages: oversized };
      }
      return {};
    });

    const tool = createOpenClawTools().find((candidate) => candidate.name === "sessions_history");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_history tool");
    }

    const result = await tool.execute("call4b", {
      sessionKey: "main",
      includeTools: true,
    });
    const details = result.details as {
      messages?: Array<Record<string, unknown>>;
      truncated?: boolean;
      droppedMessages?: boolean;
      contentTruncated?: boolean;
      contentRedacted?: boolean;
      bytes?: number;
    };
    expect(details.truncated).toBe(true);
    expect(details.droppedMessages).toBe(true);
    expect(details.contentTruncated).toBe(true);
    expect(details.contentRedacted).toBe(false);
    expect(typeof details.bytes).toBe("number");
    expect((details.bytes ?? 0) <= 80 * 1024).toBe(true);
    expect(details.messages && details.messages.length > 0).toBe(true);

    const first = details.messages?.[0] as
      | {
          details?: unknown;
          usage?: unknown;
          content?: Array<{
            type?: string;
            text?: string;
            thinking?: string;
            thinkingSignature?: string;
          }>;
        }
      | undefined;
    expect(first?.details).toBeUndefined();
    expect(first?.usage).toBeUndefined();
    const textBlock = first?.content?.find((block) => block.type === "text");
    expect(typeof textBlock?.text).toBe("string");
    expect((textBlock?.text ?? "").length <= 4015).toBe(true);
    const thinkingBlock = first?.content?.find((block) => block.type === "thinking");
    expect(thinkingBlock?.thinkingSignature).toBeUndefined();
  });

  it("sessions_history enforces a hard byte cap even when a single message is huge", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "ok" }],
              extra: "x".repeat(200_000),
            },
          ],
        };
      }
      return {};
    });

    const tool = createOpenClawTools().find((candidate) => candidate.name === "sessions_history");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_history tool");
    }

    const result = await tool.execute("call4c", {
      sessionKey: "main",
      includeTools: true,
    });
    const details = result.details as {
      messages?: Array<Record<string, unknown>>;
      truncated?: boolean;
      droppedMessages?: boolean;
      contentTruncated?: boolean;
      contentRedacted?: boolean;
      bytes?: number;
    };
    expect(details.truncated).toBe(true);
    expect(details.droppedMessages).toBe(true);
    expect(details.contentTruncated).toBe(false);
    expect(details.contentRedacted).toBe(false);
    expect(typeof details.bytes).toBe("number");
    expect((details.bytes ?? 0) <= 80 * 1024).toBe(true);
    expect(details.messages).toHaveLength(1);
    expect(details.messages?.[0]?.content).toContain(
      "[sessions_history omitted: message too large]",
    );
  });

  it("sessions_history sets contentRedacted when sensitive data is redacted", async () => {
    callGatewayMock.mockReset();
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [
                { type: "text", text: "Use sk-1234567890abcdef1234 to authenticate with the API." },
              ],
            },
          ],
        };
      }
      return {};
    });

    const tool = createOpenClawTools().find((candidate) => candidate.name === "sessions_history");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_history tool");
    }

    const result = await tool.execute("call-redact-1", { sessionKey: "main" });
    const details = result.details as {
      messages?: Array<Record<string, unknown>>;
      truncated?: boolean;
      contentTruncated?: boolean;
      contentRedacted?: boolean;
    };
    expect(details.contentRedacted).toBe(true);
    expect(details.contentTruncated).toBe(false);
    expect(details.truncated).toBe(false);
    const msg = details.messages?.[0] as { content?: Array<{ type?: string; text?: string }> };
    const textBlock = msg?.content?.find((b) => b.type === "text");
    expect(typeof textBlock?.text).toBe("string");
    expect(textBlock?.text).not.toContain("sk-1234567890abcdef1234");
  });

  it("sessions_history sets both contentRedacted and contentTruncated independently", async () => {
    callGatewayMock.mockReset();
    const longPrefix = "safe text ".repeat(420);
    const sensitiveText = `${longPrefix} sk-9876543210fedcba9876 end`;
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: sensitiveText }],
            },
          ],
        };
      }
      return {};
    });

    const tool = createOpenClawTools().find((candidate) => candidate.name === "sessions_history");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_history tool");
    }

    const result = await tool.execute("call-redact-2", { sessionKey: "main" });
    const details = result.details as {
      truncated?: boolean;
      contentTruncated?: boolean;
      contentRedacted?: boolean;
    };
    expect(details.contentRedacted).toBe(true);
    expect(details.contentTruncated).toBe(true);
    expect(details.truncated).toBe(true);
  });

  it("sessions_history resolves sessionId inputs", async () => {
    const sessionId = "sess-group";
    const targetKey = "agent:main:discord:channel:1457165743010611293";
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as {
        method?: string;
        params?: Record<string, unknown>;
      };
      if (request.method === "sessions.resolve") {
        return {
          key: targetKey,
        };
      }
      if (request.method === "chat.history") {
        return {
          messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
        };
      }
      return {};
    });

    const tool = createOpenClawTools().find((candidate) => candidate.name === "sessions_history");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_history tool");
    }

    const result = await tool.execute("call5", { sessionKey: sessionId });
    const details = result.details as { messages?: unknown[] };
    expect(details.messages).toHaveLength(1);
    const historyCall = callGatewayMock.mock.calls.find(
      (call) => (call[0] as { method?: string }).method === "chat.history",
    );
    expect(historyCall?.[0]).toMatchObject({
      method: "chat.history",
      params: { sessionKey: targetKey },
    });
  });

  it("sessions_history errors on missing sessionId", async () => {
    const sessionId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.resolve") {
        throw new Error("No session found");
      }
      return {};
    });

    const tool = createOpenClawTools().find((candidate) => candidate.name === "sessions_history");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_history tool");
    }

    const result = await tool.execute("call6", { sessionKey: sessionId });
    const details = result.details as { status?: string; error?: string };
    expect(details.status).toBe("error");
    expect(details.error).toMatch(/Session not found|No session found/);
  });

  it("sessions_send supports fire-and-forget and wait", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    let agentCallCount = 0;
    let _historyCallCount = 0;
    let sendCallCount = 0;
    let lastWaitedRunId: string | undefined;
    const replyByRunId = new Map<string, string>();
    const requesterKey = "discord:group:req";
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        agentCallCount += 1;
        const runId = `run-${agentCallCount}`;
        const params = request.params as { message?: string; sessionKey?: string } | undefined;
        const message = params?.message ?? "";
        let reply = "REPLY_SKIP";
        if (message === "ping" || message === "wait") {
          reply = "done";
        } else if (message === "Agent-to-agent announce step.") {
          reply = "ANNOUNCE_SKIP";
        } else if (params?.sessionKey === requesterKey) {
          reply = "pong";
        }
        replyByRunId.set(runId, reply);
        return {
          runId,
          status: "accepted",
          acceptedAt: 1234 + agentCallCount,
        };
      }
      if (request.method === "agent.wait") {
        const params = request.params as { runId?: string } | undefined;
        lastWaitedRunId = params?.runId;
        return { runId: params?.runId ?? "run-1", status: "ok" };
      }
      if (request.method === "chat.history") {
        _historyCallCount += 1;
        const text = (lastWaitedRunId && replyByRunId.get(lastWaitedRunId)) ?? "";
        return {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text,
                },
              ],
              timestamp: 20,
            },
          ],
        };
      }
      if (request.method === "send") {
        sendCallCount += 1;
        return { messageId: "m1" };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: requesterKey,
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const fire = await tool.execute("call5", {
      sessionKey: "main",
      message: "ping",
      timeoutSeconds: 0,
    });
    expect(fire.details).toMatchObject({
      status: "accepted",
      runId: "run-1",
      delivery: { status: "pending", mode: "announce" },
    });
    await waitForCalls(() => calls.filter((call) => call.method === "agent").length, 4);
    await waitForCalls(() => calls.filter((call) => call.method === "agent.wait").length, 4);
    await waitForCalls(() => calls.filter((call) => call.method === "chat.history").length, 4);

    const waitPromise = tool.execute("call6", {
      sessionKey: "main",
      message: "wait",
      timeoutSeconds: 1,
    });
    const waited = await waitPromise;
    expect(waited.details).toMatchObject({
      status: "ok",
      reply: "done",
      delivery: { status: "pending", mode: "announce" },
    });
    expect(typeof (waited.details as { runId?: string }).runId).toBe("string");
    await waitForCalls(() => calls.filter((call) => call.method === "agent").length, 8);
    await waitForCalls(() => calls.filter((call) => call.method === "agent.wait").length, 8);
    await waitForCalls(() => calls.filter((call) => call.method === "chat.history").length, 8);

    const agentCalls = calls.filter((call) => call.method === "agent");
    const waitCalls = calls.filter((call) => call.method === "agent.wait");
    const historyOnlyCalls = calls.filter((call) => call.method === "chat.history");
    expect(agentCalls).toHaveLength(8);
    for (const call of agentCalls) {
      expect(call.params).toMatchObject({
        channel: "webchat",
        inputProvenance: { kind: "inter_session" },
      });
      expect((call.params as { lane?: string }).lane).toMatch(/^nested(?::|$)/u);
    }
    expect(
      agentCalls.some(
        (call) =>
          typeof (call.params as { extraSystemPrompt?: string })?.extraSystemPrompt === "string" &&
          (call.params as { extraSystemPrompt?: string })?.extraSystemPrompt?.includes(
            "Agent-to-agent message context",
          ),
      ),
    ).toBe(true);
    expect(
      agentCalls.some(
        (call) =>
          typeof (call.params as { extraSystemPrompt?: string })?.extraSystemPrompt === "string" &&
          (call.params as { extraSystemPrompt?: string })?.extraSystemPrompt?.includes(
            "Agent-to-agent reply step",
          ),
      ),
    ).toBe(true);
    expect(
      agentCalls.some(
        (call) =>
          typeof (call.params as { extraSystemPrompt?: string })?.extraSystemPrompt === "string" &&
          (call.params as { extraSystemPrompt?: string })?.extraSystemPrompt?.includes(
            "contains no new information",
          ),
      ),
    ).toBe(true);
    expect(
      agentCalls.some(
        (call) =>
          typeof (call.params as { extraSystemPrompt?: string })?.extraSystemPrompt === "string" &&
          (call.params as { extraSystemPrompt?: string })?.extraSystemPrompt?.includes(
            "Agent-to-agent announce step",
          ),
      ),
    ).toBe(true);
    expect(
      agentCalls.some(
        (call) =>
          typeof (call.params as { extraSystemPrompt?: string })?.extraSystemPrompt === "string" &&
          (call.params as { extraSystemPrompt?: string })?.extraSystemPrompt?.includes(
            "no user-visible new information",
          ),
      ),
    ).toBe(true);
    expect(waitCalls).toHaveLength(8);
    expect(historyOnlyCalls).toHaveLength(9);
    expect(sendCallCount).toBe(0);
  });

  it("sessions_send keeps late announce flow alive after a synchronous timeout", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    let agentCallCount = 0;
    let runOneWaitCount = 0;
    let lastWaitedRunId: string | undefined;
    const runOneWaitTimeouts: number[] = [];
    const replyByRunId = new Map<string, string>();
    const requesterKey = "discord:group:req";
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      calls.push(request);
      if (request.method === "agent") {
        agentCallCount += 1;
        const runId = `run-${agentCallCount}`;
        const message = typeof request.params?.message === "string" ? request.params.message : "";
        replyByRunId.set(runId, message === "slow" ? "late done" : "ANNOUNCE_SKIP");
        return { runId, status: "accepted" };
      }
      if (request.method === "agent.wait") {
        const runId = typeof request.params?.runId === "string" ? request.params.runId : "";
        lastWaitedRunId = runId;
        if (runId === "run-1") {
          runOneWaitCount += 1;
          runOneWaitTimeouts.push(
            typeof request.params?.timeoutMs === "number" ? request.params.timeoutMs : 0,
          );
          return { runId, status: runOneWaitCount === 1 ? "timeout" : "ok" };
        }
        return { runId, status: "ok" };
      }
      if (request.method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: replyByRunId.get(lastWaitedRunId ?? "") ?? "" }],
              timestamp: 20,
            },
          ],
        };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: requesterKey,
      agentChannel: "discord",
      config: {
        ...TEST_CONFIG,
        session: {
          ...TEST_CONFIG.session,
          agentToAgent: { maxPingPongTurns: 0 },
        },
      },
    }).find((candidate) => candidate.name === "sessions_send");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-timeout-late-announce", {
      sessionKey: "main",
      message: "slow",
      timeoutSeconds: 1,
    });

    expect(result.details).toMatchObject({
      status: "timeout",
      runId: "run-1",
      delivery: { status: "pending", mode: "announce" },
    });
    await waitForCalls(
      () =>
        calls.filter(
          (call) =>
            call.method === "agent.wait" &&
            (call.params as { runId?: string } | undefined)?.runId === "run-1",
        ).length,
      2,
    );
    await waitForCalls(() => calls.filter((call) => call.method === "chat.history").length, 1);

    expect(runOneWaitTimeouts[0]).toBe(1_000);
    expect(runOneWaitTimeouts[1]).toBe(600_000);
  });

  it("sessions_send resolves sessionId inputs", async () => {
    const sessionId = "sess-send";
    const targetKey = "agent:main:discord:channel:123";
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as {
        method?: string;
        params?: Record<string, unknown>;
      };
      if (request.method === "sessions.resolve") {
        return { key: targetKey };
      }
      if (request.method === "agent") {
        return { runId: "run-1", acceptedAt: 123 };
      }
      if (request.method === "agent.wait") {
        return { status: "ok" };
      }
      if (request.method === "chat.history") {
        return { messages: [] };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: "main",
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call7", {
      sessionKey: sessionId,
      message: "ping",
      timeoutSeconds: 0,
    });
    const details = result.details as { status?: string };
    expect(details.status).toBe("accepted");
    const agentCall = callGatewayMock.mock.calls.find(
      (call) => (call[0] as { method?: string }).method === "agent",
    );
    expect(agentCall?.[0]).toMatchObject({
      method: "agent",
      params: { sessionKey: targetKey },
    });
  });

  it("sessions_send runs ping-pong then announces", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    let agentCallCount = 0;
    let lastWaitedRunId: string | undefined;
    const replyByRunId = new Map<string, string>();
    const requesterKey = "discord:group:req";
    const targetKey = "discord:group:target";
    let sendParams: { to?: string; channel?: string; message?: string } = {};
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        agentCallCount += 1;
        const runId = `run-${agentCallCount}`;
        const params = request.params as
          | {
              message?: string;
              sessionKey?: string;
              extraSystemPrompt?: string;
            }
          | undefined;
        let reply = "initial";
        if (params?.extraSystemPrompt?.includes("Agent-to-agent reply step")) {
          reply = params.sessionKey === requesterKey ? "pong-1" : "pong-2";
        }
        if (params?.extraSystemPrompt?.includes("Agent-to-agent announce step")) {
          reply = "announce now";
        }
        replyByRunId.set(runId, reply);
        return {
          runId,
          status: "accepted",
          acceptedAt: 2000 + agentCallCount,
        };
      }
      if (request.method === "agent.wait") {
        const params = request.params as { runId?: string } | undefined;
        lastWaitedRunId = params?.runId;
        return { runId: params?.runId ?? "run-1", status: "ok" };
      }
      if (request.method === "chat.history") {
        const text = (lastWaitedRunId && replyByRunId.get(lastWaitedRunId)) ?? "";
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text }],
              timestamp: 20,
            },
          ],
        };
      }
      if (request.method === "send") {
        const params = request.params as
          | { to?: string; channel?: string; message?: string }
          | undefined;
        sendParams = {
          to: params?.to,
          channel: params?.channel,
          message: params?.message,
        };
        return { messageId: "m-announce" };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: requesterKey,
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const waited = await tool.execute("call7", {
      sessionKey: targetKey,
      message: "ping",
      timeoutSeconds: 1,
    });
    expect(waited.details).toMatchObject({
      status: "ok",
      reply: "initial",
    });
    await vi.waitFor(
      () => {
        expect(calls.filter((call) => call.method === "agent")).toHaveLength(4);
      },
      { timeout: 2_000, interval: 5 },
    );

    const agentCalls = calls.filter((call) => call.method === "agent");
    expect(agentCalls).toHaveLength(4);
    for (const call of agentCalls) {
      expect(call.params).toMatchObject({
        channel: "webchat",
        inputProvenance: { kind: "inter_session" },
      });
      expect((call.params as { lane?: string }).lane).toMatch(/^nested(?::|$)/u);
    }

    const replySteps = calls.filter(
      (call) =>
        call.method === "agent" &&
        typeof (call.params as { extraSystemPrompt?: string })?.extraSystemPrompt === "string" &&
        (call.params as { extraSystemPrompt?: string })?.extraSystemPrompt?.includes(
          "Agent-to-agent reply step",
        ),
    );
    expect(replySteps).toHaveLength(2);
    expect(sendParams).toMatchObject({
      to: "group:target",
      channel: "discord",
      message: "announce now",
    });
  });

  it("sessions_send preserves threadId when announce target is hydrated via sessions.list", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    let agentCallCount = 0;
    let lastWaitedRunId: string | undefined;
    const replyByRunId = new Map<string, string>();
    const requesterKey = "discord:group:req";
    const targetKey = "agent:main:worker";
    let sendParams: {
      to?: string;
      channel?: string;
      accountId?: string;
      message?: string;
      threadId?: string;
    } = {};

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        agentCallCount += 1;
        const runId = `run-${agentCallCount}`;
        const params = request.params as
          | {
              sessionKey?: string;
              extraSystemPrompt?: string;
            }
          | undefined;
        let reply = "initial";
        if (params?.extraSystemPrompt?.includes("Agent-to-agent reply step")) {
          reply = params.sessionKey === requesterKey ? "pong-1" : "pong-2";
        }
        if (params?.extraSystemPrompt?.includes("Agent-to-agent announce step")) {
          reply = "announce now";
        }
        replyByRunId.set(runId, reply);
        return {
          runId,
          status: "accepted",
          acceptedAt: 3000 + agentCallCount,
        };
      }
      if (request.method === "agent.wait") {
        const params = request.params as { runId?: string } | undefined;
        lastWaitedRunId = params?.runId;
        return { runId: params?.runId ?? "run-1", status: "ok" };
      }
      if (request.method === "chat.history") {
        const text = (lastWaitedRunId && replyByRunId.get(lastWaitedRunId)) ?? "";
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text }],
              timestamp: 20,
            },
          ],
        };
      }
      if (request.method === "sessions.list") {
        return {
          sessions: [
            {
              key: targetKey,
              deliveryContext: {
                channel: "whatsapp",
                to: "123@g.us",
                accountId: "work",
                threadId: 99,
              },
            },
          ],
        };
      }
      if (request.method === "send") {
        const params = request.params as
          | {
              to?: string;
              channel?: string;
              accountId?: string;
              message?: string;
              threadId?: string;
            }
          | undefined;
        sendParams = {
          to: params?.to,
          channel: params?.channel,
          accountId: params?.accountId,
          message: params?.message,
          threadId: params?.threadId,
        };
        return { messageId: "m-threaded-announce" };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: requesterKey,
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const waited = await tool.execute("call-thread", {
      sessionKey: targetKey,
      message: "ping",
      timeoutSeconds: 1,
    });
    expect(waited.details).toMatchObject({
      status: "ok",
      reply: "initial",
    });
    await vi.waitFor(
      () => {
        expect(calls.filter((call) => call.method === "send")).toHaveLength(1);
      },
      { timeout: 2_000, interval: 5 },
    );

    expect(sendParams).toMatchObject({
      to: "123@g.us",
      channel: "whatsapp",
      accountId: "work",
      message: "announce now",
      threadId: "99",
    });
  });

  it("sessions_send routes finished controlled child sessions to tracked completion delivery", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    const requesterKey = "agent:main:main";
    const childKey = "agent:main:subagent:worker";
    addSubagentRunForTests({
      runId: "run-finished-child",
      childSessionKey: childKey,
      controllerSessionKey: requesterKey,
      requesterSessionKey: requesterKey,
      requesterDisplayKey: "main",
      task: "finished child task",
      cleanup: "keep",
      spawnMode: "session",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
      endedAt: Date.now() - 1_000,
      outcome: { status: "ok" },
      resultReceiptId: "receipt-finished-child",
    });
    await recordHealthyChildHeadroom(childKey, "run-finished-child");

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            { key: requesterKey, kind: "direct" },
            { key: childKey, kind: "direct", spawnedBy: requesterKey },
          ],
        };
      }
      if (request.method === "agent") {
        return { runId: "run-followup-child", status: "accepted" };
      }
      if (request.method === "agent.wait") {
        return { runId: "run-followup-child", status: "pending" };
      }
      if (request.method === "chat.history") {
        throw new Error("chat.history should not run for tracked child follow-up");
      }
      if (request.method === "send") {
        throw new Error("send should not run for tracked child follow-up");
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: requesterKey,
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-finished-child", {
      sessionKey: childKey,
      message: "continue with the next slice",
      timeoutSeconds: 0,
    });
    expect(result.details).toMatchObject({
      status: "accepted",
      runId: "run-followup-child",
      sessionKey: childKey,
      delivery: { status: "tracked", mode: "completion_event" },
      mode: "restart",
    });

    const agentCalls = calls.filter((call) => call.method === "agent");
    expect(agentCalls).toHaveLength(1);
    expect(agentCalls[0]?.params).toMatchObject({
      sessionKey: childKey,
      deliver: false,
      lane: "subagent",
    });
    expect(calls.some((call) => call.method === "chat.history")).toBe(false);
    expect(calls.some((call) => call.method === "send")).toBe(false);
  });

  it("sessions_send blocks substantial pinned-child reuse when headroom telemetry is missing", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    const requesterKey = "agent:main:main";
    const childKey = "agent:main:subagent:missing-headroom";
    addSubagentRunForTests({
      runId: "run-missing-headroom-child",
      childSessionKey: childKey,
      controllerSessionKey: requesterKey,
      requesterSessionKey: requesterKey,
      requesterDisplayKey: "main",
      task: "finished child task",
      cleanup: "keep",
      spawnMode: "session",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
      endedAt: Date.now() - 1_000,
      outcome: { status: "ok" },
      resultReceiptId: "receipt-missing-headroom-child",
    });

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        throw new Error("substantial pinned-child reuse must preflight before restart");
      }
      if (request.method === "send") {
        throw new Error("substantial pinned-child reuse must not fall through to send");
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: requesterKey,
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-missing-headroom-child", {
      sessionKey: childKey,
      message: "continue with the next implementation slice",
      timeoutSeconds: 0,
      assignmentKind: "implementation",
    });

    expect(result.details).toMatchObject({
      ok: false,
      status: "no_delivery",
      code: "child_route_assignment_unavailable",
      details: {
        kind: "child_route_assignment_preflight",
        assignmentKind: "implementation",
        status: "unavailable",
        reason: "context_headroom",
      },
      delivery: { status: "rejected", mode: "child_route_preflight" },
    });
    expect(calls.some((call) => call.method === "agent")).toBe(false);
    expect(calls.some((call) => call.method === "send")).toBe(false);
  });

  it("sessions_send allows healthy small clarification reuse without a headroom decision", async () => {
    const calls: Array<{ method?: string; params?: Record<string, unknown> }> = [];
    const requesterKey = "agent:main:main";
    const childKey = "agent:main:subagent:clarification";
    addSubagentRunForTests({
      runId: "run-clarification-child",
      childSessionKey: childKey,
      controllerSessionKey: requesterKey,
      requesterSessionKey: requesterKey,
      requesterDisplayKey: "main",
      task: "finished child task",
      cleanup: "keep",
      spawnMode: "session",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
      endedAt: Date.now() - 1_000,
      outcome: { status: "ok" },
      resultReceiptId: "receipt-clarification-child",
    });

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      calls.push(request);
      if (request.method === "agent") {
        return { runId: "run-clarification-followup", status: "accepted" };
      }
      if (request.method === "agent.wait") {
        return { runId: "run-clarification-followup", status: "pending" };
      }
      if (request.method === "send") {
        throw new Error("healthy controlled child should use tracked restart");
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: requesterKey,
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-small-clarification-child", {
      sessionKey: childKey,
      message: "Can you clarify the final file list?",
      timeoutSeconds: 0,
      assignmentKind: "small_clarification",
    });

    expect(result.details).toMatchObject({
      status: "accepted",
      runId: "run-clarification-followup",
      sessionKey: childKey,
      delivery: { status: "tracked", mode: "completion_event" },
      mode: "restart",
    });
    expect(calls.filter((call) => call.method === "agent")).toHaveLength(1);
  });

  it("sessions_send spawns a fresh child when assignment preflight rejects a no-final old generation", async () => {
    const calls: Array<{ method?: string; params?: Record<string, unknown> }> = [];
    const requesterKey = "agent:main:main";
    const oldChildKey = "agent:main:subagent:preflight-lifecycle";
    let freshChildKey = "";
    addSubagentRunForTests({
      runId: "run-preflight-lifecycle-old",
      childSessionKey: oldChildKey,
      controllerSessionKey: requesterKey,
      requesterSessionKey: requesterKey,
      requesterDisplayKey: "main",
      task: "finish lifecycle preflight task",
      cleanup: "keep",
      label: "reviewer",
      spawnMode: "run",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
      endedAt: Date.now() - 1_000,
      outcome: { status: "ok" },
    });

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      calls.push(request);
      if (request.method === "sessions.patch") {
        freshChildKey =
          typeof request.params?.key === "string" ? request.params.key : freshChildKey;
        return {};
      }
      if (request.method === "agent") {
        if (request.params?.sessionKey === oldChildKey) {
          throw new Error("preflight reroute must not restart the old child");
        }
        if (request.params?.message === "Agent-to-agent announce step.") {
          throw new Error("preflight reroute must not use announce delivery");
        }
        freshChildKey =
          typeof request.params?.sessionKey === "string"
            ? request.params.sessionKey
            : freshChildKey;
        return { runId: "run-preflight-lifecycle-fresh", status: "accepted" };
      }
      if (request.method === "agent.wait") {
        if (request.params?.runId === "run-preflight-lifecycle-old") {
          throw new Error("preflight reroute must wait on the fresh child");
        }
        return { runId: request.params?.runId, status: "ok" };
      }
      if (request.method === "chat.history") {
        if (request.params?.sessionKey === oldChildKey) {
          throw new Error("preflight reroute must not read old child history");
        }
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "fresh lifecycle child finished" }],
              timestamp: 20,
            },
          ],
        };
      }
      if (request.method === "send") {
        throw new Error("preflight reroute must not fall through to send delivery");
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: requesterKey,
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-preflight-lifecycle-reroute", {
      sessionKey: oldChildKey,
      message: "continue with bounded fresh context",
      timeoutSeconds: 1,
      assignmentKind: "review",
      handoff: {
        originalTask: "finish lifecycle preflight task",
        currentNextStep: "continue with bounded fresh context",
      },
    });

    expect(result.details).toMatchObject({
      status: "ok",
      runId: "run-preflight-lifecycle-fresh",
      reply: "fresh lifecycle child finished",
      sessionKey: freshChildKey,
      delivery: { status: "tracked", mode: "completion_event" },
      reroute: {
        status: "fresh_child_spawned",
        rejectedOldChild: {
          childSessionKey: oldChildKey,
          deliveryAttemptId: expect.stringMatching(/^child_route_preflight:/),
          generation: "run-preflight-lifecycle-old",
        },
        freshChild: {
          role: "main",
          runId: "run-preflight-lifecycle-fresh",
        },
      },
    });
    expect(freshChildKey).toMatch(/^agent:main:subagent:/);
    expect(freshChildKey).not.toBe(oldChildKey);
    expect(
      calls.filter(
        (call) =>
          call.method === "agent" &&
          call.params?.lane === "subagent" &&
          call.params.bootstrapContextMode === "lightweight",
      ),
    ).toHaveLength(1);
    const rawTaskMessage = calls.find((call) => call.method === "agent")?.params?.message;
    const taskMessage = typeof rawTaskMessage === "string" ? rawTaskMessage : "";
    expect(taskMessage).toContain("agent_lifecycle_abandoned");
    expect(taskMessage).toContain("child_route_preflight");
    expect(getLatestSubagentRunByChildSessionKey(oldChildKey)?.suppressAnnounceReason).toBe(
      "fresh-reroute",
    );
    expect(getLatestSubagentRunByChildSessionKey(freshChildKey)?.resultReceiptId).toMatch(/^scr_/);
  });

  it("sessions_send does not suppress an old generation when assignment preflight reroute lacks handoff", async () => {
    const calls: Array<{ method?: string; params?: Record<string, unknown> }> = [];
    const requesterKey = "agent:main:main";
    const oldChildKey = "agent:main:subagent:preflight-missing-handoff";
    addSubagentRunForTests({
      runId: "run-preflight-missing-handoff-old",
      childSessionKey: oldChildKey,
      controllerSessionKey: requesterKey,
      requesterSessionKey: requesterKey,
      requesterDisplayKey: "main",
      task: "finish missing handoff preflight task",
      cleanup: "keep",
      label: "reviewer",
      spawnMode: "run",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
      endedAt: Date.now() - 1_000,
      outcome: { status: "ok" },
    });

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      calls.push(request);
      if (request.method === "agent") {
        throw new Error("preflight missing handoff must stop before spawning");
      }
      if (request.method === "send") {
        throw new Error("preflight missing handoff must not fall through to send");
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: requesterKey,
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-preflight-missing-handoff-reroute", {
      sessionKey: oldChildKey,
      message: "continue with bounded fresh context",
      timeoutSeconds: 0,
      assignmentKind: "review",
    });

    expect(result.details).toMatchObject({
      ok: false,
      status: "no_delivery",
      delivery: { status: "rejected", mode: "child_route_preflight" },
      reroute: {
        status: "handoff_required",
      },
    });
    expect(calls.some((call) => call.method === "agent")).toBe(false);
    expect(
      getLatestSubagentRunByChildSessionKey(oldChildKey)?.suppressAnnounceReason,
    ).toBeUndefined();
  });

  it("sessions_send spawns a fresh child when assignment preflight sees hard low headroom", async () => {
    const calls: Array<{ method?: string; params?: Record<string, unknown> }> = [];
    const requesterKey = "agent:main:main";
    const oldChildKey = "agent:main:subagent:preflight-headroom";
    let freshChildKey = "";
    addSubagentRunForTests({
      runId: "run-preflight-headroom-old",
      childSessionKey: oldChildKey,
      controllerSessionKey: requesterKey,
      requesterSessionKey: requesterKey,
      requesterDisplayKey: "main",
      task: "finish headroom preflight task",
      cleanup: "keep",
      label: "implementer",
      spawnMode: "run",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
      endedAt: Date.now() - 1_000,
      outcome: { status: "ok" },
      resultReceiptId: "receipt-preflight-headroom-old",
    });
    await recordChildRouteContextHeadroomSnapshot({
      childSessionKey: oldChildKey,
      runId: "run-preflight-headroom-old",
      estimatedPromptTokens: 99_000,
      modelContextLimitTokens: 100_000,
      headroomTokens: 1_000,
      headroomPercent: 1,
      estimateSource: "actual_request",
      lastCompactionStatus: "none",
    });

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      calls.push(request);
      if (request.method === "sessions.patch") {
        freshChildKey =
          typeof request.params?.key === "string" ? request.params.key : freshChildKey;
        return {};
      }
      if (request.method === "agent") {
        if (request.params?.sessionKey === oldChildKey) {
          throw new Error("low-headroom preflight must not restart the old child");
        }
        freshChildKey =
          typeof request.params?.sessionKey === "string"
            ? request.params.sessionKey
            : freshChildKey;
        return { runId: "run-preflight-headroom-fresh", status: "accepted" };
      }
      if (request.method === "agent.wait") {
        return { runId: request.params?.runId, status: "ok" };
      }
      if (request.method === "chat.history") {
        if (request.params?.sessionKey === oldChildKey) {
          throw new Error("low-headroom preflight must not read old child history");
        }
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "fresh headroom child finished" }],
              timestamp: 20,
            },
          ],
        };
      }
      if (request.method === "send") {
        throw new Error("low-headroom preflight must not fall through to send delivery");
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: requesterKey,
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-preflight-headroom-reroute", {
      sessionKey: oldChildKey,
      message: "continue after low context headroom",
      timeoutSeconds: 1,
      assignmentKind: "implementation",
      handoff: {
        originalTask: "finish headroom preflight task",
        currentNextStep: "continue after low context headroom",
      },
    });

    expect(result.details).toMatchObject({
      status: "ok",
      runId: "run-preflight-headroom-fresh",
      reply: "fresh headroom child finished",
      sessionKey: freshChildKey,
      delivery: { status: "tracked", mode: "completion_event" },
      reroute: {
        status: "fresh_child_spawned",
        rejectedOldChild: {
          childSessionKey: oldChildKey,
          deliveryAttemptId: expect.stringMatching(/^child_route_preflight:/),
          generation: "run-preflight-headroom-old",
        },
        freshChild: {
          role: "main",
          runId: "run-preflight-headroom-fresh",
        },
      },
    });
    expect(freshChildKey).toMatch(/^agent:main:subagent:/);
    expect(freshChildKey).not.toBe(oldChildKey);
    const rawTaskMessage = calls.find((call) => call.method === "agent")?.params?.message;
    const taskMessage = typeof rawTaskMessage === "string" ? rawTaskMessage : "";
    expect(taskMessage).toContain("context_overflow");
    expect(taskMessage).toContain("child_route_preflight");
    expect(
      calls.filter(
        (call) =>
          call.method === "agent" &&
          call.params?.lane === "subagent" &&
          call.params.bootstrapContextMode === "lightweight",
      ),
    ).toHaveLength(1);
    expect(getLatestSubagentRunByChildSessionKey(oldChildKey)?.suppressAnnounceReason).toBe(
      "fresh-reroute",
    );
    expect(getLatestSubagentRunByChildSessionKey(freshChildKey)?.resultReceiptId).toMatch(/^scr_/);
  });

  it("sessions_send requires degradedContext before rerouting with missing cleaned-up attachments", async () => {
    const calls: Array<{ method?: string; params?: Record<string, unknown> }> = [];
    const requesterKey = "agent:main:main";
    const oldChildKey = "agent:main:subagent:missing-cleaned-attachments";
    const missingAttachmentsDir = path.join(tempStateDir ?? os.tmpdir(), "deleted-attachments");
    addSubagentRunForTests({
      runId: "run-missing-cleaned-attachments-old",
      childSessionKey: oldChildKey,
      controllerSessionKey: requesterKey,
      requesterSessionKey: requesterKey,
      requesterDisplayKey: "main",
      task: "finish missing attachment task",
      cleanup: "delete",
      label: "implementer",
      spawnMode: "run",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
      attachmentsDir: missingAttachmentsDir,
      retainAttachmentsOnKeep: false,
    });
    await recordChildRouteHealthEvent({
      code: "context_overflow",
      status: "active",
      source: "context_overflow",
      childSessionKey: oldChildKey,
      runId: "run-missing-cleaned-attachments-old",
    });

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      calls.push(request);
      if (request.method === "agent") {
        throw new Error("missing attachment reroute must stop before spawning");
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: requesterKey,
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-missing-cleaned-attachments", {
      sessionKey: oldChildKey,
      message: "continue without the deleted file",
      timeoutSeconds: 0,
      handoff: {
        originalTask: "finish missing attachment task",
        currentNextStep: "continue without the deleted file",
      },
    });

    expect(result.details).toMatchObject({
      ok: false,
      status: "no_delivery",
      delivery: { status: "rejected", mode: "child_route_guard" },
      reroute: {
        status: "attachment_degradation_required",
        attachments: {
          retainedAttachmentPolicy: "cleanup",
          attachmentRoots: expect.arrayContaining([
            expect.objectContaining({
              path: missingAttachmentsDir,
              available: false,
              retained: false,
            }),
          ]),
          attachmentReferences: expect.arrayContaining([
            expect.objectContaining({
              name: "(attachment directory)",
              available: false,
              rootPath: missingAttachmentsDir,
            }),
          ]),
        },
      },
    });
    expect(calls.some((call) => call.method === "agent")).toBe(false);
    expect(
      getLatestSubagentRunByChildSessionKey(oldChildKey)?.suppressAnnounceReason,
    ).toBeUndefined();
  });

  it("sessions_send spawns a fresh tracked child after spawn_fresh route-health rejection", async () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sessions-send-reroute-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const withRerouteState = async <T>(fn: () => Promise<T>): Promise<T> =>
      await withChildRouteHealthStateDirForTest(stateDir, () =>
        withChildRouteDeliveryAttemptsStateDirForTest(stateDir, fn),
      );
    resetChildRouteHealthForTest();
    const calls: Array<{ method?: string; params?: Record<string, unknown> }> = [];
    const requesterKey = "agent:implementer:main";
    const oldChildKey = "agent:implementer:subagent:old-slice";

    try {
      const runSubagentSpawning = vi.fn(async () => ({
        status: "ok" as const,
        threadBindingReady: true,
      }));
      hookRunnerState.current = {
        hasHooks: (hookName: string) => hookName === "subagent_spawning",
        runSubagentSpawning,
      };
      let freshSpawnStartCount = 0;
      const attachmentsRootDir = path.join(stateDir, "attachments");
      const attachmentsDir = path.join(attachmentsRootDir, "old-slice");
      const oldWorkspaceDir = path.join(stateDir, "workspaces", "old-slice");
      await fs.mkdir(attachmentsDir, { recursive: true });
      await fs.writeFile(path.join(attachmentsDir, "input.txt"), "retained input", "utf8");
      addSubagentRunForTests({
        runId: "run-old-implementer",
        childSessionKey: oldChildKey,
        controllerSessionKey: requesterKey,
        requesterSessionKey: requesterKey,
        requesterDisplayKey: requesterKey,
        task: "finish the unhealthy-child handoff implementation",
        cleanup: "keep",
        label: "implementer",
        spawnMode: "session",
        requesterOrigin: {
          channel: "discord",
          accountId: "acct-1",
          to: "channel-1",
          threadId: "thread-9",
        },
        createdAt: Date.now() - 5_000,
        startedAt: Date.now() - 4_000,
        attachmentsRootDir,
        attachmentsDir,
        retainAttachmentsOnKeep: true,
        workspaceDir: oldWorkspaceDir,
      });
      await withRerouteState(() =>
        recordChildRouteHealthEvent({
          code: "context_overflow",
          status: "active",
          source: "context_overflow",
          childSessionKey: oldChildKey,
          runId: "run-old-implementer",
        }),
      );
      await withRerouteState(() =>
        recordChildRouteHealthEvent({
          code: "auth_profile_session_expired",
          status: "active",
          source: "provider_error",
          provider: {
            providerId: "openai",
            authProfileKey: "other-profile",
          },
        }),
      );
      await writeSessionToolStore("implementer", {
        [oldChildKey]: {
          sessionId: "sess-old-slice",
          updatedAt: Date.now(),
          modelProvider: "openai",
          model: "gpt-5.4",
          authProfileOverride: "handoff-profile",
          authProfileOverrideSource: "user",
          thinkingLevel: "high",
          fastMode: true,
          reasoningLevel: "xhigh",
          verboseLevel: "detailed",
          traceLevel: "debug",
          elevatedLevel: "admin",
          execHost: "host",
          execSecurity: "workspace-write",
          execAsk: "never",
          execNode: "node-22",
          responseUsage: "full",
        },
      });
      await withRerouteState(() =>
        recordChildRouteHealthEvent({
          code: "auth_profile_session_expired",
          status: "active",
          source: "provider_error",
          provider: {
            providerId: "anthropic",
            authProfileKey: "other-profile",
          },
        }),
      );

      let freshChildKey = "";
      callGatewayMock.mockImplementation(async (opts: unknown) => {
        const request = opts as { method?: string; params?: Record<string, unknown> };
        calls.push(request);
        if (request.method === "sessions.patch") {
          const key = typeof request.params?.key === "string" ? request.params.key : "";
          if (key === oldChildKey) {
            throw new Error("old unhealthy child must not be patched or restarted");
          }
          freshChildKey = key;
          return {};
        }
        if (request.method === "agent") {
          const params = request.params ?? {};
          if (params.sessionKey === oldChildKey) {
            throw new Error("old unhealthy child must not receive follow-up work");
          }
          if (params.message === "Agent-to-agent announce step.") {
            throw new Error("fresh reroute must not start generic A2A announce delivery");
          }
          const isFreshSpawnStart =
            params.lane === "subagent" && params.bootstrapContextMode === "lightweight";
          if (!isFreshSpawnStart) {
            return { runId: "run-non-reroute-agent", status: "accepted" };
          }
          expect(getLatestSubagentRunByChildSessionKey(oldChildKey)?.suppressAnnounceReason).toBe(
            "fresh-reroute",
          );
          freshChildKey = typeof params.sessionKey === "string" ? params.sessionKey : freshChildKey;
          freshSpawnStartCount += 1;
          return {
            runId:
              freshSpawnStartCount === 1 ? "run-fresh-implementer" : "run-fresh-implementer-next",
            status: "accepted",
          };
        }
        if (request.method === "agent.wait") {
          if (request.params?.runId === "run-old-implementer") {
            throw new Error("parent must not wait for the old stale generation");
          }
          return { runId: request.params?.runId, status: "ok" };
        }
        if (request.method === "chat.history") {
          if (request.params?.sessionKey === oldChildKey) {
            throw new Error("parent must not read completion from the old stale generation");
          }
          return {
            messages: [
              {
                role: "assistant",
                content: [{ type: "text", text: "fresh child finished" }],
                timestamp: 20,
              },
            ],
          };
        }
        if (request.method === "send") {
          throw new Error("fresh reroute must not fall through to send delivery");
        }
        return {};
      });

      const tool = createOpenClawTools({
        agentSessionKey: requesterKey,
        agentChannel: "discord",
      }).find((candidate) => candidate.name === "sessions_send");
      expect(tool).toBeDefined();
      if (!tool) {
        throw new Error("missing sessions_send tool");
      }
      const freshSpawnAgentCalls = () =>
        calls.filter(
          (call) =>
            call.method === "agent" &&
            call.params?.lane === "subagent" &&
            call.params.bootstrapContextMode === "lightweight",
        );

      const missingHandoff = await withRerouteState(() =>
        tool.execute("call-spawn-fresh-reroute-missing-handoff", {
          sessionKey: oldChildKey,
          message: "continue with the next implementation slice",
          timeoutSeconds: 1,
        }),
      );
      expect(missingHandoff.details).toMatchObject({
        ok: false,
        status: "no_delivery",
        delivery: { status: "rejected", mode: "child_route_guard" },
        reroute: {
          status: "handoff_required",
        },
      });
      expect(freshSpawnAgentCalls()).toHaveLength(0);
      expect(
        getLatestSubagentRunByChildSessionKey(oldChildKey)?.suppressAnnounceReason,
      ).toBeUndefined();

      const result = await withRerouteState(() =>
        tool.execute("call-spawn-fresh-reroute", {
          sessionKey: oldChildKey,
          message: "continue with the next implementation slice",
          timeoutSeconds: 1,
          handoff: {
            originalTask: "finish the unhealthy-child handoff implementation",
            acceptanceCriteria: ["fresh child completes the next implementation slice"],
            constraints: ["Do not reuse the old child session."],
            findings: ["The previous child route was rejected for context_overflow."],
            currentNextStep: "continue with the next implementation slice",
            nonGoals: ["Do not ask the old child to summarize."],
            degradedContext: true,
          },
        }),
      );

      expect(result.details).toMatchObject({
        status: "ok",
        runId: "run-fresh-implementer",
        reply: "fresh child finished",
        delivery: { status: "tracked", mode: "completion_event" },
        reroute: {
          status: "fresh_child_spawned",
          rejectedOldChild: {
            childSessionKey: oldChildKey,
            generation: "run-old-implementer",
          },
          freshChild: {
            role: "implementer",
            runId: "run-fresh-implementer",
          },
        },
      });
      expect((result.details as { sessionKey?: string }).sessionKey).toBe(freshChildKey);
      expect(freshChildKey).toMatch(/^agent:implementer:subagent:/);
      expect(freshChildKey).not.toBe(oldChildKey);

      const agentCalls = freshSpawnAgentCalls();
      expect(agentCalls).toHaveLength(1);
      expect(runSubagentSpawning).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "session",
          requester: expect.objectContaining({
            accountId: "acct-1",
            channel: "discord",
            threadId: "thread-9",
            to: "channel-1",
          }),
          threadRequested: true,
        }),
        expect.objectContaining({
          requesterSessionKey: requesterKey,
        }),
      );
      expect(getLatestSubagentRunByChildSessionKey(oldChildKey)?.suppressAnnounceReason).toBe(
        "fresh-reroute",
      );
      expect(agentCalls[0]?.params).toMatchObject({
        sessionKey: freshChildKey,
        deliver: false,
        thinking: "high",
        lane: "subagent",
        bootstrapContextMode: "lightweight",
      });
      const runtimePatchCalls = calls.filter(
        (call) => call.method === "sessions.patch" && call.params?.key === freshChildKey,
      );
      expect(runtimePatchCalls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            params: expect.objectContaining({
              thinkingLevel: "high",
              fastMode: true,
              execNode: "node-22",
              responseUsage: "full",
              spawnedWorkspaceDir: oldWorkspaceDir,
            }),
          }),
        ]),
      );
      expect(runtimePatchCalls).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            params: expect.objectContaining({
              authProfileOverride: expect.anything(),
            }),
          }),
        ]),
      );
      for (const call of runtimePatchCalls) {
        const params = call.params ?? {};
        expect(params).not.toHaveProperty("reasoningLevel");
        expect(params).not.toHaveProperty("verboseLevel");
        expect(params).not.toHaveProperty("traceLevel");
        expect(params).not.toHaveProperty("elevatedLevel");
        expect(params).not.toHaveProperty("execHost");
        expect(params).not.toHaveProperty("execSecurity");
        expect(params).not.toHaveProperty("execAsk");
        expect(params).not.toHaveProperty("ttsAuto");
      }
      const freshStore = loadSessionStore(
        resolveStorePath(TEST_CONFIG.session?.store, {
          agentId: "implementer",
        }),
        {
          skipCache: true,
        },
      );
      expect(freshStore[freshChildKey]).toMatchObject({
        authProfileOverride: "handoff-profile",
        authProfileOverrideSource: "user",
      });
      expect(agentCalls[0]?.params).not.toHaveProperty("sessionId");
      expect(agentCalls[0]?.params).not.toHaveProperty("restartSessionId");
      const taskMessage =
        typeof agentCalls[0]?.params?.message === "string" ? agentCalls[0].params.message : "";
      expect(taskMessage).toContain("[Child handoff packet]");
      expect(taskMessage).toContain(oldChildKey);
      expect(taskMessage).toContain("context_overflow");
      expect(taskMessage).toContain("handoff-profile");
      expect(taskMessage).toContain("gpt-5.4");
      expect(taskMessage).toContain("thinking");
      expect(taskMessage).toContain("workspace-write");
      expect(taskMessage).toContain("retainedAttachmentPolicy");
      expect(taskMessage).toContain("input.txt");
      expect(getLatestSubagentRunByChildSessionKey(freshChildKey)?.resultReceiptId).toMatch(
        /^scr_/,
      );
      expect(getLatestSubagentRunByChildSessionKey(freshChildKey)?.workspaceDir).toBe(
        oldWorkspaceDir,
      );
      expect(calls.some((call) => call.method === "send")).toBe(false);
      const attemptsAfterFirstSpawn = await withRerouteState(
        async () =>
          JSON.parse(await fs.readFile(resolveChildRouteDeliveryAttemptsPath(), "utf8")) as {
            attempts?: Record<string, unknown>;
          },
      );
      expect(Object.keys(attemptsAfterFirstSpawn.attempts ?? {})).toHaveLength(1);

      const duplicate = await withRerouteState(() =>
        tool.execute("call-spawn-fresh-reroute-duplicate", {
          sessionKey: oldChildKey,
          message: "continue with the next implementation slice",
          timeoutSeconds: 0,
          handoff: {
            originalTask: "finish the unhealthy-child handoff implementation",
            currentNextStep: "continue with the next implementation slice",
            degradedContext: true,
          },
        }),
      );
      expect(duplicate.details).toMatchObject({
        status: "accepted",
        runId: "run-fresh-implementer",
        sessionKey: freshChildKey,
        mode: "session",
        delivery: { status: "tracked", mode: "completion_event" },
      });
      expect(freshSpawnAgentCalls()).toHaveLength(1);

      const duplicateWithChangedWording = await withRerouteState(() =>
        tool.execute("call-spawn-fresh-reroute-duplicate-changed-message", {
          sessionKey: oldChildKey,
          message: "please continue this implementation slice with the same feature goal",
          timeoutSeconds: 0,
          handoff: {
            originalTask: "finish the unhealthy-child handoff implementation",
            currentNextStep: "continue with the next implementation slice",
            degradedContext: true,
          },
        }),
      );
      expect(duplicateWithChangedWording.details).toMatchObject({
        status: "accepted",
        runId: "run-fresh-implementer",
        sessionKey: freshChildKey,
        mode: "session",
        delivery: { status: "tracked", mode: "completion_event" },
      });
      expect(freshSpawnAgentCalls()).toHaveLength(1);

      await withRerouteState(() =>
        recordChildRouteHealthEvent({
          code: "context_overflow",
          status: "success",
          source: "manual",
          childSessionKey: oldChildKey,
          runId: "run-old-implementer",
        }),
      );
      const afterLateOldSuccess = await withRerouteState(() =>
        tool.execute("call-spawn-fresh-reroute-after-old-success", {
          sessionKey: oldChildKey,
          message: "continue after the old child reported success late",
          timeoutSeconds: 0,
        }),
      );
      expect(afterLateOldSuccess.details).toMatchObject({
        status: "accepted",
        runId: "run-fresh-implementer",
        sessionKey: freshChildKey,
        mode: "session",
        delivery: { status: "tracked", mode: "completion_event" },
      });
      expect(freshSpawnAgentCalls()).toHaveLength(1);

      const firstFreshChildKey = freshChildKey;
      addSubagentRunForTests({
        runId: "run-old-implementer-next",
        childSessionKey: oldChildKey,
        controllerSessionKey: requesterKey,
        requesterSessionKey: requesterKey,
        requesterDisplayKey: requesterKey,
        task: "finish the unhealthy-child handoff implementation",
        cleanup: "keep",
        label: "implementer",
        spawnMode: "run",
        createdAt: Date.now(),
        startedAt: Date.now(),
      });
      await withRerouteState(() =>
        recordChildRouteHealthEvent({
          code: "context_overflow",
          status: "active",
          source: "context_overflow",
          childSessionKey: oldChildKey,
          runId: "run-old-implementer-next",
        }),
      );

      const nextGeneration = await withRerouteState(() =>
        tool.execute("call-spawn-fresh-reroute-next-generation", {
          sessionKey: oldChildKey,
          message: "continue with the next implementation slice",
          timeoutSeconds: 0,
          handoff: {
            originalTask: "finish the unhealthy-child handoff implementation",
            currentNextStep: "continue with the next implementation slice",
            degradedContext: true,
          },
        }),
      );
      expect(nextGeneration.details).toMatchObject({
        status: "accepted",
        runId: "run-fresh-implementer-next",
        delivery: { status: "tracked", mode: "completion_event" },
        reroute: {
          status: "fresh_child_spawned",
          rejectedOldChild: {
            childSessionKey: oldChildKey,
            generation: "run-old-implementer-next",
          },
        },
      });
      expect((nextGeneration.details as { sessionKey?: string }).sessionKey).toBe(freshChildKey);
      expect(freshChildKey).not.toBe(firstFreshChildKey);
      expect(freshSpawnAgentCalls()).toHaveLength(2);
    } finally {
      resetChildRouteHealthForTest();
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fs.rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      callGatewayMock.mockReset();
    }
  });

  it("sessions_send keeps fresh reroute run errors terminal for the same feature", async () => {
    const calls: Array<{ method?: string; params?: Record<string, unknown> }> = [];
    const requesterKey = "agent:implementer:main";
    const oldChildKey = "agent:implementer:subagent:fresh-error";
    addSubagentRunForTests({
      runId: "run-old-fresh-error",
      childSessionKey: oldChildKey,
      controllerSessionKey: requesterKey,
      requesterSessionKey: requesterKey,
      requesterDisplayKey: requesterKey,
      task: "finish the reroute error slice",
      cleanup: "keep",
      label: "implementer",
      spawnMode: "run",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    });
    await withPinnedSessionToolState(() =>
      recordChildRouteHealthEvent({
        code: "context_overflow",
        status: "active",
        source: "context_overflow",
        childSessionKey: oldChildKey,
        runId: "run-old-fresh-error",
      }),
    );
    await withPinnedSessionToolState(() =>
      recordChildRouteHealthEvent({
        code: "auth_profile_session_expired",
        status: "active",
        source: "provider_error",
        provider: {
          providerId: "openai",
          authProfileKey: "other-profile",
        },
      }),
    );
    await writeSessionToolStore("implementer", {
      [oldChildKey]: {
        sessionId: "sess-fresh-error",
        updatedAt: Date.now(),
        modelProvider: "openai",
        model: "gpt-5.4",
      },
    });

    let freshSpawnStartCount = 0;
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      calls.push(request);
      if (request.method === "sessions.patch") {
        return {};
      }
      if (request.method === "agent") {
        const params = request.params ?? {};
        if (params.sessionKey === oldChildKey) {
          throw new Error("old unhealthy child must not receive follow-up work");
        }
        freshSpawnStartCount += 1;
        return { runId: "run-fresh-error", status: "accepted" };
      }
      if (request.method === "agent.wait") {
        return { runId: request.params?.runId, status: "error", error: "fresh child failed" };
      }
      if (request.method === "send") {
        throw new Error("fresh error reroute must not fall through to send delivery");
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: requesterKey,
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const first = await withPinnedSessionToolState(() =>
      tool.execute("call-spawn-fresh-reroute-error", {
        sessionKey: oldChildKey,
        message: "continue with the error slice",
        timeoutSeconds: 1,
        handoff: {
          originalTask: "finish the reroute error slice",
          currentNextStep: "continue with the error slice",
        },
      }),
    );
    expect(first.details).toMatchObject({
      status: "error",
      runId: "run-fresh-error",
      error: "fresh child failed",
    });
    expect(freshSpawnStartCount).toBe(1);
    await withPinnedSessionToolState(() =>
      recordChildRouteHealthEvent({
        code: "agent_lifecycle_error",
        status: "active",
        source: "agent_lifecycle",
        childSessionKey: oldChildKey,
        runId: "run-old-fresh-error",
      }),
    );

    const second = await withPinnedSessionToolState(() =>
      tool.execute("call-spawn-fresh-reroute-error-again", {
        sessionKey: oldChildKey,
        message: "retry that same feature with slightly different wording",
        timeoutSeconds: 1,
        handoff: {
          originalTask: "finish the reroute error slice",
          currentNextStep: "retry the same feature",
        },
      }),
    );
    expect(second.details).toMatchObject({
      ok: false,
      status: "no_delivery",
      delivery: { status: "rejected", mode: "child_route_guard" },
      reroute: {
        status: "error",
        error: "fresh child failed",
        runId: "run-fresh-error",
      },
    });
    expect(freshSpawnStartCount).toBe(1);
    expect(calls.some((call) => call.method === "send")).toBe(false);
  });

  it("sessions_send blocks fresh reroute on provider default credential-source auth expiry", async () => {
    const calls: Array<{ method?: string; params?: Record<string, unknown> }> = [];
    const requesterKey = "agent:implementer:main";
    const oldChildKey = "agent:implementer:subagent:default-source-auth-blocked";
    addSubagentRunForTests({
      runId: "run-default-source-auth-blocked",
      childSessionKey: oldChildKey,
      controllerSessionKey: requesterKey,
      requesterSessionKey: requesterKey,
      requesterDisplayKey: requesterKey,
      task: "finish with default credential auth blocker present",
      cleanup: "keep",
      label: "implementer",
      spawnMode: "run",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    });
    await writeSessionToolStore("implementer", {
      [oldChildKey]: {
        sessionId: "sess-default-source-auth-blocked",
        updatedAt: Date.now(),
        modelProvider: "openai",
        model: "gpt-5.4",
      },
    });
    await recordChildRouteHealthEvent({
      code: "context_overflow",
      status: "active",
      source: "context_overflow",
      childSessionKey: oldChildKey,
      runId: "run-default-source-auth-blocked",
    });
    await recordChildRouteHealthEvent({
      code: "auth_profile_session_expired",
      status: "active",
      source: "provider_error",
      provider: {
        providerId: "openai",
        credentialSource: "env: OPENAI_API_KEY",
      },
    });

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      calls.push(request);
      if (request.method === "agent") {
        throw new Error("default-source-auth-blocked reroute must not spawn a fresh child");
      }
      if (request.method === "agent.wait") {
        throw new Error("default-source-auth-blocked reroute must not wait on old or fresh runs");
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: requesterKey,
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-default-source-auth-blocked-reroute", {
      sessionKey: oldChildKey,
      message: "continue with the next implementation slice",
      timeoutSeconds: 1,
      handoff: {
        originalTask: "finish with default credential auth blocker present",
        currentNextStep: "continue with the next implementation slice",
      },
    });

    expect(result.details).toMatchObject({
      ok: false,
      status: "no_delivery",
      code: "child_session_unhealthy",
      details: {
        kind: "child_route_unhealthy",
        codes: ["auth_profile_session_expired", "context_overflow"],
        recommendedAction: "reauth",
        stateTransitionRequired: true,
      },
      delivery: { status: "rejected", mode: "child_route_guard" },
    });
    expect(calls.some((call) => call.method === "agent")).toBe(false);
    expect(calls.some((call) => call.method === "agent.wait")).toBe(false);
    expect(calls.some((call) => call.method === "send")).toBe(false);
  });

  it("sessions_send does not apply unrelated auth blockers to the target route", async () => {
    const calls: Array<{ method?: string; params?: Record<string, unknown> }> = [];
    const requesterKey = "agent:implementer:main";
    const childKey = "agent:implementer:subagent:auth-unrelated";
    addSubagentRunForTests({
      runId: "run-auth-unrelated-implementer",
      childSessionKey: childKey,
      controllerSessionKey: requesterKey,
      requesterSessionKey: requesterKey,
      requesterDisplayKey: requesterKey,
      task: "answer a small clarification",
      cleanup: "keep",
      label: "implementer",
      spawnMode: "run",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    });
    await writeSessionToolStore("implementer", {
      [childKey]: {
        sessionId: "sess-auth-unrelated",
        updatedAt: Date.now(),
        modelProvider: "openai",
        model: "gpt-5.4",
        authProfileOverride: "target-profile",
        authProfileOverrideSource: "user",
      },
    });
    await recordChildRouteHealthEvent({
      code: "auth_profile_session_expired",
      status: "active",
      source: "provider_error",
      provider: {
        providerId: "openai",
        authProfileKey: "other-profile",
      },
    });

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      calls.push(request);
      if (request.method === "agent") {
        return { runId: "run-auth-unrelated-send" };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: requesterKey,
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-auth-unrelated", {
      sessionKey: childKey,
      message: "quick status?",
      timeoutSeconds: 0,
      assignmentKind: "small_clarification",
    });

    expect(result.details).toMatchObject({
      status: "accepted",
      runId: "run-auth-unrelated-send",
      sessionKey: childKey,
      delivery: { status: "tracked", mode: "completion_event" },
      mode: "restart",
    });
    expect(calls.some((call) => call.method === "agent")).toBe(true);
  });

  it("sessions_send does not deliver or spawn fresh while an auth route blocker is active", async () => {
    const calls: Array<{ method?: string; params?: Record<string, unknown> }> = [];
    const requesterKey = "agent:implementer:main";
    const oldChildKey = "agent:implementer:subagent:auth-blocked";
    addSubagentRunForTests({
      runId: "run-auth-blocked-implementer",
      childSessionKey: oldChildKey,
      controllerSessionKey: requesterKey,
      requesterSessionKey: requesterKey,
      requesterDisplayKey: requesterKey,
      task: "finish with auth blocker present",
      cleanup: "keep",
      label: "implementer",
      spawnMode: "run",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    });
    await writeSessionToolStore("implementer", {
      [oldChildKey]: {
        sessionId: "sess-auth-blocked",
        updatedAt: Date.now(),
        modelProvider: "openai",
        model: "gpt-5.4",
        authProfileOverride: "expired-profile",
        authProfileOverrideSource: "user",
      },
    });
    await recordChildRouteHealthEvent({
      code: "auth_profile_session_expired",
      status: "active",
      source: "provider_error",
      provider: {
        providerId: "openai",
        authProfileKey: "expired-profile",
      },
    });

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      calls.push(request);
      if (request.method === "agent") {
        throw new Error("auth-blocked reroute must not spawn a fresh child");
      }
      if (request.method === "agent.wait") {
        throw new Error("auth-blocked reroute must not wait on old or fresh runs");
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: requesterKey,
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-auth-blocked-reroute", {
      sessionKey: oldChildKey,
      message: "continue with the next implementation slice",
      timeoutSeconds: 1,
    });

    expect(result.details).toMatchObject({
      ok: false,
      status: "no_delivery",
      code: "child_session_unhealthy",
      details: {
        kind: "child_route_unhealthy",
        codes: ["auth_profile_session_expired"],
        recommendedAction: "reauth",
        stateTransitionRequired: true,
      },
      delivery: { status: "rejected", mode: "child_route_guard" },
    });
    expect(calls.some((call) => call.method === "agent")).toBe(false);
    expect(calls.some((call) => call.method === "agent.wait")).toBe(false);
    expect(calls.some((call) => call.method === "send")).toBe(false);
  });

  it("sessions_send blocks fresh reroute on source-scoped auth expiry from the same child run", async () => {
    const calls: Array<{ method?: string; params?: Record<string, unknown> }> = [];
    const requesterKey = "agent:implementer:main";
    const oldChildKey = "agent:implementer:subagent:source-auth-blocked";
    addSubagentRunForTests({
      runId: "run-source-auth-blocked",
      childSessionKey: oldChildKey,
      controllerSessionKey: requesterKey,
      requesterSessionKey: requesterKey,
      requesterDisplayKey: requesterKey,
      task: "finish with source auth blocker present",
      cleanup: "keep",
      label: "implementer",
      spawnMode: "run",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
    });
    await writeSessionToolStore("implementer", {
      [oldChildKey]: {
        sessionId: "sess-source-auth-blocked",
        updatedAt: Date.now(),
        modelProvider: "openai",
        model: "gpt-5.4",
      },
    });
    await recordChildRouteHealthEvent({
      code: "context_overflow",
      status: "active",
      source: "context_overflow",
      childSessionKey: oldChildKey,
      runId: "run-source-auth-blocked",
    });
    await recordChildRouteHealthEvent({
      code: "auth_profile_session_expired",
      status: "active",
      source: "provider_error",
      childSessionKey: oldChildKey,
      runId: "run-source-auth-blocked",
      provider: {
        providerId: "openai",
        modelId: "gpt-5.4",
        credentialSource: "env: OPENAI_API_KEY",
      },
    });

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      calls.push(request);
      if (request.method === "agent") {
        throw new Error("source-auth-blocked reroute must not spawn a fresh child");
      }
      if (request.method === "agent.wait") {
        throw new Error("source-auth-blocked reroute must not wait on old or fresh runs");
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: requesterKey,
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-source-auth-blocked-reroute", {
      sessionKey: oldChildKey,
      message: "continue with the next implementation slice",
      timeoutSeconds: 1,
      handoff: {
        originalTask: "finish with source auth blocker present",
        currentNextStep: "continue with the next implementation slice",
      },
    });

    expect(result.details).toMatchObject({
      ok: false,
      status: "no_delivery",
      code: "child_session_unhealthy",
      details: {
        kind: "child_route_unhealthy",
        codes: ["auth_profile_session_expired", "context_overflow"],
        recommendedAction: "reauth",
        stateTransitionRequired: true,
      },
      delivery: { status: "rejected", mode: "child_route_guard" },
    });
    expect(calls.some((call) => call.method === "agent")).toBe(false);
    expect(calls.some((call) => call.method === "agent.wait")).toBe(false);
    expect(calls.some((call) => call.method === "send")).toBe(false);
  });

  it("sessions_send rejects fire-and-forget delivery to stale untracked subagent sessions across timeout variants", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    const requesterKey = "agent:planner:main";
    const staleChildKey = "agent:tester:subagent:legacy-boundary-delete";

    try {
      callGatewayMock.mockImplementation(async (opts: unknown) => {
        const request = opts as { method?: string; params?: unknown };
        calls.push(request);
        if (request.method === "sessions.list") {
          return {
            path: "/tmp/sessions.json",
            sessions: [
              { key: requesterKey, kind: "direct" },
              { key: staleChildKey, kind: "direct", spawnedBy: requesterKey },
            ],
          };
        }
        if (request.method === "agent") {
          throw new Error("stale untracked subagent should not be restarted through A2A announce");
        }
        if (request.method === "agent.wait") {
          throw new Error("stale untracked subagent should not enter tracked completion wait");
        }
        if (request.method === "send") {
          throw new Error("stale untracked subagent should not reach send fallback");
        }
        return {};
      });

      const tool = createOpenClawTools({
        agentSessionKey: requesterKey,
        agentChannel: "discord",
        config: {
          ...TEST_CONFIG,
          tools: {
            ...TEST_CONFIG.tools,
            agentToAgent: { enabled: true, allow: ["*"] },
          },
        },
      }).find((candidate) => candidate.name === "sessions_send");
      expect(tool).toBeDefined();
      if (!tool) {
        throw new Error("missing sessions_send tool");
      }

      const cases: Array<{ callId: string; timeoutSeconds?: number }> = [
        {
          callId: "call-stale-untracked-child-timeout-zero",
          timeoutSeconds: 0,
        },
        {
          callId: "call-stale-untracked-child-timeout-one",
          timeoutSeconds: 1,
        },
        {
          callId: "call-stale-untracked-child-default-timeout",
        },
        {
          callId: "call-stale-untracked-child-bounded-timeout",
          timeoutSeconds: 5,
        },
      ] as const;

      for (const { callId, timeoutSeconds } of cases) {
        calls.length = 0;
        const result = await tool.execute(callId, {
          sessionKey: staleChildKey,
          message: "Task T4: rerun verification",
          ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
        });

        expect(result.details).toMatchObject({
          ok: false,
          status: "no_delivery",
          code: "child_route_health_unavailable",
          details: {
            kind: "child_route_health_unavailable",
            childSessionKey: staleChildKey,
            requesterSessionKey: requesterKey,
            errorKind: "child_route_untrusted",
            retryable: false,
            plannerInstruction:
              "Child-shaped targets require tracked child ownership before follow-up delivery.",
          },
          delivery: { status: "rejected", mode: "child_route_guard" },
        });
        expect(result.details).not.toMatchObject({
          delivery: { status: "pending", mode: "announce" },
        });
        expect(calls.some((call) => call.method === "agent")).toBe(false);
        expect(calls.some((call) => call.method === "agent.wait")).toBe(false);
        expect(calls.some((call) => call.method === "send")).toBe(false);
      }
    } finally {
      callGatewayMock.mockReset();
    }
  });

  it("sessions_send lets a requester message its own cross-agent child despite agentToAgent allowlist", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    const requesterKey = "agent:planner:main";
    const childKey = "agent:implementer:subagent:impl-review-fix-1";
    addSubagentRunForTests({
      runId: "run-finished-implementer-child",
      childSessionKey: childKey,
      controllerSessionKey: requesterKey,
      requesterSessionKey: requesterKey,
      requesterDisplayKey: requesterKey,
      task: "implementer review fix",
      cleanup: "keep",
      spawnMode: "session",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
      endedAt: Date.now() - 1_000,
      outcome: { status: "ok" },
      resultReceiptId: "receipt-finished-implementer-child",
    });
    await recordHealthyChildHeadroom(childKey, "run-finished-implementer-child");

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        return { runId: "run-implementer-followup", status: "accepted" };
      }
      if (request.method === "agent.wait") {
        return { runId: "run-implementer-followup", status: "pending" };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: requesterKey,
      agentChannel: "discord",
      config: {
        ...TEST_CONFIG,
        tools: {
          ...TEST_CONFIG.tools,
          agentToAgent: { enabled: true, allow: ["planner"] },
        },
      },
    }).find((candidate) => candidate.name === "sessions_send");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-cross-agent-owned-child", {
      sessionKey: childKey,
      message: "Task T4: apply the reviewer fix",
      timeoutSeconds: 0,
    });

    expect(result.details).toMatchObject({
      status: "accepted",
      runId: "run-implementer-followup",
      sessionKey: childKey,
      delivery: { status: "tracked", mode: "completion_event" },
      mode: "restart",
    });
    const agentCalls = calls.filter((call) => call.method === "agent");
    expect(agentCalls).toHaveLength(1);
    expect(agentCalls[0]?.params).toMatchObject({
      sessionKey: childKey,
      deliver: false,
      lane: "subagent",
    });
  });

  it("sessions_send restarts ended controlled child sessions with descendants and honors timeoutSeconds", async () => {
    const requesterKey = "agent:main:main";
    const childKey = "agent:main:subagent:wait-worker";
    let oldRunWaitTimeoutMs: number | undefined;
    let followupWaitTimeoutMs: number | undefined;
    addSubagentRunForTests({
      runId: "run-finished-wait-child",
      childSessionKey: childKey,
      controllerSessionKey: requesterKey,
      requesterSessionKey: requesterKey,
      requesterDisplayKey: "main",
      task: "finished child wait task",
      cleanup: "keep",
      spawnMode: "session",
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_000,
      endedAt: Date.now() - 1_000,
      outcome: { status: "ok" },
      resultReceiptId: "receipt-finished-wait-child",
    });
    await recordHealthyChildHeadroom(childKey, "run-finished-wait-child");
    addSubagentRunForTests({
      runId: "run-finished-wait-descendant",
      childSessionKey: `${childKey}:subagent:leaf`,
      controllerSessionKey: childKey,
      requesterSessionKey: childKey,
      requesterDisplayKey: childKey,
      task: "descendant task",
      cleanup: "keep",
      createdAt: Date.now() - 500,
      startedAt: Date.now() - 500,
    });

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            { key: requesterKey, kind: "direct" },
            { key: childKey, kind: "direct", spawnedBy: requesterKey },
          ],
        };
      }
      if (request.method === "chat.history") {
        return { messages: [] };
      }
      if (request.method === "agent") {
        return { runId: "run-finished-wait-followup", status: "accepted" };
      }
      if (request.method === "agent.wait") {
        if (request.params?.runId === "run-finished-wait-child") {
          oldRunWaitTimeoutMs =
            typeof request.params?.timeoutMs === "number" ? request.params.timeoutMs : undefined;
          return { runId: "run-finished-wait-child", status: "ok" };
        }
        followupWaitTimeoutMs =
          typeof request.params?.timeoutMs === "number" ? request.params.timeoutMs : undefined;
        return { runId: "run-finished-wait-followup", status: "timeout" };
      }
      return {};
    });

    const tool = createOpenClawTools({
      agentSessionKey: requesterKey,
      agentChannel: "discord",
    }).find((candidate) => candidate.name === "sessions_send");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing sessions_send tool");
    }

    const result = await tool.execute("call-finished-child-wait", {
      sessionKey: childKey,
      message: "continue with the next slice",
      timeoutSeconds: 1,
    });
    expect(result.details).toMatchObject({
      status: "timeout",
      runId: "run-finished-wait-followup",
      sessionKey: childKey,
      delivery: { status: "tracked", mode: "completion_event" },
    });
    expect(oldRunWaitTimeoutMs).toBe(5_000);
    expect(followupWaitTimeoutMs).toBe(1_000);
  });
});
