import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createRunningTaskRun,
  findTaskRunByExactScope,
  findTaskRunByRunId,
} from "../../tasks/task-executor.js";
import { resetTaskRegistryForTests } from "../../tasks/task-registry.js";
import { configureTaskRegistryRuntime } from "../../tasks/task-registry.store.js";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import type { DelegationAssignmentRecord, DelegationFingerprint } from "./contracts.js";
import { resolveGuardedDelegationExecution } from "./execution.js";
import { reconcileDelegationGatewayTerminalTaskAfterRestart } from "./gateway-task-reconciliation.js";
import { unsafeDatabaseForTest } from "./ledger.test-helpers.js";
import { resolveDelegationPolicyDigest } from "./policy.js";
import {
  appendDelegationRouteEvent,
  authorizeDelegationRoute,
  bindDelegationRoute,
  consumeDelegationGatewayDispatch,
  issueDelegationGatewayDispatch,
  reconcileDelegationGatewayTaskAfterRestart,
  reconcileDelegationInitialSpawnTaskAfterRestart,
  recordDelegationGatewayDispatchEnqueued,
  type DelegationRuntime,
  resolveDelegationRuntime,
} from "./runtime.js";
import { canonicalizeDelegationScope } from "./scope.js";
import { createDelegationGuardTestConfig, installDelegationTestValidator } from "./test-helpers.js";

vi.mock("../../plugins/provider-thinking.js", () => ({
  resolveProviderBinaryThinking: () => undefined,
  resolveProviderDefaultThinkingLevel: () => undefined,
  resolveProviderThinkingProfile: () => undefined,
  resolveProviderXHighThinking: () => true,
}));

const PLANNER_SESSION = "agent:planner:main";
const PLANNER_2_SESSION = "agent:planner2:main";
const HELPER_MODEL = "openai/gpt-5.4";
const CHILD_SESSION = "agent:helper:subagent:child-1";

let rootDir: string;
let originalStateDir: string | undefined;
let config: OpenClawConfig;
let runtime: DelegationRuntime;
let sliceCounter = 0;

function requireGuard() {
  const guard = config.agents?.delegationGuard;
  if (!guard) {
    throw new Error("Missing delegation guard fixture");
  }
  return guard;
}

function issueHelperAssignment(): {
  assignment: DelegationAssignmentRecord;
  delegationToken: string;
} {
  sliceCounter += 1;
  const scope = canonicalizeDelegationScope({
    version: "openclaw-scope-v1",
    kind: "slice",
    entries: [{ path: `src/delegation-${sliceCounter}.ts`, expectation: "may-create" }],
  });
  const guard = requireGuard();
  const epoch = runtime.ledger.currentEpoch();
  const fingerprint: DelegationFingerprint = {
    contractVersion: "openclaw-delegation-v1",
    candidateId: `fingerprint-${sliceCounter}`,
    candidateDigest: String(sliceCounter).padStart(64, "a"),
    contextDigest: String(sliceCounter).padStart(64, "b"),
    scopeDigest: scope.scopeDigest,
    worktreeIdentity: "test-worktree",
    head: "0".repeat(40),
    epoch,
    pathCount: 1,
    dirtyCount: 0,
    validatorId: guard.validator.id,
    validatorVersion: guard.validator.version,
    validatorDigest: guard.validator.sha256,
    policyDigest: resolveDelegationPolicyDigest(guard),
    truncated: false,
  };
  const baseline = runtime.ledger.createSliceWithBaseline({
    controllerAgentId: "planner",
    controllerSessionKey: PLANNER_SESSION,
    repositoryRoot: rootDir,
    scope,
    fingerprint,
  });
  return runtime.ledger.issueAssignment({
    sliceId: baseline.sliceId,
    controllerAgentId: "planner",
    controllerSessionKey: PLANNER_SESSION,
    workerAgentId: "helper",
    role: "helper",
    requiredThinking: "xhigh",
    requiredModel: HELPER_MODEL,
    workspaceAccess: "ro",
    purpose: "discovery",
  });
}

function authorizeHelperSpawn(delegationToken: string) {
  return authorizeDelegationRoute({
    config,
    agentSessionKey: PLANNER_SESSION,
    effectiveThinking: "xhigh",
    targetAgentId: "helper",
    delegationToken,
    routeKind: "spawn",
  });
}

function prepareHelperSendToken(childSessionKey = CHILD_SESSION) {
  const issued = issueHelperAssignment();
  const spawn = authorizeHelperSpawn(issued.delegationToken);
  bindDelegationRoute({ authorized: spawn, childSessionKey, runId: `run-${sliceCounter}` });
  appendDelegationRouteEvent({
    authorized: spawn,
    kind: "accepted",
    childSessionKey,
    runId: `run-${sliceCounter}`,
  });
  const delegationToken = runtime.ledger.issueRouteToken({
    assignmentId: issued.assignment.assignmentId,
    controllerAgentId: "planner",
    controllerSessionKey: PLANNER_SESSION,
    routeKind: "send",
    targetSessionKey: childSessionKey,
  });
  return { issued, childSessionKey, delegationToken };
}

