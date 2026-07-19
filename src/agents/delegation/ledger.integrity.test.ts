import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { hashDelegationReportSemantics, openDelegationLedger } from "./ledger.js";
import {
  closeLedgerForTest,
  completeDiscoveryAndImplementation,
  createFingerprint,
  createLedgerFixture,
  createTestGuard,
  installTestValidator,
  issueAssignment,
  makeCompleteReport,
  startAssignment,
  TEST_CONTROLLER,
  unsafeDatabaseForTest,
} from "./ledger.test-helpers.js";
import { resolveDelegationPolicyDigest } from "./policy.js";

const reconcileNoTestGatewayTask = () => "absent" as const;

function replaceV2AppendOrderWithCommittedV1(db: ReturnType<typeof unsafeDatabaseForTest>): void {
  db.exec(`
    CREATE TABLE ledger_record_appends (
      append_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      assignment_id TEXT NOT NULL REFERENCES assignments(assignment_id),
      record_kind TEXT NOT NULL CHECK(record_kind IN ('receipt', 'route_event')),
      record_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(record_kind, record_id)
    );
    INSERT INTO ledger_record_appends
      (assignment_id, record_kind, record_id, created_at)
    SELECT assignment_id, record_kind, record_id, created_at
    FROM ledger_record_appends_v2
    ORDER BY append_sequence;
    DROP TRIGGER receipts_record_append_order_v2;
    DROP TRIGGER route_events_record_append_order_v2;
    DROP TABLE ledger_record_appends_v2;
    DROP TABLE ledger_schema_migrations;
    CREATE TABLE ledger_schema_migrations (
      migration_id TEXT PRIMARY KEY
    );
    INSERT INTO ledger_schema_migrations (migration_id)
    VALUES ('receipt-route-causal-order-v1');
  `);
}

function replaceV2AppendOrderWithF092BackfilledV1(
  db: ReturnType<typeof unsafeDatabaseForTest>,
): void {
  db.exec(`
    CREATE TABLE ledger_record_appends (
      append_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      assignment_id TEXT NOT NULL REFERENCES assignments(assignment_id),
      record_kind TEXT NOT NULL CHECK(record_kind IN ('receipt', 'route_event')),
      record_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(record_kind, record_id)
    );
    INSERT INTO ledger_record_appends
      (assignment_id, record_kind, record_id, created_at)
    SELECT assignment_id, record_kind, record_id, created_at
    FROM (
      SELECT r.assignment_id, 'receipt' AS record_kind, r.receipt_id AS record_id,
             r.created_at, 1 AS tie_rank
      FROM receipts r
      UNION ALL
      SELECT e.assignment_id, 'route_event' AS record_kind, e.event_id AS record_id,
             e.created_at, CASE e.kind WHEN 'validation_rejected' THEN 2 ELSE 0 END AS tie_rank
      FROM route_events e
    )
    ORDER BY created_at, tie_rank, record_kind, record_id;
    DROP TRIGGER receipts_record_append_order_v2;
    DROP TRIGGER route_events_record_append_order_v2;
    DROP TABLE ledger_record_appends_v2;
    DROP TABLE ledger_schema_migrations;
    CREATE TABLE ledger_schema_migrations (
      migration_id TEXT PRIMARY KEY
    );
    INSERT INTO ledger_schema_migrations (migration_id)
    VALUES ('receipt-route-causal-order-v1');
  `);
}

