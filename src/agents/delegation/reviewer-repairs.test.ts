import { describe, expect, it } from "vitest";
import {
  completeAssignment,
  completeDiscoveryAndImplementation,
  createFingerprint,
  createLedgerFixture,
  createRepositorySnapshot,
  createVerificationWave,
  finishAssignment,
  issueAssignment,
  makeCompleteReport,
  makeFinding,
  startAssignment,
  TEST_CONTROLLER,
  type DelegationLedgerFixture,
} from "./ledger.test-helpers.js";
import { appendDelegationObservationEvent } from "./runtime.js";

function createSecondSlice(fixture: DelegationLedgerFixture): DelegationLedgerFixture {
  const repositoryRoot = fixture.ledger.getSliceScope(fixture.sliceId)?.repositoryRoot;
  if (!repositoryRoot) {
    throw new Error("Missing fixture repository root");
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
      label: "second-slice-baseline",
    }),
    repositorySnapshot: createRepositorySnapshot({ repositoryRoot }),
  });
  return {
    ...fixture,
    sliceId: baseline.sliceId,
    baselineCandidateId: baseline.candidateId,
  };
}

function settleVerificationWave(fixture: DelegationLedgerFixture) {
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
      findings: [makeFinding({ localId: "T-1", summary: "Requires consolidated repair" })],
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
  return { ...wave, testerAssignmentId: tester.assignment.assignmentId };
}

describe("delegation reviewer repair regressions", () => {
  it("allows in-scope dirty-path changes and rejects an out-of-scope mutation", () => {
    const fixture = createLedgerFixture();
    try {
      const repositoryRoot = fixture.ledger.getSliceScope(fixture.sliceId)?.repositoryRoot;
      if (!repositoryRoot) {
        throw new Error("Missing fixture repository root");
      }
      expect(() =>
        fixture.ledger.assertNoOutOfScopeChanges({
          sliceId: fixture.sliceId,
          currentSnapshot: createRepositorySnapshot({
            repositoryRoot,
            entries: [{ path: "src/one.ts", state: "file", digest: "in-scope-digest" }],
          }),
        }),
      ).not.toThrow();

      expect(() =>
        fixture.ledger.assertNoOutOfScopeChanges({
          sliceId: fixture.sliceId,
          currentSnapshot: createRepositorySnapshot({
            repositoryRoot,
            entries: [{ path: "src/outside.ts", state: "file", digest: "outside-digest" }],
          }),
        }),
      ).toThrow(/outside the protected scope.*src\/outside\.ts/i);
    } finally {
      fixture.close();
    }
  });

  it("does not terminalize an assignment when a bounded observation wait times out", () => {
    const fixture = createLedgerFixture();
    try {
      const discovery = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
      const started = startAssignment({ fixture, ...discovery });
      appendDelegationObservationEvent({
        authorized: {
          runtime: {
            guard: fixture.guard,
            ledger: fixture.ledger,
            policyDigest: fixture.policyDigest,
          },
          assignment: discovery.assignment,
        },
        kind: "wait_timeout",
        childSessionKey: started.childSessionKey,
        runId: started.runId,
        reason: "controller stopped waiting before the worker run ended",
      });

      expect(
        finishAssignment({
          fixture,
          assignment: discovery.assignment,
          runId: started.runId,
        }).terminalReceiptId,
      ).toMatch(/^terminal-receipt_/);
    } finally {
      fixture.close();
    }
  });

  it("rejects reuse of a completed child from another protected slice", () => {
    const fixture = createLedgerFixture();
    try {
      const discovery = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
      completeAssignment({ fixture, ...discovery });
      const implementation = issueAssignment({
        fixture,
        purpose: "implementation",
        role: "implementer",
      });
      const reusableSessionKey = "agent:implementer:subagent:completed-first-slice";
      const implementationRun = startAssignment({
        fixture,
        ...implementation,
        childSessionKey: reusableSessionKey,
      });
      finishAssignment({
        fixture,
        assignment: implementation.assignment,
        runId: implementationRun.runId,
      });

      const secondFixture = createSecondSlice(fixture);
      completeDiscoveryAndImplementation(secondFixture);
      const wave = settleVerificationWave(secondFixture);
      const revisionId = secondFixture.ledger.appendRemediationRevision({
        sliceId: secondFixture.sliceId,
        sourceWaveId: wave.waveId,
        dispositions: [
          {
            assignmentId: wave.testerAssignmentId,
            localId: "T-1",
            disposition: "fix",
            finalProvenance: "change-induced",
            rationale: "The protected review evidence requires one consolidated repair.",
          },
        ],
      });

      expect(() =>
        issueAssignment({
          fixture: secondFixture,
          purpose: "remediation",
          role: "implementer",
          candidateId: wave.candidateId,
          waveId: wave.waveId,
          remediationRevisionId: revisionId,
          initialRouteKind: "send",
          targetSessionKey: reusableSessionKey,
        }),
      ).toThrow(/reuse only a completed child owned by the same controller and worker/i);
    } finally {
      fixture.close();
    }
  });
});
