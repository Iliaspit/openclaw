import { afterEach, describe, expect, it, vi } from "vitest";
import { __testing, captureSubagentCompletionReply } from "./subagent-announce-output.js";

type LoadConfigResult = ReturnType<(typeof import("../config/config.js"))["loadConfig"]>;

const testConfig: LoadConfigResult = {
  session: {
    mainKey: "main",
    scope: "per-sender",
  },
};

describe("captureSubagentCompletionReply", () => {
  afterEach(() => {
    __testing.setDepsForTest();
  });

  it("requires visible assistant reply when strict completion capture is enabled", async () => {
    const callGatewayMock = vi.fn(async () => ({
      messages: [{ role: "toolResult", content: [{ type: "text", text: "raw tool output" }] }],
    }));
    const readLatestAssistantReplyMock = vi.fn(async () => undefined);
    __testing.setDepsForTest({
      callGateway: callGatewayMock,
      loadConfig: () => testConfig,
      readLatestAssistantReply: readLatestAssistantReplyMock,
    });

    const result = await captureSubagentCompletionReply("agent:main:subagent:child", {
      waitForReply: false,
      requireAssistantReply: true,
    });

    expect(result).toBeUndefined();
    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(readLatestAssistantReplyMock).toHaveBeenCalledWith({
      sessionKey: "agent:main:subagent:child",
      limit: 100,
    });
  });

  it("keeps raw-output fallback for non-strict completion capture", async () => {
    const callGatewayMock = vi.fn(async () => ({
      messages: [{ role: "toolResult", content: [{ type: "text", text: "raw tool output" }] }],
    }));
    const readLatestAssistantReplyMock = vi.fn(async () => undefined);
    __testing.setDepsForTest({
      callGateway: callGatewayMock,
      loadConfig: () => testConfig,
      readLatestAssistantReply: readLatestAssistantReplyMock,
    });

    const result = await captureSubagentCompletionReply("agent:main:subagent:child", {
      waitForReply: false,
    });

    expect(result).toBe("raw tool output");
    expect(callGatewayMock).toHaveBeenCalledWith({
      method: "chat.history",
      params: { sessionKey: "agent:main:subagent:child", limit: 100 },
    });
    expect(readLatestAssistantReplyMock).not.toHaveBeenCalled();
  });
});
