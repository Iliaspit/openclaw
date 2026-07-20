import { z } from "zod";
import { canonicalDelegationJson, hashDelegationIdentity } from "./identity.js";

export const DELEGATION_LEDGER_REPAIR_AUTHORIZATION_VERSION =
  "openclaw-delegation-ledger-repair-authorization-v1" as const;
export const DELEGATION_LEDGER_REPAIR_OBSERVED_COMPLETION_AUTHORIZATION_VERSION =
  "openclaw-delegation-ledger-repair-authorization-v2" as const;
export const DELEGATION_LEDGER_REPAIR_INSPECTION_VERSION =
  "openclaw-delegation-ledger-repair-inspection-v1" as const;
export const DELEGATION_LEDGER_REPAIR_OBSERVED_COMPLETION_INSPECTION_VERSION =
  "openclaw-delegation-ledger-repair-inspection-v2" as const;
export const DELEGATION_LEDGER_REPAIR_KIND =
  "completed-format-correction-missing-superseded-rejection-v1" as const;
export const DELEGATION_LEDGER_REPAIR_OBSERVED_COMPLETION_CASE =
  "completed-format-correction-pre-correction-missing-accepted-report-v1" as const;
export const DELEGATION_LEDGER_REPAIR_OUTCOME = "supersession-restored" as const;

const identifierSchema = z.string().trim().min(1).max(512);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);

export const DelegationLedgerRepairExpectedStateSchema = z
  .object({
    assignmentEpoch: z.number().int().positive(),
    correctionId: identifierSchema,
    originalReceiptId: identifierSchema,
    originalValidationId: identifierSchema,
    originalReceiptAppendSequence: z.number().int().positive(),
    correctedReceiptId: identifierSchema,
    correctedValidationId: identifierSchema,
    correctedReceiptAppendSequence: z.number().int().positive(),
    semanticDigest: sha256Schema,
    terminalResultId: identifierSchema,
    terminalReceiptId: identifierSchema,
    completedEventId: identifierSchema,
  })
  .strict();

export const DelegationLedgerRepairObservedCompletionExpectedStateSchema =
  DelegationLedgerRepairExpectedStateSchema.extend({
    terminalRunId: identifierSchema,
    terminalResultCreatedAt: z.number().int().positive(),
  }).strict();

export const DelegationLedgerRepairMissingEventSchema = z
  .object({
    kind: z.literal("validation_rejected"),
    receiptId: identifierSchema,
    validationId: identifierSchema,
    afterAppendSequence: z.number().int().positive(),
    beforeAppendSequence: z.number().int().positive(),
  })
  .strict();

export const DelegationLedgerRepairValidatorSchema = z
  .object({
    id: identifierSchema,
    version: identifierSchema,
    sha256: sha256Schema,
  })
  .strict();

