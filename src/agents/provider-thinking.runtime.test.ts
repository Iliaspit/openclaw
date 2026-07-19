import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveProviderHookPlugin: vi.fn(),
}));

vi.mock("../plugins/provider-hook-runtime.js", () => ({
  resolveProviderHookPlugin: mocks.resolveProviderHookPlugin,
}));

import {
  resolveRuntimeProviderThinkingLevelLabels,
  resolveRuntimeProviderThinkingLevelSupport,
} from "./provider-thinking.runtime.js";

describe("resolveRuntimeProviderThinkingLevelSupport", () => {
  beforeEach(() => {
    mocks.resolveProviderHookPlugin.mockReset();
  });

  it("uses the targeted provider thinking profile", () => {
    mocks.resolveProviderHookPlugin.mockReturnValue({
      resolveThinkingProfile: () => ({
        levels: [{ id: "off" }, { id: "high" }, { id: "xhigh" }, { id: "max" }],
      }),
    });

    expect(
      resolveRuntimeProviderThinkingLevelSupport({
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        level: "xhigh",
        config: {},
        workspaceDir: "/workspace",
      }),
    ).toBe(true);
    expect(mocks.resolveProviderHookPlugin).toHaveBeenCalledWith({
      provider: "openai-codex",
      config: {},
      workspaceDir: "/workspace",
      env: undefined,
    });
  });

  it("returns false when a loaded provider profile omits the level", () => {
    mocks.resolveProviderHookPlugin.mockReturnValue({
      resolveThinkingProfile: () => ({ levels: [{ id: "off" }, { id: "high" }] }),
    });

    expect(
      resolveRuntimeProviderThinkingLevelSupport({
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        level: "xhigh",
      }),
    ).toBe(false);
  });

  it("defers to the generic policy when no provider profile is available", () => {
    mocks.resolveProviderHookPlugin.mockReturnValue(undefined);

    expect(
      resolveRuntimeProviderThinkingLevelSupport({
        provider: "unknown",
        model: "model",
        level: "medium",
      }),
    ).toBeUndefined();
  });

  it("returns normalized provider labels in thinking-rank order", () => {
    mocks.resolveProviderHookPlugin.mockReturnValue({
      resolveThinkingProfile: () => ({
        levels: [
          { id: "max" },
          { id: "off" },
          { id: "xhigh", label: "extra high" },
          { id: "high" },
        ],
      }),
    });

    expect(
      resolveRuntimeProviderThinkingLevelLabels({
        provider: "openai-codex",
        model: "gpt-5.6-sol",
      }),
    ).toEqual(["off", "high", "extra high", "max"]);
  });

  it("defers session option labels when no provider profile is available", () => {
    mocks.resolveProviderHookPlugin.mockReturnValue(undefined);

    expect(
      resolveRuntimeProviderThinkingLevelLabels({
        provider: "unknown",
        model: "model",
      }),
    ).toBeUndefined();
  });
});
