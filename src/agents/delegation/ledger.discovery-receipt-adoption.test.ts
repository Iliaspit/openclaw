import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  closeLedgerForTest,
  completeAssignment,
  createFingerprint,
  createLedgerFixture,
  createRepositorySnapshot,
  createVerificationWave,
  issueAssignment,
  startAssignment,
  submitAcceptedReport,
  TEST_CONTROLLER,
  type DelegationLedgerFixture,
  unsafeDatabaseForTest,
} from "./ledger.test-helpers.js";
import { canonicalizeDelegationScope } from "./scope.js";

const OPERATOR = {
  id: "operator@example.com",
  reason: "Reuse the exact accepted discovery on a corrected same-epoch slice.",
  ticket: "OPS-ADOPT-1",
} as const;

let causalTimestamp = Date.now() + 60_000;
const nextCausalTimestamp = () => (causalTimestamp += 1);

function createTargetSlice(
  fixture: DelegationLedgerFixture,
  options: { label?: string; paths?: string[]; createdAt?: number } = {},
): DelegationLedgerFixture {
  const sourceSlice = fixture.ledger.getSliceScope(fixture.sliceId);
  if (!sourceSlice) {
    throw new Error("Missing source slice");
  }
  const scope = options.paths
    ? canonicalizeDelegationScope({
        version: "openclaw-scope-v1",
        kind: "slice",
        entries: options.paths.map((path) => ({ path, expectation: "existing" as const })),
      })
    : fixture.scope;
  const baseline = fixture.ledger.createSliceWithBaseline({
    controllerAgentId: TEST_CONTROLLER.agentId,
    controllerSessionKey: TEST_CONTROLLER.sessionKey,
    repositoryRoot: sourceSlice.repositoryRoot,
    scope,
    fingerprint: createFingerprint({
      guard: fixture.guard,
      policyDigest: fixture.policyDigest,
      scope,
      epoch: fixture.ledger.currentEpoch(),
      label: options.label ?? "baseline",
    }),
    repositorySnapshot: createRepositorySnapshot({ repositoryRoot: sourceSlice.repositoryRoot }),
    createdAt: options.createdAt ?? nextCausalTimestamp(),
  });
  return {
    ...fixture,
    scope,
    sliceId: baseline.sliceId,
    baselineCandidateId: baseline.candidateId,
  };
}

function reconcileTargetDiscovery(fixture: DelegationLedgerFixture) {
  const target = issueAssignment({
    fixture,
    purpose: "discovery",
    role: "helper",
    issuedAt: nextCausalTimestamp(),
  });
  fixture.ledger.rejectUnstartedAssignment({
    assignmentId: target.assignment.assignmentId,
    controllerAgentId: TEST_CONTROLLER.agentId,
    controllerSessionKey: TEST_CONTROLLER.sessionKey,
    reason: "Operator reconciled an intentionally unstarted corrected-slice discovery.",
    rejectedAt: nextCausalTimestamp(),
  });
  return target.assignment;
}

function createLaterSourceReviewer(
  fixture: DelegationLedgerFixture,
  options: { acceptedPayload?: unknown } = {},
) {
  const implementation = issueAssignment({
    fixture,
    purpose: "implementation",
    role: "implementer",
  });
  completeAssignment({ fixture, ...implementation });
  const wave = createVerificationWave(fixture);
  const blocking = issueAssignment({
    fixture,
    purpose: "verification",
    role: "reviewer",
    candidateId: wave.candidateId,
    waveId: wave.waveId,
  });
  const childSessionKey = `agent:reviewer:subagent:${blocking.assignment.assignmentId}`;
  const runId = `run-${blocking.assignment.assignmentId}`;
  const acceptedAt = nextCausalTimestamp();
  startAssignment({
    fixture,
    ...blocking,
    childSessionKey,
    runId,
    boundAt: acceptedAt - 1,
    acceptedAt,
    acceptedPayload: options.acceptedPayload ?? { childSessionKey, runId },
  });
  return { blocking, childSessionKey, runId };
}

