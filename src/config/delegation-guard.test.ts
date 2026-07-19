import { describe, expect, it } from "vitest";
import {
  createDelegationGuardTestConfig,
  DELEGATION_TEST_WORKER_IDS,
} from "../agents/delegation/test-helpers.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import { validateConfigObject } from "./validation.js";

function guardedAgent(config: OpenClawConfig, agentId: string) {
  const agent = config.agents?.list?.find((entry) => entry.id === agentId);
  if (!agent) {
    throw new Error(`Missing delegation test agent: ${agentId}`);
  }
  return agent;
}

function expectInvalid(config: OpenClawConfig, message: RegExp): void {
  const result = validateConfigObject(config);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.issues.map((issue) => issue.message).join("\n")).toMatch(message);
  }
}

describe("agents.delegationGuard config", () => {
  it("accepts the exact guarded role, thinking, model, allowlist, and sandbox partition", () => {
    const result = validateConfigObject(createDelegationGuardTestConfig());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.agents?.delegationGuard?.workers).toEqual([
        expect.objectContaining({
          role: "helper",
          requiredThinking: "xhigh",
          workspaceAccess: "ro",
        }),
        expect.objectContaining({
          role: "implementer",
          requiredThinking: "xhigh",
          workspaceAccess: "rw",
        }),
        expect.objectContaining({
          role: "tester",
          requiredThinking: "medium",
          workspaceAccess: "ro",
        }),
        expect.objectContaining({
          role: "reviewer",
          requiredThinking: "high",
          workspaceAccess: "ro",
        }),
        expect.objectContaining({ role: "qa", requiredThinking: "medium", workspaceAccess: "ro" }),
      ]);
    }
  });

  it("preserves legacy configurations when no delegation guard is configured", () => {
    const result = validateConfigObject({
      agents: {
        list: [{ id: "main", model: "openai/gpt-5.4" }],
      },
    });

    expect(result.ok).toBe(true);
  });

  it("requires exactly one worker per guarded role", () => {
    const duplicateRole = createDelegationGuardTestConfig();
    const reviewer = duplicateRole.agents?.delegationGuard?.workers.find(
      (worker) => worker.role === "reviewer",
    );
    if (!reviewer) {
      throw new Error("Missing reviewer fixture");
    }
    reviewer.role = "tester";

    expectInvalid(duplicateRole, /exactly one|requires exactly one reviewer/i);
  });

  it("rejects overlapping, duplicate, or non-normalized principal ids", () => {
    const overlapping = createDelegationGuardTestConfig();
    const helper = overlapping.agents?.delegationGuard?.workers[0];
    if (!helper) {
      throw new Error("Missing helper fixture");
    }
    helper.agentId = "planner";
    expectInvalid(overlapping, /cannot be both/i);

    const duplicate = createDelegationGuardTestConfig();
    duplicate.agents?.delegationGuard?.controllers.push({
      agentId: "planner",
      requiredThinking: "xhigh",
    });
    expectInvalid(duplicate, /controller agent ids must be unique/i);

    const nonNormalized = createDelegationGuardTestConfig();
    const controller = nonNormalized.agents?.delegationGuard?.controllers[0];
    if (!controller) {
      throw new Error("Missing planner fixture");
    }
    controller.agentId = "Planner";
    expectInvalid(nonNormalized, /normalized lowercase/i);
  });

  it.each([
    ["planner", "high", /exact xhigh thinking/i],
    ["helper", "high", /exact xhigh thinking/i],
    ["implementer", "high", /exact xhigh thinking/i],
    ["tester", "high", /exact medium thinking/i],
    ["reviewer", "medium", /exact high thinking/i],
    ["qa", "high", /exact medium thinking/i],
  ] as const)("rejects a non-exact thinking default for %s", (agentId, thinking, message) => {
    const config = createDelegationGuardTestConfig();
    guardedAgent(config, agentId).thinkingDefault = thinking;

    expectInvalid(config, message);
  });

  it("requires controllers to allow exactly the guarded worker ids", () => {
    const wildcard = createDelegationGuardTestConfig();
    guardedAgent(wildcard, "planner").subagents = { allowAgents: ["*"] };
    expectInvalid(wildcard, /allow exactly the configured guarded workers/i);

    const incomplete = createDelegationGuardTestConfig();
    guardedAgent(incomplete, "planner").subagents = {
      allowAgents: DELEGATION_TEST_WORKER_IDS.slice(0, -1),
    };
    expectInvalid(incomplete, /allow exactly the configured guarded workers/i);
  });

  it("requires embedded per-session Docker sandboxes with exact workspace access", () => {
    const controllerAccess = createDelegationGuardTestConfig();
    guardedAgent(controllerAccess, "planner").sandbox = {
      mode: "all",
      backend: "docker",
      scope: "session",
      workspaceAccess: "rw",
    };
    expectInvalid(controllerAccess, /read-only workspace access/i);

    const implementerAccess = createDelegationGuardTestConfig();
    guardedAgent(implementerAccess, "implementer").sandbox = {
      mode: "all",
      backend: "docker",
      scope: "session",
      workspaceAccess: "ro",
    };
    expectInvalid(implementerAccess, /rw workspace access/i);

    const sharedScope = createDelegationGuardTestConfig();
    guardedAgent(sharedScope, "reviewer").sandbox = {
      mode: "all",
      backend: "docker",
      scope: "shared",
      workspaceAccess: "ro",
    };
    expectInvalid(sharedScope, /per-session Docker sandbox/i);

    const wrongBackend = createDelegationGuardTestConfig();
    guardedAgent(wrongBackend, "tester").sandbox = {
      mode: "all",
      backend: "host",
      scope: "session",
      workspaceAccess: "ro",
    };
    expectInvalid(wrongBackend, /per-session Docker sandbox/i);

    const acp = createDelegationGuardTestConfig();
    guardedAgent(acp, "qa").runtime = { type: "acp" };
    expectInvalid(acp, /embedded runtime/i);
  });

  it("requires one explicit provider/model and rejects worker fallbacks", () => {
    const unqualified = createDelegationGuardTestConfig();
    guardedAgent(unqualified, "helper").model = {
      primary: "gpt-5.4",
      fallbacks: [],
    };
    expectInvalid(unqualified, /explicit provider\/model primary/i);

    const fallback = createDelegationGuardTestConfig();
    guardedAgent(fallback, "reviewer").model = {
      primary: "openai/gpt-5.4",
      fallbacks: ["anthropic/claude-sonnet-4-6"],
    };
    expectInvalid(fallback, /no fallbacks/i);
  });

  it("requires an absolute digest-pinned bounded validator contract", () => {
    const relative = createDelegationGuardTestConfig();
    relative.agents!.delegationGuard!.validator.entrypoint = "scripts/validator.mjs";
    expectInvalid(relative, /entrypoint must be absolute/i);

    const malformedDigest = createDelegationGuardTestConfig();
    malformedDigest.agents!.delegationGuard!.validator.sha256 = "ABC123";
    expectInvalid(malformedDigest, /invalid string|pattern/i);

    const unbounded = createDelegationGuardTestConfig();
    unbounded.agents!.delegationGuard!.validator.maxOutputBytes = 2 * 1024 * 1024;
    expectInvalid(unbounded, /too big|less than or equal/i);
  });
});
