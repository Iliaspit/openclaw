import { describe, expect, it } from "vitest";
import {
  completeDiscoveryAndImplementation,
  createLedgerFixture,
  createVerificationWave,
  issueAssignment,
  makeCompleteReport,
  startAssignment,
} from "./ledger.test-helpers.js";

function createStartedVerifier() {
  const fixture = createLedgerFixture(["src/one.ts"]);
  completeDiscoveryAndImplementation(fixture);
  const wave = createVerificationWave(fixture);
  const issued = issueAssignment({
    fixture,
    purpose: "verification",
    role: "tester",
    candidateId: wave.candidateId,
    waveId: wave.waveId,
  });
  startAssignment({ fixture, ...issued });
  return { fixture, assignment: issued.assignment };
}

describe("protected delegation report slot", () => {
  it.each(["accepted", "rejected"] as const)(
    "returns only the byte-identical %s receipt as an idempotent retry",
    (outcome) => {
      const { fixture, assignment } = createStartedVerifier();
      try {
        const report = makeCompleteReport({ assigned: assignment.scopeUnits });
        expect(
          fixture.ledger.inspectInitialReportSlot({
            assignmentId: assignment.assignmentId,
            report,
          }),
        ).toMatchObject({ state: "open" });
        const persisted = fixture.ledger.appendValidatedReceipt({
          assignmentId: assignment.assignmentId,
          report,
          outcome,
          issues: outcome === "rejected" ? [{ code: "format", message: "invalid" }] : [],
        });
        const retried = fixture.ledger.inspectInitialReportSlot({
          assignmentId: assignment.assignmentId,
          report,
        });
        expect(retried).toMatchObject({
          state: "idempotent",
          receiptId: persisted.receiptId,
          semanticDigest: persisted.semanticDigest,
          validation: { validationId: persisted.validationId, outcome },
        });

        const conflicting = structuredClone(report);
        conflicting.commands[0].evidenceId = "same-semantics-different-identity";
        conflicting.scope.inspected[0].evidenceIds = ["same-semantics-different-identity"];
        expect(() =>
          fixture.ledger.inspectInitialReportSlot({
            assignmentId: assignment.assignmentId,
            report: conflicting,
          }),
        ).toThrow("byte-identical immutable initial report");
      } finally {
        fixture.close();
      }
    },
  );

  it("rejects an unpersisted report after the assignment route closes", () => {
    const { fixture, assignment } = createStartedVerifier();
    try {
      fixture.ledger.appendRouteEvent({
        assignmentId: assignment.assignmentId,
        kind: "timeout",
        payload: { reason: "worker did not submit" },
      });
      const report = makeCompleteReport({ assigned: assignment.scopeUnits });
      expect(() =>
        fixture.ledger.inspectInitialReportSlot({
          assignmentId: assignment.assignmentId,
          report,
        }),
      ).toThrow("route or review wave was closed");
      expect(() =>
        fixture.ledger.appendReceipt({ assignmentId: assignment.assignmentId, report }),
      ).toThrow("route or review wave was closed");
    } finally {
      fixture.close();
    }
  });

  it("preserves a byte-identical receipt that has not yet received validation", () => {
    const { fixture, assignment } = createStartedVerifier();
    try {
      const report = makeCompleteReport({ assigned: assignment.scopeUnits });
      const receiptId = fixture.ledger.appendReceipt({
        assignmentId: assignment.assignmentId,
        report,
      });
      expect(
        fixture.ledger.inspectInitialReportSlot({
          assignmentId: assignment.assignmentId,
          report,
        }),
      ).toMatchObject({
        state: "idempotent",
        receiptId,
        validation: undefined,
      });
    } finally {
      fixture.close();
    }
  });
});
