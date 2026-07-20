import { z } from "zod";
import { canonicalDelegationJson, hashDelegationIdentity } from "./identity.js";

export const DELEGATION_LEDGER_REPAIR_AUTHORIZATION_VERSION =
  "openclaw-delegation-ledger-repair-authorization-v1" as const;
export const DELEGATION_LEDGER_REPAIR_INSPECTION_VERSION =
  "openclaw-delegation-ledger-repair-inspection-v1" as const;
export const DELEGATION_LEDGER_REPAIR_KIND =
  "completed-format-correction-missing-superseded-rejection-v1" as const;
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
    operator: z
      .object({
        id: identifierSchema,
        reason: z.string().trim().min(1).max(4_096),
        ticket: identifierSchema,
      })
      .strict(),
    idempotencyKey: identifierSchema,
  })
  .strict();

export type DelegationLedgerRepairExpectedState = z.infer<
  typeof DelegationLedgerRepairExpectedStateSchema
>;
export type DelegationLedgerRepairMissingEvent = z.infer<
  typeof DelegationLedgerRepairMissingEventSchema
>;
export type DelegationLedgerRepairValidator = z.infer<typeof DelegationLedgerRepairValidatorSchema>;
export type DelegationLedgerRepairInspection = z.infer<
  typeof DelegationLedgerRepairInspectionSchema
>;
export type DelegationLedgerRepairAuthorization = z.infer<
  typeof DelegationLedgerRepairAuthorizationSchema
>;

export function parseDelegationLedgerRepairAuthorization(
  value: unknown,
): DelegationLedgerRepairAuthorization {
  return DelegationLedgerRepairAuthorizationSchema.parse(value);
}

export function parseDelegationLedgerRepairInspection(
  value: unknown,
): DelegationLedgerRepairInspection {
  return DelegationLedgerRepairInspectionSchema.parse(value);
}

export function hashDelegationLedgerRepairAuthorization(
  authorization: DelegationLedgerRepairAuthorization,
): string {
  return hashDelegationIdentity("delegation-ledger-repair-authorization-v1", authorization);
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

export function createDelegationLedgerRepairAuthorization(params: {
  inspection: DelegationLedgerRepairInspection;
  operator: DelegationLedgerRepairAuthorization["operator"];
  idempotencyKey: string;
}): DelegationLedgerRepairAuthorization {
  const inspection = DelegationLedgerRepairInspectionSchema.parse(params.inspection);
  return DelegationLedgerRepairAuthorizationSchema.parse({
    ...inspection,
    version: DELEGATION_LEDGER_REPAIR_AUTHORIZATION_VERSION,
    operator: params.operator,
    idempotencyKey: params.idempotencyKey,
  });
}

export function canonicalDelegationLedgerRepairAuthorization(
  authorization: DelegationLedgerRepairAuthorization,
): string {
  return canonicalDelegationJson(authorization);
}
