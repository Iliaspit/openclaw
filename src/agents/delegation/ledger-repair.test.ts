import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import {
  createDelegationLedgerRepairAuthorization,
  type DelegationLedgerRepairAuthorization,
} from "./ledger-repair-contract.js";
import { applyDelegationLedgerRepair, inspectDelegationLedgerRepair } from "./ledger-repair.js";
import {
  closeLedgerForTest,
  createLedgerFixture,
  issueAssignment,
  makeCompleteReport,
  startAssignment,
  unsafeDatabaseForTest,
  type DelegationLedgerFixture,
} from "./ledger.test-helpers.js";

function createKnownContradiction(): {
  fixture: DelegationLedgerFixture;
  assignmentId: string;
} {
  const fixture = createLedgerFixture();
  const issued = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
  const started = startAssignment({ fixture, ...issued });
  const report = makeCompleteReport({ assigned: issued.assignment.scopeUnits });
  const rejected = fixture.ledger.appendRejectedReceipt({
    assignmentId: issued.assignment.assignmentId,
    report,
    issues: [{ code: "format", message: "format correction required" }],
    createdAt: 1_001,
  });
  const rejectionEventId = fixture.ledger.appendRouteEvent({
    assignmentId: issued.assignment.assignmentId,
    kind: "validation_rejected",
    payload: { receiptId: rejected.receiptId, validationId: rejected.validationId },
    createdAt: 1_002,
  });
  const correctedReceiptId = fixture.ledger.appendFormatCorrection({
    assignmentId: issued.assignment.assignmentId,
    originalReceiptId: rejected.receiptId,
    report,
    createdAt: 1_003,
  });
  fixture.ledger.appendValidation({
    receiptId: correctedReceiptId,
    outcome: "accepted",
    createdAt: 1_004,
  });
  const resultText = "completed corrected delegation";
  fixture.ledger.recordAcceptedTerminalCompletion({
    assignmentId: issued.assignment.assignmentId,
    runId: started.runId,
    resultReceipt: {
      receiptId: "known-corruption-result",
      sha256: createHash("sha256").update(resultText).digest("hex"),
      bytes: Buffer.byteLength(resultText),
      capturedAt: 1_005,
      resultText,
    },
    createdAt: 1_005,
  });

  // Reproduce the exact historical contradiction. Tests deliberately remove
  // only the superseded rejection and its append-order row; production repair
  // never deletes, updates, or ignores an existing ledger record.
  const db = unsafeDatabaseForTest(fixture.ledger);
  db.exec(`
    DROP TRIGGER route_events_reject_delete;
    DROP TRIGGER ledger_record_appends_v2_reject_delete;
  `);
  db.prepare(
    `DELETE FROM ledger_record_appends_v2
     WHERE record_kind = 'route_event' AND record_id = ?`,
  ).run(rejectionEventId);
  db.prepare(`DELETE FROM route_events WHERE event_id = ?`).run(rejectionEventId);
  closeLedgerForTest(fixture.ledger);
  return { fixture, assignmentId: issued.assignment.assignmentId };
}

function authorize(params: {
  fixture: DelegationLedgerFixture;
  assignmentId: string;
  idempotencyKey?: string;
}): DelegationLedgerRepairAuthorization {
  return createDelegationLedgerRepairAuthorization({
    inspection: inspectDelegationLedgerRepair({
      stateDir: params.fixture.stateDir,
      assignmentId: params.assignmentId,
    }),
    operator: {
      id: "operator@example.com",
      reason: "Restore the one missing superseded format-rejection event binding.",
      ticket: "OPS-4242",
    },
    idempotencyKey: params.idempotencyKey ?? `repair-${params.assignmentId}`,
  });
}

async function reopenStrict(fixture: DelegationLedgerFixture) {
  vi.resetModules();
  const ledgerModule = await import("./ledger.js");
  return ledgerModule.openDelegationLedger({
    guard: fixture.guard,
    policyDigest: fixture.policyDigest,
    stateDir: fixture.stateDir,
    reconcileGatewayTask: () => "absent",
  });
}

