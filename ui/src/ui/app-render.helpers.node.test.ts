import { describe, expect, it, vi } from "vitest";
const {
  refreshChatMock,
  refreshChatAvatarMock,
  refreshSlashCommandsMock,
  loadChatHistoryMock,
  loadSessionsMock,
} = vi.hoisted(() => ({
  refreshChatMock: vi.fn(),
  refreshChatAvatarMock: vi.fn(),
  refreshSlashCommandsMock: vi.fn(),
  loadChatHistoryMock: vi.fn(),
  loadSessionsMock: vi.fn(),
}));

vi.mock("./app-chat.ts", () => ({
  refreshChat: refreshChatMock,
  refreshChatAvatar: refreshChatAvatarMock,
}));

vi.mock("./chat/slash-commands.ts", () => ({
  refreshSlashCommands: (...args: unknown[]) => refreshSlashCommandsMock(...args),
}));

vi.mock("./controllers/chat.ts", () => ({
  loadChatHistory: loadChatHistoryMock,
}));

vi.mock("./controllers/sessions.ts", () => ({
  loadSessions: loadSessionsMock,
}));

import {
  isCronSessionKey,
  parseSessionKey,
  resolveAssistantAttachmentAuthToken,
  resolveSessionDisplayName,
  resolveSessionOptionGroups,
  switchChatSession,
} from "./app-render.helpers.ts";
import type { AppViewState } from "./app-view-state.ts";
import type { SessionsListResult } from "./types.ts";

type SessionRow = SessionsListResult["sessions"][number];

function row(overrides: Partial<SessionRow> & { key: string }): SessionRow {
  return { kind: "direct", updatedAt: 0, ...overrides };
}

describe("resolveSessionOptionGroups", () => {
  it("orders generic agent groups by agents.list and puts primary sessions ahead of subagents", () => {
    const state = {
      sessionsHideCron: true,
      hello: {
        snapshot: {
          sessionDefaults: { mainKey: "main" },
        },
      },
      agentsList: {
        agents: [{ id: "alpha" }, { id: "main" }],
        defaultId: "alpha",
      },
    } as unknown as AppViewState;

    const sessions: SessionsListResult = {
      ts: 1,
      path: "/p",
      count: 3,
      defaults: { model: null, modelProvider: null, contextTokens: null },
      sessions: [
        row({
          key: "agent:alpha:subagent:aaa",
          updatedAt: 100,
        }),
        row({
          key: "agent:alpha:main",
          updatedAt: 50,
        }),
        row({
          key: "agent:main:main",
          updatedAt: 10,
        }),
      ],
    };

    const groups = resolveSessionOptionGroups(state, "agent:alpha:main", sessions);
    expect(groups.map((g) => g.id)).toEqual(["top-level-agents", "spawned-and-other-sessions"]);
    expect(groups[0]?.options.map((o) => o.key)).toEqual(["agent:alpha:main", "agent:main:main"]);
    expect(groups[1]?.options.map((o) => o.key)).toEqual(["agent:alpha:subagent:aaa"]);
  });

  it("keeps planner sessions and WhatsApp at the top while grouping support agent sessions", () => {
    const state = {
      sessionsHideCron: true,
      hello: {
        snapshot: {
          sessionDefaults: { mainKey: "main" },
        },
      },
      agentsList: {
        agents: [
          { id: "planner", name: "Planner 1" },
          { id: "planner-helper", name: "Planner Helper" },
          { id: "implementer", name: "Implementer" },
          { id: "tester", name: "Tester" },
          { id: "reviewer", name: "Reviewer" },
          { id: "qa", name: "QA" },
          { id: "planner-2", name: "Planner 2" },
          { id: "planner-3", name: "Planner 3" },
          { id: "planner-4", name: "Planner 4" },
        ],
        defaultId: "planner",
      },
    } as unknown as AppViewState;

    const sessions: SessionsListResult = {
      ts: 1,
      path: "/p",
      count: 12,
      defaults: { model: null, modelProvider: null, contextTokens: null },
      sessions: [
        row({ key: "agent:planner-helper:main", updatedAt: 100 }),
        row({ key: "agent:implementer:main", updatedAt: 95 }),
        row({ key: "agent:tester:main", updatedAt: 90 }),
        row({ key: "agent:reviewer:main", updatedAt: 85 }),
        row({ key: "agent:qa:main", updatedAt: 80 }),
        row({ key: "agent:planner:main", updatedAt: 75 }),
        row({ key: "agent:planner-2:main", updatedAt: 70 }),
        row({ key: "agent:planner-3:main", updatedAt: 65 }),
        row({ key: "agent:planner-4:main", updatedAt: 60 }),
        row({ key: "whatsapp:g-agent-planner-whatsapp-direct-+447476642296", updatedAt: 55 }),
        row({
          key: "agent:implementer:subagent:impl-1",
          updatedAt: 50,
          label: "impl-phase3-fixture-migration-1",
        }),
        row({
          key: "agent:planner-helper:subagent:helper-1",
          updatedAt: 45,
          label: "helper-phase3-fixture-migration-1",
        }),
      ],
    };

    const groups = resolveSessionOptionGroups(state, "agent:planner:main", sessions);
    expect(groups.map((g) => g.id)).toEqual([
      "top-level-agents",
      "agent:planner-helper",
      "agent:implementer",
      "agent:tester",
      "agent:reviewer",
      "agent:qa",
    ]);
    expect(groups[0]?.options.map((o) => o.key)).toEqual([
      "agent:planner:main",
      "agent:planner-2:main",
      "agent:planner-3:main",
      "agent:planner-4:main",
      "whatsapp:g-agent-planner-whatsapp-direct-+447476642296",
    ]);
    expect(groups[0]?.options.map((o) => o.label)).toEqual([
      "Planner 1 (planner)",
      "Planner 2 (planner-2)",
      "Planner 3 (planner-3)",
      "Planner 4 (planner-4)",
      "WhatsApp · +447476642296",
    ]);
    expect(groups[1]?.options.map((o) => o.key)).toEqual([
      "agent:planner-helper:main",
      "agent:planner-helper:subagent:helper-1",
    ]);
    expect(groups[2]?.options.map((o) => o.key)).toEqual([
      "agent:implementer:main",
      "agent:implementer:subagent:impl-1",
    ]);
  });
});