function prepareHelperSendRoute(childSessionKey = CHILD_SESSION, idempotencyKey?: string) {
  const prepared = prepareHelperSendToken(childSessionKey);
  const resolvedIdempotencyKey = idempotencyKey ?? `gateway-dispatch-${sliceCounter}`;
  const authorized = authorizeDelegationRoute({
    config,
    agentSessionKey: PLANNER_SESSION,
    effectiveThinking: "xhigh",
    targetAgentId: "helper",
    targetThinking: "xhigh",
    targetModel: HELPER_MODEL,
    targetSessionKey: childSessionKey,
    delegationToken: prepared.delegationToken,
    idempotencyKey: resolvedIdempotencyKey,
    routeKind: "send",
  });
  if (!authorized) {
    throw new Error("Expected guarded send authorization");
  }
  return {
    issued: prepared.issued,
    authorized,
    childSessionKey,
    idempotencyKey: resolvedIdempotencyKey,
  };
}

function settleAllOpenAssignmentsBeforeEpochTransition() {
  const db = unsafeDatabaseForTest(runtime.ledger);
  const rows = db
    .prepare(
      `SELECT a.assignment_id,
              EXISTS(
                SELECT 1 FROM route_events accepted
                WHERE accepted.assignment_id = a.assignment_id AND accepted.kind = 'accepted'
              ) AS accepted
       FROM assignments a
       WHERE a.epoch = ?
         AND NOT EXISTS (
           SELECT 1 FROM route_events terminal
           WHERE terminal.assignment_id = a.assignment_id
             AND terminal.kind IN ('route_rejected', 'validation_rejected', 'timeout', 'completed')
         )`,
    )
    .all(runtime.ledger.currentEpoch()) as Array<{
    assignment_id: string;
    accepted: number | bigint;
  }>;
  for (const row of rows) {
    runtime.ledger.appendRouteEvent({
      assignmentId: row.assignment_id,
      kind: Number(row.accepted) === 1 ? "validation_rejected" : "route_rejected",
      payload: { reason: "test epoch quiescence" },
    });
  }
}

beforeAll(() => {
  rootDir = realpathSync(mkdtempSync(path.join(tmpdir(), "openclaw-delegation-routing-")));
  originalStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = path.join(rootDir, "state");
  const validator = installDelegationTestValidator(rootDir);
  config = createDelegationGuardTestConfig({ rootDir, validator });
  const resolved = resolveDelegationRuntime(config);
  if (!resolved) {
    throw new Error("Expected delegation runtime fixture");
  }
  runtime = resolved;
});

afterAll(() => {
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
  rmSync(rootDir, { recursive: true, force: true });
});

