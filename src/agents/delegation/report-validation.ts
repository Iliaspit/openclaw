import type { DelegationWorkerReport } from "./contracts.js";
import { DelegationReportContractError } from "./report-result.js";
import { canonicalizeDelegationScopePath } from "./scope.js";

export function validateDelegationNewlyDiscovered(params: {
  report: DelegationWorkerReport;
  assignedScope: string[];
}): void {
  const assigned = new Set(params.assignedScope);
  const discovered = new Set<string>();
  for (const entry of params.report.scope.newlyDiscovered) {
    let canonicalPath: string;
    try {
      canonicalPath = canonicalizeDelegationScopePath(entry.path);
    } catch (error) {
      throw new DelegationReportContractError(
        "newly_discovered_invalid",
        error instanceof Error ? error.message : "Newly discovered scope path is invalid.",
      );
    }
    if (entry.scopeId !== canonicalPath) {
      throw new DelegationReportContractError(
        "newly_discovered_invalid",
        `Newly discovered scope ID must exactly equal its canonical path: ${entry.path}`,
      );
    }
    if (assigned.has(canonicalPath)) {
      throw new DelegationReportContractError(
        "newly_discovered_invalid",
        `Newly discovered scope collides with assigned scope: ${canonicalPath}`,
      );
    }
    if (discovered.has(canonicalPath)) {
      throw new DelegationReportContractError(
        "newly_discovered_invalid",
        `Newly discovered scope contains a duplicate path: ${canonicalPath}`,
      );
    }
    discovered.add(canonicalPath);
  }

  const evidence = new Map<
    string,
    | { kind: "command"; value: DelegationWorkerReport["commands"][number] }
    | { kind: "artifact"; value: DelegationWorkerReport["artifacts"][number] }
  >();
  for (const command of params.report.commands) {
    if (evidence.has(command.evidenceId)) {
      throw new DelegationReportContractError(
        "newly_discovered_invalid",
        `Delegation report evidence ID is not globally unique: ${command.evidenceId}`,
      );
    }
    evidence.set(command.evidenceId, { kind: "command", value: command });
  }
  for (const artifact of params.report.artifacts) {
    if (evidence.has(artifact.evidenceId)) {
      throw new DelegationReportContractError(
        "newly_discovered_invalid",
        `Delegation report evidence ID is not globally unique: ${artifact.evidenceId}`,
      );
    }
    evidence.set(artifact.evidenceId, { kind: "artifact", value: artifact });
  }

  const requireEvidence = (evidenceId: string, owner: string) => {
    if (!evidence.has(evidenceId)) {
      throw new DelegationReportContractError(
        "newly_discovered_invalid",
        `${owner} references missing evidence ID: ${evidenceId}`,
      );
    }
  };
  for (const inspected of params.report.scope.inspected) {
    for (const evidenceId of inspected.evidenceIds) {
      requireEvidence(evidenceId, `Inspected scope ${inspected.scopeId}`);
    }
  }
  for (const failed of params.report.scope.failed) {
    if (failed.evidenceId) {
      requireEvidence(failed.evidenceId, `Failed scope ${failed.scopeId}`);
    }
  }
  for (const entry of params.report.scope.newlyDiscovered) {
    for (const evidenceId of entry.evidenceIds) {
      requireEvidence(evidenceId, `Newly discovered scope ${entry.scopeId}`);
    }
    if (entry.disposition !== "covered") {
      continue;
    }
    const covered = entry.evidenceIds.some((evidenceId) => {
      const bound = evidence.get(evidenceId);
      return bound?.kind === "command"
        ? bound.value.exitCode === 0 &&
            !bound.value.truncated &&
            bound.value.scopeIds.includes(entry.scopeId)
        : bound?.value.path === entry.path;
    });
    if (!covered) {
      throw new DelegationReportContractError(
        "newly_discovered_invalid",
        `Covered newly discovered scope requires successful, nontruncated path-bound evidence: ${entry.scopeId}`,
      );
    }
  }
  for (const finding of params.report.findings) {
    for (const evidenceId of finding.evidenceIds) {
      requireEvidence(evidenceId, `Finding ${finding.localId}`);
    }
  }

  const allowedScope = new Set([...assigned, ...discovered]);
  for (const command of params.report.commands) {
    for (const scopeId of command.scopeIds) {
      if (!allowedScope.has(scopeId)) {
        throw new DelegationReportContractError(
          "newly_discovered_invalid",
          `Command evidence references scope outside assigned and newly discovered scope: ${scopeId}`,
        );
      }
    }
  }
  for (const finding of params.report.findings) {
    for (const scopeId of finding.scopeIds) {
      if (!allowedScope.has(scopeId)) {
        throw new DelegationReportContractError(
          "newly_discovered_invalid",
          `Finding references scope outside assigned and newly discovered scope: ${scopeId}`,
        );
      }
    }
  }
}