export const DelegationLedgerRepairObservedCompletionEventsSchema = z
  .object({
    accepted: z
      .object({
        eventId: identifierSchema,
        appendSequence: z.number().int().positive(),
        createdAt: z.number().int().positive(),
        childSessionKey: identifierSchema,
        runId: identifierSchema,
      })
      .strict(),
    supersededRejection: z
      .object({
        eventId: identifierSchema,
        appendSequence: z.number().int().positive(),
        createdAt: z.number().int().positive(),
        code: z.literal("report-structure-invalid"),
        receiptId: identifierSchema,
        validationId: identifierSchema,
      })
      .strict(),
    prematureCompletionRejection: z
      .object({
        eventId: identifierSchema,
        appendSequence: z.number().int().positive(),
        createdAt: z.number().int().positive(),
        code: z.literal("missing-accepted-report"),
        runId: identifierSchema,
      })
      .strict(),
    completed: z
      .object({
        eventId: identifierSchema,
        appendSequence: z.number().int().positive(),
        createdAt: z.number().int().positive(),
        runId: identifierSchema,
        terminalReceiptId: identifierSchema,
        acceptedReceiptId: identifierSchema,
        acceptedSemanticDigest: sha256Schema,
        resultReceipt: z
          .object({
            receiptId: identifierSchema,
            sha256: sha256Schema,
            bytes: z.number().int().nonnegative(),
            capturedAt: z.number().int().positive(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export const DelegationLedgerRepairObservedCompletionCountsSchema = z
  .object({
    receipts: z.number().int().nonnegative(),
    validations: z.number().int().nonnegative(),
    corrections: z.number().int().nonnegative(),
    terminalRunBindings: z.number().int().nonnegative(),
    terminalResults: z.number().int().nonnegative(),
    terminalReceipts: z.number().int().nonnegative(),
    routeEvents: z.number().int().nonnegative(),
    acceptedEvents: z.number().int().nonnegative(),
    completedEvents: z.number().int().nonnegative(),
    rejectionEvents: z.number().int().nonnegative(),
    otherTerminalEvents: z.number().int().nonnegative(),
    existingRepairEvents: z.number().int().nonnegative(),
  })
  .strict();

const DelegationLedgerRepairOperatorSchema = z
  .object({
    id: identifierSchema,
    reason: z.string().trim().min(1).max(4_096),
    ticket: identifierSchema,
  })
  .strict();

export const DelegationLedgerRepairInspectionSchema = z
  .object({
    version: z.literal(DELEGATION_LEDGER_REPAIR_INSPECTION_VERSION),
    repairKind: z.literal(DELEGATION_LEDGER_REPAIR_KIND),
    assignmentId: identifierSchema,
    corruptionFingerprint: sha256Schema,
    expectedLedgerHead: sha256Schema,
    expectedState: DelegationLedgerRepairExpectedStateSchema,
    expectedMissingEvent: DelegationLedgerRepairMissingEventSchema,
    validator: DelegationLedgerRepairValidatorSchema,
  })
  .strict();

export const DelegationLedgerRepairObservedCompletionInspectionSchema = z
  .object({
    version: z.literal(DELEGATION_LEDGER_REPAIR_OBSERVED_COMPLETION_INSPECTION_VERSION),
    repairKind: z.literal(DELEGATION_LEDGER_REPAIR_KIND),
    repairCase: z.literal(DELEGATION_LEDGER_REPAIR_OBSERVED_COMPLETION_CASE),
    assignmentId: identifierSchema,
    corruptionFingerprint: sha256Schema,
    expectedLedgerHead: sha256Schema,
    expectedState: DelegationLedgerRepairObservedCompletionExpectedStateSchema,
    expectedEvents: DelegationLedgerRepairObservedCompletionEventsSchema,
    expectedCounts: DelegationLedgerRepairObservedCompletionCountsSchema,
    validator: DelegationLedgerRepairValidatorSchema,
  })
  .strict();

export const DelegationLedgerRepairAuthorizationSchema = z
  .object({
    version: z.literal(DELEGATION_LEDGER_REPAIR_AUTHORIZATION_VERSION),
    repairKind: z.literal(DELEGATION_LEDGER_REPAIR_KIND),
    assignmentId: identifierSchema,
    corruptionFingerprint: sha256Schema,
    expectedLedgerHead: sha256Schema,
    expectedState: DelegationLedgerRepairExpectedStateSchema,
    expectedMissingEvent: DelegationLedgerRepairMissingEventSchema,
    validator: DelegationLedgerRepairValidatorSchema,
    operator: DelegationLedgerRepairOperatorSchema,
    idempotencyKey: identifierSchema,
  })
  .strict();

export const DelegationLedgerRepairObservedCompletionAuthorizationSchema = z
  .object({
    version: z.literal(DELEGATION_LEDGER_REPAIR_OBSERVED_COMPLETION_AUTHORIZATION_VERSION),
    repairKind: z.literal(DELEGATION_LEDGER_REPAIR_KIND),
    repairCase: z.literal(DELEGATION_LEDGER_REPAIR_OBSERVED_COMPLETION_CASE),
    assignmentId: identifierSchema,
    corruptionFingerprint: sha256Schema,
    expectedLedgerHead: sha256Schema,
    expectedState: DelegationLedgerRepairObservedCompletionExpectedStateSchema,
    expectedEvents: DelegationLedgerRepairObservedCompletionEventsSchema,
    expectedCounts: DelegationLedgerRepairObservedCompletionCountsSchema,
    validator: DelegationLedgerRepairValidatorSchema,
    operator: DelegationLedgerRepairOperatorSchema,
    idempotencyKey: identifierSchema,
  })
  .strict();

const DelegationLedgerRepairInspectionUnionSchema = z.discriminatedUnion("version", [
  DelegationLedgerRepairInspectionSchema,
  DelegationLedgerRepairObservedCompletionInspectionSchema,
]);

const DelegationLedgerRepairAuthorizationUnionSchema = z.discriminatedUnion("version", [
  DelegationLedgerRepairAuthorizationSchema,
  DelegationLedgerRepairObservedCompletionAuthorizationSchema,
]);

export type DelegationLedgerRepairExpectedState = z.infer<
  typeof DelegationLedgerRepairExpectedStateSchema
>;
export type DelegationLedgerRepairObservedCompletionExpectedState = z.infer<
  typeof DelegationLedgerRepairObservedCompletionExpectedStateSchema
>;
export type DelegationLedgerRepairMissingEvent = z.infer<
  typeof DelegationLedgerRepairMissingEventSchema
>;
export type DelegationLedgerRepairObservedCompletionEvents = z.infer<
  typeof DelegationLedgerRepairObservedCompletionEventsSchema
>;
export type DelegationLedgerRepairObservedCompletionCounts = z.infer<
  typeof DelegationLedgerRepairObservedCompletionCountsSchema
>;
export type DelegationLedgerRepairValidator = z.infer<typeof DelegationLedgerRepairValidatorSchema>;
export type DelegationLedgerRepairInspection = z.infer<
  typeof DelegationLedgerRepairInspectionUnionSchema
>;
export type DelegationLedgerRepairAuthorization = z.infer<
  typeof DelegationLedgerRepairAuthorizationUnionSchema
>;

export function parseDelegationLedgerRepairAuthorization(
  value: unknown,
): DelegationLedgerRepairAuthorization {
  return DelegationLedgerRepairAuthorizationUnionSchema.parse(value);
}

export function parseDelegationLedgerRepairInspection(
  value: unknown,
): DelegationLedgerRepairInspection {
  return DelegationLedgerRepairInspectionUnionSchema.parse(value);
}

export function hashDelegationLedgerRepairAuthorization(
  authorization: DelegationLedgerRepairAuthorization,
): string {
  return hashDelegationIdentity(
    authorization.version === DELEGATION_LEDGER_REPAIR_AUTHORIZATION_VERSION
      ? "delegation-ledger-repair-authorization-v1"
      : "delegation-ledger-repair-authorization-v2",
    authorization,
  );
}

export function hashDelegationLedgerCorruption(params: {
  repairKind: typeof DELEGATION_LEDGER_REPAIR_KIND;
  assignmentId: string;
  expectedLedgerHead: string;
  expectedState: DelegationLedgerRepairExpectedState;
  expectedMissingEvent: DelegationLedgerRepairMissingEvent;
  validator: DelegationLedgerRepairValidator;
}): string {
  return hashDelegationIdentity("delegation-ledger-corruption-v1", params);
}

export function hashDelegationLedgerObservedCompletionCorruption(params: {
  repairKind: typeof DELEGATION_LEDGER_REPAIR_KIND;
  repairCase: typeof DELEGATION_LEDGER_REPAIR_OBSERVED_COMPLETION_CASE;
  assignmentId: string;
  expectedLedgerHead: string;
  expectedState: DelegationLedgerRepairObservedCompletionExpectedState;
  expectedEvents: DelegationLedgerRepairObservedCompletionEvents;
  expectedCounts: DelegationLedgerRepairObservedCompletionCounts;
  validator: DelegationLedgerRepairValidator;
}): string {
  return hashDelegationIdentity("delegation-ledger-observed-completion-corruption-v1", params);
}

export function createDelegationLedgerRepairAuthorization(params: {
  inspection: DelegationLedgerRepairInspection;
  operator: DelegationLedgerRepairAuthorization["operator"];
  idempotencyKey: string;
}): DelegationLedgerRepairAuthorization {
  const inspection = DelegationLedgerRepairInspectionUnionSchema.parse(params.inspection);
  return DelegationLedgerRepairAuthorizationUnionSchema.parse({
    ...inspection,
    version:
      inspection.version === DELEGATION_LEDGER_REPAIR_INSPECTION_VERSION
        ? DELEGATION_LEDGER_REPAIR_AUTHORIZATION_VERSION
        : DELEGATION_LEDGER_REPAIR_OBSERVED_COMPLETION_AUTHORIZATION_VERSION,
    operator: params.operator,
    idempotencyKey: params.idempotencyKey,
  });
}

export function delegationLedgerRepairExpectedEvidence(
  authorization: DelegationLedgerRepairAuthorization,
): unknown {
  if (authorization.version === DELEGATION_LEDGER_REPAIR_AUTHORIZATION_VERSION) {
    return authorization.expectedMissingEvent;
  }
  return {
    repairCase: authorization.repairCase,
    expectedEvents: authorization.expectedEvents,
    expectedCounts: authorization.expectedCounts,
  };
}

export function canonicalDelegationLedgerRepairAuthorization(
  authorization: DelegationLedgerRepairAuthorization,
): string {
  return canonicalDelegationJson(authorization);
}