function recordMissingAcceptedReport(params: {
  fixture: DelegationLedgerFixture;
  blocking: ReturnType<typeof issueAssignment>;
  runId: string;
  childSessionKey: string;
  createdAt?: number;
  omitTerminalResult?: boolean;
  submitAcceptedReceipt?: boolean;
  rejectionPayload?: unknown;
  extraAcceptedRoute?: boolean;
}) {
  const createdAt = params.createdAt ?? nextCausalTimestamp();
  if (params.submitAcceptedReceipt) {
    submitAcceptedReport({ fixture: params.fixture, assignment: params.blocking.assignment });
  }
  if (!params.omitTerminalResult) {
    const resultText = `reviewer result for ${params.blocking.assignment.assignmentId}`;
    params.fixture.ledger.recordTerminalResultReceipt({
      assignmentId: params.blocking.assignment.assignmentId,
      runId: params.runId,
      resultReceipt: {
        receiptId: `result-${params.blocking.assignment.assignmentId}`,
        sha256: createHash("sha256").update(resultText).digest("hex"),
        bytes: Buffer.byteLength(resultText),
        capturedAt: createdAt + 1,
        resultText,
      },
      createdAt,
    });
  }
  if (params.extraAcceptedRoute) {
    params.fixture.ledger.appendRouteEvent({
      assignmentId: params.blocking.assignment.assignmentId,
      kind: "accepted",
      payload: {
        childSessionKey: params.childSessionKey,
        runId: params.runId,
        duplicate: true,
      },
      createdAt,
    });
  }
  params.fixture.ledger.appendRouteEvent({
    assignmentId: params.blocking.assignment.assignmentId,
    kind: "validation_rejected",
    payload: params.rejectionPayload ?? { code: "missing-accepted-report", runId: params.runId },
    createdAt,
  });
}

function rejectLaterSourcePhase(
  fixture: DelegationLedgerFixture,
  options: Omit<
    Parameters<typeof recordMissingAcceptedReport>[0],
    "fixture" | "blocking" | "runId" | "childSessionKey"
  > = {},
): string {
  const phase = createLaterSourceReviewer(fixture);
  recordMissingAcceptedReport({ fixture, ...phase, ...options });
  return phase.blocking.assignment.assignmentId;
}

function adopt(params: {
  fixture: DelegationLedgerFixture;
  targetAssignmentId: string;
  sourceReceiptId: string;
  sourceBlockingAssignmentId: string;
  idempotencyKey?: string;
  createdAt?: number;
}) {
  return params.fixture.ledger.adoptCompletedDiscoveryReceipt({
    targetAssignmentId: params.targetAssignmentId,
    sourceReceiptId: params.sourceReceiptId,
    sourceBlockingAssignmentId: params.sourceBlockingAssignmentId,
    controllerAgentId: TEST_CONTROLLER.agentId,
    controllerSessionKey: TEST_CONTROLLER.sessionKey,
    operator: OPERATOR,
    idempotencyKey: params.idempotencyKey ?? "adopt-discovery-1",
    createdAt: params.createdAt ?? nextCausalTimestamp(),
  });
}

