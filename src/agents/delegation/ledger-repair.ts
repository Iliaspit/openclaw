import { chmodSync, existsSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import {
  canonicalDelegationJson,
  createDelegationRecordId,
  hashDelegationIdentity,
} from "./identity.js";
import {
  canonicalDelegationLedgerRepairAuthorization,
  delegationLedgerRepairExpectedEvidence,
  DELEGATION_LEDGER_REPAIR_INSPECTION_VERSION,
  DELEGATION_LEDGER_REPAIR_KIND,
  DELEGATION_LEDGER_REPAIR_OBSERVED_COMPLETION_CASE,
  DELEGATION_LEDGER_REPAIR_OBSERVED_COMPLETION_INSPECTION_VERSION,
  DELEGATION_LEDGER_REPAIR_OUTCOME,
  hashDelegationLedgerCorruption,
  hashDelegationLedgerObservedCompletionCorruption,
  hashDelegationLedgerRepairAuthorization,
  parseDelegationLedgerRepairAuthorization,
  type DelegationLedgerRepairAuthorization,
  type DelegationLedgerRepairExpectedState,
  type DelegationLedgerRepairInspection,
  type DelegationLedgerRepairMissingEvent,
  type DelegationLedgerRepairObservedCompletionCounts,
  type DelegationLedgerRepairObservedCompletionEvents,
  type DelegationLedgerRepairObservedCompletionExpectedState,
  type DelegationLedgerRepairValidator,
} from "./ledger-repair-contract.js";
import { ensureDelegationLedgerSchema } from "./ledger.js";

const LEDGER_FILE_MODE = 0o600;
const LEDGER_SIDECARS = ["", "-shm", "-wal"] as const;

type SupportedContradictionRow = {
  assignmentEpoch: number | bigint;
  correctionId: string;
  correctionSemanticDigest: string;
  originalReceiptId: string;
  originalSemanticDigest: string;
  originalValidationId: string;
  originalValidationOutcome: string;
  originalValidationIssuesJson: string;
  originalValidatorId: string;
  originalValidatorVersion: string;
  originalValidatorDigest: string;
  originalAppendSequence: number | bigint;
  correctedReceiptId: string;
  correctedCorrectionOf: string | null;
  correctedSemanticDigest: string;
  correctedValidationId: string;
  correctedValidationOutcome: string;
  correctedValidatorId: string;
  correctedValidatorVersion: string;
  correctedValidatorDigest: string;
  correctedAppendSequence: number | bigint;
  epochValidatorId: string;
  epochValidatorVersion: string;
  epochValidatorDigest: string;
  terminalResultId: string;
  terminalResultRunId: string;
  terminalResultReceiptId: string;
  terminalResultReceiptSha256: string;
  terminalResultReceiptBytes: number | bigint;
  terminalResultReceiptCapturedAt: number | bigint;
  terminalResultCreatedAt: number | bigint;
  terminalRunBindingCount: number | bigint;
  terminalChildSessionKey: string | null;
  terminalReceiptId: string;
  terminalReceiptRunId: string;
  terminalAcceptedReceiptId: string;
  terminalAcceptedSemanticDigest: string;
  acceptedResultReceiptId: string;
  acceptedResultReceiptSha256: string;
  acceptedResultReceiptBytes: number | bigint;
  acceptedResultReceiptCapturedAt: number | bigint;
  completedEventId: string;
  completedPayloadJson: string;
  receiptCount: number | bigint;
  validationCount: number | bigint;
  correctionCount: number | bigint;
  terminalResultCount: number | bigint;
  terminalReceiptCount: number | bigint;
  routeEventCount: number | bigint;
  acceptedEventCount: number | bigint;
  completedEventCount: number | bigint;
  rejectionEventCount: number | bigint;
  otherTerminalEventCount: number | bigint;
  existingRepairCount: number | bigint;
};

type SupportedRouteEventRow = {
  eventId: string;
  kind: string;
  payloadJson: string;
  createdAt: number | bigint;
  appendSequence: number | bigint;
};

export type DelegationLedgerRepairResult = {
  status: "applied" | "already-applied";
  repairEventId: string;
  repairReceiptId: string;
  authorizationDigest: string;
};

function toNumber(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
}

function normalizeSqliteValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeSqliteValue(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        normalizeSqliteValue(entry),
      ]),
    );
  }
  return value;
}

function quoteSqliteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function computeDelegationLedgerHead(db: DatabaseSync): string {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all() as Array<{ name: string }>;
  const snapshot = tables.map(({ name }) => ({
    table: name,
    rows: normalizeSqliteValue(
      db.prepare(`SELECT * FROM ${quoteSqliteIdentifier(name)} ORDER BY rowid`).all(),
    ),
  }));
  return hashDelegationIdentity("delegation-ledger-head-v1", snapshot);
}

function openMaintenanceDatabase(params: { stateDir: string; busyTimeoutMs?: number }): {
  db: DatabaseSync;
  pathname: string;
} {
  const pathname = path.join(params.stateDir, "delegation", "ledger.sqlite");
  if (!existsSync(pathname)) {
    throw new Error(`Delegation ledger does not exist: ${pathname}`);
  }
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(pathname);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, params.busyTimeoutMs ?? 5_000)};`);
    db.exec("PRAGMA locking_mode = EXCLUSIVE;");
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = FULL;");
    // Acquire the exclusive maintenance lock before schema inspection. In
    // exclusive locking mode this connection retains it until close, including
    // across the transaction that atomically appends the repair pair.
    db.exec("BEGIN EXCLUSIVE; COMMIT;");
    ensureDelegationLedgerSchema(db);
    return { db, pathname };
  } catch (error) {
    db.close();
    throw error;
  }
}

function secureLedgerFiles(pathname: string): void {
  for (const suffix of LEDGER_SIDECARS) {
    const candidate = `${pathname}${suffix}`;
    if (existsSync(candidate)) {
      chmodSync(candidate, LEDGER_FILE_MODE);
    }
  }
}

function supportedContradictionRows(
  db: DatabaseSync,
  assignmentId: string,
): SupportedContradictionRow[] {
  return db
    .prepare(
      `SELECT a.epoch AS assignmentEpoch,
              c.correction_id AS correctionId,
              c.semantic_digest AS correctionSemanticDigest,
              original.receipt_id AS originalReceiptId,
              original.semantic_digest AS originalSemanticDigest,
              original_validation.validation_id AS originalValidationId,
              original_validation.outcome AS originalValidationOutcome,
              original_validation.issues_json AS originalValidationIssuesJson,
              original_validation.validator_id AS originalValidatorId,
              original_validation.validator_version AS originalValidatorVersion,
              original_validation.validator_digest AS originalValidatorDigest,
              original_order.append_sequence AS originalAppendSequence,
              corrected.receipt_id AS correctedReceiptId,
              corrected.correction_of AS correctedCorrectionOf,
              corrected.semantic_digest AS correctedSemanticDigest,
              corrected_validation.validation_id AS correctedValidationId,
              corrected_validation.outcome AS correctedValidationOutcome,
              corrected_validation.validator_id AS correctedValidatorId,
              corrected_validation.validator_version AS correctedValidatorVersion,
              corrected_validation.validator_digest AS correctedValidatorDigest,
              corrected_order.append_sequence AS correctedAppendSequence,
              epoch.validator_id AS epochValidatorId,
              epoch.validator_version AS epochValidatorVersion,
              epoch.validator_digest AS epochValidatorDigest,
              tr.terminal_result_id AS terminalResultId,
              tr.run_id AS terminalResultRunId,
              tr.result_receipt_id AS terminalResultReceiptId,
              tr.result_receipt_sha256 AS terminalResultReceiptSha256,
              tr.result_receipt_bytes AS terminalResultReceiptBytes,
              tr.result_receipt_captured_at AS terminalResultReceiptCapturedAt,
              tr.created_at AS terminalResultCreatedAt,
              (SELECT COUNT(*) FROM assignment_bindings b
                WHERE b.assignment_id = a.assignment_id AND b.run_id = tr.run_id)
                AS terminalRunBindingCount,
              (SELECT b.child_session_key FROM assignment_bindings b
                WHERE b.assignment_id = a.assignment_id AND b.run_id = tr.run_id
                ORDER BY b.bound_at, b.binding_id LIMIT 1) AS terminalChildSessionKey,
              t.terminal_receipt_id AS terminalReceiptId,
              t.run_id AS terminalReceiptRunId,
              t.accepted_receipt_id AS terminalAcceptedReceiptId,
              t.accepted_semantic_digest AS terminalAcceptedSemanticDigest,
              t.result_receipt_id AS acceptedResultReceiptId,
              t.result_receipt_sha256 AS acceptedResultReceiptSha256,
              t.result_receipt_bytes AS acceptedResultReceiptBytes,
              t.result_receipt_captured_at AS acceptedResultReceiptCapturedAt,
              completed.event_id AS completedEventId,
              completed.payload_json AS completedPayloadJson,
              (SELECT COUNT(*) FROM receipts WHERE assignment_id = a.assignment_id)
                AS receiptCount,
              (SELECT COUNT(*) FROM validations v
                 JOIN receipts r ON r.receipt_id = v.receipt_id
                WHERE r.assignment_id = a.assignment_id) AS validationCount,
              (SELECT COUNT(*) FROM correction_uses WHERE assignment_id = a.assignment_id)
                AS correctionCount,
              (SELECT COUNT(*) FROM terminal_results WHERE assignment_id = a.assignment_id)
                AS terminalResultCount,
              (SELECT COUNT(*) FROM terminal_receipts WHERE assignment_id = a.assignment_id)
                AS terminalReceiptCount,
              (SELECT COUNT(*) FROM route_events WHERE assignment_id = a.assignment_id)
                AS routeEventCount,
              (SELECT COUNT(*) FROM route_events
                WHERE assignment_id = a.assignment_id AND kind = 'accepted')
                AS acceptedEventCount,
              (SELECT COUNT(*) FROM route_events
                WHERE assignment_id = a.assignment_id AND kind = 'completed')
                AS completedEventCount,
              (SELECT COUNT(*) FROM route_events
                WHERE assignment_id = a.assignment_id AND kind = 'validation_rejected')
                AS rejectionEventCount,
              (SELECT COUNT(*) FROM route_events
                WHERE assignment_id = a.assignment_id AND kind IN ('route_rejected', 'timeout'))
                AS otherTerminalEventCount,
              (SELECT COUNT(*) FROM delegation_ledger_repair_events
                WHERE assignment_id = a.assignment_id) AS existingRepairCount
       FROM assignments a
       JOIN epoch_events epoch ON epoch.epoch = a.epoch
       JOIN correction_uses c ON c.assignment_id = a.assignment_id
       JOIN receipts original ON original.receipt_id = c.original_receipt_id
       JOIN receipts corrected ON corrected.receipt_id = c.corrected_receipt_id
       JOIN validations original_validation
         ON original_validation.receipt_id = original.receipt_id
       JOIN validations corrected_validation
         ON corrected_validation.receipt_id = corrected.receipt_id
       JOIN ledger_record_appends_v2 original_order
         ON original_order.assignment_id = a.assignment_id
        AND original_order.record_kind = 'receipt'
        AND original_order.record_id = original.receipt_id
       JOIN ledger_record_appends_v2 corrected_order
         ON corrected_order.assignment_id = a.assignment_id
        AND corrected_order.record_kind = 'receipt'
        AND corrected_order.record_id = corrected.receipt_id
       JOIN terminal_results tr ON tr.assignment_id = a.assignment_id
       JOIN terminal_receipts t ON t.assignment_id = a.assignment_id
       JOIN route_events completed
         ON completed.assignment_id = a.assignment_id AND completed.kind = 'completed'
       WHERE a.assignment_id = ?`,
    )
    .all(assignmentId) as SupportedContradictionRow[];
}

function supportedRouteEventRows(db: DatabaseSync, assignmentId: string): SupportedRouteEventRow[] {
  return db
    .prepare(
      `SELECT e.event_id AS eventId, e.kind, e.payload_json AS payloadJson,
              e.created_at AS createdAt, o.append_sequence AS appendSequence
       FROM route_events e
       JOIN ledger_record_appends_v2 o
         ON o.assignment_id = e.assignment_id
        AND o.record_kind = 'route_event'
        AND o.record_id = e.event_id
       WHERE e.assignment_id = ?
       ORDER BY o.append_sequence`,
    )
    .all(assignmentId) as SupportedRouteEventRow[];
}

function parseRoutePayload(row: SupportedRouteEventRow): Record<string, unknown> | undefined {
  try {
    const payload = JSON.parse(row.payloadJson) as unknown;
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function exactRoutePayload(
  row: SupportedRouteEventRow,
  expected: Record<string, unknown>,
): boolean {
  const payload = parseRoutePayload(row);
  return Boolean(payload && canonicalDelegationJson(payload) === canonicalDelegationJson(expected));
}

function observedCompletionCounts(
  row: SupportedContradictionRow,
): DelegationLedgerRepairObservedCompletionCounts {
  return {
    receipts: toNumber(row.receiptCount),
    validations: toNumber(row.validationCount),
    corrections: toNumber(row.correctionCount),
    terminalRunBindings: toNumber(row.terminalRunBindingCount),
    terminalResults: toNumber(row.terminalResultCount),
    terminalReceipts: toNumber(row.terminalReceiptCount),
    routeEvents: toNumber(row.routeEventCount),
    acceptedEvents: toNumber(row.acceptedEventCount),
    completedEvents: toNumber(row.completedEventCount),
    rejectionEvents: toNumber(row.rejectionEventCount),
    otherTerminalEvents: toNumber(row.otherTerminalEventCount),
    existingRepairEvents: toNumber(row.existingRepairCount),
  };
}

function parseCompletedPayload(row: SupportedContradictionRow) {
  try {
    return JSON.parse(row.completedPayloadJson) as {
      runId?: unknown;
      terminalReceiptId?: unknown;
      acceptedReceiptId?: unknown;
      acceptedSemanticDigest?: unknown;
      resultReceipt?: {
        receiptId?: unknown;
        sha256?: unknown;
        bytes?: unknown;
        capturedAt?: unknown;
      };
    };
  } catch {
    return undefined;
  }
}

function inspectSupportedContradiction(
  db: DatabaseSync,
  assignmentId: string,
): DelegationLedgerRepairInspection {
  const rows = supportedContradictionRows(db, assignmentId);
  if (rows.length !== 1) {
    throw new Error(
      `Assignment ${assignmentId} does not have the one supported completed-format-correction contradiction.`,
    );
  }
  const row = rows[0];
  const completed = parseCompletedPayload(row);
  let issues: unknown;
  try {
    issues = JSON.parse(row.originalValidationIssuesJson) as unknown;
  } catch {
    issues = undefined;
  }
  const validator: DelegationLedgerRepairValidator = {
    id: row.epochValidatorId,
    version: row.epochValidatorVersion,
    sha256: row.epochValidatorDigest,
  };
  const expectedState: DelegationLedgerRepairExpectedState = {
    assignmentEpoch: toNumber(row.assignmentEpoch),
    correctionId: row.correctionId,
    originalReceiptId: row.originalReceiptId,
    originalValidationId: row.originalValidationId,
    originalReceiptAppendSequence: toNumber(row.originalAppendSequence),
    correctedReceiptId: row.correctedReceiptId,
    correctedValidationId: row.correctedValidationId,
    correctedReceiptAppendSequence: toNumber(row.correctedAppendSequence),
    semanticDigest: row.correctionSemanticDigest,
    terminalResultId: row.terminalResultId,
    terminalReceiptId: row.terminalReceiptId,
    completedEventId: row.completedEventId,
  };
  const expectedMissingEvent: DelegationLedgerRepairMissingEvent = {
    kind: "validation_rejected",
    receiptId: row.originalReceiptId,
    validationId: row.originalValidationId,
    afterAppendSequence: toNumber(row.originalAppendSequence),
    beforeAppendSequence: toNumber(row.correctedAppendSequence),
  };
  const missingEventCountsMatch =
    toNumber(row.receiptCount) === 2 &&
    toNumber(row.validationCount) === 2 &&
    toNumber(row.correctionCount) === 1 &&
    toNumber(row.terminalResultCount) === 1 &&
    toNumber(row.terminalReceiptCount) === 1 &&
    toNumber(row.routeEventCount) === 2 &&
    toNumber(row.acceptedEventCount) === 1 &&
    toNumber(row.completedEventCount) === 1 &&
    toNumber(row.rejectionEventCount) === 0 &&
    toNumber(row.otherTerminalEventCount) === 0 &&
    toNumber(row.existingRepairCount) === 0;
  const validatorsMatch =
    row.originalValidatorId === validator.id &&
    row.originalValidatorVersion === validator.version &&
    row.originalValidatorDigest === validator.sha256 &&
    row.correctedValidatorId === validator.id &&
    row.correctedValidatorVersion === validator.version &&
    row.correctedValidatorDigest === validator.sha256;
  const correctionMatches =
    (row.originalValidationOutcome === "rejected" || row.originalValidationOutcome === "blocked") &&
    Array.isArray(issues) &&
    issues.length > 0 &&
    row.correctedValidationOutcome === "accepted" &&
    row.correctedCorrectionOf === row.originalReceiptId &&
    row.originalSemanticDigest === row.correctionSemanticDigest &&
    row.correctedSemanticDigest === row.correctionSemanticDigest &&
    expectedMissingEvent.afterAppendSequence < expectedMissingEvent.beforeAppendSequence;
  const terminalResultMatches =
    row.terminalResultRunId === row.terminalReceiptRunId &&
    row.terminalResultReceiptId === row.acceptedResultReceiptId &&
    row.terminalResultReceiptSha256 === row.acceptedResultReceiptSha256 &&
    toNumber(row.terminalResultReceiptBytes) === toNumber(row.acceptedResultReceiptBytes) &&
    toNumber(row.terminalResultReceiptCapturedAt) === toNumber(row.acceptedResultReceiptCapturedAt);
  const terminalMatches =
    row.terminalAcceptedReceiptId === row.correctedReceiptId &&
    row.terminalAcceptedSemanticDigest === row.correctionSemanticDigest &&
    completed?.runId === row.terminalReceiptRunId &&
    completed.terminalReceiptId === row.terminalReceiptId &&
    completed.acceptedReceiptId === row.correctedReceiptId &&
    completed.acceptedSemanticDigest === row.correctionSemanticDigest &&
    completed.resultReceipt?.receiptId === row.acceptedResultReceiptId &&
    completed.resultReceipt.sha256 === row.acceptedResultReceiptSha256 &&
    completed.resultReceipt.bytes === toNumber(row.acceptedResultReceiptBytes) &&
    completed.resultReceipt.capturedAt === toNumber(row.acceptedResultReceiptCapturedAt);
  const commonStateMatches =
    validatorsMatch && correctionMatches && terminalResultMatches && terminalMatches;
  const expectedLedgerHead = computeDelegationLedgerHead(db);
  if (commonStateMatches && missingEventCountsMatch) {
    const corruptionFingerprint = hashDelegationLedgerCorruption({
      repairKind: DELEGATION_LEDGER_REPAIR_KIND,
      assignmentId,
      expectedLedgerHead,
      expectedState,
      expectedMissingEvent,
      validator,
    });
    return {
      version: DELEGATION_LEDGER_REPAIR_INSPECTION_VERSION,
      repairKind: DELEGATION_LEDGER_REPAIR_KIND,
      assignmentId,
      corruptionFingerprint,
      expectedLedgerHead,
      expectedState,
      expectedMissingEvent,
      validator,
    };
  }

  const expectedCounts = observedCompletionCounts(row);
  const observedCompletionCountsMatch =
    expectedCounts.receipts === 2 &&
    expectedCounts.validations === 2 &&
    expectedCounts.corrections === 1 &&
    expectedCounts.terminalRunBindings === 1 &&
    expectedCounts.terminalResults === 1 &&
    expectedCounts.terminalReceipts === 1 &&
    expectedCounts.routeEvents === 4 &&
    expectedCounts.acceptedEvents === 1 &&
    expectedCounts.completedEvents === 1 &&
    expectedCounts.rejectionEvents === 2 &&
    expectedCounts.otherTerminalEvents === 0 &&
    expectedCounts.existingRepairEvents === 0;
  const routeRows = supportedRouteEventRows(db, assignmentId);
  const accepted = routeRows.find((event) => event.kind === "accepted");
  const supersededRejection = routeRows.find(
    (event) =>
      event.kind === "validation_rejected" &&
      exactRoutePayload(event, {
        code: "report-structure-invalid",
        receiptId: row.originalReceiptId,
        validationId: row.originalValidationId,
      }),
  );
  const prematureCompletionRejection = routeRows.find(
    (event) =>
      event.kind === "validation_rejected" &&
      exactRoutePayload(event, {
        code: "missing-accepted-report",
        runId: row.terminalResultRunId,
      }),
  );
  const completedRoute = routeRows.find(
    (event) =>
      event.kind === "completed" &&
      event.eventId === row.completedEventId &&
      exactRoutePayload(event, {
        runId: row.terminalReceiptRunId,
        terminalReceiptId: row.terminalReceiptId,
        acceptedReceiptId: row.correctedReceiptId,
        acceptedSemanticDigest: row.correctionSemanticDigest,
        resultReceipt: {
          receiptId: row.acceptedResultReceiptId,
          sha256: row.acceptedResultReceiptSha256,
          bytes: toNumber(row.acceptedResultReceiptBytes),
          capturedAt: toNumber(row.acceptedResultReceiptCapturedAt),
        },
      }),
  );
  const acceptedPayload = accepted ? parseRoutePayload(accepted) : undefined;
  const acceptedChildSessionKey =
    typeof acceptedPayload?.childSessionKey === "string"
      ? acceptedPayload.childSessionKey
      : undefined;
  const acceptedPayloadKeys = acceptedPayload ? Object.keys(acceptedPayload).toSorted() : [];
  const observedCompletionMatches = Boolean(
    commonStateMatches &&
    observedCompletionCountsMatch &&
    routeRows.length === 4 &&
    accepted &&
    supersededRejection &&
    prematureCompletionRejection &&
    completedRoute &&
    acceptedPayload?.runId === row.terminalResultRunId &&
    acceptedChildSessionKey &&
    acceptedChildSessionKey === row.terminalChildSessionKey &&
    canonicalDelegationJson(acceptedPayloadKeys) ===
      canonicalDelegationJson(["childSessionKey", "runId"]) &&
    toNumber(accepted.appendSequence) + 1 === toNumber(row.originalAppendSequence) &&
    toNumber(row.originalAppendSequence) + 1 === toNumber(supersededRejection.appendSequence) &&
    toNumber(supersededRejection.appendSequence) + 1 ===
      toNumber(prematureCompletionRejection.appendSequence) &&
    toNumber(prematureCompletionRejection.appendSequence) + 1 ===
      toNumber(row.correctedAppendSequence) &&
    toNumber(row.correctedAppendSequence) + 1 === toNumber(completedRoute.appendSequence) &&
    toNumber(prematureCompletionRejection.createdAt) === toNumber(row.terminalResultCreatedAt),
  );
  if (
    !observedCompletionMatches ||
    !accepted ||
    !supersededRejection ||
    !prematureCompletionRejection ||
    !completedRoute ||
    !acceptedChildSessionKey
  ) {
    throw new Error(
      `Assignment ${assignmentId} has different or additional ledger corruption; the narrow repair is not authorized.`,
    );
  }

  const observedExpectedState: DelegationLedgerRepairObservedCompletionExpectedState = {
    ...expectedState,
    terminalRunId: row.terminalResultRunId,
    terminalResultCreatedAt: toNumber(row.terminalResultCreatedAt),
  };
  const expectedEvents: DelegationLedgerRepairObservedCompletionEvents = {
    accepted: {
      eventId: accepted.eventId,
      appendSequence: toNumber(accepted.appendSequence),
      createdAt: toNumber(accepted.createdAt),
      childSessionKey: acceptedChildSessionKey,
      runId: row.terminalResultRunId,
    },
    supersededRejection: {
      eventId: supersededRejection.eventId,
      appendSequence: toNumber(supersededRejection.appendSequence),
      createdAt: toNumber(supersededRejection.createdAt),
      code: "report-structure-invalid",
      receiptId: row.originalReceiptId,
      validationId: row.originalValidationId,
    },
    prematureCompletionRejection: {
      eventId: prematureCompletionRejection.eventId,
      appendSequence: toNumber(prematureCompletionRejection.appendSequence),
      createdAt: toNumber(prematureCompletionRejection.createdAt),
      code: "missing-accepted-report",
      runId: row.terminalResultRunId,
    },
    completed: {
      eventId: completedRoute.eventId,
      appendSequence: toNumber(completedRoute.appendSequence),
      createdAt: toNumber(completedRoute.createdAt),
      runId: row.terminalResultRunId,
      terminalReceiptId: row.terminalReceiptId,
      acceptedReceiptId: row.correctedReceiptId,
      acceptedSemanticDigest: row.correctionSemanticDigest,
      resultReceipt: {
        receiptId: row.acceptedResultReceiptId,
        sha256: row.acceptedResultReceiptSha256,
        bytes: toNumber(row.acceptedResultReceiptBytes),
        capturedAt: toNumber(row.acceptedResultReceiptCapturedAt),
      },
    },
  };
  const corruptionFingerprint = hashDelegationLedgerObservedCompletionCorruption({
    repairKind: DELEGATION_LEDGER_REPAIR_KIND,
    repairCase: DELEGATION_LEDGER_REPAIR_OBSERVED_COMPLETION_CASE,
    assignmentId,
    expectedLedgerHead,
    expectedState: observedExpectedState,
    expectedEvents,
    expectedCounts,
    validator,
  });
  return {
    version: DELEGATION_LEDGER_REPAIR_OBSERVED_COMPLETION_INSPECTION_VERSION,
    repairKind: DELEGATION_LEDGER_REPAIR_KIND,
    repairCase: DELEGATION_LEDGER_REPAIR_OBSERVED_COMPLETION_CASE,
    assignmentId,
    corruptionFingerprint,
    expectedLedgerHead,
    expectedState: observedExpectedState,
    expectedEvents,
    expectedCounts,
    validator,
  };
}

function withExclusiveTransaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN EXCLUSIVE;");
  try {
    const result = operation();
    db.exec("COMMIT;");
    return result;
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

export function inspectDelegationLedgerRepair(params: {
  stateDir: string;
  assignmentId: string;
  busyTimeoutMs?: number;
}): DelegationLedgerRepairInspection {
  const { db, pathname } = openMaintenanceDatabase(params);
  try {
    return withExclusiveTransaction(db, () =>
      inspectSupportedContradiction(db, params.assignmentId),
    );
  } finally {
    db.close();
    secureLedgerFiles(pathname);
  }
}

function priorRepairResult(params: {
  db: DatabaseSync;
  authorization: DelegationLedgerRepairAuthorization;
  authorizationDigest: string;
}): DelegationLedgerRepairResult | undefined {
  const rows = params.db
    .prepare(
      `SELECT e.repair_event_id AS repairEventId,
              e.assignment_id AS assignmentId,
              e.authorization_json AS authorizationJson,
              e.authorization_digest AS authorizationDigest,
              e.idempotency_key AS idempotencyKey,
              r.repair_receipt_id AS repairReceiptId,
              r.authorization_digest AS receiptAuthorizationDigest,
              r.idempotency_key AS receiptIdempotencyKey,
              r.outcome
       FROM delegation_ledger_repair_events e
       LEFT JOIN delegation_ledger_repair_receipts r
         ON r.repair_event_id = e.repair_event_id
       WHERE e.idempotency_key = ? OR e.assignment_id = ? OR e.authorization_digest = ?`,
    )
    .all(
      params.authorization.idempotencyKey,
      params.authorization.assignmentId,
      params.authorizationDigest,
    ) as Array<{
    repairEventId: string;
    assignmentId: string;
    authorizationJson: string;
    authorizationDigest: string;
    idempotencyKey: string;
    repairReceiptId: string | null;
    receiptAuthorizationDigest: string | null;
    receiptIdempotencyKey: string | null;
    outcome: string | null;
  }>;
  if (rows.length === 0) {
    return undefined;
  }
  if (rows.length !== 1) {
    throw new Error("Conflicting delegation ledger repair records already exist.");
  }
  const row = rows[0];
  const repairReceiptId = row.repairReceiptId;
  const exactRetry =
    row.assignmentId === params.authorization.assignmentId &&
    row.authorizationJson === canonicalDelegationLedgerRepairAuthorization(params.authorization) &&
    row.authorizationDigest === params.authorizationDigest &&
    row.idempotencyKey === params.authorization.idempotencyKey &&
    row.repairEventId ===
      createDelegationRecordId("ledger-repair-event", {
        authorizationDigest: params.authorizationDigest,
      }) &&
    repairReceiptId !== null &&
    repairReceiptId ===
      createDelegationRecordId("ledger-repair-receipt", {
        authorizationDigest: params.authorizationDigest,
      }) &&
    row.receiptAuthorizationDigest === params.authorizationDigest &&
    row.receiptIdempotencyKey === params.authorization.idempotencyKey &&
    row.outcome === DELEGATION_LEDGER_REPAIR_OUTCOME;
  if (!exactRetry) {
    throw new Error(
      "Delegation ledger repair replay conflicts with an existing assignment, authorization, or idempotency key.",
    );
  }
  return {
    status: "already-applied",
    repairEventId: row.repairEventId,
    repairReceiptId,
    authorizationDigest: params.authorizationDigest,
  };
}

export function applyDelegationLedgerRepair(params: {
  stateDir: string;
  authorization: unknown;
  createdAt?: number;
  busyTimeoutMs?: number;
  faultInjection?: { afterRepairEventAppend?: () => void };
}): DelegationLedgerRepairResult {
  const authorization = parseDelegationLedgerRepairAuthorization(params.authorization);
  const authorizationDigest = hashDelegationLedgerRepairAuthorization(authorization);
  const { db, pathname } = openMaintenanceDatabase(params);
  try {
    return withExclusiveTransaction(db, () => {
      const prior = priorRepairResult({ db, authorization, authorizationDigest });
      if (prior) {
        return prior;
      }
      const inspection = inspectSupportedContradiction(db, authorization.assignmentId);
      if (inspection.expectedLedgerHead !== authorization.expectedLedgerHead) {
        throw new Error("Delegation ledger repair authorization has a stale expected ledger head.");
      }
      if (inspection.corruptionFingerprint !== authorization.corruptionFingerprint) {
        throw new Error(
          "Delegation ledger repair authorization has an incorrect corruption fingerprint.",
        );
      }
      const expectedAuthorizationFacts = {
        ...inspection,
        version: authorization.version,
        operator: authorization.operator,
        idempotencyKey: authorization.idempotencyKey,
      };
      if (
        canonicalDelegationJson(expectedAuthorizationFacts) !==
        canonicalDelegationLedgerRepairAuthorization(authorization)
      ) {
        throw new Error(
          "Delegation ledger repair authorization does not match the assignment, expected state, rejection evidence, or validator.",
        );
      }
      const createdAt = params.createdAt ?? Date.now();
      const repairEventId = createDelegationRecordId("ledger-repair-event", {
        authorizationDigest,
      });
      const repairReceiptId = createDelegationRecordId("ledger-repair-receipt", {
        authorizationDigest,
      });
      db.prepare(
        `INSERT INTO delegation_ledger_repair_events
         (repair_event_id, assignment_id, repair_kind, authorization_json,
          authorization_digest, corruption_fingerprint, pre_repair_ledger_head,
          expected_state_json, expected_missing_event_json, validator_id,
          validator_version, validator_digest, operator_id, operator_reason,
          operator_ticket, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        repairEventId,
        authorization.assignmentId,
        authorization.repairKind,
        canonicalDelegationLedgerRepairAuthorization(authorization),
        authorizationDigest,
        authorization.corruptionFingerprint,
        authorization.expectedLedgerHead,
        canonicalDelegationJson(authorization.expectedState),
        canonicalDelegationJson(delegationLedgerRepairExpectedEvidence(authorization)),
        authorization.validator.id,
        authorization.validator.version,
        authorization.validator.sha256,
        authorization.operator.id,
        authorization.operator.reason,
        authorization.operator.ticket,
        authorization.idempotencyKey,
        createdAt,
      );
      params.faultInjection?.afterRepairEventAppend?.();
      db.prepare(
        `INSERT INTO delegation_ledger_repair_receipts
         (repair_receipt_id, repair_event_id, assignment_id, authorization_digest,
          idempotency_key, outcome, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        repairReceiptId,
        repairEventId,
        authorization.assignmentId,
        authorizationDigest,
        authorization.idempotencyKey,
        DELEGATION_LEDGER_REPAIR_OUTCOME,
        createdAt,
      );
      return {
        status: "applied",
        repairEventId,
        repairReceiptId,
        authorizationDigest,
      };
    });
  } finally {
    db.close();
    secureLedgerFiles(pathname);
  }
}