/* ================================================================
 *  parseSessionKey – low-level key → type / fallback mapping
 * ================================================================ */

describe("parseSessionKey", () => {
  it("identifies main session (bare 'main')", () => {
    expect(parseSessionKey("main")).toEqual({ prefix: "", fallbackName: "Main Session" });
  });

  it("identifies main session (agent:main:main)", () => {
    expect(parseSessionKey("agent:main:main")).toEqual({
      prefix: "",
      fallbackName: "Main Session",
    });
  });

  it("identifies subagent sessions", () => {
    expect(parseSessionKey("agent:main:subagent:18abfefe-1fa6-43cb-8ba8-ebdc9b43e253")).toEqual({
      prefix: "Subagent:",
      fallbackName: "Subagent:",
    });
  });

  it("identifies cron sessions", () => {
    expect(parseSessionKey("agent:main:cron:daily-briefing-uuid")).toEqual({
      prefix: "Cron:",
      fallbackName: "Cron Job:",
    });
    expect(parseSessionKey("cron:daily-briefing-uuid")).toEqual({
      prefix: "Cron:",
      fallbackName: "Cron Job:",
    });
  });

  it("identifies direct chat with known channel", () => {
    expect(parseSessionKey("agent:main:bluebubbles:direct:+19257864429")).toEqual({
      prefix: "",
      fallbackName: "iMessage · +19257864429",
    });
  });

  it("identifies direct chat with telegram", () => {
    expect(parseSessionKey("agent:main:telegram:direct:user123")).toEqual({
      prefix: "",
      fallbackName: "Telegram · user123",
    });
  });

  it("identifies group chat with known channel", () => {
    expect(parseSessionKey("agent:main:discord:group:guild-chan")).toEqual({
      prefix: "",
      fallbackName: "Discord Group",
    });
  });

  it("capitalises unknown channels in direct/group patterns", () => {
    expect(parseSessionKey("agent:main:mychannel:direct:user1")).toEqual({
      prefix: "",
      fallbackName: "Mychannel · user1",
    });
  });

  it("identifies channel-prefixed legacy keys", () => {
    expect(parseSessionKey("bluebubbles:g-agent-main-bluebubbles-direct-+19257864429")).toEqual({
      prefix: "",
      fallbackName: "iMessage Session",
    });
    expect(parseSessionKey("discord:123:456")).toEqual({
      prefix: "",
      fallbackName: "Discord Session",
    });
  });

  it("handles bare channel name as key", () => {
    expect(parseSessionKey("telegram")).toEqual({
      prefix: "",
      fallbackName: "Telegram Session",
    });
  });

  it("returns raw key for unknown patterns", () => {
    expect(parseSessionKey("something-unknown")).toEqual({
      prefix: "",
      fallbackName: "something-unknown",
    });
  });
});

