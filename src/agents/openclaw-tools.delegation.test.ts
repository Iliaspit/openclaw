import { describe, expect, it, vi } from "vitest";
import { createDelegationGuardTestConfig } from "./delegation/test-helpers.js";
import { createOpenClawTools } from "./openclaw-tools.js";

vi.mock("@mariozechner/pi-ai/oauth", () => ({
  getOAuthApiKey: () => "",
  getOAuthProviders: () => [],
}));

function delegationToolNames(agentId: string, enabled = true): string[] {
  const config = createDelegationGuardTestConfig({ enabled });
  return createOpenClawTools({
    config,
    agentSessionKey: `agent:${agentId}:main`,
    requesterAgentIdOverride: agentId,
    workspaceDir: `/tmp/openclaw-delegation-test/workspaces/${agentId}`,
    effectiveThinking:
      agentId === "reviewer"
        ? "high"
        : agentId === "tester" || agentId === "qa"
          ? "medium"
          : "xhigh",
    disablePluginTools: true,
  })
    .map((tool) => tool.name)
    .filter((name) => name.startsWith("delegation_"));
}

describe("delegation tool exposure", () => {
  it("exposes delegation_guard only to configured controllers", () => {
    expect(delegationToolNames("planner")).toEqual(["delegation_guard"]);
    expect(delegationToolNames("planner2")).toEqual(["delegation_guard"]);
  });

  it.each(["helper", "implementer", "qa"])(
    "exposes only delegation_report to the guarded %s worker",
    (agentId) => expect(delegationToolNames(agentId)).toEqual(["delegation_report"]),
  );

  it.each(["tester", "reviewer"])(
    "adds bounded runtime evidence only to the guarded %s lane",
    (agentId) =>
      expect(delegationToolNames(agentId)).toEqual(["delegation_evidence", "delegation_report"]),
  );

  it("does not expose protected delegation tools to unclassified agents", () => {
    expect(delegationToolNames("outsider")).toEqual([]);
  });

  it("does not alter tool exposure when the delegation guard is disabled", () => {
    expect(delegationToolNames("planner", false)).toEqual([]);
    expect(delegationToolNames("helper", false)).toEqual([]);
  });
});
