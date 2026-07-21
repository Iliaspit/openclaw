import type { DelegationAssignmentRecord, DelegationWorkerReport } from "./contracts.js";
import { DELEGATION_EVIDENCE_NAMESPACE_VERSION } from "./contracts.js";
import { compareDelegationStrings, hashDelegationIdentity } from "./identity.js";
import { DelegationReportContractError } from "./report-result.js";

const MAX_LOCAL_EVIDENCE_ID_BYTES = 256;

export type DelegationEvidenceIdentity = {
  version: typeof DELEGATION_EVIDENCE_NAMESPACE_VERSION;
  namespace: string;
  assignmentId: string;
  mapping: Array<{ localId: string; canonicalId: string }>;
  mappingDigest: string;
};

function assertLocalEvidenceId(value: string): void {
  let hasControlCharacter = false;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      hasControlCharacter = true;
      break;
    }
  }
  if (
    value.trim() !== value ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_LOCAL_EVIDENCE_ID_BYTES ||
    hasControlCharacter ||
    value.startsWith("evidence_")
  ) {
    throw new DelegationReportContractError(
      "evidence_identity_invalid",
      `Delegation report evidence ID is not a valid worker-local ID: ${value}`,
    );
  }
}

export function canonicalDelegationEvidenceId(params: {
  assignmentId: string;
  localId: string;
}): string {
  assertLocalEvidenceId(params.localId);
  const namespaceDigest = hashDelegationIdentity(DELEGATION_EVIDENCE_NAMESPACE_VERSION, {
    assignmentId: params.assignmentId,
  });
  const evidenceDigest = hashDelegationIdentity(DELEGATION_EVIDENCE_NAMESPACE_VERSION, {
    assignmentId: params.assignmentId,
    localId: params.localId,
  });
  return `evidence_${namespaceDigest.slice(0, 16)}_${evidenceDigest}`;
}

export function bindDelegationEvidenceToAssignment(params: {
  assignment: Pick<DelegationAssignmentRecord, "assignmentId">;
  report: DelegationWorkerReport;
}): { report: DelegationWorkerReport; identity: DelegationEvidenceIdentity } {
  const producerIds = [
    ...params.report.commands.map((entry) => entry.evidenceId),
    ...params.report.artifacts.map((entry) => entry.evidenceId),
  ];
  const mapping = new Map<string, string>();
  for (const localId of producerIds) {
    assertLocalEvidenceId(localId);
    if (mapping.has(localId)) {
      throw new DelegationReportContractError(
        "evidence_identity_invalid",
        `Delegation report evidence ID is duplicated within one report: ${localId}`,
      );
    }
    mapping.set(
      localId,
      canonicalDelegationEvidenceId({ assignmentId: params.assignment.assignmentId, localId }),
    );
  }
  const bindReference = (localId: string): string => {
    assertLocalEvidenceId(localId);
    const canonicalId = mapping.get(localId);
    if (!canonicalId) {
      throw new DelegationReportContractError(
        "evidence_identity_invalid",
        `Delegation report references missing worker-local evidence ID: ${localId}`,
      );
    }
    return canonicalId;
  };
  const sortedMapping = [...mapping.entries()]
    .map(([localId, canonicalId]) => ({ localId, canonicalId }))
    .toSorted((left, right) => compareDelegationStrings(left.localId, right.localId));
  const namespaceDigest = hashDelegationIdentity(DELEGATION_EVIDENCE_NAMESPACE_VERSION, {
    assignmentId: params.assignment.assignmentId,
  });
  const identity: DelegationEvidenceIdentity = {
    version: DELEGATION_EVIDENCE_NAMESPACE_VERSION,
    namespace: `evidence_${namespaceDigest.slice(0, 16)}_`,
    assignmentId: params.assignment.assignmentId,
    mapping: sortedMapping,
    mappingDigest: hashDelegationIdentity("delegation-evidence-mapping-v1", sortedMapping),
  };
  return {
    identity,
    report: {
      ...params.report,
      scope: {
        ...params.report.scope,
        inspected: params.report.scope.inspected.map((entry) => ({
          ...entry,
          evidenceIds: entry.evidenceIds.map(bindReference),
        })),
        failed: params.report.scope.failed.map((entry) => ({
          ...entry,
          ...(entry.evidenceId ? { evidenceId: bindReference(entry.evidenceId) } : {}),
        })),
        newlyDiscovered: params.report.scope.newlyDiscovered.map((entry) => ({
          ...entry,
          evidenceIds: entry.evidenceIds.map(bindReference),
        })),
      },
      commands: params.report.commands.map((entry) => ({
        ...entry,
        evidenceId: bindReference(entry.evidenceId),
      })),
      artifacts: params.report.artifacts.map((entry) => ({
        ...entry,
        evidenceId: bindReference(entry.evidenceId),
      })),
      findings: params.report.findings.map((entry) => ({
        ...entry,
        evidenceIds: entry.evidenceIds.map(bindReference),
      })),
    },
  };
}