describe("resolveAssistantAttachmentAuthToken", () => {
  it("prefers the explicit gateway token when present", () => {
    expect(
      resolveAssistantAttachmentAuthToken({
        settings: { token: "session-token" } as AppViewState["settings"],
        password: "shared-password",
      }),
    ).toBe("session-token");
  });

  it("falls back to the shared password when token is blank", () => {
    expect(
      resolveAssistantAttachmentAuthToken({
        settings: { token: "   " } as AppViewState["settings"],
        password: "shared-password",
      }),
    ).toBe("shared-password");
  });

  it("returns null when neither auth secret is available", () => {
    expect(
      resolveAssistantAttachmentAuthToken({
        settings: { token: "" } as AppViewState["settings"],
        password: "   ",
      }),
    ).toBeNull();
  });
});

/* ================================================================
 *  resolveSessionDisplayName – full resolution with row data
 * ================================================================ */

describe("resolveSessionDisplayName", () => {
  // ── Key-only fallbacks (no row) ──────────────────

  it("returns 'Main Session' for agent:main:main key", () => {
    expect(resolveSessionDisplayName("agent:main:main")).toBe("Main Session");
  });

  it("returns 'Main Session' for bare 'main' key", () => {
    expect(resolveSessionDisplayName("main")).toBe("Main Session");
  });

  it("returns 'Subagent:' for subagent key without row", () => {
    expect(resolveSessionDisplayName("agent:main:subagent:abc-123")).toBe("Subagent:");
  });

  it("returns 'Cron Job:' for cron key without row", () => {
    expect(resolveSessionDisplayName("agent:main:cron:abc-123")).toBe("Cron Job:");
  });

  it("parses direct chat key with channel", () => {
    expect(resolveSessionDisplayName("agent:main:bluebubbles:direct:+19257864429")).toBe(
      "iMessage · +19257864429",
    );
  });

  it("parses channel-prefixed legacy key", () => {
    expect(resolveSessionDisplayName("discord:123:456")).toBe("Discord Session");
  });

  it("returns raw key for unknown patterns", () => {
    expect(resolveSessionDisplayName("something-custom")).toBe("something-custom");
  });

  // ── With row data (label / displayName) ──────────

  it("returns parsed fallback when row has no label or displayName", () => {
    expect(resolveSessionDisplayName("agent:main:main", row({ key: "agent:main:main" }))).toBe(
      "Main Session",
    );
  });

  it("returns parsed fallback when displayName matches key", () => {
    expect(resolveSessionDisplayName("mykey", row({ key: "mykey", displayName: "mykey" }))).toBe(
      "mykey",
    );
  });

  it("returns parsed fallback when label matches key", () => {
    expect(resolveSessionDisplayName("mykey", row({ key: "mykey", label: "mykey" }))).toBe("mykey");
  });

  it("uses label alone when available", () => {
    expect(
      resolveSessionDisplayName(
        "discord:123:456",
        row({ key: "discord:123:456", label: "General" }),
      ),
    ).toBe("General");
  });

  it("falls back to displayName when label is absent", () => {
    expect(
      resolveSessionDisplayName(
        "discord:123:456",
        row({ key: "discord:123:456", displayName: "My Chat" }),
      ),
    ).toBe("My Chat");
  });

  it("prefers label over displayName when both are present", () => {
    expect(
      resolveSessionDisplayName(
        "discord:123:456",
        row({ key: "discord:123:456", displayName: "My Chat", label: "General" }),
      ),
    ).toBe("General");
  });

  it("ignores whitespace-only label and falls back to displayName", () => {
    expect(
      resolveSessionDisplayName(
        "discord:123:456",
        row({ key: "discord:123:456", displayName: "My Chat", label: "   " }),
      ),
    ).toBe("My Chat");
  });

  it("uses parsed fallback when whitespace-only label and no displayName", () => {
    expect(
      resolveSessionDisplayName("discord:123:456", row({ key: "discord:123:456", label: "   " })),
    ).toBe("Discord Session");
  });

  it("trims label and displayName", () => {
    expect(resolveSessionDisplayName("k", row({ key: "k", label: "  General  " }))).toBe("General");
    expect(resolveSessionDisplayName("k", row({ key: "k", displayName: "  My Chat  " }))).toBe(
      "My Chat",
    );
  });

  // ── Type prefixes applied to labels / displayNames ──

  it("prefixes subagent label with Subagent:", () => {
    expect(
      resolveSessionDisplayName(
        "agent:main:subagent:abc-123",
        row({ key: "agent:main:subagent:abc-123", label: "maintainer-v2" }),
      ),
    ).toBe("Subagent: maintainer-v2");
  });

  it("prefixes subagent displayName with Subagent:", () => {
    expect(
      resolveSessionDisplayName(
        "agent:main:subagent:abc-123",
        row({ key: "agent:main:subagent:abc-123", displayName: "Task Runner" }),
      ),
    ).toBe("Subagent: Task Runner");
  });

  it("prefixes cron label with Cron:", () => {
    expect(
      resolveSessionDisplayName(
        "agent:main:cron:abc-123",
        row({ key: "agent:main:cron:abc-123", label: "daily-briefing" }),
      ),
    ).toBe("Cron: daily-briefing");
  });

  it("prefixes cron displayName with Cron:", () => {
    expect(
      resolveSessionDisplayName(
        "agent:main:cron:abc-123",
        row({ key: "agent:main:cron:abc-123", displayName: "Nightly Sync" }),
      ),
    ).toBe("Cron: Nightly Sync");
  });

  it("does not double-prefix cron labels that already include Cron:", () => {
    expect(
      resolveSessionDisplayName(
        "agent:main:cron:abc-123",
        row({ key: "agent:main:cron:abc-123", label: "Cron: Nightly Sync" }),
      ),
    ).toBe("Cron: Nightly Sync");
  });

  it("does not double-prefix subagent display names that already include Subagent:", () => {
    expect(
      resolveSessionDisplayName(
        "agent:main:subagent:abc-123",
        row({ key: "agent:main:subagent:abc-123", displayName: "Subagent: Runner" }),
      ),
    ).toBe("Subagent: Runner");
  });

  it("does not prefix non-typed sessions with labels", () => {
    expect(
      resolveSessionDisplayName(
        "agent:main:bluebubbles:direct:+19257864429",
        row({ key: "agent:main:bluebubbles:direct:+19257864429", label: "Tyler" }),
      ),
    ).toBe("Tyler");
  });
});