describe("protected discovery receipt adoption", () => {
  it("adopts one exact completed discovery and deterministically unlocks implementation", () => {
    const fixture = createLedgerFixture();
    try {
      const source = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
      const completed = completeAssignment({ fixture, ...source });
      const sourceBlockingAssignmentId = rejectLaterSourcePhase(fixture);
      const targetFixture = createTargetSlice(fixture);
      const target = reconcileTargetDiscovery(targetFixture);

      const first = adopt({
        fixture,
        targetAssignmentId: target.assignmentId,
        sourceReceiptId: completed.receiptId,
        sourceBlockingAssignmentId,
      });
      const repeated = adopt({
        fixture,
        targetAssignmentId: target.assignmentId,
        sourceReceiptId: completed.receiptId,
        sourceBlockingAssignmentId,
      });

      expect(first.adoptionId).toMatch(/^discovery-receipt-adoption_/);
      expect(first.alreadyAdopted).toBe(false);
      expect(first.discoveryPrerequisiteSatisfied).toBe(true);
      expect(repeated).toMatchObject({
        adoptionId: first.adoptionId,
        authorizationDigest: first.authorizationDigest,
        alreadyAdopted: true,
      });
      expect(
        issueAssignment({
          fixture: targetFixture,
          purpose: "implementation",
          role: "implementer",
        }).assignment.sliceId,
      ).toBe(targetFixture.sliceId);
    } finally {
      fixture.close();
    }
  });

  it("survives a strict close and reopen with the same immutable identities", async () => {
    const fixture = createLedgerFixture();
    try {
      const source = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
      const completed = completeAssignment({ fixture, ...source });
      const sourceBlockingAssignmentId = rejectLaterSourcePhase(fixture);
      const targetFixture = createTargetSlice(fixture);
      const target = reconcileTargetDiscovery(targetFixture);
      const adoption = adopt({
        fixture,
        targetAssignmentId: target.assignmentId,
        sourceReceiptId: completed.receiptId,
        sourceBlockingAssignmentId,
      });

      closeLedgerForTest(fixture.ledger);
      vi.resetModules();
      const restartedModule = await import("./ledger.js");
      const reopened = restartedModule.openDelegationLedger({
        guard: fixture.guard,
        policyDigest: fixture.policyDigest,
        stateDir: fixture.stateDir,
        reconcileGatewayTask: () => "absent",
      });
      try {
        expect(reopened.discoveryReceiptAdoptionForSlice(targetFixture.sliceId)).toMatchObject({
          adoptionId: adoption.adoptionId,
          authorizationDigest: adoption.authorizationDigest,
          discoveryPrerequisiteSatisfied: true,
        });
      } finally {
        closeLedgerForTest(reopened);
      }
    } finally {
      fixture.close();
    }
  });

  it.each([
    ["missing terminal result", { omitTerminalResult: true }],
    ["accepted reviewer receipt", { submitAcceptedReceipt: true }],
    ["missing rejection run", { rejectionPayload: { code: "missing-accepted-report" } }],
    [
      "wrong rejection run",
      { rejectionPayload: { code: "missing-accepted-report", runId: "wrong-run" } },
    ],
    [
      "extra rejection payload",
      {
        rejectionPayload: {
          code: "missing-accepted-report",
          runId: "wrong-run",
          synthetic: true,
        },
      },
    ],
    ["extra accepted route", { extraAcceptedRoute: true }],
  ] as const)("rejects synthetic blocker evidence: %s", (_name, blockerOptions) => {
    const fixture = createLedgerFixture();
    try {
      const source = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
      const completed = completeAssignment({ fixture, ...source });
      const sourceBlockingAssignmentId = rejectLaterSourcePhase(fixture, blockerOptions);
      const targetFixture = createTargetSlice(fixture);
      const target = reconcileTargetDiscovery(targetFixture);

      expect(() =>
        adopt({
          fixture,
          targetAssignmentId: target.assignmentId,
          sourceReceiptId: completed.receiptId,
          sourceBlockingAssignmentId,
        }),
      ).toThrow(/exact receipt-free reviewer terminal-result run/i);
    } finally {
      fixture.close();
    }
  });

  it("rejects a reviewer accepted-route run that differs from its protected binding", () => {
    const fixture = createLedgerFixture();
    try {
      const source = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
      const completed = completeAssignment({ fixture, ...source });
      const phase = createLaterSourceReviewer(fixture, {
        acceptedPayload: { childSessionKey: "wrong-child", runId: "wrong-run" },
      });
      recordMissingAcceptedReport({ fixture, ...phase });
      const targetFixture = createTargetSlice(fixture);
      const target = reconcileTargetDiscovery(targetFixture);

      expect(() =>
        adopt({
          fixture,
          targetAssignmentId: target.assignmentId,
          sourceReceiptId: completed.receiptId,
          sourceBlockingAssignmentId: phase.blocking.assignment.assignmentId,
        }),
      ).toThrow(/exact receipt-free reviewer terminal-result run/i);
    } finally {
      fixture.close();
    }
  });

  it("rejects an authorization timestamp before target reconciliation", () => {
    const fixture = createLedgerFixture();
    try {
      const source = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
      const completed = completeAssignment({ fixture, ...source });
      const sourceBlockingAssignmentId = rejectLaterSourcePhase(fixture);
      const targetFixture = createTargetSlice(fixture);
      const target = reconcileTargetDiscovery(targetFixture);

      expect(() =>
        adopt({
          fixture,
          targetAssignmentId: target.assignmentId,
          sourceReceiptId: completed.receiptId,
          sourceBlockingAssignmentId,
          createdAt: 2_000,
        }),
      ).toThrow(/authorization must follow every protected prerequisite/i);
    } finally {
      fixture.close();
    }
  });

  it("rejects a receipt whose source slice does not own the blocking phase", () => {
    const fixture = createLedgerFixture();
    try {
      const source = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
      completeAssignment({ fixture, ...source });
      const sourceBlockingAssignmentId = rejectLaterSourcePhase(fixture);
      const unrelatedFixture = createTargetSlice(fixture);
      const unrelated = issueAssignment({
        fixture: unrelatedFixture,
        purpose: "discovery",
        role: "helper",
      });
      const unrelatedCompleted = completeAssignment({ fixture, ...unrelated });
      const targetFixture = createTargetSlice(fixture);
      const target = reconcileTargetDiscovery(targetFixture);

      expect(() =>
        adopt({
          fixture,
          targetAssignmentId: target.assignmentId,
          sourceReceiptId: unrelatedCompleted.receiptId,
          sourceBlockingAssignmentId,
        }),
      ).toThrow(/rejected reviewer verification from the source slice/i);
    } finally {
      fixture.close();
    }
  });

  it("rejects stale evidence after an epoch transition", () => {
    const fixture = createLedgerFixture();
    try {
      const source = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
      const completed = completeAssignment({ fixture, ...source });
      const rejectionCreatedAt = nextCausalTimestamp();
      const sourceBlockingAssignmentId = rejectLaterSourcePhase(fixture, {
        createdAt: rejectionCreatedAt,
      });
      const targetFixture = createTargetSlice(fixture, { createdAt: rejectionCreatedAt - 1 });
      const target = reconcileTargetDiscovery(targetFixture);
      fixture.ledger.rollback({ actorAgentId: TEST_CONTROLLER.agentId, reason: "test rollback" });

      expect(() =>
        adopt({
          fixture,
          targetAssignmentId: target.assignmentId,
          sourceReceiptId: completed.receiptId,
          sourceBlockingAssignmentId,
        }),
      ).toThrow(/stale or cross-epoch evidence/i);
    } finally {
      fixture.close();
    }
  });

  it("rejects an idempotent retry after its adoption epoch becomes inactive", () => {
    const fixture = createLedgerFixture();
    try {
      const source = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
      const completed = completeAssignment({ fixture, ...source });
      const sourceBlockingAssignmentId = rejectLaterSourcePhase(fixture);
      const targetFixture = createTargetSlice(fixture);
      const target = reconcileTargetDiscovery(targetFixture);
      adopt({
        fixture,
        targetAssignmentId: target.assignmentId,
        sourceReceiptId: completed.receiptId,
        sourceBlockingAssignmentId,
      });
      fixture.ledger.rollback({ actorAgentId: TEST_CONTROLLER.agentId, reason: "test rollback" });

      expect(() =>
        adopt({
          fixture,
          targetAssignmentId: target.assignmentId,
          sourceReceiptId: completed.receiptId,
          sourceBlockingAssignmentId,
        }),
      ).toThrow(/historical inactive epoch/i);
    } finally {
      fixture.close();
    }
  });

  it("rejects a clean source slice and a target created before the later rejection", () => {
    const fixture = createLedgerFixture();
    try {
      const source = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
      const completed = completeAssignment({ fixture, ...source });
      const cleanPhase = createLaterSourceReviewer(fixture);
      const cleanTargetFixture = createTargetSlice(fixture);
      const cleanTarget = reconcileTargetDiscovery(cleanTargetFixture);
      expect(() =>
        adopt({
          fixture,
          targetAssignmentId: cleanTarget.assignmentId,
          sourceReceiptId: completed.receiptId,
          sourceBlockingAssignmentId: cleanPhase.blocking.assignment.assignmentId,
        }),
      ).toThrow(/missing-accepted-report rejection/i);

      const rejectionCreatedAt = nextCausalTimestamp();
      recordMissingAcceptedReport({
        fixture,
        ...cleanPhase,
        createdAt: rejectionCreatedAt,
      });
      expect(() =>
        adopt({
          fixture,
          targetAssignmentId: cleanTarget.assignmentId,
          sourceReceiptId: completed.receiptId,
          sourceBlockingAssignmentId: cleanPhase.blocking.assignment.assignmentId,
        }),
      ).toThrow(/then the corrected target slice/i);
    } finally {
      fixture.close();
    }
  });

  it("requires exact canonical scope and byte-identical baseline fingerprints", () => {
    const fixture = createLedgerFixture();
    try {
      const source = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
      const completed = completeAssignment({ fixture, ...source });
      const sourceBlockingAssignmentId = rejectLaterSourcePhase(fixture);
      const mismatchedFingerprint = createTargetSlice(fixture, { label: "drifted-baseline" });
      const fingerprintTarget = reconcileTargetDiscovery(mismatchedFingerprint);
      expect(() =>
        adopt({
          fixture,
          targetAssignmentId: fingerprintTarget.assignmentId,
          sourceReceiptId: completed.receiptId,
          sourceBlockingAssignmentId,
        }),
      ).toThrow(/byte-identical protected baseline fingerprints/i);

      const mismatchedScope = createTargetSlice(fixture, { paths: ["src/one.ts"] });
      const scopeTarget = reconcileTargetDiscovery(mismatchedScope);
      expect(() =>
        adopt({
          fixture,
          targetAssignmentId: scopeTarget.assignmentId,
          sourceReceiptId: completed.receiptId,
          sourceBlockingAssignmentId,
          idempotencyKey: "adopt-discovery-scope-mismatch",
        }),
      ).toThrow(/matching helper discovery assignments|exact canonical scope match/i);
    } finally {
      fixture.close();
    }
  });

  it("fails closed on strict reopen when immutable adoption authorization is corrupted", async () => {
    const fixture = createLedgerFixture();
    try {
      const source = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
      const completed = completeAssignment({ fixture, ...source });
      const sourceBlockingAssignmentId = rejectLaterSourcePhase(fixture);
      const targetFixture = createTargetSlice(fixture);
      const target = reconcileTargetDiscovery(targetFixture);
      adopt({
        fixture,
        targetAssignmentId: target.assignmentId,
        sourceReceiptId: completed.receiptId,
        sourceBlockingAssignmentId,
      });
      const db = unsafeDatabaseForTest(fixture.ledger);
      db.exec("DROP TRIGGER discovery_receipt_adoptions_reject_update");
      db.prepare(
        `UPDATE discovery_receipt_adoptions SET authorization_digest = 'corrupt-digest'`,
      ).run();

      expect(() => fixture.ledger.assertDiscoveryReceiptAdoptionsValid()).toThrow(
        /failed integrity validation/i,
      );
      closeLedgerForTest(fixture.ledger);
      vi.resetModules();
      const restartedModule = await import("./ledger.js");
      expect(() =>
        restartedModule.openDelegationLedger({
          guard: fixture.guard,
          policyDigest: fixture.policyDigest,
          stateDir: fixture.stateDir,
          reconcileGatewayTask: () => "absent",
        }),
      ).toThrow(/failed integrity validation/i);
    } finally {
      fixture.close();
    }
  });

  it("rejects adoption unless the target was reconciled as provably unstarted", () => {
    const fixture = createLedgerFixture();
    try {
      const source = issueAssignment({ fixture, purpose: "discovery", role: "helper" });
      const completed = completeAssignment({ fixture, ...source });
      const sourceBlockingAssignmentId = rejectLaterSourcePhase(fixture);
      const targetFixture = createTargetSlice(fixture);
      const target = issueAssignment({
        fixture: targetFixture,
        purpose: "discovery",
        role: "helper",
        issuedAt: nextCausalTimestamp(),
      });

      expect(() =>
        adopt({
          fixture,
          targetAssignmentId: target.assignment.assignmentId,
          sourceReceiptId: completed.receiptId,
          sourceBlockingAssignmentId,
        }),
      ).toThrow(/operator-reconciled assignment with no execution evidence/i);
    } finally {
      fixture.close();
    }
  });
});