describe("guarded route authorization", () => {
  it("treats active prior-writer tasks as uncertain and never invents a failure", () => {
    let status: TaskRecord["status"] = "running";
    const task = (): TaskRecord => ({
      taskId: "guarded-restart-task",
      runtime: "cli",
      requesterSessionKey: PLANNER_SESSION,
      ownerKey: CHILD_SESSION,
      scopeKind: "session",
      childSessionKey: CHILD_SESSION,
      runId: "guarded-restart-run",
      task: "continue guarded work",
      status,
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      createdAt: 1,
    });
    expect(
      reconcileDelegationGatewayTaskAfterRestart(
        { runId: "guarded-restart-run", targetSessionKey: CHILD_SESSION, requiredTask: true },
        {
          assertReady: () => {},
          findTask: () => task(),
        },
      ),
    ).toBe("uncertain");
    expect(status).toBe("running");
    expect(
      reconcileDelegationGatewayTaskAfterRestart(
        { runId: "guarded-restart-run", targetSessionKey: CHILD_SESSION, requiredTask: false },
        {
          assertReady: () => {},
          findTask: () => task(),
        },
      ),
    ).toBe("interrupted");
    expect(status).toBe("running");

    status = "succeeded";
    expect(
      reconcileDelegationGatewayTaskAfterRestart(
        { runId: "guarded-restart-run", targetSessionKey: CHILD_SESSION, requiredTask: true },
        {
          assertReady: () => {},
          findTask: () => task(),
        },
      ),
    ).toBe("completed");

    status = "failed";
    expect(
      reconcileDelegationGatewayTaskAfterRestart(
        { runId: "guarded-restart-run", targetSessionKey: CHILD_SESSION, requiredTask: true },
        { assertReady: () => {}, findTask: () => task() },
      ),
    ).toBe("interrupted");
  });

  it("fails closed when durable task-store restore is unavailable", () => {
    resetTaskRegistryForTests({ persist: false });
    configureTaskRegistryRuntime({
      store: {
        loadSnapshot: () => {
          throw new Error("simulated task store load failure");
        },
        saveSnapshot: () => {},
      },
    });
    try {
      expect(() =>
        reconcileDelegationGatewayTaskAfterRestart({
          runId: "guarded-missing-store-run",
          targetSessionKey: CHILD_SESSION,
          requiredTask: false,
        }),
      ).toThrow("Task registry durable state is unavailable");
    } finally {
      resetTaskRegistryForTests({ persist: false });
    }
  });

  it("terminalizes a durable legacy initial-spawn task as pre-execution failure", () => {
    resetTaskRegistryForTests({ persist: false });
    try {
      const runId = "legacy-initial-spawn-task";
      createRunningTaskRun({
        runtime: "subagent",
        sourceId: runId,
        ownerKey: PLANNER_SESSION,
        scopeKind: "session",
        childSessionKey: CHILD_SESSION,
        runId,
        task: "legacy guarded initial spawn",
        deliveryStatus: "not_applicable",
        startedAt: Date.now(),
      });

      expect(
        reconcileDelegationInitialSpawnTaskAfterRestart({
          runId,
          targetSessionKey: CHILD_SESSION,
        }),
      ).toBe("interrupted");
      expect(findTaskRunByRunId(runId)).toMatchObject({
        runtime: "subagent",
        status: "failed",
        childSessionKey: CHILD_SESSION,
      });
    } finally {
      resetTaskRegistryForTests({ persist: false });
    }
  });

  it("reconciles exact Gateway and subagent tasks when an initial spawn shares one run id", () => {
    resetTaskRegistryForTests({ persist: false });
    try {
      const runId = "guarded-composed-shared-run";
      const subagentTask = createRunningTaskRun({
        runtime: "subagent",
        sourceId: runId,
        ownerKey: PLANNER_SESSION,
        scopeKind: "session",
        childSessionKey: CHILD_SESSION,
        runId,
        task: "protected initial spawn",
        deliveryStatus: "not_applicable",
        startedAt: Date.now(),
      });
      const gatewayTask = createRunningTaskRun({
        runtime: "cli",
        sourceId: runId,
        ownerKey: CHILD_SESSION,
        scopeKind: "session",
        childSessionKey: CHILD_SESSION,
        runId,
        task: "protected Gateway execution",
        deliveryStatus: "not_applicable",
        startedAt: Date.now(),
      });

      expect(subagentTask.taskId).not.toBe(gatewayTask.taskId);
      expect(findTaskRunByRunId(runId)?.runtime).toBe("subagent");
      expect(
        reconcileDelegationGatewayTaskAfterRestart({
          runId,
          targetSessionKey: CHILD_SESSION,
          requiredTask: true,
        }),
      ).toBe("uncertain");
      expect(
        reconcileDelegationInitialSpawnTaskAfterRestart({
          runId,
          targetSessionKey: CHILD_SESSION,
        }),
      ).toBe("interrupted");
      expect(
        findTaskRunByExactScope({
          runId,
          runtime: "subagent",
          childSessionKey: CHILD_SESSION,
        }),
      ).toMatchObject({ taskId: subagentTask.taskId, status: "failed" });
      expect(
        findTaskRunByExactScope({
          runId,
          runtime: "cli",
          childSessionKey: CHILD_SESSION,
        }),
      ).toMatchObject({ taskId: gatewayTask.taskId, status: "running" });

      reconcileDelegationGatewayTerminalTaskAfterRestart({
        runId,
        targetSessionKey: CHILD_SESSION,
        terminalKind: "route_rejected",
      });
      expect(
        findTaskRunByExactScope({
          runId,
          runtime: "cli",
          childSessionKey: CHILD_SESSION,
        }),
      ).toMatchObject({ taskId: gatewayTask.taskId, status: "failed" });
    } finally {
      resetTaskRegistryForTests({ persist: false });
    }
  });

  it("does not write a failure while completion accounting is uncertain", () => {
    const runningTask: TaskRecord = {
      taskId: "guarded-terminal-write-task",
      runtime: "cli",
      requesterSessionKey: PLANNER_SESSION,
      ownerKey: CHILD_SESSION,
      scopeKind: "session",
      childSessionKey: CHILD_SESSION,
      runId: "guarded-terminal-write-run",
      task: "continue guarded work",
      status: "running",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      createdAt: 1,
    };
    resetTaskRegistryForTests({ persist: false });
    configureTaskRegistryRuntime({
      store: {
        loadSnapshot: () => ({
          tasks: new Map([[runningTask.taskId, runningTask]]),
          deliveryStates: new Map(),
        }),
        saveSnapshot: () => {},
        upsertTask: () => {
          throw new Error("simulated task terminal write failure");
        },
      },
    });
    try {
      expect(
        reconcileDelegationGatewayTaskAfterRestart({
          runId: runningTask.runId!,
          targetSessionKey: CHILD_SESSION,
          requiredTask: true,
        }),
      ).toBe("uncertain");
      expect(findTaskRunByRunId(runningTask.runId!)?.status).toBe("running");
      expect(
        reconcileDelegationGatewayTaskAfterRestart({
          runId: runningTask.runId!,
          targetSessionKey: CHILD_SESSION,
          requiredTask: true,
        }),
      ).toBe("uncertain");
      expect(findTaskRunByRunId(runningTask.runId!)?.status).toBe("running");
    } finally {
      resetTaskRegistryForTests({ persist: false });
    }
  });

  it("requires a durable task only after accepted dispatch proof", () => {
    expect(() =>
      reconcileDelegationGatewayTaskAfterRestart(
        { runId: "missing-required-run", targetSessionKey: CHILD_SESSION, requiredTask: true },
        { assertReady: () => {}, findTask: () => undefined },
      ),
    ).toThrow("required durable task record");
    expect(() =>
      reconcileDelegationGatewayTaskAfterRestart(
        { runId: "missing-pre-enqueue-run", targetSessionKey: CHILD_SESSION, requiredTask: false },
        { assertReady: () => {}, findTask: () => undefined },
      ),
    ).not.toThrow();
  });

  it("preserves legacy unguarded routes without opening protected authority", () => {
    expect(
      authorizeDelegationRoute({
        config: { agents: { list: [{ id: "main" }, { id: "worker" }] } },
        agentSessionKey: "agent:main:main",
        targetAgentId: "worker",
        routeKind: "spawn",
      }),
    ).toBeUndefined();
  });

  it("blocks a guarded worker main session that has no runtime assignment", () => {
    expect(() =>
      resolveGuardedDelegationExecution({
        config,
        sessionKey: "agent:helper:main",
        agentId: "helper",
        provider: "openai",
        model: "gpt-5.4",
        thinking: "xhigh",
        workspaceDir: rootDir,
      }),
    ).toThrow(/cannot execute outside a runtime-bound assignment/i);
  });

  it("binds guarded execution to the protected slice worktree", () => {
    const issued = issueHelperAssignment();
    const childSessionKey = `agent:helper:subagent:workspace-${sliceCounter}`;
    const authorized = authorizeHelperSpawn(issued.delegationToken);
    bindDelegationRoute({ authorized, childSessionKey, runId: `run-${sliceCounter}` });
    appendDelegationRouteEvent({
      authorized,
      kind: "accepted",
      childSessionKey,
      runId: `run-${sliceCounter}`,
    });

    expect(
      resolveGuardedDelegationExecution({
        config,
        sessionKey: childSessionKey,
        agentId: "helper",
        provider: "openai",
        model: "gpt-5.4",
        thinking: "xhigh",
        workspaceDir: rootDir,
      }),
    ).toMatchObject({ assignmentId: issued.assignment.assignmentId });
    expect(() =>
      resolveGuardedDelegationExecution({
        config,
        sessionKey: childSessionKey,
        agentId: "helper",
        provider: "openai",
        model: "gpt-5.4",
        thinking: "xhigh",
        workspaceDir: path.dirname(rootDir),
      }),
    ).toThrow(/workspace does not match the protected slice worktree/i);
  });

  it("authorizes an exact controller-to-worker spawn and binds runtime-owned assignment facts", () => {
    const issued = issueHelperAssignment();

    const authorized = authorizeHelperSpawn(issued.delegationToken);

    expect(authorized?.assignment).toMatchObject({
      assignmentId: issued.assignment.assignmentId,
      controllerAgentId: "planner",
      controllerSessionKey: PLANNER_SESSION,
      workerAgentId: "helper",
      role: "helper",
      requiredThinking: "xhigh",
      requiredModel: HELPER_MODEL,
      workspaceAccess: "ro",
    });
  });

  it("binds an initial spawn and issues an exact one-use Gateway capability atomically", () => {
    const issued = issueHelperAssignment();
    const authorized = authorizeHelperSpawn(issued.delegationToken);
    if (!authorized) {
      throw new Error("Missing guarded spawn authorization");
    }
    const childSessionKey = `${CHILD_SESSION}-initial-capability`;
    const idempotencyKey = `initial-capability-${sliceCounter}`;
    const { capability } = runtime.ledger.bindInitialSpawnWithGatewayDispatch({
      assignmentId: issued.assignment.assignmentId,
      controllerSessionKey: PLANNER_SESSION,
      childSessionKey,
      idempotencyKey,
    });

    expect(runtime.ledger.resolveAssignmentForChildSession(childSessionKey)?.assignmentId).toBe(
      issued.assignment.assignmentId,
    );
    expect(
      consumeDelegationGatewayDispatch({
        config,
        capability,
        controllerSessionKey: PLANNER_SESSION,
        targetSessionKey: childSessionKey,
        idempotencyKey,
      }),
    ).toEqual(expect.objectContaining({ firstUse: true }));
    expect(
      consumeDelegationGatewayDispatch({
        config,
        capability,
        controllerSessionKey: PLANNER_SESSION,
        targetSessionKey: childSessionKey,
        idempotencyKey,
      }),
    ).toEqual(expect.objectContaining({ firstUse: false }));
  });

  it.each([
    ["wrong controller", PLANNER_2_SESSION, `${CHILD_SESSION}-initial-exact`, "initial-exact"],
    ["wrong child", PLANNER_SESSION, `${CHILD_SESSION}-other`, "initial-exact"],
    ["wrong idempotency", PLANNER_SESSION, `${CHILD_SESSION}-initial-exact`, "initial-other"],
  ])(
    "rejects an initial-spawn Gateway capability with %s",
    (_label, controllerSessionKey, targetSessionKey, idempotencyKey) => {
      const issued = issueHelperAssignment();
      const authorized = authorizeHelperSpawn(issued.delegationToken);
      if (!authorized) {
        throw new Error("Missing guarded spawn authorization");
      }
      const exactChildSessionKey = `${CHILD_SESSION}-initial-exact`;
      const exactIdempotencyKey = "initial-exact";
      const { capability } = runtime.ledger.bindInitialSpawnWithGatewayDispatch({
        assignmentId: issued.assignment.assignmentId,
        controllerSessionKey: PLANNER_SESSION,
        childSessionKey: exactChildSessionKey,
        idempotencyKey: exactIdempotencyKey,
      });

      expect(() =>
        consumeDelegationGatewayDispatch({
          config,
          capability,
          controllerSessionKey,
          targetSessionKey,
          idempotencyKey,
        }),
      ).toThrow(/stale|does not match/i);
    },
  );

  it.each(["spawn", "send", "steer"] as const)(
    "requires a one-use delegation token for guarded %s routes",
    (routeKind) => {
      expect(() =>
        authorizeDelegationRoute({
          config,
          agentSessionKey: PLANNER_SESSION,
          effectiveThinking: "xhigh",
          targetAgentId: "helper",
          targetThinking: "xhigh",
          targetModel: HELPER_MODEL,
          targetSessionKey: CHILD_SESSION,
          routeKind,
        }),
      ).toThrow(/one-use delegationToken/i);
    },
  );

  it("rejects forged tokens", () => {
    expect(() => authorizeHelperSpawn("forged-token")).toThrow(/unknown delegation token/i);
  });

  it("rejects a one-use token replay", () => {
    const issued = issueHelperAssignment();
    expect(authorizeHelperSpawn(issued.delegationToken)).toBeDefined();

    expect(() => authorizeHelperSpawn(issued.delegationToken)).toThrow(/unique|token_uses/i);
  });

  it("rejects wrong-role and cross-planner token use", () => {
    const wrongRole = issueHelperAssignment();
    expect(() =>
      authorizeDelegationRoute({
        config,
        agentSessionKey: PLANNER_SESSION,
        effectiveThinking: "xhigh",
        targetAgentId: "tester",
        delegationToken: wrongRole.delegationToken,
        routeKind: "spawn",
      }),
    ).toThrow(/stale|does not match/i);

    const crossPlanner = issueHelperAssignment();
    expect(() =>
      authorizeDelegationRoute({
        config,
        agentSessionKey: PLANNER_2_SESSION,
        effectiveThinking: "xhigh",
        targetAgentId: "helper",
        delegationToken: crossPlanner.delegationToken,
        routeKind: "spawn",
      }),
    ).toThrow(/stale|does not match/i);
  });

  it("blocks worker-to-worker and unguarded-to-worker bypasses", () => {
    expect(() =>
      authorizeDelegationRoute({
        config,
        agentSessionKey: "agent:helper:main",
        effectiveThinking: "xhigh",
        targetAgentId: "tester",
        delegationToken: "bypass",
        routeKind: "spawn",
      }),
    ).toThrow(/workers cannot spawn, send to, or steer/i);

    expect(() =>
      authorizeDelegationRoute({
        config,
        agentSessionKey: "agent:outsider:main",
        effectiveThinking: "xhigh",
        targetAgentId: "helper",
        delegationToken: "bypass",
        routeKind: "spawn",
      }),
    ).toThrow(/not a guarded delegation controller/i);
  });

  it("blocks guarded controllers from routing to unguarded agents while leaving unrelated routes alone", () => {
    expect(() =>
      authorizeDelegationRoute({
        config,
        agentSessionKey: PLANNER_SESSION,
        effectiveThinking: "xhigh",
        targetAgentId: "outsider",
        routeKind: "spawn",
      }),
    ).toThrow(/only to configured guarded workers/i);

    expect(
      authorizeDelegationRoute({
        config,
        agentSessionKey: "agent:outsider:main",
        targetAgentId: "main",
        routeKind: "spawn",
      }),
    ).toBeUndefined();
  });

  it("rejects controller thinking, worker thinking, and model overrides instead of clamping", () => {
    const lowController = issueHelperAssignment();
    expect(() =>
      authorizeDelegationRoute({
        config,
        agentSessionKey: PLANNER_SESSION,
        effectiveThinking: "high",
        targetAgentId: "helper",
        delegationToken: lowController.delegationToken,
        routeKind: "spawn",
      }),
    ).toThrow(/exact xhigh thinking/i);

    const workerOverride = issueHelperAssignment();
    expect(() =>
      authorizeDelegationRoute({
        config,
        agentSessionKey: PLANNER_SESSION,
        effectiveThinking: "xhigh",
        targetAgentId: "helper",
        targetThinking: "high",
        delegationToken: workerOverride.delegationToken,
        routeKind: "spawn",
      }),
    ).toThrow(/exact xhigh thinking/i);

    const modelOverride = issueHelperAssignment();
    expect(() =>
      authorizeDelegationRoute({
        config,
        agentSessionKey: PLANNER_SESSION,
        effectiveThinking: "xhigh",
        targetAgentId: "helper",
        targetModel: "anthropic/claude-sonnet-4-6",
        delegationToken: modelOverride.delegationToken,
        routeKind: "spawn",
      }),
    ).toThrow(/target model .* is not allowed/i);
  });

  it("authorizes send and steer only for the exact active bound child session", () => {
    for (const routeKind of ["send", "steer"] as const) {
      const issued = issueHelperAssignment();
      const authorized = authorizeHelperSpawn(issued.delegationToken);
      const childSessionKey = `${CHILD_SESSION}-${routeKind}`;
      bindDelegationRoute({
        authorized,
        childSessionKey,
        runId: `run-helper-${routeKind}`,
      });
      appendDelegationRouteEvent({
        authorized,
        kind: "accepted",
        childSessionKey,
        runId: `run-helper-${routeKind}`,
      });
      const delegationToken = runtime.ledger.issueRouteToken({
        assignmentId: issued.assignment.assignmentId,
        controllerAgentId: "planner",
        controllerSessionKey: PLANNER_SESSION,
        routeKind,
        targetSessionKey: childSessionKey,
      });
      const followup = authorizeDelegationRoute({
        config,
        agentSessionKey: PLANNER_SESSION,
        effectiveThinking: "xhigh",
        targetAgentId: "helper",
        targetThinking: "xhigh",
        targetModel: HELPER_MODEL,
        targetSessionKey: childSessionKey,
        delegationToken,
        idempotencyKey: `${routeKind}-${sliceCounter}`,
        routeKind,
      });
      expect(followup?.assignment.assignmentId).toBe(issued.assignment.assignmentId);
      expect(followup?.gatewayDispatch?.capability).toBeTruthy();
    }
  });

  it.each([
    ["send", "steer"],
    ["steer", "send"],
  ] as const)("blocks an outstanding %s token before issuing %s", (firstKind, secondKind) => {
    const issued = issueHelperAssignment();
    const authorized = authorizeHelperSpawn(issued.delegationToken);
    const childSessionKey = `${CHILD_SESSION}-${firstKind}-outstanding`;
    bindDelegationRoute({ authorized, childSessionKey, runId: `run-${firstKind}` });
    appendDelegationRouteEvent({
      authorized,
      kind: "accepted",
      childSessionKey,
      runId: `run-${firstKind}`,
    });
    runtime.ledger.issueRouteToken({
      assignmentId: issued.assignment.assignmentId,
      controllerAgentId: "planner",
      controllerSessionKey: PLANNER_SESSION,
      routeKind: firstKind,
      targetSessionKey: childSessionKey,
    });
    expect(() =>
      runtime.ledger.issueRouteToken({
        assignmentId: issued.assignment.assignmentId,
        controllerAgentId: "planner",
        controllerSessionKey: PLANNER_SESSION,
        routeKind: secondKind,
        targetSessionKey: childSessionKey,
      }),
    ).toThrow(/outstanding send or steer/i);
  });

  it("rejects send or steer tokens presented for another child session", () => {
    const issued = issueHelperAssignment();
    const authorized = authorizeHelperSpawn(issued.delegationToken);
    bindDelegationRoute({ authorized, childSessionKey: CHILD_SESSION, runId: "run-helper" });
    appendDelegationRouteEvent({
      authorized,
      kind: "accepted",
      childSessionKey: CHILD_SESSION,
      runId: "run-helper",
    });
    const delegationToken = runtime.ledger.issueRouteToken({
      assignmentId: issued.assignment.assignmentId,
      controllerAgentId: "planner",
      controllerSessionKey: PLANNER_SESSION,
      routeKind: "send",
      targetSessionKey: CHILD_SESSION,
    });

    expect(() =>
      authorizeDelegationRoute({
        config,
        agentSessionKey: PLANNER_SESSION,
        effectiveThinking: "xhigh",
        targetAgentId: "helper",
        targetThinking: "xhigh",
        targetModel: HELPER_MODEL,
        targetSessionKey: "agent:helper:subagent:other-child",
        delegationToken,
        idempotencyKey: `wrong-child-${sliceCounter}`,
        routeKind: "send",
      }),
    ).toThrow(/stale|does not match/i);
  });

  it("revalidates an exact one-use Gateway dispatch capability", () => {
    const route = prepareHelperSendRoute();
    const idempotencyKey = route.idempotencyKey;
    const capability = issueDelegationGatewayDispatch({
      authorized: route.authorized,
      targetSessionKey: route.childSessionKey,
      idempotencyKey,
    });
    expect(capability).toBeTruthy();

    expect(
      consumeDelegationGatewayDispatch({
        config,
        capability,
        controllerSessionKey: PLANNER_SESSION,
        targetSessionKey: route.childSessionKey,
        idempotencyKey,
      })?.assignment.assignmentId,
    ).toBe(route.issued.assignment.assignmentId);
    expect(
      consumeDelegationGatewayDispatch({
        config,
        capability,
        controllerSessionKey: PLANNER_SESSION,
        targetSessionKey: route.childSessionKey,
        idempotencyKey,
      }),
    ).toEqual(expect.objectContaining({ firstUse: false }));
  });

  it("rolls back token consumption when atomic capability persistence fails", () => {
    const collisionCapability = "atomic-dispatch-collision-capability";
    const first = prepareHelperSendToken();
    runtime.ledger.consumeSendTokenWithGatewayDispatch({
      delegationToken: first.delegationToken,
      callerAgentId: "planner",
      callerSessionKey: PLANNER_SESSION,
      targetAgentId: "helper",
      targetSessionKey: first.childSessionKey,
      idempotencyKey: "atomic-first",
      capability: collisionCapability,
    });

    const second = prepareHelperSendToken();
    expect(() =>
      runtime.ledger.consumeSendTokenWithGatewayDispatch({
        delegationToken: second.delegationToken,
        callerAgentId: "planner",
        callerSessionKey: PLANNER_SESSION,
        targetAgentId: "helper",
        targetSessionKey: second.childSessionKey,
        idempotencyKey: "atomic-second-collision",
        capability: collisionCapability,
      }),
    ).toThrow(/unique|gateway_dispatch_capabilities/i);

    expect(
      authorizeDelegationRoute({
        config,
        agentSessionKey: PLANNER_SESSION,
        effectiveThinking: "xhigh",
        targetAgentId: "helper",
        targetThinking: "xhigh",
        targetModel: HELPER_MODEL,
        targetSessionKey: second.childSessionKey,
        delegationToken: second.delegationToken,
        idempotencyKey: "atomic-second-retry",
        routeKind: "send",
      })?.assignment.assignmentId,
    ).toBe(second.issued.assignment.assignmentId);
  });

  it.each(["send", "steer"] as const)(
    "permits immediate recovery after a guarded %s post-authorization exception",
    (routeKind) => {
      const issued = issueHelperAssignment();
      const spawn = authorizeHelperSpawn(issued.delegationToken);
      const childSessionKey = `${CHILD_SESSION}-${routeKind}-post-auth-failure`;
      bindDelegationRoute({ authorized: spawn, childSessionKey, runId: `run-${routeKind}` });
      appendDelegationRouteEvent({
        authorized: spawn,
        kind: "accepted",
        childSessionKey,
        runId: `run-${routeKind}`,
      });
      const delegationToken = runtime.ledger.issueRouteToken({
        assignmentId: issued.assignment.assignmentId,
        controllerAgentId: "planner",
        controllerSessionKey: PLANNER_SESSION,
        routeKind,
        targetSessionKey: childSessionKey,
      });
      const authorized = authorizeDelegationRoute({
        config,
        agentSessionKey: PLANNER_SESSION,
        effectiveThinking: "xhigh",
        targetAgentId: "helper",
        targetThinking: "xhigh",
        targetModel: HELPER_MODEL,
        targetSessionKey: childSessionKey,
        delegationToken,
        idempotencyKey: `${routeKind}-post-auth-failure`,
        routeKind,
      });
      appendDelegationRouteEvent({
        authorized,
        kind: "route_rejected",
        childSessionKey,
        runId: `run-${routeKind}`,
        reason: "simulated asynchronous pre-dispatch failure",
      });

      const recovery = runtime.ledger.issueAssignment({
        sliceId: issued.assignment.sliceId,
        controllerAgentId: "planner",
        controllerSessionKey: PLANNER_SESSION,
        workerAgentId: "helper",
        role: "helper",
        requiredThinking: "xhigh",
        requiredModel: HELPER_MODEL,
        workspaceAccess: "ro",
        purpose: "discovery",
        recoveryOfAssignmentId: issued.assignment.assignmentId,
      });
      expect(recovery.assignment.routeFamilyId).toBe(issued.assignment.routeFamilyId);
    },
  );

  it("resumes a durable Gateway claim and replays its immutable outcome", () => {
    const route = prepareHelperSendRoute(CHILD_SESSION, "gateway-dispatch-outcome");
    const capability = issueDelegationGatewayDispatch({
      authorized: route.authorized,
      targetSessionKey: route.childSessionKey,
      idempotencyKey: route.idempotencyKey,
    });
    const claim = consumeDelegationGatewayDispatch({
      config,
      capability,
      controllerSessionKey: PLANNER_SESSION,
      targetSessionKey: route.childSessionKey,
      idempotencyKey: route.idempotencyKey,
    });
    expect(claim).toEqual(expect.objectContaining({ firstUse: true }));
    const replayedClaim = consumeDelegationGatewayDispatch({
      config,
      capability,
      controllerSessionKey: PLANNER_SESSION,
      targetSessionKey: route.childSessionKey,
      idempotencyKey: route.idempotencyKey,
    });
    expect(replayedClaim).toEqual(expect.objectContaining({ firstUse: false }));
    expect(replayedClaim?.outcome).toBeUndefined();

    recordDelegationGatewayDispatchEnqueued({
      config,
      capability: capability ?? "",
      controllerSessionKey: PLANNER_SESSION,
      targetSessionKey: route.childSessionKey,
      idempotencyKey: route.idempotencyKey,
      runId: route.idempotencyKey,
      response: { runId: route.idempotencyKey, status: "accepted" },
    });
    createRunningTaskRun({
      runtime: "cli",
      sourceId: route.idempotencyKey,
      ownerKey: route.childSessionKey,
      scopeKind: "session",
      childSessionKey: route.childSessionKey,
      runId: route.idempotencyKey,
      task: "durable guarded Gateway replay fixture",
      deliveryStatus: "not_applicable",
      startedAt: Date.now(),
    });
    expect(
      consumeDelegationGatewayDispatch({
        config,
        capability,
        controllerSessionKey: PLANNER_SESSION,
        targetSessionKey: route.childSessionKey,
        idempotencyKey: route.idempotencyKey,
      })?.outcome,
    ).toEqual({
      decision: "accepted",
      response: { runId: route.idempotencyKey, status: "accepted" },
    });
  });

  it.each([
    ["wrong controller", PLANNER_2_SESSION, CHILD_SESSION, "gateway-dispatch-exact"],
    ["wrong child", PLANNER_SESSION, "agent:helper:subagent:other", "gateway-dispatch-exact"],
    ["wrong idempotency key", PLANNER_SESSION, CHILD_SESSION, "gateway-dispatch-other"],
  ])("rejects a Gateway dispatch capability with %s", (_label, controller, child, idem) => {
    const route = prepareHelperSendRoute(CHILD_SESSION, "gateway-dispatch-exact");
    const capability = issueDelegationGatewayDispatch({
      authorized: route.authorized,
      targetSessionKey: route.childSessionKey,
      idempotencyKey: "gateway-dispatch-exact",
    });

    expect(() =>
      consumeDelegationGatewayDispatch({
        config,
        capability,
        controllerSessionKey: controller,
        targetSessionKey: child,
        idempotencyKey: idem,
      }),
    ).toThrow(/stale|does not match/i);
  });

  it("invalidates a Gateway dispatch capability on rollback", () => {
    const route = prepareHelperSendRoute(CHILD_SESSION, "gateway-dispatch-before-rollback");
    const capability = issueDelegationGatewayDispatch({
      authorized: route.authorized,
      targetSessionKey: route.childSessionKey,
      idempotencyKey: "gateway-dispatch-before-rollback",
    });
    expect(() =>
      runtime.ledger.rollback({ actorAgentId: "planner", reason: "unsafe active rollback" }),
    ).toThrow(/active assignment/i);
    settleAllOpenAssignmentsBeforeEpochTransition();
    runtime.ledger.rollback({ actorAgentId: "planner", reason: "dispatch rollback test" });

    expect(() =>
      consumeDelegationGatewayDispatch({
        config,
        capability,
        controllerSessionKey: PLANNER_SESSION,
        targetSessionKey: route.childSessionKey,
        idempotencyKey: "gateway-dispatch-before-rollback",
      }),
    ).toThrow(/stale|does not match/i);
  });

  it("invalidates outstanding tokens on rollback epochs", () => {
    const issued = issueHelperAssignment();
    settleAllOpenAssignmentsBeforeEpochTransition();
    runtime.ledger.rollback({ actorAgentId: "planner", reason: "test rollback" });

    expect(() => authorizeHelperSpawn(issued.delegationToken)).toThrow(/stale|does not match/i);
  });
});
