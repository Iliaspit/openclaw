import { beforeEach, describe, expect, it, vi } from "vitest";
import { subagentRuns } from "./subagent-registry-memory.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { createSessionsHistoryTool } from "./tools/sessions-history-tool.js";

const callGatewayMock = vi.fn();
vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

let mockConfig: Record<string, unknown> = {
  session: { mainKey: "main", scope: "per-sender" },
};
vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    loadConfig: () => mockConfig,
    resolveGatewayPort: () => 18789,
  };
});
function getSessionsHistoryTool(options?: { agentSessionKey?: string; sandboxed?: boolean }) {
  return createSessionsHistoryTool({
    agentSessionKey: options?.agentSessionKey ?? "main",
    sandboxed: options?.sandboxed,
    config: mockConfig as never,
    callGateway: (opts: unknown) => callGatewayMock(opts),
  });
}

function mockGatewayWithHistory(
  extra?: (req: { method?: string; params?: Record<string, unknown> }) => unknown,
) {
  callGatewayMock.mockClear();
  callGatewayMock.mockImplementation(async (opts: unknown) => {
    const req = opts as { method?: string; params?: Record<string, unknown> };
    const handled = extra?.(req);
    if (handled !== undefined) {
      return handled;
    }
    if (req.method === "chat.history") {
      return { messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }] };
    }
    return {};
  });
}

describe("sessions tools visibility", () => {
  beforeEach(() => {
    callGatewayMock.mockClear();
    subagentRuns.clear();
  });

  it("defaults to tree visibility (self + spawned) for sessions_history", async () => {
    mockConfig = {
      session: { mainKey: "main", scope: "per-sender" },
      tools: { agentToAgent: { enabled: false } },
    };
    mockGatewayWithHistory((req) => {
      if (req.method === "sessions.list" && req.params?.spawnedBy === "main") {
        return { sessions: [{ key: "subagent:child-1" }] };
      }
      if (req.method === "sessions.resolve") {
        const key = typeof req.params?.key === "string" ? req.params.key : "";
        return { key };
      }
      return undefined;
    });

    const tool = getSessionsHistoryTool();

    const denied = await tool.execute("call1", {
      sessionKey: "agent:main:discord:direct:someone-else",
    });
    expect(denied.details).toMatchObject({ status: "forbidden" });

    const allowed = await tool.execute("call2", { sessionKey: "subagent:child-1" });
    expect(allowed.details).toMatchObject({
      sessionKey: "subagent:child-1",
    });
  });

  it("allows broader access when tools.sessions.visibility=all", async () => {
    mockConfig = {
      session: { mainKey: "main", scope: "per-sender" },
      tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: false } },
    };
    mockGatewayWithHistory();
    const tool = getSessionsHistoryTool();

    const result = await tool.execute("call3", {
      sessionKey: "agent:main:discord:direct:someone-else",
    });
    expect(result.details).toMatchObject({
      sessionKey: "agent:main:discord:direct:someone-else",
    });
  });

  it("allows parent sessions_history for tracked cross-agent child subagents", async () => {
    mockConfig = {
      session: { mainKey: "main", scope: "per-sender" },
      tools: {
        sessions: { visibility: "all" },
        agentToAgent: { enabled: true, allow: ["planner-4"] },
      },
    };
    const childSessionKey = "agent:planner-helper:subagent:child-1";
    const run: SubagentRunRecord = {
      runId: "run-child-1",
      childSessionKey,
      controllerSessionKey: "agent:planner-4:main",
      requesterSessionKey: "agent:planner-4:main",
      requesterDisplayKey: "agent:planner-4:main",
      task: "inspect child result",
      cleanup: "keep",
      createdAt: 100,
    };
    subagentRuns.set(run.runId, run);
    mockGatewayWithHistory();
    const tool = getSessionsHistoryTool({ agentSessionKey: "agent:planner-4:main" });

    const result = await tool.execute("call-controlled-child-history", {
      sessionKey: childSessionKey,
    });

    expect(result.details).toMatchObject({
      sessionKey: childSessionKey,
      messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
    });
  });

  it("clamps sandboxed sessions to tree when agents.defaults.sandbox.sessionToolsVisibility=spawned", async () => {
    mockConfig = {
      session: { mainKey: "main", scope: "per-sender" },
      tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true, allow: ["*"] } },
      agents: { defaults: { sandbox: { sessionToolsVisibility: "spawned" } } },
    };
    mockGatewayWithHistory((req) => {
      if (req.method === "sessions.list" && req.params?.spawnedBy === "main") {
        return { sessions: [] };
      }
      return undefined;
    });

    const tool = getSessionsHistoryTool({ sandboxed: true });

    const denied = await tool.execute("call4", {
      sessionKey: "agent:other:main",
    });
    expect(denied.details).toMatchObject({ status: "forbidden" });
  });
});