describe("protected delegation ledger integrity", () => {
  it("uses one gateway writer and protects the ledger directory and files", () => {
    const fixture = createLedgerFixture();
    try {
      const repeated = openDelegationLedger({
        guard: fixture.guard,
        policyDigest: fixture.policyDigest,
        stateDir: fixture.stateDir,
        reconcileGatewayTask: reconcileNoTestGatewayTask,
      });

      expect(repeated).toBe(fixture.ledger);
      expect(statSync(`${fixture.stateDir}/delegation`).mode & 0o777).toBe(0o700);
      expect(statSync(fixture.ledger.path).mode & 0o777).toBe(0o600);
    } finally {
      fixture.close();
    }
  });

  it("restores protected state after a writer restart and advances the epoch for a new stack", async () => {
    const fixture = createLedgerFixture();
    const discovery = issueAssignment({
      fixture,
      purpose: "discovery",
      role: "helper",
    });
    fixture.ledger.appendRouteEvent({
      assignmentId: discovery.assignment.assignmentId,
      kind: "route_rejected",
      payload: { reason: "settled before stack transition" },
    });
    closeLedgerForTest(fixture.ledger);

    const nextValidator = installTestValidator(fixture.rootDir, "validator-v2.mjs");
    const nextGuard = createTestGuard({
      validatorPath: nextValidator.validatorPath,
      validatorSha256: nextValidator.sha256,
      validatorVersion: "2",
    });
    const nextPolicyDigest = resolveDelegationPolicyDigest(nextGuard);
    vi.resetModules();
    const restartedModule = await import("./ledger.js");
    const restarted = restartedModule.openDelegationLedger({
      guard: nextGuard,
      policyDigest: nextPolicyDigest,
      stateDir: fixture.stateDir,
      reconcileGatewayTask: reconcileNoTestGatewayTask,
    });
    try {
      expect(restarted.currentEpoch()).toBe(2);
      expect(restarted.status()).toMatchObject({ slices: 1, candidates: 1, assignments: 1 });
      expect(() =>
        restarted.appendRouteEvent({
          assignmentId: discovery.assignment.assignmentId,
          kind: "accepted",
        }),
      ).toThrow(/stale/i);
    } finally {
      closeLedgerForTest(restarted);
      fixture.close();
    }
  });

  it("refuses a stack epoch transition while any assignment is active", async () => {
    const fixture = createLedgerFixture();
    const active = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
    closeLedgerForTest(fixture.ledger);
    const nextValidator = installTestValidator(fixture.rootDir, "validator-active-v2.mjs");
    const nextGuard = createTestGuard({
      validatorPath: nextValidator.validatorPath,
      validatorSha256: nextValidator.sha256,
      validatorVersion: "2",
    });
    vi.resetModules();
    const restartedModule = await import("./ledger.js");
    try {
      expect(() =>
        restartedModule.openDelegationLedger({
          guard: nextGuard,
          policyDigest: resolveDelegationPolicyDigest(nextGuard),
          stateDir: fixture.stateDir,
          reconcileGatewayTask: reconcileNoTestGatewayTask,
        }),
      ).toThrow(active.assignment.assignmentId);
    } finally {
      fixture.close();
    }
  });

  it("allows trusted reconciliation only for an exact assignment with no start evidence", () => {
    const fixture = createLedgerFixture();
    try {
      const unstarted = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
      expect(() =>
        fixture.ledger.rejectUnstartedAssignment({
          assignmentId: unstarted.assignment.assignmentId,
          controllerAgentId: TEST_CONTROLLER.agentId,
          controllerSessionKey: "agent:planner:wrong",
          reason: "wrong controller must fail closed",
        }),
      ).toThrow(/unowned/i);
      fixture.ledger.rejectUnstartedAssignment({
        assignmentId: unstarted.assignment.assignmentId,
        controllerAgentId: TEST_CONTROLLER.agentId,
        controllerSessionKey: TEST_CONTROLLER.sessionKey,
        reason: "operator confirmed the issued assignment never started",
      });
      expect(
        unsafeDatabaseForTest(fixture.ledger)
          .prepare(
            `SELECT kind FROM route_events
             WHERE assignment_id = ? AND kind = 'route_rejected'`,
          )
          .get(unstarted.assignment.assignmentId),
      ).toEqual({ kind: "route_rejected" });
      expect(() =>
        fixture.ledger.rollback({
          actorAgentId: TEST_CONTROLLER.agentId,
          reason: "unstarted assignment reconciliation unblocked rollback",
        }),
      ).not.toThrow();
    } finally {
      fixture.close();
    }

    const startedFixture = createLedgerFixture();
    try {
      const started = issueAssignment({
        fixture: startedFixture,
        purpose: "discovery",
        role: "helper",
      });
      startAssignment({
        fixture: startedFixture,
        assignment: started.assignment,
        delegationToken: started.delegationToken,
      });
      expect(() =>
        startedFixture.ledger.rejectUnstartedAssignment({
          assignmentId: started.assignment.assignmentId,
          controllerAgentId: TEST_CONTROLLER.agentId,
          controllerSessionKey: TEST_CONTROLLER.sessionKey,
          reason: "must not erase started work",
        }),
      ).toThrow(/no route, binding, report, or execution evidence/i);
    } finally {
      startedFixture.close();
    }
  });

  it("reconciles a legacy bound initial spawn only with terminal pre-execution task evidence", async () => {
    const fixture = createLedgerFixture();
    const issued = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
    fixture.ledger.consumeAssignmentToken({
      delegationToken: issued.delegationToken,
      routeKind: "spawn",
      callerAgentId: TEST_CONTROLLER.agentId,
      callerSessionKey: TEST_CONTROLLER.sessionKey,
      targetAgentId: issued.assignment.workerAgentId,
    });
    const childSessionKey = "agent:helper:subagent:legacy-interrupted";
    const runId = "legacy-interrupted-initial-spawn";
    fixture.ledger.bindAssignment({
      assignmentId: issued.assignment.assignmentId,
      childSessionKey,
      runId,
    });
    closeLedgerForTest(fixture.ledger);

    vi.resetModules();
    const restartedModule = await import("./ledger.js");
    const reconciledTasks: unknown[] = [];
    const restarted = restartedModule.openDelegationLedger({
      guard: fixture.guard,
      policyDigest: fixture.policyDigest,
      stateDir: fixture.stateDir,
      reconcileGatewayTask: reconcileNoTestGatewayTask,
      reconcileInitialSpawnTask: (params) => {
        reconciledTasks.push(params);
        return "interrupted";
      },
    });
    try {
      expect(reconciledTasks).toEqual([{ runId, targetSessionKey: childSessionKey }]);
      expect(
        unsafeDatabaseForTest(restarted)
          .prepare(
            `SELECT kind FROM route_events
             WHERE assignment_id = ? AND kind = 'route_rejected'`,
          )
          .get(issued.assignment.assignmentId),
      ).toEqual({ kind: "route_rejected" });
      expect(() =>
        restarted.rollback({
          actorAgentId: TEST_CONTROLLER.agentId,
          reason: "legacy interrupted initial spawn reconciled",
        }),
      ).not.toThrow();
    } finally {
      closeLedgerForTest(restarted);
      fixture.close();
    }
  });

  it("reconciles an unclaimed initial-spawn capability and exposes exact cleanup ownership", async () => {
    const fixture = createLedgerFixture();
    const issued = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
    fixture.ledger.consumeAssignmentToken({
      delegationToken: issued.delegationToken,
      routeKind: "spawn",
      callerAgentId: TEST_CONTROLLER.agentId,
      callerSessionKey: TEST_CONTROLLER.sessionKey,
      targetAgentId: issued.assignment.workerAgentId,
    });
    const childSessionKey = "agent:helper:subagent:initial-capability-restart";
    const runId = "initial-capability-restart";
    fixture.ledger.bindInitialSpawnWithGatewayDispatch({
      assignmentId: issued.assignment.assignmentId,
      controllerSessionKey: TEST_CONTROLLER.sessionKey,
      childSessionKey,
      idempotencyKey: runId,
    });
    closeLedgerForTest(fixture.ledger);

    vi.resetModules();
    const restartedModule = await import("./ledger.js");
    const reconciledInitialTasks: unknown[] = [];
    const restarted = restartedModule.openDelegationLedger({
      guard: fixture.guard,
      policyDigest: fixture.policyDigest,
      stateDir: fixture.stateDir,
      reconcileGatewayTask: reconcileNoTestGatewayTask,
      reconcileInitialSpawnTask: (params) => {
        reconciledInitialTasks.push(params);
        return "interrupted";
      },
    });
    try {
      expect(reconciledInitialTasks).toEqual([{ runId, targetSessionKey: childSessionKey }]);
      expect(restarted.listRejectedInitialSpawnCleanupTargets()).toEqual([
        {
          assignmentId: issued.assignment.assignmentId,
          controllerSessionKey: TEST_CONTROLLER.sessionKey,
          childSessionKey,
          runId,
        },
      ]);
      expect(
        unsafeDatabaseForTest(restarted)
          .prepare(
            `SELECT decision FROM gateway_dispatch_outcomes
             WHERE assignment_id = ?`,
          )
          .get(issued.assignment.assignmentId),
      ).toEqual({ decision: "rejected" });
      expect(() =>
        restarted.rollback({
          actorAgentId: TEST_CONTROLLER.agentId,
          reason: "unclaimed protected initial spawn reconciled",
        }),
      ).not.toThrow();
      expect(restarted.listRejectedInitialSpawnCleanupTargets()).toEqual([
        {
          assignmentId: issued.assignment.assignmentId,
          controllerSessionKey: TEST_CONTROLLER.sessionKey,
          childSessionKey,
          runId,
        },
      ]);
    } finally {
      closeLedgerForTest(restarted);
      fixture.close();
    }
  });

  it("reconciles an issued but unclaimed Gateway dispatch after process restart", async () => {
    const fixture = createLedgerFixture();
    const issued = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
    const started = startAssignment({
      fixture,
      assignment: issued.assignment,
      delegationToken: issued.delegationToken,
    });
    const sendToken = fixture.ledger.issueRouteToken({
      assignmentId: issued.assignment.assignmentId,
      controllerAgentId: TEST_CONTROLLER.agentId,
      controllerSessionKey: TEST_CONTROLLER.sessionKey,
      routeKind: "send",
      targetSessionKey: started.childSessionKey,
    });
    fixture.ledger.consumeSendTokenWithGatewayDispatch({
      delegationToken: sendToken,
      callerAgentId: TEST_CONTROLLER.agentId,
      callerSessionKey: TEST_CONTROLLER.sessionKey,
      targetAgentId: issued.assignment.workerAgentId,
      targetSessionKey: started.childSessionKey,
      idempotencyKey: "discarded-before-gateway",
    });
    closeLedgerForTest(fixture.ledger);

    vi.resetModules();
    const restartedModule = await import("./ledger.js");
    const restarted = restartedModule.openDelegationLedger({
      guard: fixture.guard,
      policyDigest: fixture.policyDigest,
      stateDir: fixture.stateDir,
      reconcileGatewayTask: reconcileNoTestGatewayTask,
    });
    try {
      const db = unsafeDatabaseForTest(restarted);
      expect(
        db
          .prepare(
            `SELECT decision FROM gateway_dispatch_outcomes
             WHERE assignment_id = ?`,
          )
          .get(issued.assignment.assignmentId),
      ).toEqual({ decision: "rejected" });
      expect(
        db
          .prepare(
            `SELECT 1 FROM route_events
             WHERE assignment_id = ? AND kind = 'route_rejected'`,
          )
          .get(issued.assignment.assignmentId),
      ).toBeDefined();
      const restartedFixture = { ...fixture, ledger: restarted };
      expect(
        issueAssignment({
          fixture: restartedFixture,
          purpose: "discovery",
          role: "helper",
          recoveryOfAssignmentId: issued.assignment.assignmentId,
        }).assignment.routeFamilyId,
      ).toBe(issued.assignment.routeFamilyId);
    } finally {
      closeLedgerForTest(restarted);
      fixture.close();
    }
  });

  it("reconciles a claimed dispatch with no outcome after process restart", async () => {
    const fixture = createLedgerFixture();
    const issued = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
    const started = startAssignment({
      fixture,
      assignment: issued.assignment,
      delegationToken: issued.delegationToken,
    });
    const sendToken = fixture.ledger.issueRouteToken({
      assignmentId: issued.assignment.assignmentId,
      controllerAgentId: TEST_CONTROLLER.agentId,
      controllerSessionKey: TEST_CONTROLLER.sessionKey,
      routeKind: "send",
      targetSessionKey: started.childSessionKey,
    });
    const idempotencyKey = "claimed-before-process-crash";
    const dispatch = fixture.ledger.consumeSendTokenWithGatewayDispatch({
      delegationToken: sendToken,
      callerAgentId: TEST_CONTROLLER.agentId,
      callerSessionKey: TEST_CONTROLLER.sessionKey,
      targetAgentId: issued.assignment.workerAgentId,
      targetSessionKey: started.childSessionKey,
      idempotencyKey,
    });
    fixture.ledger.consumeGatewayDispatchCapability({
      capability: dispatch.capability,
      controllerSessionKey: TEST_CONTROLLER.sessionKey,
      targetSessionKey: started.childSessionKey,
      idempotencyKey,
    });
    closeLedgerForTest(fixture.ledger);

    vi.resetModules();
    const restartedModule = await import("./ledger.js");
    const restarted = restartedModule.openDelegationLedger({
      guard: fixture.guard,
      policyDigest: fixture.policyDigest,
      stateDir: fixture.stateDir,
      reconcileGatewayTask: reconcileNoTestGatewayTask,
    });
    try {
      const db = unsafeDatabaseForTest(restarted);
      expect(
        db
          .prepare(
            `SELECT decision FROM gateway_dispatch_outcomes
             WHERE assignment_id = ?`,
          )
          .get(issued.assignment.assignmentId),
      ).toEqual({ decision: "rejected" });
      expect(
        db
          .prepare(
            `SELECT 1 FROM route_events
             WHERE assignment_id = ? AND kind = 'route_rejected'`,
          )
          .get(issued.assignment.assignmentId),
      ).toBeDefined();
      const restartedFixture = { ...fixture, ledger: restarted };
      expect(
        issueAssignment({
          fixture: restartedFixture,
          purpose: "discovery",
          role: "helper",
          recoveryOfAssignmentId: issued.assignment.assignmentId,
        }).assignment.routeFamilyId,
      ).toBe(issued.assignment.routeFamilyId);
    } finally {
      closeLedgerForTest(restarted);
      fixture.close();
    }
  });

  it("reconciles an accepted guarded run that did not complete before process restart", async () => {
    const fixture = createLedgerFixture();
    const issued = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
    const started = startAssignment({
      fixture,
      assignment: issued.assignment,
      delegationToken: issued.delegationToken,
    });
    const sendToken = fixture.ledger.issueRouteToken({
      assignmentId: issued.assignment.assignmentId,
      controllerAgentId: TEST_CONTROLLER.agentId,
      controllerSessionKey: TEST_CONTROLLER.sessionKey,
      routeKind: "send",
      targetSessionKey: started.childSessionKey,
    });
    const idempotencyKey = "accepted-before-process-crash";
    const dispatch = fixture.ledger.consumeSendTokenWithGatewayDispatch({
      delegationToken: sendToken,
      callerAgentId: TEST_CONTROLLER.agentId,
      callerSessionKey: TEST_CONTROLLER.sessionKey,
      targetAgentId: issued.assignment.workerAgentId,
      targetSessionKey: started.childSessionKey,
      idempotencyKey,
    });
    fixture.ledger.consumeGatewayDispatchCapability({
      capability: dispatch.capability,
      controllerSessionKey: TEST_CONTROLLER.sessionKey,
      targetSessionKey: started.childSessionKey,
      idempotencyKey,
    });
    fixture.ledger.recordGatewayDispatchEnqueued({
      capability: dispatch.capability,
      controllerSessionKey: TEST_CONTROLLER.sessionKey,
      targetSessionKey: started.childSessionKey,
      idempotencyKey,
      runId: idempotencyKey,
      response: { runId: idempotencyKey, status: "accepted" },
    });
    closeLedgerForTest(fixture.ledger);

    vi.resetModules();
    const restartedModule = await import("./ledger.js");
    expect(() =>
      restartedModule.openDelegationLedger({
        guard: fixture.guard,
        policyDigest: fixture.policyDigest,
        stateDir: fixture.stateDir,
        reconcileGatewayTask: () => {
          throw new Error("task terminal persistence failed");
        },
      }),
    ).toThrow("task terminal persistence failed");
    let durableTaskStatus: "running" | "failed" = "running";
    const restarted = restartedModule.openDelegationLedger({
      guard: fixture.guard,
      policyDigest: fixture.policyDigest,
      stateDir: fixture.stateDir,
      reconcileGatewayTask: ({ runId, targetSessionKey, requiredTask }) => {
        expect(runId).toBe(idempotencyKey);
        expect(targetSessionKey).toBe(started.childSessionKey);
        expect(requiredTask).toBe(true);
        durableTaskStatus = "failed";
        return "interrupted";
      },
    });
    try {
      expect(durableTaskStatus).toBe("failed");
      expect(
        restarted.consumeGatewayDispatchCapability({
          capability: dispatch.capability,
          controllerSessionKey: TEST_CONTROLLER.sessionKey,
          targetSessionKey: started.childSessionKey,
          idempotencyKey,
        }),
      ).toEqual(
        expect.objectContaining({
          outcome: expect.objectContaining({ decision: "rejected" }),
        }),
      );
      expect(
        unsafeDatabaseForTest(restarted)
          .prepare(
            `SELECT 1 FROM route_events
             WHERE assignment_id = ? AND kind = 'validation_rejected'`,
          )
          .get(issued.assignment.assignmentId),
      ).toBeDefined();
      expect(
        unsafeDatabaseForTest(restarted)
          .prepare(
            `SELECT 1 FROM route_events
             WHERE assignment_id = ? AND kind = 'route_rejected'`,
          )
          .get(issued.assignment.assignmentId),
      ).toBeUndefined();
      expect(() =>
        issueAssignment({
          fixture: { ...fixture, ledger: restarted },
          purpose: "discovery",
          role: "helper",
          recoveryOfAssignmentId: issued.assignment.assignmentId,
        }),
      ).toThrow("route-rejection evidence");
    } finally {
      closeLedgerForTest(restarted);
      fixture.close();
    }
  });

  it("blocks overlapping sends and recovery for completed work after task pruning", async () => {
    const fixture = createLedgerFixture();
    const issued = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
    const started = startAssignment({
      fixture,
      assignment: issued.assignment,
      delegationToken: issued.delegationToken,
    });
    const sendToken = fixture.ledger.issueRouteToken({
      assignmentId: issued.assignment.assignmentId,
      controllerAgentId: TEST_CONTROLLER.agentId,
      controllerSessionKey: TEST_CONTROLLER.sessionKey,
      routeKind: "send",
      targetSessionKey: started.childSessionKey,
    });
    const idempotencyKey = "completed-before-caller-ack";
    const dispatch = fixture.ledger.consumeSendTokenWithGatewayDispatch({
      delegationToken: sendToken,
      callerAgentId: TEST_CONTROLLER.agentId,
      callerSessionKey: TEST_CONTROLLER.sessionKey,
      targetAgentId: issued.assignment.workerAgentId,
      targetSessionKey: started.childSessionKey,
      idempotencyKey,
    });
    fixture.ledger.consumeGatewayDispatchCapability({
      capability: dispatch.capability,
      controllerSessionKey: TEST_CONTROLLER.sessionKey,
      targetSessionKey: started.childSessionKey,
      idempotencyKey,
    });
    fixture.ledger.recordGatewayDispatchEnqueued({
      capability: dispatch.capability,
      controllerSessionKey: TEST_CONTROLLER.sessionKey,
      targetSessionKey: started.childSessionKey,
      idempotencyKey,
      runId: idempotencyKey,
      response: { runId: idempotencyKey, status: "accepted" },
    });
    expect(() =>
      fixture.ledger.issueRouteToken({
        assignmentId: issued.assignment.assignmentId,
        controllerAgentId: TEST_CONTROLLER.agentId,
        controllerSessionKey: TEST_CONTROLLER.sessionKey,
        routeKind: "send",
        targetSessionKey: started.childSessionKey,
      }),
    ).toThrow(/already has a Gateway dispatch/i);
    closeLedgerForTest(fixture.ledger);

    vi.resetModules();
    const restartedModule = await import("./ledger.js");
    const reconciledRuns: string[] = [];
    const restarted = restartedModule.openDelegationLedger({
      guard: fixture.guard,
      policyDigest: fixture.policyDigest,
      stateDir: fixture.stateDir,
      reconcileGatewayTask: ({ runId, requiredTask }) => {
        expect(requiredTask).toBe(true);
        reconciledRuns.push(runId);
        return runId === idempotencyKey ? "completed" : "interrupted";
      },
    });
    try {
      expect(reconciledRuns).toEqual([idempotencyKey]);
      const db = unsafeDatabaseForTest(restarted);
      expect(
        db
          .prepare(
            `SELECT 1 FROM route_events
             WHERE assignment_id = ? AND kind = 'validation_rejected'`,
          )
          .get(issued.assignment.assignmentId),
      ).toBeDefined();
      expect(
        db
          .prepare(
            `SELECT 1 FROM route_events
             WHERE assignment_id = ? AND kind = 'route_rejected'`,
          )
          .get(issued.assignment.assignmentId),
      ).toBeUndefined();
      expect(() =>
        issueAssignment({
          fixture: { ...fixture, ledger: restarted },
          purpose: "discovery",
          role: "helper",
          recoveryOfAssignmentId: issued.assignment.assignmentId,
        }),
      ).toThrow("route-rejection evidence");
    } finally {
      closeLedgerForTest(restarted);
    }

    vi.resetModules();
    const prunedTaskModule = await import("./ledger.js");
    const afterTaskPrune = prunedTaskModule.openDelegationLedger({
      guard: fixture.guard,
      policyDigest: fixture.policyDigest,
      stateDir: fixture.stateDir,
      reconcileGatewayTask: () => {
        throw new Error("terminal task should not be required after route closure");
      },
    });
    try {
      expect(afterTaskPrune.status().assignments).toBeGreaterThan(0);
    } finally {
      closeLedgerForTest(afterTaskPrune);
      fixture.close();
    }
  });

  it("reconciles cleanup-held Gateway tasks after protected terminality on restart", async () => {
    const fixture = createLedgerFixture();
    const issued = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
    const started = startAssignment({ fixture, ...issued });
    const sendToken = fixture.ledger.issueRouteToken({
      assignmentId: issued.assignment.assignmentId,
      controllerAgentId: TEST_CONTROLLER.agentId,
      controllerSessionKey: TEST_CONTROLLER.sessionKey,
      routeKind: "send",
      targetSessionKey: started.childSessionKey,
    });
    const idempotencyKey = "cleanup-hold-restart";
    const dispatch = fixture.ledger.consumeSendTokenWithGatewayDispatch({
      delegationToken: sendToken,
      callerAgentId: TEST_CONTROLLER.agentId,
      callerSessionKey: TEST_CONTROLLER.sessionKey,
      targetAgentId: issued.assignment.workerAgentId,
      targetSessionKey: started.childSessionKey,
      idempotencyKey,
    });
    fixture.ledger.consumeGatewayDispatchCapability({
      capability: dispatch.capability,
      controllerSessionKey: TEST_CONTROLLER.sessionKey,
      targetSessionKey: started.childSessionKey,
      idempotencyKey,
    });
    fixture.ledger.recordGatewayDispatchEnqueued({
      capability: dispatch.capability,
      controllerSessionKey: TEST_CONTROLLER.sessionKey,
      targetSessionKey: started.childSessionKey,
      idempotencyKey,
      runId: idempotencyKey,
      response: { runId: idempotencyKey, status: "accepted" },
    });
    fixture.ledger.recordGatewayDispatchExecutionFailed({
      capability: dispatch.capability,
      controllerSessionKey: TEST_CONTROLLER.sessionKey,
      targetSessionKey: started.childSessionKey,
      idempotencyKey,
      runId: idempotencyKey,
      response: { message: "worker failed" },
    });
    fixture.ledger.rollback({
      actorAgentId: TEST_CONTROLLER.agentId,
      reason: "terminal task cleanup across rollback epoch",
    });
    closeLedgerForTest(fixture.ledger);

    vi.resetModules();
    const restartedModule = await import("./ledger.js");
    const reconciled: unknown[] = [];
    const restarted = restartedModule.openDelegationLedger({
      guard: fixture.guard,
      policyDigest: fixture.policyDigest,
      stateDir: fixture.stateDir,
      reconcileGatewayTask: reconcileNoTestGatewayTask,
      reconcileTerminalGatewayTask: (params) => reconciled.push(params),
    });
    try {
      expect(reconciled).toEqual([
        {
          runId: idempotencyKey,
          targetSessionKey: started.childSessionKey,
          terminalKind: "validation_rejected",
        },
      ]);
    } finally {
      closeLedgerForTest(restarted);
      fixture.close();
    }
  });

  it("reconciles prior-epoch terminal Gateway tasks after a validator stack install", async () => {
    const fixture = createLedgerFixture();
    const issued = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
    const started = startAssignment({ fixture, ...issued });
    const sendToken = fixture.ledger.issueRouteToken({
      assignmentId: issued.assignment.assignmentId,
      controllerAgentId: TEST_CONTROLLER.agentId,
      controllerSessionKey: TEST_CONTROLLER.sessionKey,
      routeKind: "send",
      targetSessionKey: started.childSessionKey,
    });
    const idempotencyKey = "cleanup-hold-validator-install";
    const dispatch = fixture.ledger.consumeSendTokenWithGatewayDispatch({
      delegationToken: sendToken,
      callerAgentId: TEST_CONTROLLER.agentId,
      callerSessionKey: TEST_CONTROLLER.sessionKey,
      targetAgentId: issued.assignment.workerAgentId,
      targetSessionKey: started.childSessionKey,
      idempotencyKey,
    });
    fixture.ledger.consumeGatewayDispatchCapability({
      capability: dispatch.capability,
      controllerSessionKey: TEST_CONTROLLER.sessionKey,
      targetSessionKey: started.childSessionKey,
      idempotencyKey,
    });
    fixture.ledger.recordGatewayDispatchEnqueued({
      capability: dispatch.capability,
      controllerSessionKey: TEST_CONTROLLER.sessionKey,
      targetSessionKey: started.childSessionKey,
      idempotencyKey,
      runId: idempotencyKey,
      response: { runId: idempotencyKey, status: "accepted" },
    });
    fixture.ledger.recordGatewayDispatchExecutionFailed({
      capability: dispatch.capability,
      controllerSessionKey: TEST_CONTROLLER.sessionKey,
      targetSessionKey: started.childSessionKey,
      idempotencyKey,
      runId: idempotencyKey,
      response: { message: "worker failed before validator install" },
    });
    closeLedgerForTest(fixture.ledger);

    const nextValidator = installTestValidator(fixture.rootDir, "cleanup-validator-v2.mjs");
    const nextGuard = createTestGuard({
      validatorPath: nextValidator.validatorPath,
      validatorSha256: nextValidator.sha256,
      validatorVersion: "2",
    });
    vi.resetModules();
    const restartedModule = await import("./ledger.js");
    const reconciled: unknown[] = [];
    const restarted = restartedModule.openDelegationLedger({
      guard: nextGuard,
      policyDigest: resolveDelegationPolicyDigest(nextGuard),
      stateDir: fixture.stateDir,
      reconcileGatewayTask: reconcileNoTestGatewayTask,
      reconcileTerminalGatewayTask: (params) => reconciled.push(params),
    });
    try {
      expect(restarted.currentEpoch()).toBe(2);
      expect(reconciled).toEqual([
        {
          runId: idempotencyKey,
          targetSessionKey: started.childSessionKey,
          terminalKind: "validation_rejected",
        },
      ]);
    } finally {
      closeLedgerForTest(restarted);
      fixture.close();
    }
  });

  it("closes failed Gateway execution and replays the durable rejection", () => {
    const fixture = createLedgerFixture();
    try {
      const issued = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
      const started = startAssignment({
        fixture,
        assignment: issued.assignment,
        delegationToken: issued.delegationToken,
      });
      const sendToken = fixture.ledger.issueRouteToken({
        assignmentId: issued.assignment.assignmentId,
        controllerAgentId: TEST_CONTROLLER.agentId,
        controllerSessionKey: TEST_CONTROLLER.sessionKey,
        routeKind: "send",
        targetSessionKey: started.childSessionKey,
      });
      const runId = "failed-gateway-execution";
      const dispatch = fixture.ledger.consumeSendTokenWithGatewayDispatch({
        delegationToken: sendToken,
        callerAgentId: TEST_CONTROLLER.agentId,
        callerSessionKey: TEST_CONTROLLER.sessionKey,
        targetAgentId: issued.assignment.workerAgentId,
        targetSessionKey: started.childSessionKey,
        idempotencyKey: runId,
      });
      fixture.ledger.consumeGatewayDispatchCapability({
        capability: dispatch.capability,
        controllerSessionKey: TEST_CONTROLLER.sessionKey,
        targetSessionKey: started.childSessionKey,
        idempotencyKey: runId,
      });
      fixture.ledger.recordGatewayDispatchEnqueued({
        capability: dispatch.capability,
        controllerSessionKey: TEST_CONTROLLER.sessionKey,
        targetSessionKey: started.childSessionKey,
        idempotencyKey: runId,
        runId,
        response: { runId, status: "accepted" },
      });
      const response = {
        message: "worker execution failed",
        retryable: false,
        details: { code: "delegation_gateway_dispatch_execution_failed" },
      };
      fixture.ledger.recordGatewayDispatchExecutionFailed({
        capability: dispatch.capability,
        controllerSessionKey: TEST_CONTROLLER.sessionKey,
        targetSessionKey: started.childSessionKey,
        idempotencyKey: runId,
        runId,
        response,
      });

      expect(
        fixture.ledger.consumeGatewayDispatchCapability({
          capability: dispatch.capability,
          controllerSessionKey: TEST_CONTROLLER.sessionKey,
          targetSessionKey: started.childSessionKey,
          idempotencyKey: runId,
        }).outcome,
      ).toEqual({ decision: "rejected", response });
      expect(
        unsafeDatabaseForTest(fixture.ledger)
          .prepare(
            `SELECT 1 FROM route_events
             WHERE assignment_id = ? AND kind = 'validation_rejected'`,
          )
          .get(issued.assignment.assignmentId),
      ).toBeDefined();
      expect(() =>
        fixture.ledger.issueRouteToken({
          assignmentId: issued.assignment.assignmentId,
          controllerAgentId: TEST_CONTROLLER.agentId,
          controllerSessionKey: TEST_CONTROLLER.sessionKey,
          routeKind: "send",
          targetSessionKey: started.childSessionKey,
        }),
      ).toThrow(/terminal/i);
    } finally {
      fixture.close();
    }
  });

  it("blocks recovery when an accepted Gateway run loses its caller acknowledgement", () => {
    const fixture = createLedgerFixture();
    try {
      const issued = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
      const started = startAssignment({ fixture, ...issued });
      const runId = "accepted-before-lost-caller-ack";
      const sendToken = fixture.ledger.issueRouteToken({
        assignmentId: issued.assignment.assignmentId,
        controllerAgentId: TEST_CONTROLLER.agentId,
        controllerSessionKey: TEST_CONTROLLER.sessionKey,
        routeKind: "send",
        targetSessionKey: started.childSessionKey,
      });
      const dispatch = fixture.ledger.consumeSendTokenWithGatewayDispatch({
        delegationToken: sendToken,
        callerAgentId: TEST_CONTROLLER.agentId,
        callerSessionKey: TEST_CONTROLLER.sessionKey,
        targetAgentId: issued.assignment.workerAgentId,
        targetSessionKey: started.childSessionKey,
        idempotencyKey: runId,
      });
      fixture.ledger.consumeGatewayDispatchCapability({
        capability: dispatch.capability,
        controllerSessionKey: TEST_CONTROLLER.sessionKey,
        targetSessionKey: started.childSessionKey,
        idempotencyKey: runId,
      });
      fixture.ledger.recordGatewayDispatchEnqueued({
        capability: dispatch.capability,
        controllerSessionKey: TEST_CONTROLLER.sessionKey,
        targetSessionKey: started.childSessionKey,
        idempotencyKey: runId,
        runId,
        response: { runId, status: "accepted" },
      });

      fixture.ledger.appendRouteEvent({
        assignmentId: issued.assignment.assignmentId,
        kind: "route_rejected",
        payload: { reason: "caller lost the accepted Gateway acknowledgement" },
      });

      const db = unsafeDatabaseForTest(fixture.ledger);
      expect(
        db
          .prepare(
            `SELECT 1 FROM route_events
             WHERE assignment_id = ? AND kind = 'validation_rejected'`,
          )
          .get(issued.assignment.assignmentId),
      ).toBeDefined();
      expect(
        db
          .prepare(
            `SELECT 1 FROM route_events
             WHERE assignment_id = ? AND kind = 'route_rejected'`,
          )
          .get(issued.assignment.assignmentId),
      ).toBeUndefined();
      expect(() =>
        issueAssignment({
          fixture,
          purpose: "discovery",
          role: "helper",
          recoveryOfAssignmentId: issued.assignment.assignmentId,
        }),
      ).toThrow("route-rejection evidence");
    } finally {
      fixture.close();
    }
  });

  it("records validation failure when an accepted worker report precedes execution failure", () => {
    const fixture = createLedgerFixture();
    try {
      const issued = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
      const started = startAssignment({ fixture, ...issued });
      const runId = "failure-after-accepted-report";
      const sendToken = fixture.ledger.issueRouteToken({
        assignmentId: issued.assignment.assignmentId,
        controllerAgentId: TEST_CONTROLLER.agentId,
        controllerSessionKey: TEST_CONTROLLER.sessionKey,
        routeKind: "send",
        targetSessionKey: started.childSessionKey,
      });
      const dispatch = fixture.ledger.consumeSendTokenWithGatewayDispatch({
        delegationToken: sendToken,
        callerAgentId: TEST_CONTROLLER.agentId,
        callerSessionKey: TEST_CONTROLLER.sessionKey,
        targetAgentId: issued.assignment.workerAgentId,
        targetSessionKey: started.childSessionKey,
        idempotencyKey: runId,
      });
      fixture.ledger.consumeGatewayDispatchCapability({
        capability: dispatch.capability,
        controllerSessionKey: TEST_CONTROLLER.sessionKey,
        targetSessionKey: started.childSessionKey,
        idempotencyKey: runId,
      });
      fixture.ledger.recordGatewayDispatchEnqueued({
        capability: dispatch.capability,
        controllerSessionKey: TEST_CONTROLLER.sessionKey,
        targetSessionKey: started.childSessionKey,
        idempotencyKey: runId,
        runId,
        response: { runId, status: "accepted" },
      });
      const report = makeCompleteReport({ assigned: issued.assignment.scopeUnits });
      const receiptId = fixture.ledger.appendReceipt({
        assignmentId: issued.assignment.assignmentId,
        report,
      });
      fixture.ledger.appendValidation({ receiptId, outcome: "accepted" });

      fixture.ledger.recordGatewayDispatchExecutionFailed({
        capability: dispatch.capability,
        controllerSessionKey: TEST_CONTROLLER.sessionKey,
        targetSessionKey: started.childSessionKey,
        idempotencyKey: runId,
        runId,
        response: { message: "worker failed after reporting" },
      });

      const db = unsafeDatabaseForTest(fixture.ledger);
      expect(
        db
          .prepare(
            `SELECT 1 FROM route_events
             WHERE assignment_id = ? AND kind = 'validation_rejected'`,
          )
          .get(issued.assignment.assignmentId),
      ).toBeDefined();
      expect(
        db
          .prepare(
            `SELECT 1 FROM route_events
             WHERE assignment_id = ? AND kind = 'route_rejected'`,
          )
          .get(issued.assignment.assignmentId),
      ).toBeUndefined();
    } finally {
      fixture.close();
    }
  });

  it("rejects identity mutation and deletion through append-only SQLite triggers", () => {
    const fixture = createLedgerFixture();
    try {
      const db = unsafeDatabaseForTest(fixture.ledger);
      expect(() =>
        db
          .prepare("UPDATE candidates SET candidate_digest = ? WHERE candidate_id = ?")
          .run("f".repeat(64), fixture.baselineCandidateId),
      ).toThrow(/append-only/i);
      expect(() =>
        db.prepare("DELETE FROM slices WHERE slice_id = ?").run(fixture.sliceId),
      ).toThrow(/append-only/i);
      expect(fixture.ledger.getCandidateRecord(fixture.baselineCandidateId)).toBeDefined();
    } finally {
      fixture.close();
    }
  });

  it("creates baseline and candidate-wave records atomically", () => {
    const fixture = createLedgerFixture();
    try {
      expect(fixture.ledger.status()).toMatchObject({ slices: 1, candidates: 1, waves: 0 });
      const invalidBaseline = createFingerprint({
        guard: fixture.guard,
        policyDigest: fixture.policyDigest,
        scope: fixture.scope,
        epoch: fixture.ledger.currentEpoch(),
        label: "invalid-baseline",
      });
      invalidBaseline.scopeDigest = "wrong-scope";
      expect(() =>
        fixture.ledger.createSliceWithBaseline({
          controllerAgentId: TEST_CONTROLLER.agentId,
          controllerSessionKey: TEST_CONTROLLER.sessionKey,
          repositoryRoot: fixture.rootDir,
          scope: fixture.scope,
          fingerprint: invalidBaseline,
        }),
      ).toThrow(/baseline fingerprint/i);
      expect(fixture.ledger.status()).toMatchObject({ slices: 1, candidates: 1 });

      completeDiscoveryAndImplementation(fixture);
      const candidate = createFingerprint({
        guard: fixture.guard,
        policyDigest: fixture.policyDigest,
        scope: fixture.scope,
        epoch: fixture.ledger.currentEpoch(),
        label: "atomic-wave",
      });
      const before = fixture.ledger.status();
      expect(() =>
        fixture.ledger.recordCandidateAndFreezeWave({
          sliceId: fixture.sliceId,
          fingerprint: candidate,
          requiredRoles: ["tester"],
        }),
      ).toThrow(/tester and reviewer/i);
      expect(fixture.ledger.status()).toEqual(before);

      const frozen = fixture.ledger.recordCandidateAndFreezeWave({
        sliceId: fixture.sliceId,
        fingerprint: candidate,
        requiredRoles: ["tester", "reviewer"],
      });
      expect(frozen.candidateId).not.toBe(fixture.baselineCandidateId);
      expect(fixture.ledger.status()).toMatchObject({ candidates: 2, waves: 1 });
    } finally {
      fixture.close();
    }
  });

  it("rejects stale candidates and invalidates outstanding tokens after rollback", () => {
    const fixture = createLedgerFixture();
    try {
      completeDiscoveryAndImplementation(fixture);
      const firstCandidateId = fixture.ledger.recordCandidate({
        sliceId: fixture.sliceId,
        fingerprint: createFingerprint({
          guard: fixture.guard,
          policyDigest: fixture.policyDigest,
          scope: fixture.scope,
          epoch: fixture.ledger.currentEpoch(),
          label: "candidate-a",
        }),
      });
      const latestCandidateId = fixture.ledger.recordCandidate({
        sliceId: fixture.sliceId,
        fingerprint: createFingerprint({
          guard: fixture.guard,
          policyDigest: fixture.policyDigest,
          scope: fixture.scope,
          epoch: fixture.ledger.currentEpoch(),
          label: "candidate-b",
        }),
      });
      expect(() =>
        fixture.ledger.freezeWave({
          sliceId: fixture.sliceId,
          candidateId: firstCandidateId,
          requiredRoles: ["tester", "reviewer"],
        }),
      ).toThrow(/latest protected candidate/i);
      const waveId = fixture.ledger.freezeWave({
        sliceId: fixture.sliceId,
        candidateId: latestCandidateId,
        requiredRoles: ["tester", "reviewer"],
      });
      const staleAssignment = issueAssignment({
        fixture,
        purpose: "verification",
        role: "tester",
        candidateId: latestCandidateId,
        waveId,
      });
      fixture.ledger.appendRouteEvent({
        assignmentId: staleAssignment.assignment.assignmentId,
        kind: "route_rejected",
        payload: { reason: "settled before rollback" },
      });
      fixture.ledger.rollback({ actorAgentId: TEST_CONTROLLER.agentId, reason: "test rollback" });
      expect(() =>
        fixture.ledger.consumeAssignmentToken({
          delegationToken: staleAssignment.delegationToken,
          routeKind: "spawn",
          callerAgentId: TEST_CONTROLLER.agentId,
          callerSessionKey: TEST_CONTROLLER.sessionKey,
          targetAgentId: "implementer",
        }),
      ).toThrow(/stale/i);
    } finally {
      fixture.close();
    }
  });

  it("consumes delegation tokens once and permits only one rejected-route recovery", () => {
    const fixture = createLedgerFixture();
    try {
      const first = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
      const consume = () =>
        fixture.ledger.consumeAssignmentToken({
          delegationToken: first.delegationToken,
          routeKind: "spawn",
          callerAgentId: TEST_CONTROLLER.agentId,
          callerSessionKey: TEST_CONTROLLER.sessionKey,
          targetAgentId: "helper",
        });
      expect(consume().assignmentId).toBe(first.assignment.assignmentId);
      expect(consume).toThrow();
      fixture.ledger.appendRouteEvent({
        assignmentId: first.assignment.assignmentId,
        kind: "route_rejected",
      });

      const recovery = issueAssignment({
        fixture,
        purpose: "discovery",
        role: "helper",
        recoveryOfAssignmentId: first.assignment.assignmentId,
      });
      fixture.ledger.appendRouteEvent({
        assignmentId: recovery.assignment.assignmentId,
        kind: "route_rejected",
      });
      expect(() =>
        issueAssignment({
          fixture,
          purpose: "discovery",
          role: "helper",
          recoveryOfAssignmentId: recovery.assignment.assignmentId,
        }),
      ).toThrow(/one recovery child/i);
    } finally {
      fixture.close();
    }
  });

  it("names the blocking assignment and same-epoch new-slice recovery for duplicate phases", () => {
    const fixture = createLedgerFixture();
    try {
      const first = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
      expect(() => issueAssignment({ fixture, purpose: "discovery", role: "helper" })).toThrow(
        new RegExp(
          `${first.assignment.assignmentId}.*settlement state pending.*corrected new slice in the same epoch`,
          "i",
        ),
      );
    } finally {
      fixture.close();
    }
  });

  it("keeps validation rejection fail-closed and directs recovery to a corrected new slice", () => {
    const fixture = createLedgerFixture();
    try {
      const first = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
      startAssignment({ fixture, ...first });
      const rejected = fixture.ledger.appendValidatedReceipt({
        assignmentId: first.assignment.assignmentId,
        report: makeCompleteReport({ assigned: first.assignment.scopeUnits }),
        outcome: "rejected",
        issues: [{ code: "validator-rejected", message: "binding rejected" }],
      });
      fixture.ledger.appendRouteEvent({
        assignmentId: first.assignment.assignmentId,
        kind: "validation_rejected",
        payload: { receiptId: rejected.receiptId },
      });

      expect(() =>
        issueAssignment({
          fixture,
          purpose: "discovery",
          role: "helper",
          recoveryOfAssignmentId: first.assignment.assignmentId,
        }),
      ).toThrow(
        new RegExp(
          `${first.assignment.assignmentId}.*settlement state validation_rejected.*corrected new slice in the same epoch`,
          "i",
        ),
      );
    } finally {
      fixture.close();
    }
  });

  it.each([
    [
      "missing scope disposition",
      (report: ReturnType<typeof makeCompleteReport>) => {
        report.scope.inspected.pop();
      },
    ],
    [
      "duplicate scope disposition",
      (report: ReturnType<typeof makeCompleteReport>) => {
        report.scope.omitted.push({
          scopeId: report.scope.assigned[0],
          path: report.scope.assigned[0],
          reason: "duplicate",
          missReasonCode: "search-missed",
        });
      },
    ],
    [
      "truncated command under complete coverage",
      (report: ReturnType<typeof makeCompleteReport>) => {
        report.commands.push({
          evidenceId: "command-1",
          purpose: "bounded search",
          command: "rg pattern",
          cwd: "/workspace",
          exitCode: 0,
          scopeIds: report.scope.assigned,
          cap: 10,
          resultCount: 10,
          truncated: true,
        });
      },
    ],
    [
      "inspected scope without evidence",
      (report: ReturnType<typeof makeCompleteReport>) => {
        report.scope.inspected[0].evidenceIds = [];
      },
    ],
    [
      "complete report without any evidence",
      (report: ReturnType<typeof makeCompleteReport>) => {
        report.commands = [];
        for (const inspected of report.scope.inspected) {
          inspected.evidenceIds = [];
        }
      },
    ],
    [
      "inspected scope with failed evidence",
      (report: ReturnType<typeof makeCompleteReport>) => {
        report.commands[0].exitCode = 1;
      },
    ],
    [
      "inspected scope with truncated evidence",
      (report: ReturnType<typeof makeCompleteReport>) => {
        report.commands[0].truncated = true;
      },
    ],
    [
      "inspected scope with evidence bound to another scope",
      (report: ReturnType<typeof makeCompleteReport>) => {
        report.commands[0].scopeIds = [report.scope.assigned[1]];
      },
    ],
  ])("rejects malformed receipt coverage: %s", (_label, mutate) => {
    const fixture = createLedgerFixture();
    try {
      const issued = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
      startAssignment({ fixture, ...issued });
      const report = makeCompleteReport({ assigned: issued.assignment.scopeUnits });
      mutate(report);
      expect(() =>
        fixture.ledger.appendReceipt({
          assignmentId: issued.assignment.assignmentId,
          report,
        }),
      ).toThrow();
      expect(fixture.ledger.hasReceiptForAssignment(issued.assignment.assignmentId)).toBe(false);
    } finally {
      fixture.close();
    }
  });

  it("binds approval-relevant status and coverage into the semantic digest", () => {
    const report = makeCompleteReport({ assigned: ["src/one.ts"] });
    const changed = structuredClone(report);
    changed.status = "blocked";
    changed.coverage = "blocked";

    expect(hashDelegationReportSemantics(changed)).not.toBe(hashDelegationReportSemantics(report));
  });

  it("resumes identical pending receipts and validations idempotently", () => {
    const fixture = createLedgerFixture();
    try {
      const issued = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
      startAssignment({ fixture, ...issued });
      const report = makeCompleteReport({ assigned: issued.assignment.scopeUnits });
      const receiptId = fixture.ledger.appendReceipt({
        assignmentId: issued.assignment.assignmentId,
        report,
      });
      expect(
        fixture.ledger.appendReceipt({
          assignmentId: issued.assignment.assignmentId,
          report: structuredClone(report),
        }),
      ).toBe(receiptId);

      const validationId = fixture.ledger.appendValidation({
        receiptId,
        outcome: "accepted",
      });
      expect(fixture.ledger.appendValidation({ receiptId, outcome: "accepted" })).toBe(
        validationId,
      );
      expect(fixture.ledger.getValidationForReceipt(receiptId)).toMatchObject({
        validationId,
        outcome: "accepted",
        validatorId: fixture.guard.validator.id,
        validatorVersion: fixture.guard.validator.version,
        validatorDigest: fixture.guard.validator.sha256,
      });
    } finally {
      fixture.close();
    }
  });

  it("persists new receipts and validations atomically", () => {
    const fixture = createLedgerFixture();
    try {
      const issued = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
      startAssignment({ fixture, ...issued });
      const report = makeCompleteReport({ assigned: issued.assignment.scopeUnits });
      unsafeDatabaseForTest(fixture.ledger).exec(`
        CREATE TRIGGER fail_atomic_validation
        BEFORE INSERT ON validations
        BEGIN
          SELECT RAISE(ABORT, 'simulated validation write failure');
        END;
      `);

      expect(() =>
        fixture.ledger.appendValidatedReceipt({
          assignmentId: issued.assignment.assignmentId,
          report,
          outcome: "accepted",
        }),
      ).toThrow("simulated validation write failure");
      expect(fixture.ledger.hasReceiptForAssignment(issued.assignment.assignmentId)).toBe(false);
    } finally {
      fixture.close();
    }
  });

  it("keeps the report slot open when pre-receipt audit mapping fails", () => {
    const fixture = createLedgerFixture();
    try {
      const issued = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
      startAssignment({ fixture, ...issued });
      const report = makeCompleteReport({ assigned: issued.assignment.scopeUnits });
      const db = unsafeDatabaseForTest(fixture.ledger);
      db.exec(`
        CREATE TRIGGER fail_pre_receipt_mapping
        BEFORE INSERT ON assignment_audit_events
        BEGIN
          SELECT RAISE(ABORT, 'simulated audit mapping failure');
        END;
      `);

      expect(() =>
        fixture.ledger.appendPreReceiptReportRejection({
          assignmentId: issued.assignment.assignmentId,
          errorCode: "report_structure_invalid",
          submittedSemanticDigest: hashDelegationReportSemantics(report),
          reportBytes: Buffer.byteLength(JSON.stringify(report), "utf8"),
          message: "🦞".repeat(400),
        }),
      ).toThrow("simulated audit mapping failure");
      expect(fixture.ledger.hasReceiptForAssignment(issued.assignment.assignmentId)).toBe(false);
      expect(
        fixture.ledger.latestPreReceiptReportRejection(issued.assignment.assignmentId),
      ).toBeUndefined();

      db.exec("DROP TRIGGER fail_pre_receipt_mapping");
      const rejection = fixture.ledger.appendPreReceiptReportRejection({
        assignmentId: issued.assignment.assignmentId,
        errorCode: "report_structure_invalid",
        submittedSemanticDigest: hashDelegationReportSemantics(report),
        reportBytes: Buffer.byteLength(JSON.stringify(report), "utf8"),
        message: "🦞".repeat(400),
      });
      expect(Buffer.byteLength(rejection.message, "utf8")).toBeLessThanOrEqual(1024);
      expect(
        fixture.ledger.latestPreReceiptReportRejection(issued.assignment.assignmentId),
      ).toEqual(rejection);
      expect(fixture.ledger.hasReceiptForAssignment(issued.assignment.assignmentId)).toBe(false);

      const corrected = fixture.ledger.appendValidatedReceipt({
        assignmentId: issued.assignment.assignmentId,
        report,
        outcome: "accepted",
      });
      expect(corrected.receiptId).toMatch(/^receipt_/);
    } finally {
      fixture.close();
    }
  });

  it("ports pre-receipt rejection through corrected same-epoch new-slice recovery", () => {
    const fixture = createLedgerFixture();
    try {
      const rejected = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
      startAssignment({ fixture, ...rejected });
      const report = makeCompleteReport({ assigned: rejected.assignment.scopeUnits });
      const audit = fixture.ledger.appendPreReceiptReportRejection({
        assignmentId: rejected.assignment.assignmentId,
        errorCode: "report_structure_invalid",
        submittedSemanticDigest: hashDelegationReportSemantics(report),
        reportBytes: Buffer.byteLength(JSON.stringify(report), "utf8"),
        message: "worker returned invalid report structure before ending",
      });

      expect(fixture.ledger.hasReceiptForAssignment(rejected.assignment.assignmentId)).toBe(false);
      expect(
        fixture.ledger.latestPreReceiptReportRejection(rejected.assignment.assignmentId),
      ).toEqual(audit);
      expect(() =>
        fixture.ledger.appendFormatCorrection({
          assignmentId: rejected.assignment.assignmentId,
          originalReceiptId: "receipt-missing",
          report,
        }),
      ).toThrow(/requires one rejected initial receipt/i);
      expect(() =>
        issueAssignment({
          fixture,
          purpose: "discovery",
          role: "helper",
          recoveryOfAssignmentId: rejected.assignment.assignmentId,
        }),
      ).toThrow(/settlement state pending.*corrected new slice in the same epoch/i);
      expect(() => issueAssignment({ fixture, purpose: "discovery", role: "helper" })).toThrow(
        new RegExp(`${rejected.assignment.assignmentId}.*corrected new slice`, "i"),
      );

      const repositoryRoot = fixture.ledger.getSliceScope(fixture.sliceId)?.repositoryRoot;
      if (!repositoryRoot) {
        throw new Error("missing repository root");
      }
      const baseline = fixture.ledger.createSliceWithBaseline({
        controllerAgentId: TEST_CONTROLLER.agentId,
        controllerSessionKey: TEST_CONTROLLER.sessionKey,
        repositoryRoot,
        scope: fixture.scope,
        fingerprint: createFingerprint({
          guard: fixture.guard,
          policyDigest: fixture.policyDigest,
          scope: fixture.scope,
          epoch: fixture.ledger.currentEpoch(),
          label: "corrected-new-slice",
        }),
      });
      const correctedFixture = { ...fixture, sliceId: baseline.sliceId };
      const corrected = issueAssignment({
        fixture: correctedFixture,
        purpose: "discovery",
        role: "helper",
      });
      startAssignment({ fixture: correctedFixture, ...corrected });
      const accepted = fixture.ledger.appendValidatedReceipt({
        assignmentId: corrected.assignment.assignmentId,
        report: makeCompleteReport({ assigned: corrected.assignment.scopeUnits }),
        outcome: "accepted",
      });
      expect(fixture.ledger.getValidationForReceipt(accepted.receiptId)?.outcome).toBe("accepted");
      expect(corrected.assignment.epoch).toBe(rejected.assignment.epoch);
    } finally {
      fixture.close();
    }
  });

  it("rejects invalid newly discovered scope before every direct initial receipt write", () => {
    const fixture = createLedgerFixture();
    try {
      const issued = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
      startAssignment({ fixture, ...issued });
      const report = makeCompleteReport({ assigned: issued.assignment.scopeUnits });
      report.scope.newlyDiscovered.push({
        scopeId: issued.assignment.scopeUnits[0],
        path: issued.assignment.scopeUnits[0],
        reason: "incorrectly rediscovered assigned scope",
        disposition: "follow-up",
        evidenceIds: [],
      });

      expect(() =>
        fixture.ledger.appendValidatedReceipt({
          assignmentId: issued.assignment.assignmentId,
          report,
          outcome: "accepted",
        }),
      ).toThrow(/collides with assigned scope/i);
      expect(fixture.ledger.hasReceiptForAssignment(issued.assignment.assignmentId)).toBe(false);
    } finally {
      fixture.close();
    }
  });

  it("closes a legacy receipt whose validation was interrupted by restart", async () => {
    const fixture = createLedgerFixture();
    const issued = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
    startAssignment({ fixture, ...issued });
    const receiptId = fixture.ledger.appendReceipt({
      assignmentId: issued.assignment.assignmentId,
      report: makeCompleteReport({ assigned: issued.assignment.scopeUnits }),
    });
    closeLedgerForTest(fixture.ledger);

    vi.resetModules();
    const restartedModule = await import("./ledger.js");
    const restarted = restartedModule.openDelegationLedger({
      guard: fixture.guard,
      policyDigest: fixture.policyDigest,
      stateDir: fixture.stateDir,
      reconcileGatewayTask: reconcileNoTestGatewayTask,
    });
    try {
      expect(restarted.getValidationForReceipt(receiptId)).toMatchObject({
        outcome: "blocked",
      });
      expect(
        unsafeDatabaseForTest(restarted)
          .prepare(
            `SELECT 1 FROM route_events
             WHERE assignment_id = ? AND kind = 'validation_rejected'`,
          )
          .get(issued.assignment.assignmentId),
      ).toBeDefined();
    } finally {
      closeLedgerForTest(restarted);
      fixture.close();
    }
  });

  it("blocks future initial receipts after terminal validation rejection", () => {
    const fixture = createLedgerFixture();
    try {
      const issued = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
      startAssignment({ fixture, ...issued });
      fixture.ledger.appendRouteEvent({
        assignmentId: issued.assignment.assignmentId,
        kind: "validation_rejected",
        payload: { code: "missing-accepted-report" },
        createdAt: 1_000,
      });
      expect(() =>
        fixture.ledger.appendReceipt({
          assignmentId: issued.assignment.assignmentId,
          report: makeCompleteReport({ assigned: issued.assignment.scopeUnits }),
          createdAt: 1_001,
        }),
      ).toThrow(/arrived after its route/i);
      expect(fixture.ledger.hasReceiptForAssignment(issued.assignment.assignmentId)).toBe(false);
    } finally {
      fixture.close();
    }
  });

  it("blocks reopen when historical rows contain an initial receipt after validation rejection", async () => {
    const fixture = createLedgerFixture();
    const issued = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
    startAssignment({ fixture, ...issued });
    fixture.ledger.appendRouteEvent({
      assignmentId: issued.assignment.assignmentId,
      kind: "validation_rejected",
      payload: { code: "missing-accepted-report" },
      createdAt: 1_000,
    });
    const report = makeCompleteReport({ assigned: issued.assignment.scopeUnits });
    unsafeDatabaseForTest(fixture.ledger)
      .prepare(
        `INSERT INTO receipts
         (receipt_id, assignment_id, semantic_digest, report_json, correction_of, created_at)
         VALUES ('historical-late-receipt', ?, ?, ?, NULL, 1001)`,
      )
      .run(
        issued.assignment.assignmentId,
        hashDelegationReportSemantics(report),
        JSON.stringify(report),
      );
    closeLedgerForTest(fixture.ledger);

    vi.resetModules();
    const restartedModule = await import("./ledger.js");
    expect(() =>
      restartedModule.openDelegationLedger({
        guard: fixture.guard,
        policyDigest: fixture.policyDigest,
        stateDir: fixture.stateDir,
        reconcileGatewayTask: reconcileNoTestGatewayTask,
      }),
    ).toThrow(
      new RegExp(`${issued.assignment.assignmentId}.*initial receipt.*operator action`, "i"),
    );
    fixture.close();
  });

  it("blocks reopen for receipt coexistence with rejected or timed-out routes and equal-time late validation", async () => {
    const scenarios = [
      { kind: "route_rejected" as const, receiptCreatedAt: 999 },
      { kind: "timeout" as const, receiptCreatedAt: 999 },
      { kind: "validation_rejected" as const, receiptCreatedAt: 1_000 },
    ];
    const fixtures = scenarios.map((scenario, index) => {
      const fixture = createLedgerFixture();
      const issued = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
      startAssignment({ fixture, ...issued });
      fixture.ledger.appendRouteEvent({
        assignmentId: issued.assignment.assignmentId,
        kind: scenario.kind,
        payload: { code: `terminal-before-receipt-${index}` },
        createdAt: 1_000,
      });
      const report = makeCompleteReport({ assigned: issued.assignment.scopeUnits });
      unsafeDatabaseForTest(fixture.ledger)
        .prepare(
          `INSERT INTO receipts
           (receipt_id, assignment_id, semantic_digest, report_json, correction_of, created_at)
           VALUES (?, ?, ?, ?, NULL, ?)`,
        )
        .run(
          `historical-contradictory-receipt-${index}`,
          issued.assignment.assignmentId,
          hashDelegationReportSemantics(report),
          JSON.stringify(report),
          scenario.receiptCreatedAt,
        );
      closeLedgerForTest(fixture.ledger);
      return { fixture, assignmentId: issued.assignment.assignmentId, kind: scenario.kind };
    });

    vi.resetModules();
    const restartedModule = await import("./ledger.js");
    try {
      for (const scenario of fixtures) {
        expect(() =>
          restartedModule.openDelegationLedger({
            guard: scenario.fixture.guard,
            policyDigest: scenario.fixture.policyDigest,
            stateDir: scenario.fixture.stateDir,
            reconcileGatewayTask: reconcileNoTestGatewayTask,
          }),
        ).toThrow(new RegExp(`${scenario.assignmentId}.*${scenario.kind}.*operator action`, "i"));
      }
    } finally {
      for (const scenario of fixtures) {
        scenario.fixture.close();
      }
    }
  });

  it("allows an equal-time validation rejection backed by its exact rejected receipt", async () => {
    const fixture = createLedgerFixture();
    const issued = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
    startAssignment({ fixture, ...issued });
    const rejected = fixture.ledger.appendRejectedReceipt({
      assignmentId: issued.assignment.assignmentId,
      report: makeCompleteReport({ assigned: issued.assignment.scopeUnits }),
      issues: [{ code: "format", message: "format correction required" }],
      createdAt: 1_000,
    });
    fixture.ledger.appendRouteEvent({
      assignmentId: issued.assignment.assignmentId,
      kind: "validation_rejected",
      payload: { receiptId: rejected.receiptId, validationId: rejected.validationId },
      createdAt: 1_000,
    });
    closeLedgerForTest(fixture.ledger);

    vi.resetModules();
    const restartedModule = await import("./ledger.js");
    const restarted = restartedModule.openDelegationLedger({
      guard: fixture.guard,
      policyDigest: fixture.policyDigest,
      stateDir: fixture.stateDir,
      reconcileGatewayTask: reconcileNoTestGatewayTask,
    });
    try {
      expect(restarted.rejectedReceiptForAssignment(issued.assignment.assignmentId)).toMatchObject({
        receiptId: rejected.receiptId,
        validationId: rejected.validationId,
      });
    } finally {
      closeLedgerForTest(restarted);
      fixture.close();
    }
  });

  it("allows an equal-time post-report terminal rejection to survive reopen", async () => {
    const fixture = createLedgerFixture();
    const issued = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
    startAssignment({ fixture, ...issued });
    const accepted = fixture.ledger.appendValidatedReceipt({
      assignmentId: issued.assignment.assignmentId,
      report: makeCompleteReport({ assigned: issued.assignment.scopeUnits }),
      outcome: "accepted",
      createdAt: 1_000,
    });
    fixture.ledger.appendRouteEvent({
      assignmentId: issued.assignment.assignmentId,
      kind: "validation_rejected",
      payload: { code: "run-timeout-after-report", receiptId: accepted.receiptId },
      createdAt: 1_000,
    });
    closeLedgerForTest(fixture.ledger);

    vi.resetModules();
    const restartedModule = await import("./ledger.js");
    const restarted = restartedModule.openDelegationLedger({
      guard: fixture.guard,
      policyDigest: fixture.policyDigest,
      stateDir: fixture.stateDir,
      reconcileGatewayTask: reconcileNoTestGatewayTask,
    });
    try {
      expect(
        restarted.latestValidationRejectedRouteForAssignment(
          issued.assignment.assignmentId,
          accepted.receiptId,
        ),
      ).toMatchObject({
        payload: { code: "run-timeout-after-report", receiptId: accepted.receiptId },
        createdAt: 1_000,
      });
    } finally {
      closeLedgerForTest(restarted);
      fixture.close();
    }
  });

  it("preserves committed v1 receipt-before-rejection order during v2 migration", async () => {
    const fixture = createLedgerFixture();
    const issued = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
    startAssignment({ fixture, ...issued });
    const rejected = fixture.ledger.appendRejectedReceipt({
      assignmentId: issued.assignment.assignmentId,
      report: makeCompleteReport({ assigned: issued.assignment.scopeUnits }),
      issues: [{ code: "format", message: "format correction required" }],
      createdAt: 1_000,
    });
    const terminalEventId = fixture.ledger.appendRouteEvent({
      assignmentId: issued.assignment.assignmentId,
      kind: "validation_rejected",
      payload: { receiptId: rejected.receiptId, validationId: rejected.validationId },
      createdAt: 1_001,
    });
    replaceV2AppendOrderWithCommittedV1(unsafeDatabaseForTest(fixture.ledger));
    closeLedgerForTest(fixture.ledger);

    vi.resetModules();
    const restartedModule = await import("./ledger.js");
    const restarted = restartedModule.openDelegationLedger({
      guard: fixture.guard,
      policyDigest: fixture.policyDigest,
      stateDir: fixture.stateDir,
      reconcileGatewayTask: reconcileNoTestGatewayTask,
    });
    try {
      const ordered = unsafeDatabaseForTest(restarted)
        .prepare(
          `SELECT record_kind AS recordKind, record_id AS recordId
           FROM ledger_record_appends_v2
           WHERE assignment_id = ? AND record_id IN (?, ?)
           ORDER BY append_sequence`,
        )
        .all(issued.assignment.assignmentId, rejected.receiptId, terminalEventId) as Array<{
        recordKind: string;
        recordId: string;
      }>;
      expect(ordered).toEqual([
        { recordKind: "receipt", recordId: rejected.receiptId },
        { recordKind: "route_event", recordId: terminalEventId },
      ]);
    } finally {
      closeLedgerForTest(restarted);
      fixture.close();
    }
  });

  it("preserves committed v1 route-before-receipt order and fails closed", async () => {
    const fixture = createLedgerFixture();
    const issued = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
    startAssignment({ fixture, ...issued });
    const legacyReceiptId = "v1-route-first-receipt";
    const legacyValidationId = "v1-route-first-validation";
    fixture.ledger.appendRouteEvent({
      assignmentId: issued.assignment.assignmentId,
      kind: "validation_rejected",
      payload: { receiptId: legacyReceiptId, validationId: legacyValidationId },
      createdAt: 1_000,
    });
    const report = makeCompleteReport({ assigned: issued.assignment.scopeUnits });
    const db = unsafeDatabaseForTest(fixture.ledger);
    db.prepare(
      `INSERT INTO receipts
       (receipt_id, assignment_id, semantic_digest, report_json, correction_of, created_at)
       VALUES (?, ?, ?, ?, NULL, 1001)`,
    ).run(
      legacyReceiptId,
      issued.assignment.assignmentId,
      hashDelegationReportSemantics(report),
      JSON.stringify(report),
    );
    db.prepare(
      `INSERT INTO validations
       (validation_id, receipt_id, outcome, validator_id, validator_version,
        validator_digest, issues_json, created_at)
       VALUES (?, ?, 'rejected', 'legacy-validator', '1', 'legacy-digest', '[]', 1001)`,
    ).run(legacyValidationId, legacyReceiptId);
    replaceV2AppendOrderWithCommittedV1(db);
    closeLedgerForTest(fixture.ledger);

    vi.resetModules();
    const restartedModule = await import("./ledger.js");
    const reopen = () =>
      restartedModule.openDelegationLedger({
        guard: fixture.guard,
        policyDigest: fixture.policyDigest,
        stateDir: fixture.stateDir,
        reconcileGatewayTask: reconcileNoTestGatewayTask,
      });
    try {
      expect(reopen).toThrow(/receipt contradicts terminal validation_rejected/i);
      expect(reopen).toThrow(/receipt contradicts terminal validation_rejected/i);
    } finally {
      fixture.close();
    }
  });

  it("rejects an equal-time tie already laundered by the f092 v1 backfill", async () => {
    const fixture = createLedgerFixture();
    const issued = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
    startAssignment({ fixture, ...issued });
    const legacyReceiptId = "f092-laundered-receipt";
    const legacyValidationId = "f092-laundered-validation";
    fixture.ledger.appendRouteEvent({
      assignmentId: issued.assignment.assignmentId,
      kind: "validation_rejected",
      payload: { receiptId: legacyReceiptId, validationId: legacyValidationId },
      createdAt: 1_000,
    });
    const report = makeCompleteReport({ assigned: issued.assignment.scopeUnits });
    const db = unsafeDatabaseForTest(fixture.ledger);
    db.prepare(
      `INSERT INTO receipts
       (receipt_id, assignment_id, semantic_digest, report_json, correction_of, created_at)
       VALUES (?, ?, ?, ?, NULL, 1000)`,
    ).run(
      legacyReceiptId,
      issued.assignment.assignmentId,
      hashDelegationReportSemantics(report),
      JSON.stringify(report),
    );
    db.prepare(
      `INSERT INTO validations
       (validation_id, receipt_id, outcome, validator_id, validator_version,
        validator_digest, issues_json, created_at)
       VALUES (?, ?, 'rejected', 'legacy-validator', '1', 'legacy-digest', '[]', 1000)`,
    ).run(legacyValidationId, legacyReceiptId);
    replaceV2AppendOrderWithF092BackfilledV1(db);
    closeLedgerForTest(fixture.ledger);

    vi.resetModules();
    const restartedModule = await import("./ledger.js");
    const reopen = () =>
      restartedModule.openDelegationLedger({
        guard: fixture.guard,
        policyDigest: fixture.policyDigest,
        stateDir: fixture.stateDir,
        reconcileGatewayTask: reconcileNoTestGatewayTask,
      });
    try {
      expect(reopen).toThrow(/cannot infer equal-time.*operator action/i);
      expect(reopen).toThrow(/cannot infer equal-time.*operator action/i);
    } finally {
      fixture.close();
    }
  });

  it("fails closed repeatedly for ambiguous legacy equal-time route-before-receipt history", async () => {
    const fixture = createLedgerFixture();
    const issued = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
    startAssignment({ fixture, ...issued });
    const legacyReceiptId = "legacy-ambiguous-receipt";
    const legacyValidationId = "legacy-ambiguous-validation";
    fixture.ledger.appendRouteEvent({
      assignmentId: issued.assignment.assignmentId,
      kind: "validation_rejected",
      payload: {
        code: "terminal-before-receipt",
        receiptId: legacyReceiptId,
        validationId: legacyValidationId,
      },
      createdAt: 1_000,
    });
    const report = makeCompleteReport({ assigned: issued.assignment.scopeUnits });
    const db = unsafeDatabaseForTest(fixture.ledger);
    db.prepare(
      `INSERT INTO receipts
         (receipt_id, assignment_id, semantic_digest, report_json, correction_of, created_at)
         VALUES (?, ?, ?, ?, NULL, 1000)`,
    ).run(
      legacyReceiptId,
      issued.assignment.assignmentId,
      hashDelegationReportSemantics(report),
      JSON.stringify(report),
    );
    db.prepare(
      `INSERT INTO validations
       (validation_id, receipt_id, outcome, validator_id, validator_version,
        validator_digest, issues_json, created_at)
       VALUES (?, ?, 'rejected', 'legacy-validator', '1', 'legacy-digest', '[]', 1000)`,
    ).run(legacyValidationId, legacyReceiptId);
    db.exec(`
      DROP TRIGGER receipts_record_append_order_v2;
      DROP TRIGGER route_events_record_append_order_v2;
      DROP TABLE ledger_record_appends_v2;
      DROP TABLE ledger_schema_migrations;
    `);
    closeLedgerForTest(fixture.ledger);

    vi.resetModules();
    const restartedModule = await import("./ledger.js");
    const reopen = () =>
      restartedModule.openDelegationLedger({
        guard: fixture.guard,
        policyDigest: fixture.policyDigest,
        stateDir: fixture.stateDir,
        reconcileGatewayTask: reconcileNoTestGatewayTask,
      });
    try {
      expect(reopen).toThrow(/cannot infer equal-time.*operator action/i);
      expect(reopen).toThrow(/cannot infer equal-time.*operator action/i);
    } finally {
      fixture.close();
    }
  });

  it("allows exactly one semantic-preserving format correction and resumes it", () => {
    const fixture = createLedgerFixture();
    try {
      const issued = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
      startAssignment({ fixture, ...issued });
      const report = makeCompleteReport({ assigned: issued.assignment.scopeUnits });
      const originalReceiptId = fixture.ledger.appendReceipt({
        assignmentId: issued.assignment.assignmentId,
        report,
      });
      const originalValidationId = fixture.ledger.appendValidation({
        receiptId: originalReceiptId,
        outcome: "rejected",
        issues: [{ code: "format", message: "format only" }],
      });
      fixture.ledger.appendRouteEvent({
        assignmentId: issued.assignment.assignmentId,
        kind: "validation_rejected",
        payload: { receiptId: originalReceiptId, validationId: originalValidationId },
      });

      const correctedReceiptId = fixture.ledger.appendFormatCorrection({
        assignmentId: issued.assignment.assignmentId,
        originalReceiptId,
        report,
      });
      expect(correctedReceiptId).not.toBe(originalReceiptId);
      expect(
        fixture.ledger.appendFormatCorrection({
          assignmentId: issued.assignment.assignmentId,
          originalReceiptId,
          report: structuredClone(report),
        }),
      ).toBe(correctedReceiptId);
      const correctedValidationId = fixture.ledger.appendValidation({
        receiptId: correctedReceiptId,
        outcome: "accepted",
      });
      expect(
        fixture.ledger.appendValidation({
          receiptId: correctedReceiptId,
          outcome: "accepted",
        }),
      ).toBe(correctedValidationId);

      const changed = structuredClone(report);
      changed.conclusionScope = "Changed approval semantics.";
      expect(() =>
        fixture.ledger.appendFormatCorrection({
          assignmentId: issued.assignment.assignmentId,
          originalReceiptId,
          report: changed,
        }),
      ).toThrow();
    } finally {
      fixture.close();
    }
  });

  it("rejects a format correction when its original rejection event is missing", () => {
    const fixture = createLedgerFixture();
    try {
      const issued = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
      startAssignment({ fixture, ...issued });
      const report = makeCompleteReport({ assigned: issued.assignment.scopeUnits });
      const rejected = fixture.ledger.appendRejectedReceipt({
        assignmentId: issued.assignment.assignmentId,
        report,
        issues: [{ code: "format", message: "format correction required" }],
      });

      expect(() =>
        fixture.ledger.appendFormatCorrection({
          assignmentId: issued.assignment.assignmentId,
          originalReceiptId: rejected.receiptId,
          report,
        }),
      ).toThrow(/one exact earlier protected rejection event/i);
      expect(
        unsafeDatabaseForTest(fixture.ledger)
          .prepare(`SELECT 1 FROM correction_uses WHERE assignment_id = ?`)
          .get(issued.assignment.assignmentId),
      ).toBeUndefined();
    } finally {
      fixture.close();
    }
  });

  it("rejects a format correction when its rejection event precedes the original receipt", () => {
    const fixture = createLedgerFixture();
    try {
      const issued = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
      startAssignment({ fixture, ...issued });
      const originalReceiptId = "route-first-correction-receipt";
      const originalValidationId = "route-first-correction-validation";
      fixture.ledger.appendRouteEvent({
        assignmentId: issued.assignment.assignmentId,
        kind: "validation_rejected",
        payload: { receiptId: originalReceiptId, validationId: originalValidationId },
      });
      const report = makeCompleteReport({ assigned: issued.assignment.scopeUnits });
      const db = unsafeDatabaseForTest(fixture.ledger);
      db.prepare(
        `INSERT INTO receipts
         (receipt_id, assignment_id, semantic_digest, report_json, correction_of, created_at)
         VALUES (?, ?, ?, ?, NULL, ?)`,
      ).run(
        originalReceiptId,
        issued.assignment.assignmentId,
        hashDelegationReportSemantics(report),
        JSON.stringify(report),
        Date.now(),
      );
      db.prepare(
        `INSERT INTO validations
         (validation_id, receipt_id, outcome, validator_id, validator_version,
          validator_digest, issues_json, created_at)
         VALUES (?, ?, 'rejected', 'legacy-validator', '1', 'legacy-digest', '[]', ?)`,
      ).run(originalValidationId, originalReceiptId, Date.now());

      expect(() =>
        fixture.ledger.appendFormatCorrection({
          assignmentId: issued.assignment.assignmentId,
          originalReceiptId,
          report,
        }),
      ).toThrow(/one exact earlier protected rejection event/i);
      expect(
        db
          .prepare(`SELECT 1 FROM correction_uses WHERE assignment_id = ?`)
          .get(issued.assignment.assignmentId),
      ).toBeUndefined();
    } finally {
      fixture.close();
    }
  });

  it("preserves semantics across a valid evidence-label format repair", () => {
    const fixture = createLedgerFixture();
    try {
      const issued = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
      startAssignment({ fixture, ...issued });
      const rejectedReport = makeCompleteReport({ assigned: issued.assignment.scopeUnits });
      rejectedReport.artifacts.push({
        evidenceId: "artifact-old",
        path: issued.assignment.scopeUnits[0],
        sha256: "a".repeat(64),
        kind: "scoped fixture content",
      });
      rejectedReport.scope.inspected[0].evidenceIds.push("artifact-old");

      const rejected = fixture.ledger.appendRejectedReceipt({
        assignmentId: issued.assignment.assignmentId,
        report: rejectedReport,
        issues: [{ code: "format", message: "evidence label requires normalization" }],
      });
      fixture.ledger.appendRouteEvent({
        assignmentId: issued.assignment.assignmentId,
        kind: "validation_rejected",
        payload: {
          receiptId: rejected.receiptId,
          validationId: rejected.validationId,
          correction: false,
        },
      });
      expect(fixture.ledger.getValidationForReceipt(rejected.receiptId)).toMatchObject({
        validationId: rejected.validationId,
        outcome: "rejected",
      });

      const correctedReport = structuredClone(rejectedReport);
      correctedReport.artifacts[0].evidenceId = "artifact-1";
      correctedReport.scope.inspected[0].evidenceIds =
        correctedReport.scope.inspected[0].evidenceIds.map((evidenceId) =>
          evidenceId === "artifact-old" ? "artifact-1" : evidenceId,
        );
      expect(hashDelegationReportSemantics(correctedReport)).toBe(rejected.semanticDigest);

      const correctedReceiptId = fixture.ledger.appendFormatCorrection({
        assignmentId: issued.assignment.assignmentId,
        originalReceiptId: rejected.receiptId,
        report: correctedReport,
      });
      expect(fixture.ledger.getReceipt(correctedReceiptId)).toMatchObject({
        correctionOf: rejected.receiptId,
        semanticDigest: rejected.semanticDigest,
      });
    } finally {
      fixture.close();
    }
  });

  it("promotes a protected terminal result after a late format correction", () => {
    const fixture = createLedgerFixture();
    try {
      const issued = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
      const started = startAssignment({ fixture, ...issued });
      const resultText = "terminal worker result captured before correction";
      const runId = "gateway-completion-before-format-correction";
      const sendToken = fixture.ledger.issueRouteToken({
        assignmentId: issued.assignment.assignmentId,
        controllerAgentId: TEST_CONTROLLER.agentId,
        controllerSessionKey: TEST_CONTROLLER.sessionKey,
        routeKind: "send",
        targetSessionKey: started.childSessionKey,
      });
      const dispatch = fixture.ledger.consumeSendTokenWithGatewayDispatch({
        delegationToken: sendToken,
        callerAgentId: TEST_CONTROLLER.agentId,
        callerSessionKey: TEST_CONTROLLER.sessionKey,
        targetAgentId: issued.assignment.workerAgentId,
        targetSessionKey: started.childSessionKey,
        idempotencyKey: runId,
      });
      fixture.ledger.consumeGatewayDispatchCapability({
        capability: dispatch.capability,
        controllerSessionKey: TEST_CONTROLLER.sessionKey,
        targetSessionKey: started.childSessionKey,
        idempotencyKey: runId,
      });
      fixture.ledger.recordGatewayDispatchEnqueued({
        capability: dispatch.capability,
        controllerSessionKey: TEST_CONTROLLER.sessionKey,
        targetSessionKey: started.childSessionKey,
        idempotencyKey: runId,
        runId,
        response: { runId, status: "accepted" },
      });
      fixture.ledger.bindAssignment({
        assignmentId: issued.assignment.assignmentId,
        childSessionKey: started.childSessionKey,
        runId,
      });
      const rejectedReport = makeCompleteReport({ assigned: issued.assignment.scopeUnits });
      rejectedReport.artifacts.push({
        evidenceId: "artifact-old",
        path: issued.assignment.scopeUnits[0],
        sha256: "a".repeat(64),
        kind: "scoped fixture content",
      });
      rejectedReport.scope.inspected[0].evidenceIds.push("artifact-old");
      const rejected = fixture.ledger.appendRejectedReceipt({
        assignmentId: issued.assignment.assignmentId,
        report: rejectedReport,
        issues: [{ code: "format", message: "evidence label requires normalization" }],
      });
      fixture.ledger.appendRouteEvent({
        assignmentId: issued.assignment.assignmentId,
        kind: "validation_rejected",
        payload: {
          receiptId: rejected.receiptId,
          validationId: rejected.validationId,
          correction: false,
        },
      });
      fixture.ledger.recordGatewayDispatchExecutionCompleted({
        capability: dispatch.capability,
        controllerSessionKey: TEST_CONTROLLER.sessionKey,
        targetSessionKey: started.childSessionKey,
        idempotencyKey: runId,
        runId,
        resultText,
      });
      expect(fixture.ledger.status().terminalResults).toBe(1);
      expect(fixture.ledger.isAssignmentCompleted(issued.assignment.assignmentId)).toBe(false);

      const correctedReport = structuredClone(rejectedReport);
      correctedReport.artifacts[0].evidenceId = "artifact-1";
      correctedReport.scope.inspected[0].evidenceIds =
        correctedReport.scope.inspected[0].evidenceIds.map((evidenceId) =>
          evidenceId === "artifact-old" ? "artifact-1" : evidenceId,
        );
      const correctedReceiptId = fixture.ledger.appendFormatCorrection({
        assignmentId: issued.assignment.assignmentId,
        originalReceiptId: rejected.receiptId,
        report: correctedReport,
      });
      fixture.ledger.appendValidation({ receiptId: correctedReceiptId, outcome: "accepted" });

      const terminalReceiptId = fixture.ledger.promoteRecordedTerminalCompletion({
        assignmentId: issued.assignment.assignmentId,
      });
      expect(terminalReceiptId).toMatch(/^terminal-receipt_/);
      expect(
        fixture.ledger.promoteRecordedTerminalCompletion({
          assignmentId: issued.assignment.assignmentId,
        }),
      ).toBe(terminalReceiptId);
      expect(fixture.ledger.isAssignmentCompleted(issued.assignment.assignmentId)).toBe(true);
      expect(
        fixture.ledger.acceptedReceiptForAssignment(issued.assignment.assignmentId)?.receiptId,
      ).toBe(correctedReceiptId);
    } finally {
      fixture.close();
    }
  });

  it.each([
    {
      name: "a global post-report rejection",
      rejectionPayload: (
        _correctedReceiptId: string,
        _originalReceiptId: string,
        _originalValidationId: string,
      ) => ({
        code: "run-timeout-after-report",
      }),
    },
    {
      name: "a rejection targeting the corrected receipt",
      rejectionPayload: (
        correctedReceiptId: string,
        _originalReceiptId: string,
        _originalValidationId: string,
      ) => ({
        receiptId: correctedReceiptId,
        code: "corrected-receipt-terminal-rejection",
      }),
    },
    {
      name: "a later rejection naming the original receipt without its validation identity",
      rejectionPayload: (
        _correctedReceiptId: string,
        originalReceiptId: string,
        _originalValidationId: string,
      ) => ({
        receiptId: originalReceiptId,
        code: "run-timeout-after-correction",
      }),
    },
    {
      name: "a later rejection repeating the original receipt and validation tuple",
      rejectionPayload: (
        _correctedReceiptId: string,
        originalReceiptId: string,
        originalValidationId: string,
      ) => ({
        receiptId: originalReceiptId,
        validationId: originalValidationId,
        code: "same-tuple-rejection-after-correction",
      }),
    },
  ])("keeps $name authoritative across a late result and reopen", async ({ rejectionPayload }) => {
    const fixture = createLedgerFixture();
    const issued = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
    const started = startAssignment({ fixture, ...issued });
    const rejectedReport = makeCompleteReport({ assigned: issued.assignment.scopeUnits });
    rejectedReport.artifacts.push({
      evidenceId: "artifact-old",
      path: issued.assignment.scopeUnits[0],
      sha256: "a".repeat(64),
      kind: "scoped fixture content",
    });
    rejectedReport.scope.inspected[0].evidenceIds.push("artifact-old");
    const rejected = fixture.ledger.appendRejectedReceipt({
      assignmentId: issued.assignment.assignmentId,
      report: rejectedReport,
      issues: [{ code: "format", message: "evidence label requires normalization" }],
      createdAt: 1_000,
    });
    fixture.ledger.appendRouteEvent({
      assignmentId: issued.assignment.assignmentId,
      kind: "validation_rejected",
      payload: {
        receiptId: rejected.receiptId,
        validationId: rejected.validationId,
        correction: false,
      },
      createdAt: 1_000,
    });

    const correctedReport = structuredClone(rejectedReport);
    correctedReport.artifacts[0].evidenceId = "artifact-1";
    correctedReport.scope.inspected[0].evidenceIds =
      correctedReport.scope.inspected[0].evidenceIds.map((evidenceId) =>
        evidenceId === "artifact-old" ? "artifact-1" : evidenceId,
      );
    const correctedReceiptId = fixture.ledger.appendFormatCorrection({
      assignmentId: issued.assignment.assignmentId,
      originalReceiptId: rejected.receiptId,
      report: correctedReport,
      createdAt: 1_001,
    });
    fixture.ledger.appendValidation({
      receiptId: correctedReceiptId,
      outcome: "accepted",
      createdAt: 1_001,
    });
    const terminalRejectionPayload = rejectionPayload(
      correctedReceiptId,
      rejected.receiptId,
      rejected.validationId,
    );
    fixture.ledger.appendRouteEvent({
      assignmentId: issued.assignment.assignmentId,
      kind: "validation_rejected",
      payload: terminalRejectionPayload,
      createdAt: 1_002,
    });

    const resultText = "late result after the route was terminally rejected";
    fixture.ledger.recordTerminalResultReceipt({
      assignmentId: issued.assignment.assignmentId,
      runId: started.runId,
      resultReceipt: {
        receiptId: "late-result-receipt",
        sha256: createHash("sha256").update(resultText).digest("hex"),
        bytes: Buffer.byteLength(resultText),
        capturedAt: 1_003,
        resultText,
      },
      createdAt: 1_003,
    });
    expect(
      fixture.ledger.promoteRecordedTerminalCompletion({
        assignmentId: issued.assignment.assignmentId,
        runId: started.runId,
        createdAt: 1_003,
      }),
    ).toBeUndefined();
    expect(fixture.ledger.isAssignmentCompleted(issued.assignment.assignmentId)).toBe(false);
    expect(
      unsafeDatabaseForTest(fixture.ledger)
        .prepare(`SELECT 1 FROM terminal_receipts WHERE assignment_id = ?`)
        .get(issued.assignment.assignmentId),
    ).toBeUndefined();
    closeLedgerForTest(fixture.ledger);

    vi.resetModules();
    const restartedModule = await import("./ledger.js");
    const restarted = restartedModule.openDelegationLedger({
      guard: fixture.guard,
      policyDigest: fixture.policyDigest,
      stateDir: fixture.stateDir,
      reconcileGatewayTask: reconcileNoTestGatewayTask,
    });
    try {
      expect(restarted.isAssignmentCompleted(issued.assignment.assignmentId)).toBe(false);
      expect(
        restarted.promoteRecordedTerminalCompletion({
          assignmentId: issued.assignment.assignmentId,
          runId: started.runId,
          createdAt: 1_004,
        }),
      ).toBeUndefined();
      expect(
        unsafeDatabaseForTest(restarted)
          .prepare(`SELECT 1 FROM terminal_receipts WHERE assignment_id = ?`)
          .get(issued.assignment.assignmentId),
      ).toBeUndefined();
    } finally {
      closeLedgerForTest(restarted);
      fixture.close();
    }
  });

  it("keeps a later same-tuple rejection applicable by event identity", () => {
    const fixture = createLedgerFixture();
    try {
      const issued = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
      startAssignment({ fixture, ...issued });
      const rejectedReport = makeCompleteReport({ assigned: issued.assignment.scopeUnits });
      rejectedReport.artifacts.push({
        evidenceId: "artifact-old",
        path: issued.assignment.scopeUnits[0],
        sha256: "a".repeat(64),
        kind: "scoped fixture content",
      });
      rejectedReport.scope.inspected[0].evidenceIds.push("artifact-old");
      const rejected = fixture.ledger.appendRejectedReceipt({
        assignmentId: issued.assignment.assignmentId,
        report: rejectedReport,
        issues: [{ code: "format", message: "evidence label requires normalization" }],
        createdAt: 1_000,
      });
      fixture.ledger.appendRouteEvent({
        assignmentId: issued.assignment.assignmentId,
        kind: "validation_rejected",
        payload: {
          code: "format",
          receiptId: rejected.receiptId,
          validationId: rejected.validationId,
        },
        createdAt: 1_000,
      });
      const correctedReport = structuredClone(rejectedReport);
      correctedReport.artifacts[0].evidenceId = "artifact-1";
      correctedReport.scope.inspected[0].evidenceIds =
        correctedReport.scope.inspected[0].evidenceIds.map((evidenceId) =>
          evidenceId === "artifact-old" ? "artifact-1" : evidenceId,
        );
      const correctedReceiptId = fixture.ledger.appendFormatCorrection({
        assignmentId: issued.assignment.assignmentId,
        originalReceiptId: rejected.receiptId,
        report: correctedReport,
        createdAt: 1_001,
      });
      fixture.ledger.appendValidation({
        receiptId: correctedReceiptId,
        outcome: "accepted",
        createdAt: 1_001,
      });

      const insertRouteEvent = unsafeDatabaseForTest(fixture.ledger).prepare(
        `INSERT INTO route_events
         (event_id, assignment_id, kind, payload_json, created_at)
         VALUES (?, ?, 'validation_rejected', ?, ?)`,
      );
      insertRouteEvent.run(
        "route-event_a-applicable",
        issued.assignment.assignmentId,
        JSON.stringify({ code: "run-timeout-after-report", runId: "run-1" }),
        2_000,
      );
      insertRouteEvent.run(
        "route-event_z-later-same-tuple",
        issued.assignment.assignmentId,
        JSON.stringify({
          code: "format",
          receiptId: rejected.receiptId,
          validationId: rejected.validationId,
        }),
        2_000,
      );

      expect(
        fixture.ledger.latestValidationRejectedRouteForAssignment(
          issued.assignment.assignmentId,
          correctedReceiptId,
        ),
      ).toEqual({
        eventId: "route-event_z-later-same-tuple",
        payload: {
          code: "format",
          receiptId: rejected.receiptId,
          validationId: rejected.validationId,
        },
        createdAt: 2_000,
      });
    } finally {
      fixture.close();
    }
  });

  it("accepts artifact evidence only when it is bound to the inspected path", () => {
    const fixture = createLedgerFixture();
    try {
      const issued = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
      startAssignment({ fixture, ...issued });
      const report = makeCompleteReport({ assigned: issued.assignment.scopeUnits });
      const inspected = report.scope.inspected[0];
      inspected.evidenceIds.push("artifact-1");
      report.artifacts.push({
        evidenceId: "artifact-1",
        path: "src/outside.ts",
        sha256: "a".repeat(64),
        kind: "bounded test artifact",
      });

      expect(() =>
        fixture.ledger.appendReceipt({
          assignmentId: issued.assignment.assignmentId,
          report,
        }),
      ).toThrow(/evidence bound to that scope/i);

      report.artifacts[0].path = inspected.path;
      report.commands.unshift({
        evidenceId: "failed-attempt",
        purpose: "Record a failed shell attempt without hiding it.",
        command: "set -o pipefail",
        cwd: "/workspace",
        exitCode: 2,
        scopeIds: [inspected.scopeId],
        cap: 1,
        resultCount: 0,
        truncated: false,
      });
      expect(
        fixture.ledger.appendReceipt({
          assignmentId: issued.assignment.assignmentId,
          report,
        }),
      ).toMatch(/^receipt_/);
    } finally {
      fixture.close();
    }
  });

  it("copies terminal result text transactionally before recording completion", () => {
    const fixture = createLedgerFixture();
    try {
      const issued = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
      const { runId } = startAssignment({ fixture, ...issued });
      const report = makeCompleteReport({ assigned: issued.assignment.scopeUnits });
      const receiptId = fixture.ledger.appendReceipt({
        assignmentId: issued.assignment.assignmentId,
        report,
      });
      fixture.ledger.appendValidation({ receiptId, outcome: "accepted" });
      const resultText = "protected terminal result\nwith full evidence";
      const validSha256 = createHash("sha256").update(resultText).digest("hex");
      const complete = (sha256: string) =>
        fixture.ledger.recordAcceptedTerminalCompletion({
          assignmentId: issued.assignment.assignmentId,
          runId,
          resultReceipt: {
            receiptId: "result-receipt",
            sha256,
            bytes: Buffer.byteLength(resultText),
            capturedAt: 1_700_000_000_000,
            resultText,
          },
        });

      expect(() => complete("0".repeat(64))).toThrow(/metadata is invalid/i);
      const db = unsafeDatabaseForTest(fixture.ledger);
      expect(
        db
          .prepare("SELECT COUNT(*) AS count FROM terminal_receipts WHERE assignment_id = ?")
          .get(issued.assignment.assignmentId),
      ).toEqual({ count: 0 });
      expect(fixture.ledger.isAssignmentCompleted(issued.assignment.assignmentId)).toBe(false);

      const terminalReceiptId = complete(validSha256);
      expect(terminalReceiptId).toMatch(/^terminal-receipt_/);
      const row = db
        .prepare(
          "SELECT result_receipt_json AS resultReceiptJson FROM terminal_receipts WHERE assignment_id = ?",
        )
        .get(issued.assignment.assignmentId) as { resultReceiptJson: string };
      expect(JSON.parse(row.resultReceiptJson)).toMatchObject({
        sha256: validSha256,
        resultText,
      });

      const duplicateResultText = "later compatibility transport rendering";
      expect(
        fixture.ledger.recordAcceptedTerminalCompletion({
          assignmentId: issued.assignment.assignmentId,
          runId,
          resultReceipt: {
            receiptId: "recaptured-result-receipt",
            sha256: createHash("sha256").update(duplicateResultText).digest("hex"),
            bytes: Buffer.byteLength(duplicateResultText),
            capturedAt: 1_700_000_000_001,
            resultText: duplicateResultText,
          },
        }),
      ).toBe(terminalReceiptId);
      expect(JSON.parse(row.resultReceiptJson)).toMatchObject({
        sha256: validSha256,
        resultText,
      });
      expect(fixture.ledger.isAssignmentCompleted(issued.assignment.assignmentId)).toBe(true);
    } finally {
      fixture.close();
    }
  });
});
