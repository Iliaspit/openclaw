import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetChildRouteHealthForTest, resolveChildRouteHealthPath } from "./child-route-health.js";
import {
  createLedgerFixture,
  issueAssignment,
  TEST_CONTROLLER,
  unsafeDatabaseForTest,
} from "./delegation/ledger.test-helpers.js";
import { authorizeDelegationRoute } from "./delegation/runtime.js";
import { createDelegationGuardTestConfig } from "./delegation/test-helpers.js";
import {
  createSubagentSpawnTestConfig,
  expectPersistedRuntimeModel,
  installSessionStoreCaptureMock,
  loadSubagentSpawnModuleForTest,
} from "./subagent-spawn.test-helpers.js";
import { installAcceptedSubagentGatewayMock } from "./test-helpers/subagent-gateway.js";

vi.mock("../plugins/provider-thinking.js", () => ({
  resolveProviderBinaryThinking: () => undefined,
  resolveProviderDefaultThinkingLevel: () => undefined,
  resolveProviderThinkingProfile: () => undefined,
  resolveProviderXHighThinking: () => true,
}));

const hoisted = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  updateSessionStoreMock: vi.fn(),
  pruneLegacyStoreKeysMock: vi.fn(),
  registerSubagentRunMock: vi.fn(),
  registerPendingSubagentTaskRunMock: vi.fn(),
  failPendingSubagentTaskRunMock: vi.fn(),
  assessSubagentSliceBudgetForSpawnMock: vi.fn(),
  recordSubagentSliceRouteHealthUnavailableForSpawnMock: vi.fn(),
  emitSessionLifecycleEventMock: vi.fn(),
  configOverride: {} as Record<string, unknown>,
  resolvedModel: "openai-codex/gpt-5.4",
  guardedSandbox: false,
}));

let resetSubagentRegistryForTests: typeof import("./subagent-registry.js").resetSubagentRegistryForTests;
let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;
let subagentSpawnTesting: typeof import("./subagent-spawn.js").__testing;
const originalStateDir = process.env.OPENCLAW_STATE_DIR;
let routeHealthStateDir: string | undefined;

function createConfigOverride(overrides?: Record<string, unknown>) {
  return createSubagentSpawnTestConfig(os.tmpdir(), {
    agents: {
      defaults: {
        workspace: os.tmpdir(),
      },
      list: [
        {
          id: "main",
          workspace: "/tmp/workspace-main",
        },
      ],
    },
    ...overrides,
  });
}

