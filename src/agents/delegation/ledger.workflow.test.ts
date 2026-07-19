import { describe, expect, it } from "vitest";
import {
  completeAssignment,
  completeDiscoveryAndImplementation,
  createFingerprint,
  createLedgerFixture,
  createVerificationWave,
  finishAssignment,
  issueAssignment,
  makeCompleteReport,
  makeFinding,
  recordTerminalReceipt,
  startAssignment,
  submitAcceptedReport,
} from "./ledger.test-helpers.js";

describe("accountable delegation wave workflow", () => {
  it("does not treat a required-role timeout as approval for remediation", () => {
    const fixture = createLedgerFixture();
    try {
      completeDiscoveryAndImplementation(fixture);
      const wave = createVerificationWave(fixture);
      const tester = issueAssignment({
        fixture,
        purpose: "verification",
        role: "tester",
        candidateId: wave.candidateId,
        waveId: wave.waveId,
      });
      const reviewer = issueAssignment({
        fixture,
        purpose: "verification",
        role: "reviewer",
        candidateId: wave.candidateId,
        waveId: wave.waveId,
      });
      startAssignment({ fixture, ...tester });
      const reviewerRun = startAssignment({ fixture, ...reviewer });
      finishAssignment({ fixture, assignment: reviewer.assignment, runId: reviewerRun.runId });
      fixture.ledger.appendRouteEvent({
        assignmentId: tester.assignment.assignmentId,
        kind: "timeout",
        payload: { deadlineKind: "run" },
      });

      expect(() =>
        fixture.ledger.appendRemediationRevision({
          sliceId: fixture.sliceId,
          sourceWaveId: wave.waveId,
          dispositions: [],
        }),
      ).toThrow(/timed-out tester.*cannot authorize remediation/i);
    } finally {
      fixture.close();
    }
  });

  it("settles a rejected route through its single recovery child receipt", () => {
    const fixture = createLedgerFixture();
    try {
      completeDiscoveryAndImplementation(fixture);
      const wave = createVerificationWave(fixture);
      const rejectedTester = issueAssignment({
        fixture,
        purpose: "verification",
        role: "tester",
        candidateId: wave.candidateId,
        waveId: wave.waveId,
      });
      fixture.ledger.appendRouteEvent({
        assignmentId: rejectedTester.assignment.assignmentId,
        kind: "route_rejected",
      });
      const recoveryTester = issueAssignment({
        fixture,
        purpose: "verification",
        role: "tester",
        candidateId: wave.candidateId,
        waveId: wave.waveId,
        recoveryOfAssignmentId: rejectedTester.assignment.assignmentId,
      });
      const reviewer = issueAssignment({
        fixture,
        purpose: "verification",
        role: "reviewer",
        candidateId: wave.candidateId,
        waveId: wave.waveId,
      });
      const testerRun = startAssignment({ fixture, ...recoveryTester });
      const reviewerRun = startAssignment({ fixture, ...reviewer });
      finishAssignment({
        fixture,
        assignment: recoveryTester.assignment,
        runId: testerRun.runId,
        report: makeCompleteReport({
          assigned: recoveryTester.assignment.scopeUnits,
          findings: [makeFinding({ localId: "T-recovery", summary: "Recovered tester finding" })],
        }),
      });
      finishAssignment({ fixture, assignment: reviewer.assignment, runId: reviewerRun.runId });
      const qa = issueAssignment({
        fixture,
        purpose: "qa",
        role: "qa",
        candidateId: wave.candidateId,
        waveId: wave.waveId,
      });
      completeAssignment({ fixture, ...qa });

      expect(
        fixture.ledger.appendRemediationRevision({
          sliceId: fixture.sliceId,
          sourceWaveId: wave.waveId,
          dispositions: [
            {
              assignmentId: recoveryTester.assignment.assignmentId,
              localId: "T-recovery",
              disposition: "fix",
              finalProvenance: "change-induced",
              rationale: "Recovered route produced the validated finding.",
            },
          ],
        }),
      ).toMatch(/^remediation_/);
    } finally {
      fixture.close();
    }
  });

  it("starts tester and reviewer together, sequences QA, and aggregates every finding once", () => {
    const fixture = createLedgerFixture();
    try {
      completeDiscoveryAndImplementation(fixture);
      const wave = createVerificationWave(fixture);
      const tester = issueAssignment({
        fixture,
        purpose: "verification",
        role: "tester",
        candidateId: wave.candidateId,
        waveId: wave.waveId,
      });
      const reviewer = issueAssignment({
        fixture,
        purpose: "verification",
        role: "reviewer",
        candidateId: wave.candidateId,
        waveId: wave.waveId,
      });
      const testerRun = startAssignment({ fixture, ...tester });
      submitAcceptedReport({
        fixture,
        assignment: tester.assignment,
        report: makeCompleteReport({
          assigned: tester.assignment.scopeUnits,
          findings: [makeFinding({ localId: "T-1", summary: "Tester blocker" })],
        }),
      });
      expect(() =>
        recordTerminalReceipt({
          fixture,
          assignment: tester.assignment,
          runId: testerRun.runId,
        }),
      ).toThrow(/tester and reviewer routes must both start/i);

      const reviewerRun = startAssignment({ fixture, ...reviewer });
      recordTerminalReceipt({
        fixture,
        assignment: tester.assignment,
        runId: testerRun.runId,
      });
      expect(() =>
        issueAssignment({
          fixture,
          purpose: "qa",
          role: "qa",
          candidateId: wave.candidateId,
          waveId: wave.waveId,
        }),
      ).toThrow(/reviewer report/i);
      finishAssignment({
        fixture,
        assignment: reviewer.assignment,
        runId: reviewerRun.runId,
        report: makeCompleteReport({
          assigned: reviewer.assignment.scopeUnits,
          findings: [makeFinding({ localId: "R-1", summary: "Reviewer blocker" })],
        }),
      });

      expect(() =>
        fixture.ledger.appendRemediationRevision({
          sliceId: fixture.sliceId,
          sourceWaveId: wave.waveId,
          dispositions: [],
        }),
      ).toThrow(/terminal QA receipt|conditional QA lane/i);
      const qa = issueAssignment({
        fixture,
        purpose: "qa",
        role: "qa",
        candidateId: wave.candidateId,
        waveId: wave.waveId,
      });
      completeAssignment({ fixture, ...qa });

      const testerDisposition = {
        assignmentId: tester.assignment.assignmentId,
        localId: "T-1",
        disposition: "fix" as const,
        finalProvenance: "change-induced" as const,
        rationale: "Validated against the baseline and candidate.",
      };
      const reviewerDisposition = {
        assignmentId: reviewer.assignment.assignmentId,
        localId: "R-1",
        disposition: "fix" as const,
        finalProvenance: "baseline-pre-existing" as const,
        rationale: "Validated against the baseline and candidate.",
      };
      expect(() =>
        fixture.ledger.appendRemediationRevision({
          sliceId: fixture.sliceId,
          sourceWaveId: wave.waveId,
          dispositions: [testerDisposition],
        }),
      ).toThrow(/every validated finding exactly once/i);
      const revisionId = fixture.ledger.appendRemediationRevision({
        sliceId: fixture.sliceId,
        sourceWaveId: wave.waveId,
        dispositions: [testerDisposition, reviewerDisposition],
      });

      const remediation = issueAssignment({
        fixture,
        purpose: "remediation",
        role: "implementer",
        candidateId: wave.candidateId,
        waveId: wave.waveId,
        remediationRevisionId: revisionId,
      });
      expect(() =>
        issueAssignment({
          fixture,
          purpose: "remediation",
          role: "implementer",
          candidateId: wave.candidateId,
          waveId: wave.waveId,
          remediationRevisionId: revisionId,
        }),
      ).toThrow(/already exists/i);
      completeAssignment({ fixture, ...remediation });
    } finally {
      fixture.close();
    }
  });

  it("allows one bounded change-induced blocker follow-up and rejects a third remediation", () => {
    const fixture = createLedgerFixture();
    try {
      completeDiscoveryAndImplementation(fixture);
      const wave = createVerificationWave(fixture);
      const tester = issueAssignment({
        fixture,
        purpose: "verification",
        role: "tester",
        candidateId: wave.candidateId,
        waveId: wave.waveId,
      });
      const reviewer = issueAssignment({
        fixture,
        purpose: "verification",
        role: "reviewer",
        candidateId: wave.candidateId,
        waveId: wave.waveId,
      });
      const testerRun = startAssignment({ fixture, ...tester });
      const reviewerRun = startAssignment({ fixture, ...reviewer });
      finishAssignment({
        fixture,
        assignment: tester.assignment,
        runId: testerRun.runId,
        report: makeCompleteReport({
          assigned: tester.assignment.scopeUnits,
          findings: [makeFinding({ localId: "T-1", summary: "Initial blocker" })],
        }),
      });
      finishAssignment({
        fixture,
        assignment: reviewer.assignment,
        runId: reviewerRun.runId,
      });
      const qa = issueAssignment({
        fixture,
        purpose: "qa",
        role: "qa",
        candidateId: wave.candidateId,
        waveId: wave.waveId,
      });
      completeAssignment({ fixture, ...qa });
      const firstRevision = fixture.ledger.appendRemediationRevision({
        sliceId: fixture.sliceId,
        sourceWaveId: wave.waveId,
        dispositions: [
          {
            assignmentId: tester.assignment.assignmentId,
            localId: "T-1",
            disposition: "fix",
            finalProvenance: "change-induced",
            rationale: "Fix in the consolidated remediation.",
          },
        ],
      });
      const remediation = issueAssignment({
        fixture,
        purpose: "remediation",
        role: "implementer",
        candidateId: wave.candidateId,
        waveId: wave.waveId,
        remediationRevisionId: firstRevision,
      });
      completeAssignment({ fixture, ...remediation });

      const confirmation = fixture.ledger.recordCandidateAndFreezeWave({
        sliceId: fixture.sliceId,
        fingerprint: createFingerprint({
          guard: fixture.guard,
          policyDigest: fixture.policyDigest,
          scope: fixture.scope,
          epoch: fixture.ledger.currentEpoch(),
          label: "post-remediation",
        }),
        requiredRoles: ["tester"],
      });
      const confirmationTester = issueAssignment({
        fixture,
        purpose: "confirmation",
        role: "tester",
        candidateId: confirmation.candidateId,
        waveId: confirmation.waveId,
      });
      completeAssignment({
        fixture,
        ...confirmationTester,
        report: makeCompleteReport({
          assigned: confirmationTester.assignment.scopeUnits,
          findings: [
            makeFinding({
              localId: "T-2",
              summary: "New blocker introduced by remediation",
              proposedProvenance: "change-induced",
            }),
          ],
        }),
      });
      const secondDispositions = [
        {
          assignmentId: confirmationTester.assignment.assignmentId,
          localId: "T-2",
          disposition: "fix" as const,
          finalProvenance: "change-induced" as const,
          rationale: "The candidate proves remediation introduced this blocker.",
        },
      ];
      expect(
        fixture.ledger.appendRemediationRevision({
          sliceId: fixture.sliceId,
          sourceWaveId: confirmation.waveId,
          dispositions: secondDispositions,
        }),
      ).toMatch(/^remediation_/);
      expect(() =>
        fixture.ledger.appendRemediationRevision({
          sliceId: fixture.sliceId,
          sourceWaveId: confirmation.waveId,
          dispositions: secondDispositions,
        }),
      ).toThrow(/only one remediation and one bounded follow-up/i);
    } finally {
      fixture.close();
    }
  });
});
