import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSubagentModelAndThinkingPlan } from "../subagent-spawn-plan.js";

vi.mock("../../plugins/provider-thinking.js", () => ({
  resolveProviderBinaryThinking: () => undefined,
  resolveProviderDefaultThinkingLevel: () => undefined,
  resolveProviderThinkingProfile: () => undefined,
  resolveProviderXHighThinking: ({
    provider,
    context,
  }: {
    provider: string;
    context: { modelId: string };
  }) => provider === "openai-codex" && context.modelId === "gpt-5.4",
}));

function config(model: string, defaultThinking?: string): OpenClawConfig {
  return {
    agents: {
      defaults: defaultThinking ? { subagents: { thinking: defaultThinking } } : undefined,
      list: [{ id: "helper", model }],
    },
  };
}

describe("guarded delegation spawn thinking", () => {
  it("injects the runtime-required exact thinking level", () => {
    const plan = resolveSubagentModelAndThinkingPlan({
      cfg: config("openai-codex/gpt-5.4"),
      targetAgentId: "helper",
      targetAgentConfig: { id: "helper", model: "openai-codex/gpt-5.4" },
      requiredThinking: "xhigh",
    });

    expect(plan).toMatchObject({
      status: "ok",
      resolvedModel: "openai-codex/gpt-5.4",
      thinkingOverride: "xhigh",
      initialSessionPatch: {
        model: "openai-codex/gpt-5.4",
        thinkingLevel: "xhigh",
      },
    });
  });

  it("rejects lower explicit and inherited session thinking instead of clamping", () => {
    const explicit = resolveSubagentModelAndThinkingPlan({
      cfg: config("openai-codex/gpt-5.4"),
      targetAgentId: "helper",
      targetAgentConfig: { id: "helper", model: "openai-codex/gpt-5.4" },
      thinkingOverrideRaw: "high",
      requiredThinking: "xhigh",
    });
    expect(explicit).toMatchObject({
      status: "error",
      error: expect.stringMatching(/conflicting overrides are not allowed/i),
    });

    const requiredWinsOverDefault = resolveSubagentModelAndThinkingPlan({
      cfg: config("openai-codex/gpt-5.4", "high"),
      targetAgentId: "helper",
      targetAgentConfig: { id: "helper", model: "openai-codex/gpt-5.4" },
      requiredThinking: "xhigh",
    });
    expect(requiredWinsOverDefault).toMatchObject({
      status: "ok",
      thinkingOverride: "xhigh",
      initialSessionPatch: { thinkingLevel: "xhigh" },
    });
  });

  it("accepts a matching explicit session thinking override", () => {
    expect(
      resolveSubagentModelAndThinkingPlan({
        cfg: config("openai-codex/gpt-5.4"),
        targetAgentId: "helper",
        targetAgentConfig: { id: "helper", model: "openai-codex/gpt-5.4" },
        thinkingOverrideRaw: "xhigh",
        requiredThinking: "xhigh",
      }),
    ).toMatchObject({
      status: "ok",
      thinkingOverride: "xhigh",
    });
  });

  it("fails closed when the assigned model cannot support the required level", () => {
    const plan = resolveSubagentModelAndThinkingPlan({
      cfg: config("openai/gpt-4.1-mini"),
      targetAgentId: "helper",
      targetAgentConfig: { id: "helper", model: "openai/gpt-4.1-mini" },
      requiredThinking: "xhigh",
    });

    expect(plan).toMatchObject({
      status: "error",
      error: expect.stringMatching(/not supported.*gpt-4\.1-mini/i),
    });
  });
});