describe("spawnSubagentDirect seam flow", () => {
  beforeAll(async () => {
    ({
      resetSubagentRegistryForTests,
      spawnSubagentDirect,
      __testing: subagentSpawnTesting,
    } = await loadSubagentSpawnModuleForTest({
      callGatewayMock: hoisted.callGatewayMock,
      loadConfig: () => hoisted.configOverride,
      updateSessionStoreMock: hoisted.updateSessionStoreMock,
      pruneLegacyStoreKeysMock: hoisted.pruneLegacyStoreKeysMock,
      registerSubagentRunMock: hoisted.registerSubagentRunMock,
      registerPendingSubagentTaskRunMock: hoisted.registerPendingSubagentTaskRunMock,
      failPendingSubagentTaskRunMock: hoisted.failPendingSubagentTaskRunMock,
      assessSubagentSliceBudgetForSpawnMock: hoisted.assessSubagentSliceBudgetForSpawnMock,
      recordSubagentSliceRouteHealthUnavailableForSpawnMock:
        hoisted.recordSubagentSliceRouteHealthUnavailableForSpawnMock,
      emitSessionLifecycleEventMock: hoisted.emitSessionLifecycleEventMock,
      resolveAgentConfig: (cfg, agentId) =>
        (
          cfg as {
            agents?: {
              list?: Array<{ id?: string }>;
            };
          }
        ).agents?.list?.find((entry) => entry.id === agentId),
      resolveSubagentSpawnModelSelection: () => hoisted.resolvedModel,
      resolveSandboxRuntimeStatus: () => ({ sandboxed: hoisted.guardedSandbox }),
      sessionStorePath: "/tmp/subagent-spawn-session-store.json",
      resetModules: false,
    }));
  });

  it("keeps guarded assignment model and thinking out of the public session patch", () => {
    expect(
      subagentSpawnTesting.buildInitialChildSessionPatch({
        spawnDepth: 1,
        subagentRole: "leaf",
        subagentControlScope: "none",
        initialSessionPatch: {
          model: "openai-codex/gpt-5.6-sol",
          thinkingLevel: "xhigh",
        },
        guarded: true,
      }),
    ).toEqual({
      spawnDepth: 1,
      subagentRole: "leaf",
      subagentControlScope: "none",
    });

    expect(
      subagentSpawnTesting.buildInitialChildSessionPatch({
        spawnDepth: 1,
        subagentRole: "leaf",
        subagentControlScope: "none",
        initialSessionPatch: {
          model: "openai-codex/gpt-5.6-sol",
          thinkingLevel: "xhigh",
        },
        guarded: false,
      }),
    ).toMatchObject({
      model: "openai-codex/gpt-5.6-sol",
      thinkingLevel: "xhigh",
    });
  });

  it("injects the exact runtime-owned scope into guarded worker instructions", () => {
    const prompt = subagentSpawnTesting.buildProtectedDelegationAssignmentPrompt({
      assignmentId: "assignment_runtime_owned",
      purpose: "discovery",
      role: "helper",
      scopeUnits: [".openclaw/delegation-runtime-canary.txt", "src/example.ts"],
    });

    expect(prompt).toContain("assignment_runtime_owned");
    expect(prompt).toContain('[".openclaw/delegation-runtime-canary.txt","src/example.ts"]');
    expect(prompt).toContain("MUST exactly equal");
    expect(prompt).toContain("Do not add labels, aliases, descriptions");
  });

  beforeEach(async () => {
    routeHealthStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-spawn-"));
    process.env.OPENCLAW_STATE_DIR = routeHealthStateDir;
    resetChildRouteHealthForTest();
    resetSubagentRegistryForTests();
    hoisted.callGatewayMock.mockReset();
    hoisted.updateSessionStoreMock.mockReset();
    hoisted.pruneLegacyStoreKeysMock.mockReset();
    hoisted.registerSubagentRunMock.mockReset();
    hoisted.registerPendingSubagentTaskRunMock.mockReset();
    hoisted.failPendingSubagentTaskRunMock.mockReset();
    hoisted.assessSubagentSliceBudgetForSpawnMock.mockReset();
    hoisted.assessSubagentSliceBudgetForSpawnMock.mockReturnValue({
      ok: true,
      sliceKey: "test-slice",
    });
    hoisted.recordSubagentSliceRouteHealthUnavailableForSpawnMock.mockReset();
    hoisted.recordSubagentSliceRouteHealthUnavailableForSpawnMock.mockReturnValue({
      ok: true,
      sliceKey: "test-slice",
    });
    hoisted.emitSessionLifecycleEventMock.mockReset();
    hoisted.configOverride = createConfigOverride();
    hoisted.resolvedModel = "openai-codex/gpt-5.4";
    hoisted.guardedSandbox = false;
    installAcceptedSubagentGatewayMock(hoisted.callGatewayMock);

    hoisted.updateSessionStoreMock.mockImplementation(
      async (
        _storePath: string,
        mutator: (store: Record<string, Record<string, unknown>>) => unknown,
      ) => {
        const store: Record<string, Record<string, unknown>> = {};
        await mutator(store);
        return store;
      },
    );
  });

  afterEach(async () => {
    resetChildRouteHealthForTest();
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    if (routeHealthStateDir) {
      await fs.rm(routeHealthStateDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
      routeHealthStateDir = undefined;
    }
  });

  it("accepts a spawned run across session patching, runtime-model persistence, registry registration, and lifecycle emission", async () => {
    const operations: string[] = [];
    const persistedStores: Array<Record<string, Record<string, unknown>>> = [];

    hoisted.callGatewayMock.mockImplementation(async (request: { method?: string }) => {
      operations.push(`gateway:${request.method ?? "unknown"}`);
      if (request.method === "agent") {
        return { runId: "run-1" };
      }
      if (request.method?.startsWith("sessions.")) {
        return { ok: true };
      }
      return {};
    });
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock, {
      operations,
      onStore: (store) => {
        persistedStores.push({ ...store });
      },
    });

    const result = await spawnSubagentDirect(
      {
        task: "inspect the spawn seam",
        model: "openai-codex/gpt-5.4",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
        agentAccountId: "acct-1",
        agentTo: "user-1",
        agentThreadId: 42,
        workspaceDir: "/tmp/requester-workspace",
      },
    );

    expect(result).toMatchObject({
      status: "accepted",
      runId: "run-1",
      mode: "run",
      modelApplied: true,
    });
    expect(result.childSessionKey).toMatch(/^agent:main:subagent:/);

    const childSessionKey = result.childSessionKey as string;
    expect(hoisted.pruneLegacyStoreKeysMock).toHaveBeenCalledTimes(1);
    expect(hoisted.updateSessionStoreMock).toHaveBeenCalledTimes(2);
    expect(hoisted.registerSubagentRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        childSessionKey,
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "agent:main:main",
        requesterOrigin: {
          channel: "discord",
          accountId: "acct-1",
          to: "user-1",
          threadId: 42,
        },
        task: "inspect the spawn seam",
        cleanup: "keep",
        model: "openai-codex/gpt-5.4",
        workspaceDir: "/tmp/requester-workspace",
        expectsCompletionMessage: true,
        spawnMode: "run",
      }),
    );
    expect(hoisted.emitSessionLifecycleEventMock).toHaveBeenCalledWith({
      sessionKey: childSessionKey,
      reason: "create",
      parentSessionKey: "agent:main:main",
      label: undefined,
    });

    expectPersistedRuntimeModel({
      persistedStore: persistedStores.find((store) => childSessionKey in store),
      sessionKey: childSessionKey,
      provider: "openai-codex",
      model: "gpt-5.4",
    });
    expect(operations.indexOf("gateway:sessions.patch")).toBeGreaterThan(-1);
    expect(operations.indexOf("store:update")).toBeGreaterThan(
      operations.indexOf("gateway:sessions.patch"),
    );
    expect(operations.indexOf("gateway:agent")).toBeGreaterThan(operations.indexOf("store:update"));
    expect(hoisted.callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "agent",
        params: expect.objectContaining({
          sessionKey: childSessionKey,
          deliver: false,
          lane: "subagent",
        }),
      }),
    );
  });

  it("propagates exact one-use Gateway authority on a guarded initial spawn", async () => {
    const fixture = createLedgerFixture(["src/guarded-spawn.ts"]);
    try {
      await fs.mkdir(path.join(fixture.rootDir, "repo"), { recursive: true });
      process.env.OPENCLAW_STATE_DIR = fixture.stateDir;
      const config = createDelegationGuardTestConfig({
        rootDir: fixture.rootDir,
        validator: {
          entrypoint: fixture.validatorPath,
          sha256: fixture.guard.validator.sha256,
        },
      });
      if (!config.agents) {
        throw new Error("Missing delegation guard test configuration");
      }
      config.agents.delegationGuard = fixture.guard;
      const guardedModel = "openai-codex/gpt-5.6-sol";
      const helperConfig = config.agents.list?.find((entry) => entry.id === "helper");
      if (!helperConfig) {
        throw new Error("Missing helper agent configuration");
      }
      helperConfig.model = { primary: guardedModel, fallbacks: [] };
      hoisted.configOverride = config as Record<string, unknown>;
      hoisted.resolvedModel = guardedModel;
      hoisted.guardedSandbox = true;
      const issued = issueAssignment({
        fixture,
        purpose: "discovery",
        role: "helper",
        requiredModel: guardedModel,
      });
      const authorized = authorizeDelegationRoute({
        config,
        agentSessionKey: TEST_CONTROLLER.sessionKey,
        effectiveThinking: "xhigh",
        targetAgentId: "helper",
        delegationToken: issued.delegationToken,
        routeKind: "spawn",
      });
      if (!authorized) {
        throw new Error("Missing guarded spawn authorization");
      }
      let initialAgentParams: Record<string, unknown> | undefined;
      hoisted.callGatewayMock.mockImplementation(
        async (request: { method?: string; params?: Record<string, unknown> }) => {
          if (request.method === "agent") {
            initialAgentParams = request.params;
            return { runId: request.params?.idempotencyKey };
          }
          if (request.method?.startsWith("sessions.")) {
            return { ok: true };
          }
          return {};
        },
      );

      const result = await spawnSubagentDirect(
        {
          task: "run the protected helper assignment",
          delegationAssignmentId: issued.assignment.assignmentId,
          agentId: "helper",
          model: issued.assignment.requiredModel,
          thinking: issued.assignment.requiredThinking,
          sandbox: "require",
        },
        {
          agentSessionKey: TEST_CONTROLLER.sessionKey,
          requesterAgentIdOverride: TEST_CONTROLLER.agentId,
        },
      );

      expect(result.status, result.error).toBe("accepted");
      expect(result).toMatchObject({
        status: "accepted",
        modelApplied: true,
        childSessionKey: expect.stringMatching(/^agent:helper:subagent:/),
      });
      expect(initialAgentParams).toMatchObject({
        sessionKey: result.childSessionKey,
        idempotencyKey: result.runId,
        thinking: "xhigh",
        delegationGatewayDispatch: expect.any(String),
      });
      expect(initialAgentParams?.delegationGatewayDispatch).not.toBe(issued.delegationToken);
      expect(hoisted.assessSubagentSliceBudgetForSpawnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          delegationAssignmentId: issued.assignment.assignmentId,
          delegationSliceId: issued.assignment.sliceId,
          delegationEpoch: issued.assignment.epoch,
          targetAgentId: "helper",
          task: "run the protected helper assignment",
        }),
      );
      expect(hoisted.registerSubagentRunMock).toHaveBeenCalledWith(
        expect.objectContaining({
          delegationAssignmentId: issued.assignment.assignmentId,
          delegationSliceId: issued.assignment.sliceId,
          delegationEpoch: issued.assignment.epoch,
        }),
      );
      expect(
        fixture.ledger.resolveAssignmentForChildSession(result.childSessionKey ?? ""),
      ).toMatchObject({
        assignmentId: issued.assignment.assignmentId,
        requiredModel: guardedModel,
        requiredThinking: "xhigh",
      });
    } finally {
      fixture.close();
    }
  });

  it("deletes a rejected pre-execution child before starting its recovery assignment", async () => {
    const fixture = createLedgerFixture(["src/recovered-guarded-spawn.ts"]);
    try {
      await fs.mkdir(path.join(fixture.rootDir, "repo"), { recursive: true });
      process.env.OPENCLAW_STATE_DIR = fixture.stateDir;
      const config = createDelegationGuardTestConfig({
        rootDir: fixture.rootDir,
        validator: {
          entrypoint: fixture.validatorPath,
          sha256: fixture.guard.validator.sha256,
        },
      });
      if (!config.agents) {
        throw new Error("Missing delegation guard test configuration");
      }
      config.agents.delegationGuard = fixture.guard;
      const guardedModel = "openai-codex/gpt-5.6-sol";
      const helperConfig = config.agents.list?.find((entry) => entry.id === "helper");
      if (!helperConfig) {
        throw new Error("Missing helper agent configuration");
      }
      helperConfig.model = { primary: guardedModel, fallbacks: [] };
      hoisted.configOverride = config as Record<string, unknown>;
      hoisted.resolvedModel = guardedModel;
      hoisted.guardedSandbox = true;

      const rejected = issueAssignment({
        fixture,
        purpose: "discovery",
        role: "helper",
        requiredModel: guardedModel,
      });
      const rejectedAuthorization = authorizeDelegationRoute({
        config,
        agentSessionKey: TEST_CONTROLLER.sessionKey,
        effectiveThinking: "xhigh",
        targetAgentId: "helper",
        delegationToken: rejected.delegationToken,
        routeKind: "spawn",
      });
      if (!rejectedAuthorization) {
        throw new Error("Missing rejected guarded spawn authorization");
      }
      const rejectedChildSessionKey = "agent:helper:subagent:rejected-before-execution";
      const rejectedRunId = "rejected-before-execution";
      const rejectedDispatch = fixture.ledger.bindInitialSpawnWithGatewayDispatch({
        assignmentId: rejected.assignment.assignmentId,
        controllerSessionKey: TEST_CONTROLLER.sessionKey,
        childSessionKey: rejectedChildSessionKey,
        idempotencyKey: rejectedRunId,
      });
      fixture.ledger.consumeGatewayDispatchCapability({
        capability: rejectedDispatch.capability,
        controllerSessionKey: TEST_CONTROLLER.sessionKey,
        targetSessionKey: rejectedChildSessionKey,
        idempotencyKey: rejectedRunId,
      });
      fixture.ledger.recordGatewayDispatchOutcome({
        capability: rejectedDispatch.capability,
        controllerSessionKey: TEST_CONTROLLER.sessionKey,
        targetSessionKey: rejectedChildSessionKey,
        idempotencyKey: rejectedRunId,
        decision: "rejected",
        response: {
          message: "rejected before execution",
          retryable: false,
          details: { code: "test_pre_execution_rejection" },
        },
        rejectRoute: true,
      });
      const recovery = issueAssignment({
        fixture,
        purpose: "discovery",
        role: "helper",
        requiredModel: guardedModel,
        recoveryOfAssignmentId: rejected.assignment.assignmentId,
      });
      const recoveryAuthorization = authorizeDelegationRoute({
        config,
        agentSessionKey: TEST_CONTROLLER.sessionKey,
        effectiveThinking: "xhigh",
        targetAgentId: "helper",
        delegationToken: recovery.delegationToken,
        routeKind: "spawn",
      });
      if (!recoveryAuthorization) {
        throw new Error("Missing recovery guarded spawn authorization");
      }

      const result = await spawnSubagentDirect(
        {
          task: "recover the protected helper assignment",
          delegationAssignmentId: recovery.assignment.assignmentId,
          agentId: "helper",
          model: recovery.assignment.requiredModel,
          thinking: recovery.assignment.requiredThinking,
          sandbox: "require",
        },
        {
          agentSessionKey: TEST_CONTROLLER.sessionKey,
          requesterAgentIdOverride: TEST_CONTROLLER.agentId,
        },
      );

      expect(result.status, result.error).toBe("accepted");
      expect(
        hoisted.callGatewayMock.mock.calls.some(
          ([request]) =>
            (request as { method?: string; params?: { key?: string } }).method ===
              "sessions.delete" &&
            (request as { params?: { key?: string } }).params?.key === rejectedChildSessionKey,
        ),
      ).toBe(true);
      expect(fixture.ledger.listRejectedInitialSpawnCleanupTargets()).toEqual([]);
    } finally {
      fixture.close();
    }
  });

  it("terminally rejects and cleans a guarded initial spawn that fails before execution", async () => {
    const fixture = createLedgerFixture(["src/rejected-guarded-spawn.ts"]);
    try {
      await fs.mkdir(path.join(fixture.rootDir, "repo"), { recursive: true });
      process.env.OPENCLAW_STATE_DIR = fixture.stateDir;
      const config = createDelegationGuardTestConfig({
        rootDir: fixture.rootDir,
        validator: {
          entrypoint: fixture.validatorPath,
          sha256: fixture.guard.validator.sha256,
        },
      });
      if (!config.agents) {
        throw new Error("Missing delegation guard test configuration");
      }
      config.agents.delegationGuard = fixture.guard;
      const guardedModel = "openai-codex/gpt-5.6-sol";
      const helperConfig = config.agents.list?.find((entry) => entry.id === "helper");
      if (!helperConfig) {
        throw new Error("Missing helper agent configuration");
      }
      helperConfig.model = { primary: guardedModel, fallbacks: [] };
      hoisted.configOverride = config as Record<string, unknown>;
      hoisted.resolvedModel = guardedModel;
      hoisted.guardedSandbox = true;
      const issued = issueAssignment({
        fixture,
        purpose: "discovery",
        role: "helper",
        requiredModel: guardedModel,
      });
      const authorized = authorizeDelegationRoute({
        config,
        agentSessionKey: TEST_CONTROLLER.sessionKey,
        effectiveThinking: "xhigh",
        targetAgentId: "helper",
        delegationToken: issued.delegationToken,
        routeKind: "spawn",
      });
      if (!authorized) {
        throw new Error("Missing guarded spawn authorization");
      }
      hoisted.callGatewayMock.mockImplementation(
        async (request: { method?: string; params?: Record<string, unknown> }) => {
          if (request.method === "agent") {
            expect(request.params?.delegationGatewayDispatch).toEqual(expect.any(String));
            throw new Error(
              "guarded child routes require their exact delegation Gateway capability",
            );
          }
          if (request.method?.startsWith("sessions.")) {
            return { ok: true };
          }
          return {};
        },
      );

      const result = await spawnSubagentDirect(
        {
          task: "reject before protected execution",
          delegationAssignmentId: issued.assignment.assignmentId,
          agentId: "helper",
          model: issued.assignment.requiredModel,
          thinking: issued.assignment.requiredThinking,
          sandbox: "require",
        },
        {
          agentSessionKey: TEST_CONTROLLER.sessionKey,
          requesterAgentIdOverride: TEST_CONTROLLER.agentId,
        },
      );

      expect(result.childSessionKey, result.error).toMatch(/^agent:helper:subagent:/);
      expect(result).toMatchObject({
        status: "error",
        childSessionKey: expect.stringMatching(/^agent:helper:subagent:/),
        runId: expect.any(String),
      });
      expect(result.error).toContain(
        "guarded child routes require their exact delegation Gateway capability",
      );
      expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();
      expect(hoisted.recordSubagentSliceRouteHealthUnavailableForSpawnMock).not.toHaveBeenCalled();
      expect(hoisted.registerPendingSubagentTaskRunMock).toHaveBeenCalledWith(
        expect.objectContaining({
          pendingRunId: result.runId,
          childSessionKey: result.childSessionKey,
        }),
      );
      expect(hoisted.failPendingSubagentTaskRunMock).toHaveBeenCalledWith(
        expect.objectContaining({
          pendingRunId: result.runId,
          error: expect.stringContaining(
            "guarded child routes require their exact delegation Gateway capability",
          ),
        }),
      );
      expect(
        hoisted.callGatewayMock.mock.calls.some(
          ([request]) =>
            (request as { method?: string; params?: { key?: string } }).method ===
              "sessions.delete" &&
            (request as { params?: { key?: string } }).params?.key === result.childSessionKey,
        ),
      ).toBe(true);
      expect(
        unsafeDatabaseForTest(fixture.ledger)
          .prepare(
            `SELECT kind FROM route_events
             WHERE assignment_id = ? AND kind = 'route_rejected'`,
          )
          .get(issued.assignment.assignmentId),
      ).toEqual({ kind: "route_rejected" });
      expect(() =>
        fixture.ledger.rollback({
          actorAgentId: TEST_CONTROLLER.agentId,
          reason: "rejected initial spawn no longer blocks rollback",
        }),
      ).not.toThrow();
    } finally {
      fixture.close();
    }
  });

  it("terminally settles a guarded spawn that fails before assignment binding", async () => {
    const fixture = createLedgerFixture(["src/prebinding-guarded-spawn.ts"]);
    try {
      await fs.mkdir(path.join(fixture.rootDir, "repo"), { recursive: true });
      process.env.OPENCLAW_STATE_DIR = fixture.stateDir;
      const config = createDelegationGuardTestConfig({
        rootDir: fixture.rootDir,
        validator: {
          entrypoint: fixture.validatorPath,
          sha256: fixture.guard.validator.sha256,
        },
      });
      if (!config.agents) {
        throw new Error("Missing delegation guard test configuration");
      }
      config.agents.delegationGuard = fixture.guard;
      const guardedModel = "openai-codex/gpt-5.6-sol";
      const helperConfig = config.agents.list?.find((entry) => entry.id === "helper");
      if (!helperConfig) {
        throw new Error("Missing helper agent configuration");
      }
      helperConfig.model = { primary: guardedModel, fallbacks: [] };
      hoisted.configOverride = config as Record<string, unknown>;
      hoisted.resolvedModel = guardedModel;
      hoisted.guardedSandbox = true;
      const issued = issueAssignment({
        fixture,
        purpose: "discovery",
        role: "helper",
        requiredModel: guardedModel,
      });
      const authorized = authorizeDelegationRoute({
        config,
        agentSessionKey: TEST_CONTROLLER.sessionKey,
        effectiveThinking: "xhigh",
        targetAgentId: "helper",
        delegationToken: issued.delegationToken,
        routeKind: "spawn",
      });
      if (!authorized) {
        throw new Error("Missing guarded spawn authorization");
      }
      hoisted.callGatewayMock.mockImplementation(
        async (request: { method?: string; params?: Record<string, unknown> }) => {
          if (request.method === "sessions.patch") {
            throw new Error("protected initial patch failed");
          }
          if (request.method === "sessions.delete") {
            return { ok: true };
          }
          if (request.method === "agent") {
            throw new Error("agent execution must not start");
          }
          return {};
        },
      );

      const result = await spawnSubagentDirect(
        {
          task: "fail before protected assignment binding",
          delegationAssignmentId: issued.assignment.assignmentId,
          agentId: "helper",
          model: issued.assignment.requiredModel,
          thinking: issued.assignment.requiredThinking,
          sandbox: "require",
        },
        {
          agentSessionKey: TEST_CONTROLLER.sessionKey,
          requesterAgentIdOverride: TEST_CONTROLLER.agentId,
        },
      );

      expect(result).toMatchObject({
        status: "error",
        childSessionKey: expect.stringMatching(/^agent:helper:subagent:/),
      });
      expect(result.error).toContain("protected initial patch failed");
      expect(hoisted.registerPendingSubagentTaskRunMock).not.toHaveBeenCalled();
      expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();
      expect(hoisted.recordSubagentSliceRouteHealthUnavailableForSpawnMock).not.toHaveBeenCalled();
      expect(
        unsafeDatabaseForTest(fixture.ledger)
          .prepare(
            `SELECT kind FROM route_events
             WHERE assignment_id = ? AND kind = 'route_rejected'`,
          )
          .get(issued.assignment.assignmentId),
      ).toEqual({ kind: "route_rejected" });
      expect(() =>
        fixture.ledger.rollback({
          actorAgentId: TEST_CONTROLLER.agentId,
          reason: "pre-binding guarded failure no longer blocks rollback",
        }),
      ).not.toThrow();
    } finally {
      fixture.close();
    }
  });

  it("terminally settles a guarded spawn when atomic assignment binding fails", async () => {
    const fixture = createLedgerFixture(["src/bind-failure-guarded-spawn.ts"]);
    try {
      await fs.mkdir(path.join(fixture.rootDir, "repo"), { recursive: true });
      process.env.OPENCLAW_STATE_DIR = fixture.stateDir;
      const config = createDelegationGuardTestConfig({
        rootDir: fixture.rootDir,
        validator: {
          entrypoint: fixture.validatorPath,
          sha256: fixture.guard.validator.sha256,
        },
      });
      if (!config.agents) {
        throw new Error("Missing delegation guard test configuration");
      }
      config.agents.delegationGuard = fixture.guard;
      const guardedModel = "openai-codex/gpt-5.6-sol";
      const helperConfig = config.agents.list?.find((entry) => entry.id === "helper");
      if (!helperConfig) {
        throw new Error("Missing helper agent configuration");
      }
      helperConfig.model = { primary: guardedModel, fallbacks: [] };
      hoisted.configOverride = config as Record<string, unknown>;
      hoisted.resolvedModel = guardedModel;
      hoisted.guardedSandbox = true;
      const issued = issueAssignment({
        fixture,
        purpose: "discovery",
        role: "helper",
        requiredModel: guardedModel,
      });
      const authorized = authorizeDelegationRoute({
        config,
        agentSessionKey: TEST_CONTROLLER.sessionKey,
        effectiveThinking: "xhigh",
        targetAgentId: "helper",
        delegationToken: issued.delegationToken,
        routeKind: "spawn",
      });
      if (!authorized) {
        throw new Error("Missing guarded spawn authorization");
      }
      vi.spyOn(fixture.ledger, "bindInitialSpawnWithGatewayDispatch").mockImplementationOnce(() => {
        throw new Error("simulated atomic bind failure");
      });
      hoisted.callGatewayMock.mockImplementation(
        async (request: { method?: string; params?: Record<string, unknown> }) => {
          if (request.method?.startsWith("sessions.")) {
            return { ok: true };
          }
          if (request.method === "agent") {
            throw new Error("agent execution must not start");
          }
          return {};
        },
      );

      const result = await spawnSubagentDirect(
        {
          task: "fail during protected assignment binding",
          delegationAssignmentId: issued.assignment.assignmentId,
          agentId: "helper",
          model: issued.assignment.requiredModel,
          thinking: issued.assignment.requiredThinking,
          sandbox: "require",
        },
        {
          agentSessionKey: TEST_CONTROLLER.sessionKey,
          requesterAgentIdOverride: TEST_CONTROLLER.agentId,
        },
      );

      expect(result).toMatchObject({
        status: "error",
        childSessionKey: expect.stringMatching(/^agent:helper:subagent:/),
      });
      expect(result.error).toContain("simulated atomic bind failure");
      expect(hoisted.registerPendingSubagentTaskRunMock).toHaveBeenCalledOnce();
      expect(hoisted.failPendingSubagentTaskRunMock).toHaveBeenCalledOnce();
      expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();
      expect(hoisted.recordSubagentSliceRouteHealthUnavailableForSpawnMock).not.toHaveBeenCalled();
      expect(
        unsafeDatabaseForTest(fixture.ledger)
          .prepare(
            `SELECT kind FROM route_events
             WHERE assignment_id = ? AND kind = 'route_rejected'`,
          )
          .get(issued.assignment.assignmentId),
      ).toEqual({ kind: "route_rejected" });
      expect(() =>
        fixture.ledger.rollback({
          actorAgentId: TEST_CONTROLLER.agentId,
          reason: "atomic bind failure no longer blocks rollback",
        }),
      ).not.toThrow();
    } finally {
      fixture.close();
    }
  });

  it("omits requesterOrigin threadId when no requester thread is provided", async () => {
    hoisted.callGatewayMock.mockImplementation(async (request: { method?: string }) => {
      if (request.method === "agent") {
        return { runId: "run-1" };
      }
      if (request.method?.startsWith("sessions.")) {
        return { ok: true };
      }
      return {};
    });
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock);

    const result = await spawnSubagentDirect(
      {
        task: "inspect unthreaded spawn",
        model: "openai-codex/gpt-5.4",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
        agentAccountId: "acct-1",
        agentTo: "user-1",
      },
    );

    expect(result.status).toBe("accepted");
    const registerInput = hoisted.registerSubagentRunMock.mock.calls[0]?.[0];
    expect(registerInput?.requesterOrigin).toMatchObject({
      channel: "discord",
      accountId: "acct-1",
      to: "user-1",
    });
    expect(
      (registerInput?.requesterOrigin as { threadId?: unknown } | undefined)?.threadId,
    ).toBeUndefined();
  });

  it("pins admin-only methods to operator.admin and preserves least-privilege for others (#59428)", async () => {
    const capturedCalls: Array<{ method?: string; scopes?: string[] }> = [];

    hoisted.callGatewayMock.mockImplementation(
      async (request: { method?: string; scopes?: string[] }) => {
        capturedCalls.push({ method: request.method, scopes: request.scopes });
        if (request.method === "agent") {
          return { runId: "run-1" };
        }
        if (request.method?.startsWith("sessions.")) {
          return { ok: true };
        }
        return {};
      },
    );
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock);

    const result = await spawnSubagentDirect(
      {
        task: "verify per-method scope routing",
        model: "openai-codex/gpt-5.4",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
        agentAccountId: "acct-1",
        agentTo: "user-1",
        workspaceDir: "/tmp/requester-workspace",
      },
    );

    expect(result.status).toBe("accepted");
    expect(capturedCalls.length).toBeGreaterThan(0);

    for (const call of capturedCalls) {
      if (call.method === "sessions.patch" || call.method === "sessions.delete") {
        // Admin-only methods must be pinned to operator.admin.
        expect(call.scopes).toEqual(["operator.admin"]);
      } else {
        // Non-admin methods (e.g. "agent") must NOT be forced to admin scope
        // so the gateway preserves least-privilege and senderIsOwner stays false.
        expect(call.scopes).toBeUndefined();
      }
    }
  });

  it("forwards normalized thinking to the agent run", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    hoisted.callGatewayMock.mockImplementation(
      async (request: { method?: string; params?: unknown }) => {
        calls.push(request);
        if (request.method === "agent") {
          return { runId: "run-thinking", status: "accepted", acceptedAt: 1000 };
        }
        if (request.method?.startsWith("sessions.")) {
          return { ok: true };
        }
        return {};
      },
    );
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock);

    const result = await spawnSubagentDirect(
      {
        task: "verify thinking forwarding",
        thinking: "high",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
      },
    );

    expect(result).toMatchObject({
      status: "accepted",
    });
    const agentCall = calls.find((call) => call.method === "agent");
    expect(agentCall?.params).toMatchObject({
      thinking: "high",
    });
  });

  it("passes planner slice role guidance into child prompt and task message", async () => {
    const calls: Array<{ method?: string; params?: Record<string, unknown> }> = [];
    hoisted.callGatewayMock.mockImplementation(
      async (request: { method?: string; params?: Record<string, unknown> }) => {
        calls.push(request);
        if (request.method === "agent") {
          return { runId: "run-qa" };
        }
        if (request.method?.startsWith("sessions.")) {
          return { ok: true };
        }
        return {};
      },
    );
    installSessionStoreCaptureMock(hoisted.updateSessionStoreMock);

    const result = await spawnSubagentDirect(
      {
        task: "QA the feature without broad gates",
        sliceRole: "qa",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
      },
    );

    expect(result).toMatchObject({ status: "accepted" });
    const agentCall = calls.find((call) => call.method === "agent");
    const rawMessage = agentCall?.params?.message;
    const rawExtraSystemPrompt = agentCall?.params?.extraSystemPrompt;
    const message = typeof rawMessage === "string" ? rawMessage : "";
    const extraSystemPrompt = typeof rawExtraSystemPrompt === "string" ? rawExtraSystemPrompt : "";
    expect(message).toContain("[Child Slice Role]: qa");
    expect(message).toContain("smallest relevant smoke command only");
    expect(message).toContain("Do not run the full E2E suite");
    expect(extraSystemPrompt).toContain("Role: qa.");
    expect(extraSystemPrompt).toContain("smallest relevant smoke command only");
    expect(extraSystemPrompt).toContain("Do not run the full E2E suite");
  });

  it("returns an error when the initial model patch is rejected", async () => {
    hoisted.callGatewayMock.mockImplementation(
      async (request: { method?: string; params?: unknown }) => {
        if (request.method === "sessions.patch") {
          const model = (request.params as { model?: unknown } | undefined)?.model;
          if (model === "bad-model") {
            throw new Error("invalid model: bad-model");
          }
          return { ok: true };
        }
        if (request.method === "agent") {
          return { runId: "run-1", status: "accepted", acceptedAt: 1000 };
        }
        if (request.method === "sessions.delete") {
          return { ok: true };
        }
        return {};
      },
    );

    const result = await spawnSubagentDirect(
      {
        task: "verify patch rejection",
        model: "bad-model",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
      },
    );

    expect(result).toMatchObject({
      status: "error",
      childSessionKey: expect.stringMatching(/^agent:main:subagent:/),
    });
    expect(result.error ?? "").toContain("invalid model");
    expect(
      hoisted.callGatewayMock.mock.calls.some(
        (call) => (call[0] as { method?: string }).method === "agent",
      ),
    ).toBe(false);
  });

  it("records failed pending-spawn state when the first child patch is rejected", async () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-spawn-pending-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    try {
      hoisted.callGatewayMock.mockImplementation(
        async (request: { method?: string; params?: unknown }) => {
          if (request.method === "sessions.patch") {
            throw new Error("initial patch rejected");
          }
          if (request.method === "sessions.delete") {
            return { ok: true };
          }
          if (request.method === "agent") {
            return { runId: "run-unexpected" };
          }
          return {};
        },
      );

      const result = await spawnSubagentDirect(
        {
          task: "verify pending-spawn before patch",
        },
        {
          agentSessionKey: "agent:main:main",
          agentChannel: "discord",
        },
      );

      expect(result).toMatchObject({
        status: "error",
        childSessionKey: expect.stringMatching(/^agent:main:subagent:/),
      });
      expect(result.error ?? "").toContain("initial patch rejected");
      expect(
        hoisted.callGatewayMock.mock.calls.some(
          (call) => (call[0] as { method?: string }).method === "agent",
        ),
      ).toBe(false);

      const routeHealth = JSON.parse(await fs.readFile(resolveChildRouteHealthPath(), "utf8")) as {
        pendingSpawns?: Record<
          string,
          {
            childSessionKey?: string;
            requesterSessionKey?: string;
            failedAt?: number;
            cleanupAttemptedAt?: number;
          }
        >;
      };
      const pending = Object.values(routeHealth.pendingSpawns ?? {});
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        childSessionKey: result.childSessionKey,
        requesterSessionKey: "agent:main:main",
        failedAt: expect.any(Number),
        cleanupAttemptedAt: expect.any(Number),
      });
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