describe("isCronSessionKey", () => {
  it("returns true for cron: prefixed keys", () => {
    expect(isCronSessionKey("cron:abc-123")).toBe(true);
    expect(isCronSessionKey("cron:weekly-agent-roundtable")).toBe(true);
    expect(isCronSessionKey("agent:main:cron:abc-123")).toBe(true);
    expect(isCronSessionKey("agent:main:cron:abc-123:run:run-1")).toBe(true);
  });

  it("returns false for non-cron keys", () => {
    expect(isCronSessionKey("main")).toBe(false);
    expect(isCronSessionKey("discord:group:eng")).toBe(false);
    expect(isCronSessionKey("agent:main:slack:cron:job:run:uuid")).toBe(false);
  });
});

describe("switchChatSession", () => {
  it("refreshes the chat avatar after clearing session-scoped state", async () => {
    const settings: AppViewState["settings"] = {
      gatewayUrl: "",
      token: "",
      locale: "en",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "claw",
      themeMode: "dark",
      splitRatio: 0.6,
      navWidth: 280,
      navCollapsed: false,
      navGroupsCollapsed: {},
      borderRadius: 50,
      chatFocusMode: false,
      chatShowThinking: false,
      chatShowToolCalls: true,
    };
    const state = {
      sessionKey: "main",
      chatMessage: "draft",
      chatAttachments: [{ mimeType: "image/png", dataUrl: "data:image/png;base64,AAA" }],
      chatMessages: [{ role: "assistant", content: "old" }],
      chatToolMessages: [{ id: "tool-1" }],
      chatStreamSegments: [{ text: "segment", ts: 1 }],
      chatThinkingLevel: "high",
      chatStream: "stream",
      chatSideResult: {
        kind: "btw",
        runId: "btw-run-1",
        sessionKey: "main",
        question: "what changed?",
        text: "draft answer",
        isError: false,
        ts: 1,
      },
      lastError: "oops",
      compactionStatus: { phase: "active" },
      fallbackStatus: { phase: "active" },
      chatAvatarUrl: "/avatar/old",
      chatQueue: [{ id: "queued" }],
      chatRunId: "run-1",
      chatSideResultTerminalRuns: new Set(["btw-run-1"]),
      chatStreamStartedAt: 1,
      settings,
      applySettings(next: typeof settings) {
        state.settings = next;
      },
      loadAssistantIdentity: vi.fn(),
      resetToolStream: vi.fn(),
      resetChatScroll: vi.fn(),
    } as unknown as AppViewState;

    refreshChatAvatarMock.mockResolvedValue(undefined);
    refreshSlashCommandsMock.mockResolvedValue(undefined);
    loadChatHistoryMock.mockResolvedValue(undefined);
    loadSessionsMock.mockResolvedValue(undefined);

    switchChatSession(state, "agent:main:test-b");
    await Promise.resolve();

    expect(state.chatSideResult).toBeNull();
    expect(state.chatSideResultTerminalRuns.size).toBe(0);
    expect(refreshChatAvatarMock).toHaveBeenCalledWith(state);
    expect(refreshSlashCommandsMock).toHaveBeenCalledWith({
      client: undefined,
      agentId: "main",
    });
    expect(loadChatHistoryMock).toHaveBeenCalledWith(state);
    expect(loadSessionsMock).toHaveBeenCalledWith(state, {
      activeMinutes: 0,
      limit: 0,
      includeGlobal: true,
      includeUnknown: true,
    });
  });

  it("does not force agentId=main for plain session keys", async () => {
    const settings: AppViewState["settings"] = {
      gatewayUrl: "",
      token: "",
      locale: "en",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "claw",
      themeMode: "dark",
      splitRatio: 0.6,
      navWidth: 280,
      navCollapsed: false,
      navGroupsCollapsed: {},
      borderRadius: 50,
      chatFocusMode: false,
      chatShowThinking: false,
      chatShowToolCalls: true,
    };
    const state = {
      sessionKey: "main",
      chatMessage: "",
      chatAttachments: [],
      chatMessages: [],
      chatToolMessages: [],
      chatStreamSegments: [],
      chatThinkingLevel: null,
      chatStream: null,
      chatSideResult: null,
      lastError: null,
      compactionStatus: null,
      fallbackStatus: null,
      chatAvatarUrl: null,
      chatQueue: [],
      chatRunId: null,
      chatSideResultTerminalRuns: new Set<string>(),
      chatStreamStartedAt: null,
      settings,
      applySettings(next: typeof settings) {
        state.settings = next;
      },
      loadAssistantIdentity: vi.fn(),
      resetToolStream: vi.fn(),
      resetChatScroll: vi.fn(),
      client: { request: vi.fn() },
    } as unknown as AppViewState;

    refreshChatAvatarMock.mockResolvedValue(undefined);
    refreshSlashCommandsMock.mockResolvedValue(undefined);
    loadChatHistoryMock.mockResolvedValue(undefined);
    loadSessionsMock.mockResolvedValue(undefined);

    switchChatSession(state, "main");
    await Promise.resolve();

    expect(refreshSlashCommandsMock).toHaveBeenCalledWith({
      client: state.client,
      agentId: undefined,
    });
  });
});