describe("delegation ledger narrow repair", () => {
  it("appends an auditable event and receipt, preserves prior rows, and restores strict reopen", async () => {
    const { fixture, assignmentId } = createKnownContradiction();
    try {
      await expect(reopenStrict(fixture)).rejects.toThrow(
        /completed format correction lacks one exact superseded rejection event/u,
      );
      const before = inspectDelegationLedgerRepair({ stateDir: fixture.stateDir, assignmentId });
      const authorization = createDelegationLedgerRepairAuthorization({
        inspection: before,
        operator: {
          id: "operator@example.com",
          reason: "Approved from incident OPS-4242.",
          ticket: "OPS-4242",
        },
        idempotencyKey: `repair-${assignmentId}`,
      });
      const result = applyDelegationLedgerRepair({
        stateDir: fixture.stateDir,
        authorization,
        createdAt: 2_000,
      });
      expect(result.status).toBe("applied");

      const reopened = await reopenStrict(fixture);
      try {
        expect(reopened.isAssignmentCompleted(assignmentId)).toBe(true);
        const db = unsafeDatabaseForTest(reopened);
        expect(
          db
            .prepare(
              `SELECT repair_kind AS repairKind, operator_id AS operatorId,
                    operator_reason AS operatorReason, operator_ticket AS operatorTicket,
                    validator_id AS validatorId, validator_digest AS validatorDigest,
                    corruption_fingerprint AS corruptionFingerprint,
                    pre_repair_ledger_head AS preRepairLedgerHead
             FROM delegation_ledger_repair_events WHERE assignment_id = ?`,
            )
            .get(assignmentId),
        ).toMatchObject({
          repairKind: authorization.repairKind,
          operatorId: authorization.operator.id,
          operatorReason: authorization.operator.reason,
          operatorTicket: authorization.operator.ticket,
          validatorId: authorization.validator.id,
          validatorDigest: authorization.validator.sha256,
          corruptionFingerprint: authorization.corruptionFingerprint,
          preRepairLedgerHead: authorization.expectedLedgerHead,
        });
        expect(
          db
            .prepare(
              `SELECT outcome FROM delegation_ledger_repair_receipts WHERE assignment_id = ?`,
            )
            .get(assignmentId),
        ).toEqual({ outcome: "supersession-restored" });
        expect(() =>
          db
            .prepare(
              `UPDATE delegation_ledger_repair_events SET operator_reason = 'changed'
             WHERE assignment_id = ?`,
            )
            .run(assignmentId),
        ).toThrow(/append-only/u);
        expect(() =>
          db
            .prepare(`DELETE FROM delegation_ledger_repair_receipts WHERE assignment_id = ?`)
            .run(assignmentId),
        ).toThrow(/append-only/u);
      } finally {
        closeLedgerForTest(reopened);
      }
    } finally {
      fixture.close();
    }
  });

  it("makes an exact retry idempotent and rejects a conflicting duplicate or replay", () => {
    const { fixture, assignmentId } = createKnownContradiction();
    try {
      const authorization = authorize({ fixture, assignmentId });
      const first = applyDelegationLedgerRepair({ stateDir: fixture.stateDir, authorization });
      expect(applyDelegationLedgerRepair({ stateDir: fixture.stateDir, authorization })).toEqual({
        ...first,
        status: "already-applied",
      });

      const conflicting = { ...authorization, idempotencyKey: `${authorization.idempotencyKey}-2` };
      expect(() =>
        applyDelegationLedgerRepair({ stateDir: fixture.stateDir, authorization: conflicting }),
      ).toThrow(/conflicts with an existing/u);
    } finally {
      fixture.close();
    }
  });

  it("rejects a stale ledger head after an unrelated append", () => {
    const { fixture, assignmentId } = createKnownContradiction();
    try {
      const authorization = authorize({ fixture, assignmentId });
      const pathname = path.join(fixture.stateDir, "delegation", "ledger.sqlite");
      const { DatabaseSync } = requireNodeSqlite();
      const db = new DatabaseSync(pathname);
      try {
        db.prepare(
          `INSERT INTO audit_events (event_id, epoch, kind, payload_json, created_at)
           VALUES ('stale-head-proof', 1, 'maintenance-observation', '{}', 1500)`,
        ).run();
      } finally {
        db.close();
      }
      expect(() =>
        applyDelegationLedgerRepair({ stateDir: fixture.stateDir, authorization }),
      ).toThrow(/stale expected ledger head/u);
    } finally {
      fixture.close();
    }
  });

  it.each([
    [
      "wrong assignment",
      (value: DelegationLedgerRepairAuthorization) => ({
        ...value,
        assignmentId: "assignment_wrong",
      }),
    ],
    [
      "incorrect fingerprint",
      (value: DelegationLedgerRepairAuthorization) => ({
        ...value,
        corruptionFingerprint: "b".repeat(64),
      }),
    ],
    [
      "mismatched expected state",
      (value: DelegationLedgerRepairAuthorization) => ({
        ...value,
        expectedState: { ...value.expectedState, terminalReceiptId: "terminal_wrong" },
      }),
    ],
    [
      "mismatched missing event",
      (value: DelegationLedgerRepairAuthorization) => ({
        ...value,
        expectedMissingEvent: { ...value.expectedMissingEvent, validationId: "validation_wrong" },
      }),
    ],
    [
      "mismatched validator",
      (value: DelegationLedgerRepairAuthorization) => ({
        ...value,
        validator: { ...value.validator, sha256: "c".repeat(64) },
      }),
    ],
  ])("rejects %s authorization", (_label, mutate) => {
    const { fixture, assignmentId } = createKnownContradiction();
    try {
      const authorization = mutate(authorize({ fixture, assignmentId }));
      expect(() =>
        applyDelegationLedgerRepair({ stateDir: fixture.stateDir, authorization }),
      ).toThrow();
    } finally {
      fixture.close();
    }
  });

  it("rejects malformed authorization and other corruption shapes", () => {
    const malformed = { version: "openclaw-delegation-ledger-repair-authorization-v1" };
    const { fixture, assignmentId } = createKnownContradiction();
    try {
      expect(() =>
        applyDelegationLedgerRepair({ stateDir: fixture.stateDir, authorization: malformed }),
      ).toThrow();

      const pathname = path.join(fixture.stateDir, "delegation", "ledger.sqlite");
      const { DatabaseSync } = requireNodeSqlite();
      const db = new DatabaseSync(pathname);
      try {
        db.prepare(
          `INSERT INTO route_events (event_id, assignment_id, kind, payload_json, created_at)
           VALUES ('unrelated-rejection', ?, 'validation_rejected', '{}', 1500)`,
        ).run(assignmentId);
      } finally {
        db.close();
      }
      expect(() =>
        inspectDelegationLedgerRepair({ stateDir: fixture.stateDir, assignmentId }),
      ).toThrow(/different or additional ledger corruption/u);
    } finally {
      fixture.close();
    }
  });

  it("keeps additional corruption fail-closed after an exact repair", async () => {
    const { fixture, assignmentId } = createKnownContradiction();
    try {
      const authorization = authorize({ fixture, assignmentId });
      applyDelegationLedgerRepair({ stateDir: fixture.stateDir, authorization });
      const pathname = path.join(fixture.stateDir, "delegation", "ledger.sqlite");
      const { DatabaseSync } = requireNodeSqlite();
      const db = new DatabaseSync(pathname);
      try {
        db.prepare(
          `INSERT INTO route_events (event_id, assignment_id, kind, payload_json, created_at)
           VALUES ('post-repair-unrelated-rejection', ?, 'validation_rejected', '{}', 3000)`,
        ).run(assignmentId);
      } finally {
        db.close();
      }

      await expect(reopenStrict(fixture)).rejects.toThrow(/repair evidence|corruption/u);
    } finally {
      fixture.close();
    }
  });

  it("rolls back both records after an interrupted append", () => {
    const { fixture, assignmentId } = createKnownContradiction();
    try {
      const authorization = authorize({ fixture, assignmentId });
      expect(() =>
        applyDelegationLedgerRepair({
          stateDir: fixture.stateDir,
          authorization,
          faultInjection: {
            afterRepairEventAppend: () => {
              throw new Error("simulated interruption");
            },
          },
        }),
      ).toThrow(/simulated interruption/u);
      expect(
        inspectDelegationLedgerRepair({ stateDir: fixture.stateDir, assignmentId }).assignmentId,
      ).toBe(assignmentId);
      expect(
        applyDelegationLedgerRepair({ stateDir: fixture.stateDir, authorization }).status,
      ).toBe("applied");
    } finally {
      fixture.close();
    }
  });

  it("fails closed while another exclusive maintenance writer holds the ledger", () => {
    const { fixture, assignmentId } = createKnownContradiction();
    try {
      const authorization = authorize({ fixture, assignmentId });
      const pathname = path.join(fixture.stateDir, "delegation", "ledger.sqlite");
      const { DatabaseSync } = requireNodeSqlite();
      const blocker = new DatabaseSync(pathname);
      try {
        blocker.exec(
          "PRAGMA locking_mode = EXCLUSIVE; PRAGMA journal_mode = WAL; BEGIN EXCLUSIVE;",
        );
        expect(() =>
          applyDelegationLedgerRepair({
            stateDir: fixture.stateDir,
            authorization,
            busyTimeoutMs: 1,
          }),
        ).toThrow(/locked|busy/u);
        blocker.exec("ROLLBACK;");
      } finally {
        blocker.close();
      }
      expect(
        applyDelegationLedgerRepair({ stateDir: fixture.stateDir, authorization }).status,
      ).toBe("applied");
    } finally {
      fixture.close();
    }
  });
});
