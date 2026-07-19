import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { resolveStateDir } from "../../config/paths.js";
import type { DelegationGuardConfig } from "../../config/types.agents.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import {
  DELEGATION_CONTRACT_VERSION,
  type CanonicalDelegationScope,
  type DelegationAssignmentPurpose,
  type DelegationAssignmentRecord,
  type DelegationFingerprint,
  type DelegationLedgerStatus,
  type DelegationRemediationDisposition,
  type DelegationRepositorySnapshot,
  type DelegationRouteKind,
  type DelegationValidationOutcome,
  type DelegationWorkerReport,
} from "./contracts.js";
import {
  canonicalDelegationJson,
  createDelegationRecordId,
  hashDelegationIdentity,
} from "./identity.js";
import { resolveDelegationGuardPrincipal } from "./policy.js";
import { verifyPinnedDelegationValidator } from "./validator.js";

const LEDGER_DIR_MODE = 0o700;
const LEDGER_FILE_MODE = 0o600;
const LEDGER_SIDECARS = ["", "-shm", "-wal"] as const;

export type DelegationGatewayTaskReconciliationOutcome =
  | "absent"
  | "interrupted"
  | "uncertain"
  | "completed";

export type DelegationGatewayTerminalKind =
  | "route_rejected"
  | "validation_rejected"
  | "timeout"
  | "completed";

type AssignmentRow = {
  assignment_id: string;
  slice_id: string;
  candidate_id: string | null;
  wave_id: string | null;
  controller_agent_id: string;
  controller_session_key: string;
  worker_agent_id: string;
  role: DelegationAssignmentRecord["role"];
  required_thinking: DelegationAssignmentRecord["requiredThinking"];
  required_model: string;
  workspace_access: DelegationAssignmentRecord["workspaceAccess"];
  scope_units_json: string;
  route_family_id: string;
  purpose: DelegationAssignmentPurpose;
  remediation_revision_id: string | null;
  recovery_of_assignment_id: string | null;
  epoch: number | bigint;
  issued_at: number | bigint;
};

type EpochRow = {
  epoch: number | bigint;
  validator_id: string;
  validator_version: string;
  validator_digest: string;
  policy_digest: string;
  contract_version: string;
};

type CountRow = { count: number | bigint };

export type DelegationGatewayDispatchOutcome = {
  decision: "accepted" | "rejected";
  response: unknown;
};

export type DelegationGatewayDispatchClaim = {
  assignment: DelegationAssignmentRecord;
  firstUse: boolean;
  dispatchRun?: {
    runId: string;
    registeredAt: number;
  };
  interruption?: "accepted_without_run_proof" | "accepted_by_prior_gateway_writer";
  outcome?: DelegationGatewayDispatchOutcome;
};

function compareSemanticVersions(left: string, right: string): number | undefined {
  const parse = (value: string): [number, number, number] | undefined => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
  };
  const leftParts = parse(left);
  const rightParts = parse(right);
  if (!leftParts || !rightParts) {
    return undefined;
  }
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] < rightParts[index] ? -1 : 1;
    }
  }
  return 0;
}

function toNumber(value: number | bigint | null | undefined): number {
  if (value == null) {
    return 0;
  }
  return typeof value === "bigint" ? Number(value) : value;
}

function assignmentFromRow(row: AssignmentRow): DelegationAssignmentRecord {
  return {
    assignmentId: row.assignment_id,
    sliceId: row.slice_id,
    ...(row.candidate_id ? { candidateId: row.candidate_id } : {}),
    ...(row.wave_id ? { waveId: row.wave_id } : {}),
    controllerAgentId: row.controller_agent_id,
    controllerSessionKey: row.controller_session_key,
    workerAgentId: row.worker_agent_id,
    role: row.role,
    requiredThinking: row.required_thinking,
    requiredModel: row.required_model,
    workspaceAccess: row.workspace_access,
    scopeUnits: JSON.parse(row.scope_units_json) as string[],
    routeFamilyId: row.route_family_id,
    purpose: row.purpose,
    ...(row.remediation_revision_id ? { remediationRevisionId: row.remediation_revision_id } : {}),
    ...(row.recovery_of_assignment_id
      ? { recoveryOfAssignmentId: row.recovery_of_assignment_id }
      : {}),
    epoch: toNumber(row.epoch),
    issuedAt: toNumber(row.issued_at),
  };
}

function isProgressableTerminalReport(
  reportJson: string,
  options: { requireCompletedStatus?: boolean; requireNoBlockers?: boolean } = {},
): boolean {
  try {
    const report = JSON.parse(reportJson) as DelegationWorkerReport;
    return (
      report.coverage === "complete" &&
      report.status !== "blocked" &&
      (!options.requireCompletedStatus || report.status === "completed") &&
      (!options.requireNoBlockers ||
        report.findings.every((finding) => finding.severity !== "blocker")) &&
      report.scope.omitted.length === 0 &&
      report.scope.failed.length === 0
    );
  } catch {
    return false;
  }
}

function ensurePermissions(pathname: string) {
  const directory = path.dirname(pathname);
  mkdirSync(directory, { recursive: true, mode: LEDGER_DIR_MODE });
  chmodSync(directory, LEDGER_DIR_MODE);
  for (const suffix of LEDGER_SIDECARS) {
    const candidate = `${pathname}${suffix}`;
    if (existsSync(candidate)) {
      chmodSync(candidate, LEDGER_FILE_MODE);
    }
  }
}

function installAppendOnlyTriggers(db: DatabaseSync, tableNames: string[]) {
  for (const tableName of tableNames) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS ${tableName}_reject_update
      BEFORE UPDATE ON ${tableName}
      BEGIN
        SELECT RAISE(ABORT, '${tableName} is append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS ${tableName}_reject_delete
      BEFORE DELETE ON ${tableName}
      BEGIN
        SELECT RAISE(ABORT, '${tableName} is append-only');
      END;
    `);
  }
}

function ensureSchema(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS epoch_events (
      event_id TEXT PRIMARY KEY,
      epoch INTEGER NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      contract_version TEXT NOT NULL,
      validator_id TEXT NOT NULL,
      validator_version TEXT NOT NULL,
      validator_digest TEXT NOT NULL,
      policy_digest TEXT NOT NULL,
      actor_agent_id TEXT,
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      event_id TEXT PRIMARY KEY,
      epoch INTEGER NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS slices (
      slice_id TEXT PRIMARY KEY,
      controller_agent_id TEXT NOT NULL,
      controller_session_key TEXT NOT NULL,
      repository_root TEXT NOT NULL,
      scope_manifest_json TEXT NOT NULL,
      scope_digest TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS slice_baselines (
      baseline_id TEXT PRIMARY KEY,
      slice_id TEXT NOT NULL UNIQUE REFERENCES slices(slice_id),
      candidate_id TEXT NOT NULL REFERENCES candidates(candidate_id),
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS candidates (
      candidate_id TEXT PRIMARY KEY,
      slice_id TEXT NOT NULL REFERENCES slices(slice_id),
      ordinal INTEGER NOT NULL,
      candidate_digest TEXT NOT NULL,
      fingerprint_json TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(slice_id, ordinal)
    );
    CREATE TABLE IF NOT EXISTS candidate_snapshots (
      candidate_id TEXT PRIMARY KEY REFERENCES candidates(candidate_id),
      snapshot_digest TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS waves (
      wave_id TEXT PRIMARY KEY,
      slice_id TEXT NOT NULL REFERENCES slices(slice_id),
      candidate_id TEXT NOT NULL REFERENCES candidates(candidate_id),
      kind TEXT NOT NULL,
      required_roles_json TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      frozen_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assignments (
      assignment_id TEXT PRIMARY KEY,
      slice_id TEXT NOT NULL REFERENCES slices(slice_id),
      candidate_id TEXT REFERENCES candidates(candidate_id),
      wave_id TEXT REFERENCES waves(wave_id),
      controller_agent_id TEXT NOT NULL,
      controller_session_key TEXT NOT NULL,
      worker_agent_id TEXT NOT NULL,
      role TEXT NOT NULL,
      required_thinking TEXT NOT NULL,
      required_model TEXT NOT NULL,
      workspace_access TEXT NOT NULL,
      scope_units_json TEXT NOT NULL,
      route_family_id TEXT NOT NULL,
      purpose TEXT NOT NULL,
      remediation_revision_id TEXT REFERENCES remediation_revisions(revision_id),
      recovery_of_assignment_id TEXT REFERENCES assignments(assignment_id),
      epoch INTEGER NOT NULL,
      issued_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assignment_tokens (
      token_hash TEXT PRIMARY KEY,
      assignment_id TEXT NOT NULL REFERENCES assignments(assignment_id),
      route_kind TEXT NOT NULL,
      target_session_key TEXT,
      epoch INTEGER NOT NULL,
      issued_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS token_uses (
      token_hash TEXT PRIMARY KEY REFERENCES assignment_tokens(token_hash),
      assignment_id TEXT NOT NULL REFERENCES assignments(assignment_id),
      route_kind TEXT NOT NULL,
      caller_agent_id TEXT NOT NULL,
      caller_session_key TEXT NOT NULL,
      target_agent_id TEXT NOT NULL,
      target_session_key TEXT,
      used_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS gateway_dispatch_capabilities (
      capability_hash TEXT PRIMARY KEY,
      assignment_id TEXT NOT NULL REFERENCES assignments(assignment_id),
      route_token_hash TEXT NOT NULL REFERENCES token_uses(token_hash),
      controller_session_key TEXT NOT NULL,
      target_session_key TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      issued_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS gateway_dispatch_uses (
      capability_hash TEXT PRIMARY KEY REFERENCES gateway_dispatch_capabilities(capability_hash),
      assignment_id TEXT NOT NULL REFERENCES assignments(assignment_id),
      controller_session_key TEXT NOT NULL,
      target_session_key TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      used_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS gateway_dispatch_outcomes (
      capability_hash TEXT PRIMARY KEY REFERENCES gateway_dispatch_capabilities(capability_hash),
      assignment_id TEXT NOT NULL REFERENCES assignments(assignment_id),
      decision TEXT NOT NULL CHECK(decision IN ('accepted', 'rejected')),
      response_json TEXT NOT NULL,
      decided_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS gateway_dispatch_runs (
      capability_hash TEXT PRIMARY KEY REFERENCES gateway_dispatch_capabilities(capability_hash),
      assignment_id TEXT NOT NULL REFERENCES assignments(assignment_id),
      run_id TEXT NOT NULL,
      target_session_key TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      writer_id TEXT NOT NULL,
      registered_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assignment_bindings (
      binding_id TEXT PRIMARY KEY,
      assignment_id TEXT NOT NULL REFERENCES assignments(assignment_id),
      child_session_key TEXT NOT NULL,
      run_id TEXT,
      bound_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS initial_spawn_cleanup_receipts (
      assignment_id TEXT PRIMARY KEY REFERENCES assignments(assignment_id),
      child_session_key TEXT NOT NULL,
      run_id TEXT NOT NULL,
      cleaned_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS route_events (
      event_id TEXT PRIMARY KEY,
      assignment_id TEXT NOT NULL REFERENCES assignments(assignment_id),
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS receipts (
      receipt_id TEXT PRIMARY KEY,
      assignment_id TEXT NOT NULL REFERENCES assignments(assignment_id),
      semantic_digest TEXT NOT NULL,
      report_json TEXT NOT NULL,
      correction_of TEXT REFERENCES receipts(receipt_id),
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS validations (
      validation_id TEXT PRIMARY KEY,
      receipt_id TEXT NOT NULL REFERENCES receipts(receipt_id),
      outcome TEXT NOT NULL,
      validator_id TEXT NOT NULL,
      validator_version TEXT NOT NULL,
      validator_digest TEXT NOT NULL,
      issues_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS terminal_results (
      terminal_result_id TEXT PRIMARY KEY,
      assignment_id TEXT NOT NULL UNIQUE REFERENCES assignments(assignment_id),
      run_id TEXT NOT NULL,
      result_receipt_id TEXT NOT NULL,
      result_receipt_sha256 TEXT NOT NULL,
      result_receipt_bytes INTEGER NOT NULL,
      result_receipt_captured_at INTEGER NOT NULL,
      result_receipt_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS terminal_receipts (
      terminal_receipt_id TEXT PRIMARY KEY,
      assignment_id TEXT NOT NULL UNIQUE REFERENCES assignments(assignment_id),
      run_id TEXT NOT NULL,
      accepted_receipt_id TEXT NOT NULL REFERENCES receipts(receipt_id),
      accepted_semantic_digest TEXT NOT NULL,
      accepted_report_json TEXT NOT NULL,
      result_receipt_id TEXT NOT NULL,
      result_receipt_sha256 TEXT NOT NULL,
      result_receipt_bytes INTEGER NOT NULL,
      result_receipt_captured_at INTEGER NOT NULL,
      result_receipt_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS remediation_revisions (
      revision_id TEXT PRIMARY KEY,
      slice_id TEXT NOT NULL REFERENCES slices(slice_id),
      source_wave_id TEXT NOT NULL REFERENCES waves(wave_id),
      ordinal INTEGER NOT NULL,
      findings_digest TEXT NOT NULL,
      findings_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(slice_id, ordinal)
    );
    CREATE TABLE IF NOT EXISTS correction_uses (
      correction_id TEXT PRIMARY KEY,
      assignment_id TEXT NOT NULL UNIQUE REFERENCES assignments(assignment_id),
      original_receipt_id TEXT NOT NULL REFERENCES receipts(receipt_id),
      corrected_receipt_id TEXT NOT NULL REFERENCES receipts(receipt_id),
      semantic_digest TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_delegation_candidates_slice ON candidates(slice_id);
    CREATE INDEX IF NOT EXISTS idx_delegation_waves_candidate ON waves(candidate_id);
    CREATE INDEX IF NOT EXISTS idx_delegation_assignments_wave ON assignments(wave_id);
    CREATE INDEX IF NOT EXISTS idx_delegation_bindings_session
      ON assignment_bindings(child_session_key, bound_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_delegation_binding_identity
      ON assignment_bindings(assignment_id, child_session_key, COALESCE(run_id, ''));
    CREATE INDEX IF NOT EXISTS idx_delegation_receipts_assignment ON receipts(assignment_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_delegation_initial_receipt
      ON receipts(assignment_id) WHERE correction_of IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_delegation_validation_receipt
      ON validations(receipt_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_delegation_gateway_dispatch_route_token
      ON gateway_dispatch_capabilities(route_token_hash);
  `);
  installAppendOnlyTriggers(db, [
    "epoch_events",
    "audit_events",
    "slices",
    "candidates",
    "candidate_snapshots",
    "slice_baselines",
    "waves",
    "assignments",
    "assignment_tokens",
    "token_uses",
    "gateway_dispatch_capabilities",
    "gateway_dispatch_uses",
    "gateway_dispatch_outcomes",
    "gateway_dispatch_runs",
    "assignment_bindings",
    "initial_spawn_cleanup_receipts",
    "route_events",
    "receipts",
    "validations",
    "terminal_results",
    "terminal_receipts",
    "remediation_revisions",
    "correction_uses",
  ]);
}

export function validateDelegationReportCoverage(report: DelegationWorkerReport) {
  const assigned = new Set(report.scope.assigned);
  if (assigned.size !== report.scope.assigned.length) {
    throw new Error("Delegation report assigned scope contains duplicates.");
  }
  const covered = new Set<string>();
  for (const pathEntry of [
    ...report.scope.inspected.map((entry) => ({ scopeId: entry.scopeId, kind: "inspected" })),
    ...report.scope.omitted.map((entry) => ({ scopeId: entry.scopeId, kind: "omitted" })),
    ...report.scope.failed.map((entry) => ({ scopeId: entry.scopeId, kind: "failed" })),
  ]) {
    if (!assigned.has(pathEntry.scopeId)) {
      throw new Error(
        `Delegation report ${pathEntry.kind} entry is outside assigned scope: ${pathEntry.scopeId}`,
      );
    }
    if (covered.has(pathEntry.scopeId)) {
      throw new Error(
        `Delegation report scope unit has multiple dispositions: ${pathEntry.scopeId}`,
      );
    }
    covered.add(pathEntry.scopeId);
  }
  if (covered.size !== assigned.size) {
    throw new Error("Every assigned delegation scope unit must be inspected, omitted, or failed.");
  }
  const commandsByEvidenceId = new Map<string, DelegationWorkerReport["commands"][number]>();
  for (const command of report.commands) {
    if (commandsByEvidenceId.has(command.evidenceId)) {
      throw new Error(`Delegation report evidence ID is duplicated: ${command.evidenceId}`);
    }
    commandsByEvidenceId.set(command.evidenceId, command);
  }
  const artifactsByEvidenceId = new Map<string, DelegationWorkerReport["artifacts"][number]>();
  for (const artifact of report.artifacts) {
    if (
      commandsByEvidenceId.has(artifact.evidenceId) ||
      artifactsByEvidenceId.has(artifact.evidenceId)
    ) {
      throw new Error(`Delegation report evidence ID is duplicated: ${artifact.evidenceId}`);
    }
    artifactsByEvidenceId.set(artifact.evidenceId, artifact);
  }
  for (const inspected of report.scope.inspected) {
    if (inspected.evidenceIds.length === 0) {
      throw new Error(
        `Inspected delegation scope requires successful command evidence: ${inspected.scopeId}`,
      );
    }
    const distinctEvidenceIds = new Set(inspected.evidenceIds);
    if (distinctEvidenceIds.size !== inspected.evidenceIds.length) {
      throw new Error(
        `Inspected delegation scope contains duplicate evidence IDs: ${inspected.scopeId}`,
      );
    }
    for (const evidenceId of inspected.evidenceIds) {
      const command = commandsByEvidenceId.get(evidenceId);
      const artifact = artifactsByEvidenceId.get(evidenceId);
      const commandIsBound =
        command?.exitCode === 0 &&
        !command.truncated &&
        command.scopeIds.includes(inspected.scopeId);
      const artifactIsBound = artifact?.path === inspected.path;
      if (!commandIsBound && !artifactIsBound) {
        throw new Error(
          `Inspected delegation scope requires successful, nontruncated evidence bound to that scope: ${inspected.scopeId}`,
        );
      }
    }
  }
  // Failed or truncated attempts remain accountable evidence and must not force
  // workers to omit them. Complete coverage is determined by each inspected
  // scope unit having separate successful, nontruncated bound evidence above.
  const evidenceComplete =
    report.scope.omitted.length === 0 &&
    report.scope.failed.length === 0 &&
    report.scope.inspected.length === assigned.size;
  if (report.coverage === "complete" && !evidenceComplete) {
    throw new Error(
      "Complete delegation coverage requires full successful, nontruncated evidence.",
    );
  }
  if (report.status === "completed" && report.coverage !== "complete") {
    throw new Error("A completed delegation report requires complete coverage.");
  }
  if (report.status === "blocked" && report.coverage !== "blocked") {
    throw new Error("A blocked delegation report must declare blocked coverage.");
  }
}

function normalizeReportEvidenceSemantics(report: DelegationWorkerReport) {
  const evidenceDescriptors = new Map<string, string[]>();
  const registerEvidence = (evidenceId: string, descriptor: string) => {
    const existing = evidenceDescriptors.get(evidenceId) ?? [];
    existing.push(descriptor);
    evidenceDescriptors.set(evidenceId, existing);
  };
  const commandDescriptors = report.commands.map(({ evidenceId, ...command }) => {
    const descriptor = `command:${hashDelegationIdentity(
      "delegation-report-command-evidence-v1",
      command,
    )}`;
    registerEvidence(evidenceId, descriptor);
    return descriptor;
  });
  const artifactDescriptors = report.artifacts.map(({ evidenceId, ...artifact }) => {
    const descriptor = `artifact:${hashDelegationIdentity(
      "delegation-report-artifact-evidence-v1",
      artifact,
    )}`;
    registerEvidence(evidenceId, descriptor);
    return descriptor;
  });
  const resolveEvidenceIds = (evidenceIds: string[]): string[] =>
    [
      ...new Set(
        evidenceIds.flatMap(
          (evidenceId) => evidenceDescriptors.get(evidenceId) ?? [`unresolved:${evidenceId}`],
        ),
      ),
    ].toSorted();

  return {
    ...report,
    scope: {
      ...report.scope,
      inspected: report.scope.inspected.map((entry) => ({
        ...entry,
        evidenceIds: resolveEvidenceIds(entry.evidenceIds),
      })),
      failed: report.scope.failed.map(({ evidenceId, ...entry }) => ({
        ...entry,
        evidenceIds: evidenceId ? resolveEvidenceIds([evidenceId]) : [],
      })),
      newlyDiscovered: report.scope.newlyDiscovered.map((entry) => ({
        ...entry,
        evidenceIds: resolveEvidenceIds(entry.evidenceIds),
      })),
    },
    commands: [...new Set(commandDescriptors)].toSorted(),
    artifacts: [...new Set(artifactDescriptors)].toSorted(),
    findings: report.findings.map((finding) => ({
      ...finding,
      evidenceIds: resolveEvidenceIds(finding.evidenceIds),
    })),
  };
}

export function hashDelegationReportSemantics(report: DelegationWorkerReport): string {
  return hashDelegationIdentity(
    "delegation-report-semantic-v2",
    normalizeReportEvidenceSemantics(report),
  );
}

function verifyRepositorySnapshot(snapshot: DelegationRepositorySnapshot): void {
  const { snapshotDigest, ...facts } = snapshot;
  const expected = hashDelegationIdentity("delegation-repository-snapshot-v1", facts);
  if (snapshot.version !== "openclaw-repository-snapshot-v1" || snapshotDigest !== expected) {
    throw new Error("Protected delegation repository snapshot has an invalid digest.");
  }
}

function changedRepositorySnapshotPaths(
  baseline: DelegationRepositorySnapshot,
  current: DelegationRepositorySnapshot,
): string[] {
  if (
    baseline.repositoryRoot !== current.repositoryRoot ||
    baseline.worktreeIdentity !== current.worktreeIdentity
  ) {
    return ["<worktree-identity>"];
  }
  const changed = new Set<string>();
  if (baseline.head !== current.head) {
    changed.add("<HEAD>");
  }
  const before = new Map(
    baseline.entries.map((entry) => [entry.path, canonicalDelegationJson(entry)]),
  );
  const after = new Map(
    current.entries.map((entry) => [entry.path, canonicalDelegationJson(entry)]),
  );
  for (const candidate of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(candidate) !== after.get(candidate)) {
      changed.add(candidate);
    }
  }
  return [...changed].toSorted();
}

export class DelegationLedger {
  private transactionDepth = 0;

  constructor(
    private readonly db: DatabaseSync,
    readonly path: string,
    private readonly guard: DelegationGuardConfig,
    private readonly policyDigest: string,
    private readonly reconcileGatewayTask: (params: {
      runId: string;
      targetSessionKey: string;
      requiredTask: boolean;
    }) => DelegationGatewayTaskReconciliationOutcome,
    private readonly reconcileTerminalGatewayTask?: (params: {
      runId: string;
      targetSessionKey: string;
      terminalKind: DelegationGatewayTerminalKind;
    }) => void,
    private readonly reconcileInitialSpawnTask?: (params: {
      runId: string;
      targetSessionKey: string;
    }) => DelegationGatewayTaskReconciliationOutcome,
    private readonly writerId = randomUUID(),
  ) {}

  private transaction<T>(write: () => T): T {
    if (this.transactionDepth > 0) {
      return write();
    }
    // Permission repair must fail before the transaction starts. Throwing after
    // COMMIT makes callers believe an authoritative write rolled back and can
    // cause them to execute an incompatible recovery transition.
    ensurePermissions(this.path);
    this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth += 1;
    try {
      const result = write();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  private latestEpochRow(): EpochRow | undefined {
    return this.db.prepare(`SELECT * FROM epoch_events ORDER BY epoch DESC LIMIT 1`).get() as
      | EpochRow
      | undefined;
  }

  currentEpoch(): number {
    const row = this.latestEpochRow();
    if (!row) {
      throw new Error("Delegation ledger has no active epoch.");
    }
    return toNumber(row.epoch);
  }

  assertActiveStack() {
    const row = this.latestEpochRow();
    if (
      !row ||
      row.contract_version !== DELEGATION_CONTRACT_VERSION ||
      row.validator_id !== this.guard.validator.id ||
      row.validator_version !== this.guard.validator.version ||
      row.validator_digest !== this.guard.validator.sha256 ||
      row.policy_digest !== this.policyDigest
    ) {
      throw new Error(
        "Configured delegation policy or validator does not match the active protected epoch.",
      );
    }
  }

  private assertAssignmentOpen(assignmentId: string): void {
    const terminal = this.db
      .prepare(
        `SELECT 1 FROM route_events
         WHERE assignment_id = ?
           AND kind IN ('route_rejected', 'validation_rejected', 'timeout', 'completed')
         LIMIT 1`,
      )
      .get(assignmentId);
    const receipt = this.db
      .prepare(`SELECT 1 FROM receipts WHERE assignment_id = ? LIMIT 1`)
      .get(assignmentId);
    if (terminal || receipt) {
      throw new Error("Delegation assignment is already terminal or has submitted its report.");
    }
  }

  private assertNoPriorGatewayDispatch(assignmentId: string): void {
    const prior = this.db
      .prepare(
        `SELECT 1 FROM gateway_dispatch_capabilities
         WHERE assignment_id = ? LIMIT 1`,
      )
      .get(assignmentId);
    if (prior) {
      throw new Error(
        "Delegation assignment already has a Gateway dispatch; overlapping or repeated sends are forbidden.",
      );
    }
  }

  private assertNoOpenAssignmentsForEpoch(epoch: number): void {
    const open = this.db
      .prepare(
        `SELECT a.assignment_id
         FROM assignments a
         WHERE a.epoch = ?
           AND NOT EXISTS (
             SELECT 1 FROM route_events e
             WHERE e.assignment_id = a.assignment_id
               AND e.kind IN ('route_rejected', 'validation_rejected', 'timeout', 'completed')
           )
         LIMIT 1`,
      )
      .get(epoch) as { assignment_id: string } | undefined;
    if (open) {
      throw new Error(
        `Delegation epoch transition requires every active assignment to settle first: ${open.assignment_id}`,
      );
    }
  }

  assertConfiguredStack(params: { guard: DelegationGuardConfig; policyDigest: string }): void {
    if (
      params.policyDigest !== this.policyDigest ||
      params.guard.validator.id !== this.guard.validator.id ||
      params.guard.validator.version !== this.guard.validator.version ||
      params.guard.validator.sha256 !== this.guard.validator.sha256
    ) {
      throw new Error(
        "A delegation ledger writer is already open with a different policy or validator stack.",
      );
    }
    this.assertActiveStack();
  }

  appendAuditEvent(params: { kind: string; payload: unknown; createdAt?: number }): string {
    this.assertActiveStack();
    const payloadJson = canonicalDelegationJson(params.payload);
    if (!params.kind.trim() || Buffer.byteLength(payloadJson, "utf8") > 16 * 1024) {
      throw new Error("Delegation audit event must have a kind and a bounded payload.");
    }
    const createdAt = params.createdAt ?? Date.now();
    const eventId = createDelegationRecordId("audit-event", {
      epoch: this.currentEpoch(),
      kind: params.kind,
      payload: params.payload,
      createdAt,
      nonce: randomUUID(),
    });
    this.db
      .prepare(
        `INSERT INTO audit_events (event_id, epoch, kind, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(eventId, this.currentEpoch(), params.kind, payloadJson, createdAt);
    return eventId;
  }

  createSlice(params: {
    controllerAgentId: string;
    controllerSessionKey: string;
    repositoryRoot: string;
    scope: CanonicalDelegationScope;
    createdAt?: number;
  }): string {
    this.assertActiveStack();
    const createdAt = params.createdAt ?? Date.now();
    const core = {
      controllerAgentId: params.controllerAgentId,
      controllerSessionKey: params.controllerSessionKey,
      repositoryRoot: params.repositoryRoot,
      scopeDigest: params.scope.scopeDigest,
      epoch: this.currentEpoch(),
      createdAt,
      nonce: randomUUID(),
    };
    const sliceId = createDelegationRecordId("slice", core);
    this.db
      .prepare(
        `INSERT INTO slices
         (slice_id, controller_agent_id, controller_session_key, repository_root,
          scope_manifest_json, scope_digest, epoch, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sliceId,
        params.controllerAgentId,
        params.controllerSessionKey,
        params.repositoryRoot,
        params.scope.canonicalJson,
        params.scope.scopeDigest,
        core.epoch,
        createdAt,
      );
    return sliceId;
  }

  createSliceWithBaseline(params: {
    controllerAgentId: string;
    controllerSessionKey: string;
    repositoryRoot: string;
    scope: CanonicalDelegationScope;
    fingerprint: DelegationFingerprint;
    repositorySnapshot?: DelegationRepositorySnapshot;
    createdAt?: number;
  }): { sliceId: string; candidateId: string; baselineId: string } {
    this.assertActiveStack();
    if (
      params.fingerprint.epoch !== this.currentEpoch() ||
      params.fingerprint.scopeDigest !== params.scope.scopeDigest ||
      params.fingerprint.policyDigest !== this.policyDigest ||
      params.fingerprint.validatorId !== this.guard.validator.id ||
      params.fingerprint.validatorVersion !== this.guard.validator.version ||
      params.fingerprint.validatorDigest !== this.guard.validator.sha256
    ) {
      throw new Error("Delegation baseline fingerprint does not match the active protected stack.");
    }
    if (params.repositorySnapshot) {
      verifyRepositorySnapshot(params.repositorySnapshot);
      if (
        params.repositorySnapshot.repositoryRoot !== params.repositoryRoot ||
        params.repositorySnapshot.worktreeIdentity !== params.fingerprint.worktreeIdentity ||
        params.repositorySnapshot.head !== params.fingerprint.head
      ) {
        throw new Error("Delegation baseline inventory does not match its protected fingerprint.");
      }
    }
    const createdAt = params.createdAt ?? Date.now();
    const sliceId = createDelegationRecordId("slice", {
      controllerAgentId: params.controllerAgentId,
      controllerSessionKey: params.controllerSessionKey,
      repositoryRoot: params.repositoryRoot,
      scopeDigest: params.scope.scopeDigest,
      epoch: this.currentEpoch(),
      createdAt,
      nonce: randomUUID(),
    });
    const candidateId = createDelegationRecordId("candidate-record", {
      sliceId,
      candidateDigest: params.fingerprint.candidateDigest,
      epoch: params.fingerprint.epoch,
      ordinal: 1,
    });
    const baselineId = createDelegationRecordId("slice-baseline", {
      sliceId,
      candidateId,
      createdAt,
    });
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO slices
           (slice_id, controller_agent_id, controller_session_key, repository_root,
            scope_manifest_json, scope_digest, epoch, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sliceId,
          params.controllerAgentId,
          params.controllerSessionKey,
          params.repositoryRoot,
          params.scope.canonicalJson,
          params.scope.scopeDigest,
          this.currentEpoch(),
          createdAt,
        );
      this.db
        .prepare(
          `INSERT INTO candidates
           (candidate_id, slice_id, ordinal, candidate_digest, fingerprint_json, epoch, created_at)
           VALUES (?, ?, 1, ?, ?, ?, ?)`,
        )
        .run(
          candidateId,
          sliceId,
          params.fingerprint.candidateDigest,
          canonicalDelegationJson(params.fingerprint),
          params.fingerprint.epoch,
          createdAt,
        );
      if (params.repositorySnapshot) {
        this.insertCandidateSnapshot(candidateId, params.repositorySnapshot, createdAt);
      }
      this.db
        .prepare(
          `INSERT INTO slice_baselines (baseline_id, slice_id, candidate_id, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(baselineId, sliceId, candidateId, createdAt);
    });
    return { sliceId, candidateId, baselineId };
  }

  recordCandidate(params: {
    sliceId: string;
    fingerprint: DelegationFingerprint;
    repositorySnapshot?: DelegationRepositorySnapshot;
    createdAt?: number;
  }): string {
    this.assertActiveStack();
    return this.transaction(() => this.recordCandidateWithinTransaction(params));
  }

  private recordCandidateWithinTransaction(params: {
    sliceId: string;
    fingerprint: DelegationFingerprint;
    repositorySnapshot?: DelegationRepositorySnapshot;
    createdAt?: number;
  }): string {
    const slice = this.db
      .prepare(`SELECT repository_root, scope_digest, epoch FROM slices WHERE slice_id = ?`)
      .get(params.sliceId) as
      | { repository_root: string; scope_digest: string; epoch: number | bigint }
      | undefined;
    if (!slice) {
      throw new Error(`Unknown delegation slice: ${params.sliceId}`);
    }
    if (
      slice.scope_digest !== params.fingerprint.scopeDigest ||
      toNumber(slice.epoch) !== this.currentEpoch() ||
      params.fingerprint.epoch !== this.currentEpoch()
    ) {
      throw new Error("Candidate fingerprint is stale or belongs to a different slice scope.");
    }
    if (params.repositorySnapshot) {
      verifyRepositorySnapshot(params.repositorySnapshot);
      if (
        params.repositorySnapshot.repositoryRoot !== slice.repository_root ||
        params.repositorySnapshot.worktreeIdentity !== params.fingerprint.worktreeIdentity ||
        params.repositorySnapshot.head !== params.fingerprint.head
      ) {
        throw new Error("Candidate inventory does not match its protected fingerprint.");
      }
    }
    const fingerprintJson = canonicalDelegationJson(params.fingerprint);
    const latest = this.db
      .prepare(
        `SELECT candidate_id, candidate_digest, fingerprint_json, ordinal
         FROM candidates WHERE slice_id = ?
         ORDER BY ordinal DESC LIMIT 1`,
      )
      .get(params.sliceId) as
      | {
          candidate_id: string;
          candidate_digest: string;
          fingerprint_json: string;
          ordinal: number | bigint;
        }
      | undefined;
    if (
      latest?.candidate_digest === params.fingerprint.candidateDigest &&
      latest.fingerprint_json === fingerprintJson
    ) {
      if (params.repositorySnapshot) {
        this.insertCandidateSnapshot(
          latest.candidate_id,
          params.repositorySnapshot,
          params.createdAt ?? Date.now(),
        );
      }
      return latest.candidate_id;
    }
    const ordinal = latest ? toNumber(latest.ordinal) + 1 : 1;
    const candidateRecordId = createDelegationRecordId("candidate-record", {
      sliceId: params.sliceId,
      candidateDigest: params.fingerprint.candidateDigest,
      epoch: params.fingerprint.epoch,
      ordinal,
    });
    this.db
      .prepare(
        `INSERT INTO candidates
         (candidate_id, slice_id, ordinal, candidate_digest, fingerprint_json, epoch, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        candidateRecordId,
        params.sliceId,
        ordinal,
        params.fingerprint.candidateDigest,
        fingerprintJson,
        params.fingerprint.epoch,
        params.createdAt ?? Date.now(),
      );
    if (params.repositorySnapshot) {
      this.insertCandidateSnapshot(
        candidateRecordId,
        params.repositorySnapshot,
        params.createdAt ?? Date.now(),
      );
    }
    return candidateRecordId;
  }

  private insertCandidateSnapshot(
    candidateId: string,
    snapshot: DelegationRepositorySnapshot,
    createdAt: number,
  ): void {
    const snapshotJson = canonicalDelegationJson(snapshot);
    const existing = this.db
      .prepare(
        `SELECT snapshot_digest, snapshot_json FROM candidate_snapshots WHERE candidate_id = ?`,
      )
      .get(candidateId) as { snapshot_digest: string; snapshot_json: string } | undefined;
    if (existing) {
      if (
        existing.snapshot_digest !== snapshot.snapshotDigest ||
        existing.snapshot_json !== snapshotJson
      ) {
        throw new Error("Candidate already has a conflicting protected repository inventory.");
      }
      return;
    }
    this.db
      .prepare(
        `INSERT INTO candidate_snapshots
         (candidate_id, snapshot_digest, snapshot_json, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(candidateId, snapshot.snapshotDigest, snapshotJson, createdAt);
  }

  assertNoOutOfScopeChanges(params: {
    sliceId: string;
    currentSnapshot: DelegationRepositorySnapshot;
    baseCandidateId?: string;
  }): void {
    this.assertActiveStack();
    verifyRepositorySnapshot(params.currentSnapshot);
    const slice = this.getSliceScope(params.sliceId);
    if (!slice || slice.epoch !== this.currentEpoch()) {
      throw new Error("Cannot compare repository scope for a missing or stale delegation slice.");
    }
    if (params.currentSnapshot.repositoryRoot !== slice.repositoryRoot) {
      throw new Error(
        "Current repository inventory does not belong to the protected slice worktree.",
      );
    }
    const baseCandidateId =
      params.baseCandidateId ?? this.latestCandidateRecordForSlice(params.sliceId)?.candidateId;
    if (!baseCandidateId) {
      throw new Error("Delegation scope comparison requires a protected base candidate.");
    }
    const baseRow = this.db
      .prepare(
        `SELECT c.slice_id, s.snapshot_json
         FROM candidates c
         JOIN candidate_snapshots s ON s.candidate_id = c.candidate_id
         WHERE c.candidate_id = ?`,
      )
      .get(baseCandidateId) as { slice_id: string; snapshot_json: string } | undefined;
    if (!baseRow || baseRow.slice_id !== params.sliceId) {
      throw new Error("Delegation base candidate has no protected repository inventory.");
    }
    const baseline = JSON.parse(baseRow.snapshot_json) as DelegationRepositorySnapshot;
    verifyRepositorySnapshot(baseline);
    const changedPaths = changedRepositorySnapshotPaths(baseline, params.currentSnapshot);
    if (slice.scope.manifest.kind === "repository") {
      return;
    }
    const allowed = new Set(slice.scope.paths);
    const outOfScope = changedPaths.filter((candidate) => !allowed.has(candidate));
    if (outOfScope.length > 0) {
      const examples = outOfScope.slice(0, 20);
      throw new Error(
        `Delegation work changed ${outOfScope.length} path(s) outside the protected scope: ${examples.join(", ")}${outOfScope.length > examples.length ? ", …" : ""}`,
      );
    }
  }

  recordSliceBaseline(params: {
    sliceId: string;
    candidateId: string;
    createdAt?: number;
  }): string {
    const candidate = this.db
      .prepare(`SELECT slice_id, epoch FROM candidates WHERE candidate_id = ?`)
      .get(params.candidateId) as { slice_id: string; epoch: number | bigint } | undefined;
    if (
      !candidate ||
      candidate.slice_id !== params.sliceId ||
      toNumber(candidate.epoch) !== this.currentEpoch()
    ) {
      throw new Error("Slice baseline must reference a current candidate from the same slice.");
    }
    const createdAt = params.createdAt ?? Date.now();
    const baselineId = createDelegationRecordId("slice-baseline", {
      sliceId: params.sliceId,
      candidateId: params.candidateId,
      createdAt,
    });
    this.db
      .prepare(
        `INSERT INTO slice_baselines (baseline_id, slice_id, candidate_id, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(baselineId, params.sliceId, params.candidateId, createdAt);
    return baselineId;
  }

  getSliceScope(sliceId: string):
    | {
        controllerAgentId: string;
        controllerSessionKey: string;
        repositoryRoot: string;
        scope: CanonicalDelegationScope;
        epoch: number;
      }
    | undefined {
    const row = this.db
      .prepare(
        `SELECT controller_agent_id, controller_session_key, repository_root,
                scope_manifest_json, scope_digest, epoch
         FROM slices WHERE slice_id = ?`,
      )
      .get(sliceId) as
      | {
          controller_agent_id: string;
          controller_session_key: string;
          repository_root: string;
          scope_manifest_json: string;
          scope_digest: string;
          epoch: number | bigint;
        }
      | undefined;
    if (!row) {
      return undefined;
    }
    const manifest = JSON.parse(row.scope_manifest_json) as CanonicalDelegationScope["manifest"];
    return {
      controllerAgentId: row.controller_agent_id,
      controllerSessionKey: row.controller_session_key,
      repositoryRoot: row.repository_root,
      scope: {
        manifest,
        canonicalJson: row.scope_manifest_json,
        scopeDigest: row.scope_digest,
        paths: manifest.kind === "slice" ? manifest.entries.map((entry) => entry.path) : [],
      },
      epoch: toNumber(row.epoch),
    };
  }

  latestCandidateForSlice(sliceId: string): DelegationFingerprint | undefined {
    const row = this.db
      .prepare(
        `SELECT fingerprint_json FROM candidates
         WHERE slice_id = ? ORDER BY ordinal DESC LIMIT 1`,
      )
      .get(sliceId) as { fingerprint_json: string } | undefined;
    return row ? (JSON.parse(row.fingerprint_json) as DelegationFingerprint) : undefined;
  }

  latestCandidateRecordForSlice(
    sliceId: string,
  ): { candidateId: string; fingerprint: DelegationFingerprint } | undefined {
    const row = this.db
      .prepare(
        `SELECT candidate_id, fingerprint_json FROM candidates
         WHERE slice_id = ? ORDER BY ordinal DESC LIMIT 1`,
      )
      .get(sliceId) as { candidate_id: string; fingerprint_json: string } | undefined;
    return row
      ? {
          candidateId: row.candidate_id,
          fingerprint: JSON.parse(row.fingerprint_json) as DelegationFingerprint,
        }
      : undefined;
  }

  getCandidateRecord(
    candidateId: string,
  ): { sliceId: string; fingerprint: DelegationFingerprint; epoch: number } | undefined {
    const row = this.db
      .prepare(`SELECT slice_id, fingerprint_json, epoch FROM candidates WHERE candidate_id = ?`)
      .get(candidateId) as
      | { slice_id: string; fingerprint_json: string; epoch: number | bigint }
      | undefined;
    return row
      ? {
          sliceId: row.slice_id,
          fingerprint: JSON.parse(row.fingerprint_json) as DelegationFingerprint,
          epoch: toNumber(row.epoch),
        }
      : undefined;
  }

  private hasProgressableTerminalPurpose(
    sliceId: string,
    purpose: DelegationAssignmentPurpose,
    options: { requireCompletedStatus?: boolean; requireNoBlockers?: boolean } = {},
  ): boolean {
    const rows = this.db
      .prepare(
        `SELECT t.accepted_report_json
         FROM assignments a
         JOIN terminal_receipts t ON t.assignment_id = a.assignment_id
         WHERE a.slice_id = ? AND a.purpose = ?`,
      )
      .all(sliceId, purpose) as Array<{ accepted_report_json: string }>;
    return rows.some((row) => isProgressableTerminalReport(row.accepted_report_json, options));
  }

  private hasProgressableTerminalWaveRole(
    waveId: string,
    purpose: DelegationAssignmentPurpose,
    role: DelegationAssignmentRecord["role"],
  ): boolean {
    const rows = this.db
      .prepare(
        `SELECT t.accepted_report_json
         FROM assignments a
         JOIN terminal_receipts t ON t.assignment_id = a.assignment_id
         WHERE a.wave_id = ? AND a.purpose = ? AND a.role = ?`,
      )
      .all(waveId, purpose, role) as Array<{ accepted_report_json: string }>;
    return rows.some((row) => isProgressableTerminalReport(row.accepted_report_json));
  }

  freezeWave(params: {
    sliceId: string;
    candidateId: string;
    requiredRoles: DelegationAssignmentRecord["role"][];
    frozenAt?: number;
  }): string {
    this.assertActiveStack();
    const roles = [...new Set(params.requiredRoles)].toSorted();
    if (roles.length === 0 || roles.length !== params.requiredRoles.length) {
      throw new Error("A delegation wave requires a non-empty unique role set.");
    }
    const candidate = this.db
      .prepare(`SELECT slice_id, epoch FROM candidates WHERE candidate_id = ?`)
      .get(params.candidateId) as { slice_id: string; epoch: number | bigint } | undefined;
    if (
      !candidate ||
      candidate.slice_id !== params.sliceId ||
      toNumber(candidate.epoch) !== this.currentEpoch()
    ) {
      throw new Error("Delegation wave candidate is missing, stale, or belongs to another slice.");
    }
    const latestCandidate = this.latestCandidateRecordForSlice(params.sliceId);
    if (latestCandidate?.candidateId !== params.candidateId) {
      throw new Error("A delegation wave must freeze the latest protected candidate record.");
    }
    const existingWaveCount = this.db
      .prepare(`SELECT COUNT(*) AS count FROM waves WHERE slice_id = ?`)
      .get(params.sliceId) as CountRow;
    const kind = toNumber(existingWaveCount.count) === 0 ? "verification" : "confirmation";
    if (kind === "verification") {
      const required = ["reviewer", "tester"];
      if (canonicalDelegationJson(roles) !== canonicalDelegationJson(required)) {
        throw new Error(
          "The first verification wave requires concurrent tester and reviewer lanes.",
        );
      }
      const implementationComplete = this.hasProgressableTerminalPurpose(
        params.sliceId,
        "implementation",
        { requireCompletedStatus: true, requireNoBlockers: true },
      );
      if (!implementationComplete) {
        throw new Error("A verification wave requires a completed initial implementation.");
      }
    } else {
      if (roles.some((role) => !["tester", "reviewer", "qa"].includes(role))) {
        throw new Error("A confirmation wave may contain only tester, reviewer, and QA lanes.");
      }
      const reusedCandidate = this.db
        .prepare(`SELECT 1 FROM waves WHERE slice_id = ? AND candidate_id = ? LIMIT 1`)
        .get(params.sliceId, params.candidateId);
      if (reusedCandidate) {
        throw new Error("A confirmation wave requires a new post-remediation candidate record.");
      }
      const remediationComplete = this.hasProgressableTerminalPurpose(
        params.sliceId,
        "remediation",
        { requireCompletedStatus: true, requireNoBlockers: true },
      );
      if (!remediationComplete) {
        throw new Error("A confirmation wave requires a completed consolidated remediation.");
      }
    }
    const frozenAt = params.frozenAt ?? Date.now();
    const facts = {
      sliceId: params.sliceId,
      candidateId: params.candidateId,
      roles,
      kind,
      epoch: this.currentEpoch(),
      frozenAt,
      nonce: randomUUID(),
    };
    const waveId = createDelegationRecordId("wave", facts);
    this.db
      .prepare(
        `INSERT INTO waves
         (wave_id, slice_id, candidate_id, kind, required_roles_json, epoch, frozen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        waveId,
        params.sliceId,
        params.candidateId,
        kind,
        canonicalDelegationJson(roles),
        facts.epoch,
        frozenAt,
      );
    return waveId;
  }

  recordCandidateAndFreezeWave(params: {
    sliceId: string;
    fingerprint: DelegationFingerprint;
    repositorySnapshot?: DelegationRepositorySnapshot;
    requiredRoles: DelegationAssignmentRecord["role"][];
    candidateCreatedAt?: number;
    frozenAt?: number;
  }): { candidateId: string; waveId: string } {
    this.assertActiveStack();
    return this.transaction(() => {
      if (params.repositorySnapshot) {
        this.assertNoOutOfScopeChanges({
          sliceId: params.sliceId,
          currentSnapshot: params.repositorySnapshot,
        });
      }
      const candidateId = this.recordCandidateWithinTransaction({
        sliceId: params.sliceId,
        fingerprint: params.fingerprint,
        repositorySnapshot: params.repositorySnapshot,
        createdAt: params.candidateCreatedAt,
      });
      const waveId = this.freezeWave({
        sliceId: params.sliceId,
        candidateId,
        requiredRoles: params.requiredRoles,
        frozenAt: params.frozenAt,
      });
      return { candidateId, waveId };
    });
  }

  issueAssignment(
    params: Omit<
      DelegationAssignmentRecord,
      | "assignmentId"
      | "routeFamilyId"
      | "scopeUnits"
      | "recoveryOfAssignmentId"
      | "epoch"
      | "issuedAt"
    > & {
      issuedAt?: number;
      recoveryOfAssignmentId?: string;
      initialRouteKind?: DelegationRouteKind;
      targetSessionKey?: string;
    },
  ): { assignment: DelegationAssignmentRecord; delegationToken: string } {
    this.assertActiveStack();
    const issuedAt = params.issuedAt ?? Date.now();
    const {
      recoveryOfAssignmentId,
      initialRouteKind = "spawn",
      targetSessionKey,
      ...assignmentParams
    } = params;
    if (
      (initialRouteKind === "spawn" && targetSessionKey) ||
      (initialRouteKind !== "spawn" && !targetSessionKey?.trim())
    ) {
      throw new Error("Initial assignment route and target session binding are inconsistent.");
    }
    if (recoveryOfAssignmentId && initialRouteKind !== "spawn") {
      throw new Error("A route-rejection recovery assignment must use one fresh child spawn.");
    }
    if (
      initialRouteKind !== "spawn" &&
      !(
        initialRouteKind === "send" &&
        (assignmentParams.purpose === "remediation" ||
          (assignmentParams.purpose === "confirmation" && assignmentParams.role === "tester"))
      )
    ) {
      throw new Error(
        "Only consolidated implementer remediation or tester confirmation may reuse a completed child.",
      );
    }
    const slice = this.getSliceScope(assignmentParams.sliceId);
    if (
      !slice ||
      slice.epoch !== this.currentEpoch() ||
      slice.controllerAgentId !== assignmentParams.controllerAgentId ||
      slice.controllerSessionKey !== assignmentParams.controllerSessionKey
    ) {
      throw new Error("Assignment controller does not own this current slice/session.");
    }
    const worker = resolveDelegationGuardPrincipal(this.guard, assignmentParams.workerAgentId);
    if (
      worker?.kind !== "worker" ||
      worker.role !== assignmentParams.role ||
      worker.requiredThinking !== assignmentParams.requiredThinking ||
      !assignmentParams.requiredModel.trim() ||
      worker.workspaceAccess !== assignmentParams.workspaceAccess
    ) {
      throw new Error("Assignment worker facts do not match the active guarded policy.");
    }
    const baseline = this.db
      .prepare(`SELECT 1 FROM slice_baselines WHERE slice_id = ? LIMIT 1`)
      .get(assignmentParams.sliceId);
    if (!baseline) {
      throw new Error("A guarded assignment requires a protected finite baseline.");
    }
    const scopeUnits = slice.scope.manifest.kind === "slice" ? slice.scope.paths : ["<repository>"];
    const candidate = assignmentParams.candidateId
      ? (this.db
          .prepare(`SELECT slice_id, epoch FROM candidates WHERE candidate_id = ?`)
          .get(assignmentParams.candidateId) as
          | { slice_id: string; epoch: number | bigint }
          | undefined)
      : undefined;
    if (
      assignmentParams.candidateId &&
      (!candidate ||
        candidate.slice_id !== assignmentParams.sliceId ||
        toNumber(candidate.epoch) !== this.currentEpoch())
    ) {
      throw new Error("Assignment candidate is stale or belongs to a different slice.");
    }
    const wave = assignmentParams.waveId
      ? (this.db
          .prepare(
            `SELECT slice_id, candidate_id, kind, required_roles_json, epoch
             FROM waves WHERE wave_id = ?`,
          )
          .get(assignmentParams.waveId) as
          | {
              slice_id: string;
              candidate_id: string;
              kind: "verification" | "confirmation";
              required_roles_json: string;
              epoch: number | bigint;
            }
          | undefined)
      : undefined;
    if (
      assignmentParams.waveId &&
      (!wave ||
        wave.slice_id !== assignmentParams.sliceId ||
        wave.candidate_id !== assignmentParams.candidateId ||
        toNumber(wave.epoch) !== this.currentEpoch())
    ) {
      throw new Error("Assignment wave does not match the current slice/candidate.");
    }
    const waveRoles = wave
      ? (JSON.parse(wave.required_roles_json) as DelegationAssignmentRecord["role"][])
      : [];
    const rejectDuplicate = (purpose: DelegationAssignmentPurpose, role: string): void => {
      const duplicate = this.db
        .prepare(
          `SELECT 1 FROM assignments
           WHERE slice_id = ? AND purpose = ? AND role = ?
             AND COALESCE(wave_id, '') = COALESCE(?, '')
           LIMIT 1`,
        )
        .get(assignmentParams.sliceId, purpose, role, assignmentParams.waveId ?? null);
      if (duplicate && !recoveryOfAssignmentId) {
        throw new Error(`A ${purpose}/${role} assignment already exists for this guarded phase.`);
      }
    };
    switch (assignmentParams.purpose) {
      case "discovery":
        if (assignmentParams.role !== "helper" || candidate || wave) {
          throw new Error("Discovery requires the helper role and the baseline scope only.");
        }
        rejectDuplicate("discovery", "helper");
        break;
      case "implementation":
        if (assignmentParams.role !== "implementer" || candidate || wave) {
          throw new Error("Initial implementation requires the implementer and no frozen wave.");
        }
        if (!this.hasProgressableTerminalPurpose(assignmentParams.sliceId, "discovery")) {
          throw new Error("Implementation requires a completed validated helper discovery.");
        }
        rejectDuplicate("implementation", "implementer");
        break;
      case "verification":
        if (
          !wave ||
          wave.kind !== "verification" ||
          !["tester", "reviewer"].includes(assignmentParams.role) ||
          !waveRoles.includes(assignmentParams.role)
        ) {
          throw new Error("Verification assignments require the frozen tester/reviewer wave.");
        }
        rejectDuplicate("verification", assignmentParams.role);
        break;
      case "qa": {
        const waveId = assignmentParams.waveId;
        if (!wave || !waveId || wave.kind !== "verification" || assignmentParams.role !== "qa") {
          throw new Error("QA requires the QA lane on the current verification wave.");
        }
        for (const prerequisiteRole of ["tester", "reviewer"] as const) {
          const terminal = this.hasProgressableTerminalWaveRole(
            waveId,
            "verification",
            prerequisiteRole,
          );
          if (!terminal) {
            throw new Error(`QA requires an accepted terminal ${prerequisiteRole} report.`);
          }
        }
        rejectDuplicate("qa", "qa");
        break;
      }
      case "remediation": {
        const waveId = assignmentParams.waveId;
        if (!wave || !waveId || assignmentParams.role !== "implementer") {
          throw new Error("Consolidated remediation requires the implementer and source wave.");
        }
        const revision = this.db
          .prepare(
            `SELECT revision_id FROM remediation_revisions
             WHERE slice_id = ? AND source_wave_id = ?
             ORDER BY ordinal DESC LIMIT 1`,
          )
          .get(assignmentParams.sliceId, waveId) as { revision_id: string } | undefined;
        if (!revision || assignmentParams.remediationRevisionId !== revision.revision_id) {
          throw new Error("Remediation assignment must bind the latest consolidated revision.");
        }
        rejectDuplicate("remediation", "implementer");
        break;
      }
      case "confirmation":
        if (
          !wave ||
          wave.kind !== "confirmation" ||
          !waveRoles.includes(assignmentParams.role) ||
          !["tester", "reviewer", "qa"].includes(assignmentParams.role)
        ) {
          throw new Error("Confirmation assignment does not match the targeted confirmation wave.");
        }
        rejectDuplicate("confirmation", assignmentParams.role);
        break;
    }
    let routeFamilyId: string | undefined;
    if (recoveryOfAssignmentId) {
      const original = this.getAssignment(recoveryOfAssignmentId);
      if (
        !original ||
        original.sliceId !== assignmentParams.sliceId ||
        original.controllerAgentId !== assignmentParams.controllerAgentId ||
        original.controllerSessionKey !== assignmentParams.controllerSessionKey ||
        original.workerAgentId !== assignmentParams.workerAgentId ||
        original.role !== assignmentParams.role ||
        original.requiredModel !== assignmentParams.requiredModel ||
        original.purpose !== assignmentParams.purpose ||
        original.candidateId !== assignmentParams.candidateId ||
        original.waveId !== assignmentParams.waveId
      ) {
        throw new Error("Recovery assignment does not match the original guarded route.");
      }
      const rejected = this.db
        .prepare(
          `SELECT 1 FROM route_events
           WHERE assignment_id = ? AND kind = 'route_rejected' LIMIT 1`,
        )
        .get(recoveryOfAssignmentId);
      if (!rejected) {
        throw new Error("A recovery child requires terminal route-rejection evidence.");
      }
      const familyCount = this.db
        .prepare(`SELECT COUNT(*) AS count FROM assignments WHERE route_family_id = ?`)
        .get(original.routeFamilyId) as CountRow;
      if (toNumber(familyCount.count) >= 2) {
        throw new Error("The guarded route family already used its one recovery child.");
      }
      routeFamilyId = original.routeFamilyId;
    }
    const facts = {
      ...assignmentParams,
      ...(recoveryOfAssignmentId ? { recoveryOfAssignmentId } : {}),
      initialRouteKind,
      ...(targetSessionKey ? { targetSessionKey } : {}),
      issuedAt,
      epoch: this.currentEpoch(),
      nonce: randomUUID(),
    };
    const assignmentId = createDelegationRecordId("assignment", facts);
    routeFamilyId ??= createDelegationRecordId("route-family", { assignmentId });
    const assignment: DelegationAssignmentRecord = {
      ...assignmentParams,
      assignmentId,
      scopeUnits,
      routeFamilyId,
      ...(recoveryOfAssignmentId ? { recoveryOfAssignmentId } : {}),
      epoch: facts.epoch,
      issuedAt,
    };
    const delegationToken = randomBytes(32).toString("base64url");
    const tokenHash = hashDelegationIdentity("delegation-token-v1", delegationToken);
    if (targetSessionKey) {
      const prior = this.resolveAssignmentForChildSession(targetSessionKey);
      const priorCompleted = prior
        ? this.db
            .prepare(
              `SELECT 1 FROM route_events
               WHERE assignment_id = ? AND kind = 'completed' LIMIT 1`,
            )
            .get(prior.assignmentId)
        : undefined;
      if (
        !prior ||
        !priorCompleted ||
        prior.sliceId !== assignment.sliceId ||
        prior.controllerAgentId !== assignment.controllerAgentId ||
        prior.controllerSessionKey !== assignment.controllerSessionKey ||
        prior.workerAgentId !== assignment.workerAgentId
      ) {
        throw new Error(
          "An assignment may reuse only a completed child owned by the same controller and worker.",
        );
      }
    }
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO assignments
           (assignment_id, slice_id, candidate_id, wave_id, controller_agent_id,
            controller_session_key, worker_agent_id, role, required_thinking,
            required_model, workspace_access, scope_units_json, route_family_id, purpose,
            remediation_revision_id, recovery_of_assignment_id, epoch, issued_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          assignment.assignmentId,
          assignment.sliceId,
          assignment.candidateId ?? null,
          assignment.waveId ?? null,
          assignment.controllerAgentId,
          assignment.controllerSessionKey,
          assignment.workerAgentId,
          assignment.role,
          assignment.requiredThinking,
          assignment.requiredModel,
          assignment.workspaceAccess,
          canonicalDelegationJson(assignment.scopeUnits),
          assignment.routeFamilyId,
          assignment.purpose,
          assignment.remediationRevisionId ?? null,
          assignment.recoveryOfAssignmentId ?? null,
          assignment.epoch,
          assignment.issuedAt,
        );
      this.db
        .prepare(
          `INSERT INTO assignment_tokens
           (token_hash, assignment_id, route_kind, target_session_key, epoch, issued_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          tokenHash,
          assignment.assignmentId,
          initialRouteKind,
          targetSessionKey ?? null,
          assignment.epoch,
          assignment.issuedAt,
        );
    });
    return { assignment, delegationToken };
  }

  issueRouteToken(params: {
    assignmentId: string;
    controllerAgentId: string;
    controllerSessionKey: string;
    routeKind: Exclude<DelegationRouteKind, "spawn">;
    targetSessionKey: string;
    issuedAt?: number;
  }): string {
    this.assertActiveStack();
    const assignment = this.getAssignment(params.assignmentId);
    if (
      !assignment ||
      assignment.epoch !== this.currentEpoch() ||
      assignment.controllerAgentId !== params.controllerAgentId ||
      assignment.controllerSessionKey !== params.controllerSessionKey
    ) {
      throw new Error("Follow-up route token does not belong to this current controller session.");
    }
    const delegationToken = randomBytes(32).toString("base64url");
    const tokenHash = hashDelegationIdentity("delegation-token-v1", delegationToken);
    this.transaction(() => {
      this.assertAssignmentOpen(params.assignmentId);
      this.assertNoPriorGatewayDispatch(params.assignmentId);
      const binding = this.db
        .prepare(
          `SELECT 1 FROM assignment_bindings
           WHERE assignment_id = ? AND child_session_key = ? LIMIT 1`,
        )
        .get(params.assignmentId, params.targetSessionKey);
      const accepted = this.db
        .prepare(
          `SELECT 1 FROM route_events
           WHERE assignment_id = ? AND kind = 'accepted' LIMIT 1`,
        )
        .get(params.assignmentId);
      const outstandingToken = this.db
        .prepare(
          `SELECT 1 FROM assignment_tokens t
           LEFT JOIN token_uses u ON u.token_hash = t.token_hash
           WHERE t.assignment_id = ? AND t.route_kind IN ('send', 'steer')
             AND u.token_hash IS NULL
           LIMIT 1`,
        )
        .get(params.assignmentId);
      if (!binding || !accepted || outstandingToken) {
        throw new Error(
          "Follow-up route token requires one active bound child and no outstanding send or steer.",
        );
      }
      this.db
        .prepare(
          `INSERT INTO assignment_tokens
           (token_hash, assignment_id, route_kind, target_session_key, epoch, issued_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          tokenHash,
          assignment.assignmentId,
          params.routeKind,
          params.targetSessionKey,
          assignment.epoch,
          params.issuedAt ?? Date.now(),
        );
    });
    return delegationToken;
  }

  private appendGatewayRouteRejectionIfOpen(params: {
    assignmentId: string;
    targetSessionKey?: string;
    runId?: string;
    createdAt: number;
    reason?: string;
    response?: unknown;
    acceptedRun?: boolean;
  }): void {
    const terminalRoute = this.db
      .prepare(
        `SELECT 1 FROM route_events
         WHERE assignment_id = ?
           AND kind IN ('route_rejected', 'validation_rejected', 'timeout', 'completed') LIMIT 1`,
      )
      .get(params.assignmentId);
    const reportSubmitted = this.db
      .prepare(`SELECT 1 FROM receipts WHERE assignment_id = ? LIMIT 1`)
      .get(params.assignmentId);
    const acceptedRunProof = this.db
      .prepare(
        `SELECT 1 FROM gateway_dispatch_outcomes o
         JOIN gateway_dispatch_runs r ON r.capability_hash = o.capability_hash
         WHERE o.assignment_id = ? AND o.decision = 'accepted' LIMIT 1`,
      )
      .get(params.assignmentId);
    if (terminalRoute) {
      return;
    }
    const kind =
      acceptedRunProof || params.acceptedRun || reportSubmitted
        ? "validation_rejected"
        : "route_rejected";
    const payloadJson = canonicalDelegationJson({
      ...(params.targetSessionKey ? { childSessionKey: params.targetSessionKey } : {}),
      ...(params.runId ? { runId: params.runId } : {}),
      reason: params.reason ?? "nested agent start failed",
      ...(kind === "validation_rejected" ? { code: "accepted-gateway-run-execution-failed" } : {}),
      ...(params.response !== undefined ? { response: params.response } : {}),
    });
    this.db
      .prepare(
        `INSERT INTO route_events
         (event_id, assignment_id, kind, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        createDelegationRecordId("route-event", {
          assignmentId: params.assignmentId,
          kind,
          payloadJson,
          createdAt: params.createdAt,
          nonce: randomUUID(),
        }),
        params.assignmentId,
        kind,
        payloadJson,
        params.createdAt,
      );
  }

  rejectRouteIfOpen(params: {
    assignmentId: string;
    targetSessionKey?: string;
    runId?: string;
    reason?: string;
    response?: unknown;
    rejectedAt?: number;
  }): void {
    this.assertActiveStack();
    const assignment = this.getAssignment(params.assignmentId);
    if (!assignment || assignment.epoch !== this.currentEpoch()) {
      throw new Error("Cannot reject a missing or stale delegation assignment.");
    }
    this.transaction(() => {
      this.appendGatewayRouteRejectionIfOpen({
        assignmentId: params.assignmentId,
        targetSessionKey: params.targetSessionKey,
        runId: params.runId,
        createdAt: params.rejectedAt ?? Date.now(),
        reason: params.reason,
        response: params.response,
      });
    });
  }

  rejectUnstartedAssignment(params: {
    assignmentId: string;
    controllerAgentId: string;
    controllerSessionKey: string;
    reason: string;
    rejectedAt?: number;
  }): void {
    this.assertActiveStack();
    this.transaction(() => {
      const assignment = this.getAssignment(params.assignmentId);
      if (
        !assignment ||
        assignment.epoch !== this.currentEpoch() ||
        assignment.controllerAgentId !== params.controllerAgentId ||
        assignment.controllerSessionKey !== params.controllerSessionKey
      ) {
        throw new Error("Cannot reconcile an unowned, missing, or stale delegation assignment.");
      }
      const startedEvidence = this.db
        .prepare(
          `SELECT
             EXISTS(SELECT 1 FROM token_uses WHERE assignment_id = ?) AS token_used,
             EXISTS(SELECT 1 FROM assignment_bindings WHERE assignment_id = ?) AS bound,
             EXISTS(SELECT 1 FROM gateway_dispatch_capabilities WHERE assignment_id = ?) AS capable,
             EXISTS(SELECT 1 FROM route_events WHERE assignment_id = ?) AS routed,
             EXISTS(SELECT 1 FROM receipts WHERE assignment_id = ?) AS reported,
             EXISTS(SELECT 1 FROM terminal_results WHERE assignment_id = ?) AS terminal_result`,
        )
        .get(
          params.assignmentId,
          params.assignmentId,
          params.assignmentId,
          params.assignmentId,
          params.assignmentId,
          params.assignmentId,
        ) as {
        token_used: number | bigint;
        bound: number | bigint;
        capable: number | bigint;
        routed: number | bigint;
        reported: number | bigint;
        terminal_result: number | bigint;
      };
      if (Object.values(startedEvidence).some((value) => toNumber(value) !== 0)) {
        throw new Error(
          "Only an assignment with no route, binding, report, or execution evidence can be reconciled as unstarted.",
        );
      }
      this.appendGatewayRouteRejectionIfOpen({
        assignmentId: params.assignmentId,
        createdAt: params.rejectedAt ?? Date.now(),
        reason: params.reason,
        response: {
          code: "delegation_unstarted_assignment_operator_rejected",
          operatorReconciled: true,
        },
      });
    });
  }

  private appendGatewayCompletionWithoutReceiptIfOpen(params: {
    assignmentId: string;
    targetSessionKey: string;
    runId: string;
    createdAt: number;
  }): void {
    const terminalRoute = this.db
      .prepare(
        `SELECT 1 FROM route_events
         WHERE assignment_id = ?
           AND kind IN ('route_rejected', 'validation_rejected', 'timeout', 'completed') LIMIT 1`,
      )
      .get(params.assignmentId);
    const reportSubmitted = this.db
      .prepare(`SELECT 1 FROM receipts WHERE assignment_id = ? LIMIT 1`)
      .get(params.assignmentId);
    if (terminalRoute || reportSubmitted) {
      return;
    }
    const payloadJson = canonicalDelegationJson({
      childSessionKey: params.targetSessionKey,
      runId: params.runId,
      reason:
        "guarded Gateway task completed before protected assignment completion; recovery is blocked to prevent duplicate side effects",
    });
    this.db
      .prepare(
        `INSERT INTO route_events
         (event_id, assignment_id, kind, payload_json, created_at)
         VALUES (?, ?, 'validation_rejected', ?, ?)`,
      )
      .run(
        createDelegationRecordId("route-event", {
          assignmentId: params.assignmentId,
          kind: "validation_rejected",
          payloadJson,
          createdAt: params.createdAt,
          nonce: randomUUID(),
        }),
        params.assignmentId,
        payloadJson,
        params.createdAt,
      );
  }

  reconcileGatewayDispatchesAfterRestart(reconciledAt = Date.now()): number {
    this.assertActiveStack();
    const unclaimedRows = this.db
      .prepare(
        `SELECT c.capability_hash, c.assignment_id, c.target_session_key, c.idempotency_key
         FROM gateway_dispatch_capabilities c
         LEFT JOIN gateway_dispatch_uses u ON u.capability_hash = c.capability_hash
         LEFT JOIN gateway_dispatch_outcomes o ON o.capability_hash = c.capability_hash
         WHERE c.epoch = ? AND u.capability_hash IS NULL AND o.capability_hash IS NULL`,
      )
      .all(this.currentEpoch()) as Array<{
      capability_hash: string;
      assignment_id: string;
      target_session_key: string;
      idempotency_key: string;
    }>;
    const claimedWithoutOutcomeRows = this.db
      .prepare(
        `SELECT c.capability_hash, c.assignment_id, c.target_session_key, c.idempotency_key
         FROM gateway_dispatch_capabilities c
         JOIN gateway_dispatch_uses u ON u.capability_hash = c.capability_hash
         LEFT JOIN gateway_dispatch_outcomes o ON o.capability_hash = c.capability_hash
         WHERE c.epoch = ? AND o.capability_hash IS NULL`,
      )
      .all(this.currentEpoch()) as Array<{
      capability_hash: string;
      assignment_id: string;
      target_session_key: string;
      idempotency_key: string;
    }>;
    const priorWriterRows = this.db
      .prepare(
        `SELECT c.assignment_id, c.target_session_key, c.idempotency_key
         FROM gateway_dispatch_capabilities c
         JOIN gateway_dispatch_outcomes o ON o.capability_hash = c.capability_hash
         JOIN gateway_dispatch_runs r ON r.capability_hash = c.capability_hash
         WHERE c.epoch = ? AND o.decision = 'accepted' AND r.writer_id <> ?
           AND NOT EXISTS (
             SELECT 1 FROM route_events e
             WHERE e.assignment_id = c.assignment_id
               AND e.kind IN ('route_rejected', 'validation_rejected', 'timeout', 'completed')
           )
           AND NOT EXISTS (
             SELECT 1 FROM receipts receipt WHERE receipt.assignment_id = c.assignment_id
           )
         ORDER BY c.assignment_id, c.idempotency_key`,
      )
      .all(this.currentEpoch(), this.writerId) as Array<{
      assignment_id: string;
      target_session_key: string;
      idempotency_key: string;
    }>;
    if (
      unclaimedRows.length === 0 &&
      claimedWithoutOutcomeRows.length === 0 &&
      priorWriterRows.length === 0
    ) {
      return 0;
    }
    return this.transaction(() => {
      for (const row of unclaimedRows) {
        const response = {
          message:
            "guarded Gateway dispatch capability was not claimed before gateway restart; issue the one allowed fresh recovery assignment",
          retryable: false,
          details: { code: "delegation_gateway_dispatch_unclaimed_restart" },
        };
        this.db
          .prepare(
            `INSERT INTO gateway_dispatch_outcomes
             (capability_hash, assignment_id, decision, response_json, decided_at)
             VALUES (?, ?, 'rejected', ?, ?)`,
          )
          .run(
            row.capability_hash,
            row.assignment_id,
            canonicalDelegationJson(response),
            reconciledAt,
          );
        this.appendGatewayRouteRejectionIfOpen({
          assignmentId: row.assignment_id,
          targetSessionKey: row.target_session_key,
          runId: row.idempotency_key,
          createdAt: reconciledAt,
        });
      }
      for (const row of claimedWithoutOutcomeRows) {
        const taskOutcome = this.reconcileGatewayTask({
          runId: row.idempotency_key,
          targetSessionKey: row.target_session_key,
          requiredTask: false,
        });
        const executionMayHaveCompleted =
          taskOutcome === "completed" || taskOutcome === "uncertain";
        const response = {
          message: executionMayHaveCompleted
            ? "guarded Gateway dispatch completion is uncertain after restart; recovery is blocked to prevent duplicate side effects"
            : "guarded Gateway dispatch was claimed without reaching a durable outcome before gateway restart; issue the one allowed fresh recovery assignment",
          retryable: false,
          details: {
            code: executionMayHaveCompleted
              ? "delegation_gateway_dispatch_completion_uncertain"
              : "delegation_gateway_dispatch_claimed_restart",
          },
        };
        this.db
          .prepare(
            `INSERT INTO gateway_dispatch_outcomes
             (capability_hash, assignment_id, decision, response_json, decided_at)
             VALUES (?, ?, 'rejected', ?, ?)`,
          )
          .run(
            row.capability_hash,
            row.assignment_id,
            canonicalDelegationJson(response),
            reconciledAt,
          );
        if (executionMayHaveCompleted) {
          this.appendGatewayCompletionWithoutReceiptIfOpen({
            assignmentId: row.assignment_id,
            targetSessionKey: row.target_session_key,
            runId: row.idempotency_key,
            createdAt: reconciledAt,
          });
        } else {
          this.appendGatewayRouteRejectionIfOpen({
            assignmentId: row.assignment_id,
            targetSessionKey: row.target_session_key,
            runId: row.idempotency_key,
            createdAt: reconciledAt,
          });
        }
      }
      // Reconcile every prior-writer run before closing its assignment. An
      // assignment can have multiple accepted follow-ups; if any one completed,
      // recovery must stay blocked regardless of row order because repeating the
      // assignment could duplicate its external side effects.
      const priorRowsByAssignment = new Map<string, typeof priorWriterRows>();
      for (const row of priorWriterRows) {
        const rows = priorRowsByAssignment.get(row.assignment_id) ?? [];
        rows.push(row);
        priorRowsByAssignment.set(row.assignment_id, rows);
      }
      for (const rows of priorRowsByAssignment.values()) {
        let completedRow: (typeof rows)[number] | undefined;
        let uncertainRow: (typeof rows)[number] | undefined;
        for (const row of rows) {
          const taskOutcome = this.reconcileGatewayTask({
            runId: row.idempotency_key,
            targetSessionKey: row.target_session_key,
            requiredTask: true,
          });
          if (taskOutcome === "absent") {
            throw new Error(
              "An accepted guarded Gateway run lost its required durable task record.",
            );
          }
          if (taskOutcome === "completed") {
            completedRow ??= row;
          } else if (taskOutcome === "uncertain") {
            uncertainRow ??= row;
          }
        }
        const unsafeRow = completedRow ?? uncertainRow;
        const evidenceRow = unsafeRow ?? rows[0];
        if (!evidenceRow) {
          continue;
        }
        if (unsafeRow) {
          this.appendGatewayCompletionWithoutReceiptIfOpen({
            assignmentId: unsafeRow.assignment_id,
            targetSessionKey: unsafeRow.target_session_key,
            runId: unsafeRow.idempotency_key,
            createdAt: reconciledAt,
          });
        } else {
          this.appendGatewayRouteRejectionIfOpen({
            assignmentId: evidenceRow.assignment_id,
            targetSessionKey: evidenceRow.target_session_key,
            runId: evidenceRow.idempotency_key,
            createdAt: reconciledAt,
          });
        }
      }
      return unclaimedRows.length + claimedWithoutOutcomeRows.length + priorWriterRows.length;
    });
  }

  reconcileInterruptedInitialSpawnsAfterRestart(reconciledAt = Date.now()): number {
    if (!this.reconcileInitialSpawnTask) {
      return 0;
    }
    this.assertActiveStack();
    const rows = this.db
      .prepare(
        `SELECT a.assignment_id, b.child_session_key, b.run_id
         FROM assignments a
         JOIN token_uses u
           ON u.assignment_id = a.assignment_id AND u.route_kind = 'spawn'
         JOIN assignment_bindings b ON b.assignment_id = a.assignment_id
         LEFT JOIN gateway_dispatch_capabilities c ON c.assignment_id = a.assignment_id
         WHERE a.epoch = ? AND b.run_id IS NOT NULL
           AND c.assignment_id IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM route_events e
             WHERE e.assignment_id = a.assignment_id
               AND e.kind IN ('route_rejected', 'validation_rejected', 'timeout', 'completed')
           )
           AND NOT EXISTS (
             SELECT 1 FROM receipts receipt WHERE receipt.assignment_id = a.assignment_id
           )
           AND b.bound_at = (
             SELECT MAX(latest.bound_at) FROM assignment_bindings latest
             WHERE latest.assignment_id = a.assignment_id
           )
         ORDER BY a.assignment_id`,
      )
      .all(this.currentEpoch()) as Array<{
      assignment_id: string;
      child_session_key: string;
      run_id: string;
    }>;
    let reconciled = 0;
    const attemptedAssignmentIds = new Set<string>();
    for (const row of rows) {
      attemptedAssignmentIds.add(row.assignment_id);
      const taskOutcome = this.reconcileInitialSpawnTask({
        runId: row.run_id,
        targetSessionKey: row.child_session_key,
      });
      if (taskOutcome === "absent") {
        // Missing task evidence cannot prove that the legacy provisional run
        // stayed pre-execution. Keep the assignment open for operator review.
        continue;
      }
      this.transaction(() => {
        this.appendGatewayRouteRejectionIfOpen({
          assignmentId: row.assignment_id,
          targetSessionKey: row.child_session_key,
          runId: row.run_id,
          createdAt: reconciledAt,
          reason:
            taskOutcome === "interrupted"
              ? "legacy guarded initial spawn failed before exact Gateway authority was issued"
              : "legacy guarded initial spawn execution cannot be proven safe to recover",
          acceptedRun: taskOutcome === "completed" || taskOutcome === "uncertain",
        });
      });
      reconciled += 1;
    }
    const rejectedPreExecutionRows = this.listRejectedInitialSpawnCleanupTargets();
    for (const row of rejectedPreExecutionRows) {
      if (attemptedAssignmentIds.has(row.assignmentId)) {
        continue;
      }
      const taskOutcome = this.reconcileInitialSpawnTask({
        runId: row.runId,
        targetSessionKey: row.childSessionKey,
      });
      if (taskOutcome !== "absent") {
        reconciled += 1;
      }
    }
    return reconciled;
  }

  listRejectedInitialSpawnCleanupTargets(): Array<{
    assignmentId: string;
    controllerSessionKey: string;
    childSessionKey: string;
    runId: string;
  }> {
    this.assertActiveStack();
    const rows = this.db
      .prepare(
        `SELECT a.assignment_id, a.controller_session_key,
                b.child_session_key, b.run_id
         FROM assignments a
         JOIN token_uses u
           ON u.assignment_id = a.assignment_id AND u.route_kind = 'spawn'
         JOIN assignment_bindings b ON b.assignment_id = a.assignment_id
         WHERE b.run_id IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM route_events e
             WHERE e.assignment_id = a.assignment_id AND e.kind = 'route_rejected'
           )
           AND NOT EXISTS (
             SELECT 1 FROM route_events e
             WHERE e.assignment_id = a.assignment_id AND e.kind IN ('accepted', 'completed')
           )
           AND NOT EXISTS (
             SELECT 1 FROM receipts receipt WHERE receipt.assignment_id = a.assignment_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM gateway_dispatch_runs run
             WHERE run.assignment_id = a.assignment_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM initial_spawn_cleanup_receipts cleanup
             WHERE cleanup.assignment_id = a.assignment_id
           )
           AND b.bound_at = (
             SELECT MAX(latest.bound_at) FROM assignment_bindings latest
             WHERE latest.assignment_id = a.assignment_id
           )
         ORDER BY a.assignment_id`,
      )
      .all() as Array<{
      assignment_id: string;
      controller_session_key: string;
      child_session_key: string;
      run_id: string;
    }>;
    return rows.map((row) => ({
      assignmentId: row.assignment_id,
      controllerSessionKey: row.controller_session_key,
      childSessionKey: row.child_session_key,
      runId: row.run_id,
    }));
  }

  recordRejectedInitialSpawnCleanup(params: {
    assignmentId: string;
    childSessionKey: string;
    runId: string;
    cleanedAt?: number;
  }): void {
    this.assertActiveStack();
    const existing = this.db
      .prepare(
        `SELECT child_session_key, run_id
         FROM initial_spawn_cleanup_receipts WHERE assignment_id = ?`,
      )
      .get(params.assignmentId) as { child_session_key: string; run_id: string } | undefined;
    if (existing) {
      if (
        existing.child_session_key !== params.childSessionKey ||
        existing.run_id !== params.runId
      ) {
        throw new Error("Initial-spawn cleanup receipt conflicts with protected route identity.");
      }
      return;
    }
    const eligible = this.listRejectedInitialSpawnCleanupTargets().some(
      (target) =>
        target.assignmentId === params.assignmentId &&
        target.childSessionKey === params.childSessionKey &&
        target.runId === params.runId,
    );
    if (!eligible) {
      throw new Error("Initial-spawn cleanup receipt requires a rejected pre-execution route.");
    }
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO initial_spawn_cleanup_receipts
           (assignment_id, child_session_key, run_id, cleaned_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          params.assignmentId,
          params.childSessionKey,
          params.runId,
          params.cleanedAt ?? Date.now(),
        );
    });
  }

  reconcileTerminalGatewayTasksAfterRestart(): number {
    if (!this.reconcileTerminalGatewayTask) {
      return 0;
    }
    const rows = this.db
      .prepare(
        `SELECT c.idempotency_key, c.target_session_key,
                CASE
                  WHEN EXISTS (SELECT 1 FROM route_events e
                               WHERE e.assignment_id = c.assignment_id AND e.kind = 'completed')
                    THEN 'completed'
                  WHEN EXISTS (SELECT 1 FROM route_events e
                               WHERE e.assignment_id = c.assignment_id AND e.kind = 'route_rejected')
                    THEN 'route_rejected'
                  WHEN EXISTS (SELECT 1 FROM route_events e
                               WHERE e.assignment_id = c.assignment_id AND e.kind = 'timeout')
                    THEN 'timeout'
                  ELSE 'validation_rejected'
                END AS terminal_kind
         FROM gateway_dispatch_capabilities c
         JOIN gateway_dispatch_uses u ON u.capability_hash = c.capability_hash
         WHERE EXISTS (
             SELECT 1 FROM route_events e
             WHERE e.assignment_id = c.assignment_id
               AND e.kind IN ('route_rejected', 'validation_rejected', 'timeout', 'completed')
           )
         ORDER BY c.assignment_id, c.idempotency_key`,
      )
      .all() as Array<{
      idempotency_key: string;
      target_session_key: string;
      terminal_kind: DelegationGatewayTerminalKind;
    }>;
    for (const row of rows) {
      this.reconcileTerminalGatewayTask({
        runId: row.idempotency_key,
        targetSessionKey: row.target_session_key,
        terminalKind: row.terminal_kind,
      });
    }
    return rows.length;
  }

  consumeGatewayDispatchCapability(params: {
    capability: string;
    controllerSessionKey: string;
    targetSessionKey: string;
    idempotencyKey: string;
    usedAt?: number;
  }): DelegationGatewayDispatchClaim {
    this.assertActiveStack();
    const capabilityHash = hashDelegationIdentity(
      "gateway-dispatch-capability-v1",
      params.capability,
    );
    const row = this.db
      .prepare(
        `SELECT a.* FROM gateway_dispatch_capabilities c
         JOIN assignments a ON a.assignment_id = c.assignment_id
         WHERE c.capability_hash = ? AND c.controller_session_key = ?
           AND c.target_session_key = ? AND c.idempotency_key = ? AND c.epoch = ?`,
      )
      .get(
        capabilityHash,
        params.controllerSessionKey,
        params.targetSessionKey,
        params.idempotencyKey,
        this.currentEpoch(),
      ) as AssignmentRow | undefined;
    if (!row) {
      throw new Error("Gateway dispatch capability is stale or does not match this exact route.");
    }
    const assignment = assignmentFromRow(row);
    const usedAt = params.usedAt ?? Date.now();
    return this.transaction(() => {
      const existingUse = this.db
        .prepare(`SELECT 1 FROM gateway_dispatch_uses WHERE capability_hash = ?`)
        .get(capabilityHash);
      if (!existingUse) {
        this.assertAssignmentOpen(assignment.assignmentId);
        const competingUse = this.db
          .prepare(
            `SELECT 1 FROM gateway_dispatch_uses u
             JOIN gateway_dispatch_capabilities c ON c.capability_hash = u.capability_hash
             WHERE c.assignment_id = ? AND c.capability_hash <> ? LIMIT 1`,
          )
          .get(assignment.assignmentId, capabilityHash);
        if (competingUse) {
          throw new Error(
            "Delegation assignment already consumed another Gateway dispatch capability.",
          );
        }
        this.db
          .prepare(
            `INSERT INTO gateway_dispatch_uses
             (capability_hash, assignment_id, controller_session_key, target_session_key,
              idempotency_key, used_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            capabilityHash,
            assignment.assignmentId,
            params.controllerSessionKey,
            params.targetSessionKey,
            params.idempotencyKey,
            usedAt,
          );
        this.bindAssignment({
          assignmentId: assignment.assignmentId,
          childSessionKey: params.targetSessionKey,
          runId: params.idempotencyKey,
          boundAt: usedAt,
        });
      }
      const outcome = this.db
        .prepare(
          `SELECT decision, response_json FROM gateway_dispatch_outcomes
           WHERE capability_hash = ?`,
        )
        .get(capabilityHash) as
        | { decision: DelegationGatewayDispatchOutcome["decision"]; response_json: string }
        | undefined;
      const dispatchRun = this.db
        .prepare(
          `SELECT run_id, writer_id, registered_at FROM gateway_dispatch_runs
           WHERE capability_hash = ? AND target_session_key = ? AND idempotency_key = ?`,
        )
        .get(capabilityHash, params.targetSessionKey, params.idempotencyKey) as
        | { run_id: string; writer_id: string; registered_at: number | bigint }
        | undefined;
      const terminalRejection = this.db
        .prepare(
          `SELECT payload_json FROM route_events
           WHERE assignment_id = ? AND kind IN ('route_rejected', 'validation_rejected')
           ORDER BY created_at DESC, event_id DESC LIMIT 1`,
        )
        .get(assignment.assignmentId) as { payload_json: string } | undefined;
      if (terminalRejection) {
        const payload = JSON.parse(terminalRejection.payload_json) as {
          response?: unknown;
          reason?: string;
        };
        return {
          assignment,
          firstUse: !existingUse,
          ...(dispatchRun
            ? {
                dispatchRun: {
                  runId: dispatchRun.run_id,
                  registeredAt: toNumber(dispatchRun.registered_at),
                },
              }
            : {}),
          outcome: {
            decision: "rejected",
            response:
              payload.response ??
              ({
                message: payload.reason ?? "guarded Gateway dispatch execution was rejected",
                retryable: false,
                details: { code: "delegation_gateway_dispatch_execution_rejected" },
              } satisfies Record<string, unknown>),
          },
        };
      }
      if (outcome?.decision === "accepted" && !dispatchRun) {
        this.appendGatewayRouteRejectionIfOpen({
          assignmentId: assignment.assignmentId,
          targetSessionKey: params.targetSessionKey,
          runId: params.idempotencyKey,
          createdAt: usedAt,
        });
        return {
          assignment,
          firstUse: !existingUse,
          interruption: "accepted_without_run_proof",
        };
      }
      if (
        outcome?.decision === "accepted" &&
        dispatchRun &&
        dispatchRun.writer_id !== this.writerId
      ) {
        this.appendGatewayRouteRejectionIfOpen({
          assignmentId: assignment.assignmentId,
          targetSessionKey: params.targetSessionKey,
          runId: params.idempotencyKey,
          createdAt: usedAt,
        });
        return {
          assignment,
          firstUse: !existingUse,
          dispatchRun: {
            runId: dispatchRun.run_id,
            registeredAt: toNumber(dispatchRun.registered_at),
          },
          interruption: "accepted_by_prior_gateway_writer",
        };
      }
      if (
        outcome?.decision === "accepted" &&
        dispatchRun &&
        dispatchRun.writer_id === this.writerId
      ) {
        const taskOutcome = this.reconcileGatewayTask({
          runId: dispatchRun.run_id,
          targetSessionKey: params.targetSessionKey,
          requiredTask: true,
        });
        if (taskOutcome === "interrupted") {
          const response = {
            message: "guarded Gateway dispatch failed before or during agent execution",
            retryable: false,
            details: { code: "delegation_gateway_dispatch_execution_rejected" },
          };
          this.appendGatewayRouteRejectionIfOpen({
            assignmentId: assignment.assignmentId,
            targetSessionKey: params.targetSessionKey,
            runId: dispatchRun.run_id,
            createdAt: usedAt,
            reason: response.message,
            response,
          });
          return {
            assignment,
            firstUse: !existingUse,
            dispatchRun: {
              runId: dispatchRun.run_id,
              registeredAt: toNumber(dispatchRun.registered_at),
            },
            outcome: { decision: "rejected", response },
          };
        }
      }
      return {
        assignment,
        firstUse: !existingUse,
        ...(dispatchRun
          ? {
              dispatchRun: {
                runId: dispatchRun.run_id,
                registeredAt: toNumber(dispatchRun.registered_at),
              },
            }
          : {}),
        ...(outcome
          ? {
              outcome: {
                decision: outcome.decision,
                response: JSON.parse(outcome.response_json) as unknown,
              },
            }
          : {}),
      };
    });
  }

  recordGatewayDispatchEnqueued(params: {
    capability: string;
    controllerSessionKey: string;
    targetSessionKey: string;
    idempotencyKey: string;
    runId: string;
    response: unknown;
    registeredAt?: number;
  }): DelegationGatewayDispatchOutcome {
    this.assertActiveStack();
    if (params.runId !== params.idempotencyKey) {
      throw new Error("Guarded Gateway dispatch enqueue must match its immutable idempotency key.");
    }
    const capabilityHash = hashDelegationIdentity(
      "gateway-dispatch-capability-v1",
      params.capability,
    );
    const responseJson = canonicalDelegationJson(params.response);
    const registeredAt = params.registeredAt ?? Date.now();
    return this.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT c.assignment_id FROM gateway_dispatch_capabilities c
           JOIN gateway_dispatch_uses u ON u.capability_hash = c.capability_hash
           WHERE c.capability_hash = ? AND c.controller_session_key = ?
             AND c.target_session_key = ? AND c.idempotency_key = ? AND c.epoch = ?`,
        )
        .get(
          capabilityHash,
          params.controllerSessionKey,
          params.targetSessionKey,
          params.idempotencyKey,
          this.currentEpoch(),
        ) as { assignment_id: string } | undefined;
      if (!row) {
        throw new Error("Gateway dispatch enqueue requires its exact current durable claim.");
      }
      this.assertAssignmentOpen(row.assignment_id);
      const existingRun = this.db
        .prepare(
          `SELECT run_id, target_session_key, idempotency_key, writer_id
           FROM gateway_dispatch_runs
           WHERE capability_hash = ?`,
        )
        .get(capabilityHash) as
        | {
            run_id: string;
            target_session_key: string;
            idempotency_key: string;
            writer_id: string;
          }
        | undefined;
      const existingOutcome = this.db
        .prepare(
          `SELECT decision, response_json FROM gateway_dispatch_outcomes
           WHERE capability_hash = ?`,
        )
        .get(capabilityHash) as
        | { decision: DelegationGatewayDispatchOutcome["decision"]; response_json: string }
        | undefined;
      if (existingRun || existingOutcome) {
        if (
          existingRun?.run_id === params.runId &&
          existingRun.target_session_key === params.targetSessionKey &&
          existingRun.idempotency_key === params.idempotencyKey &&
          existingRun.writer_id === this.writerId &&
          existingOutcome?.decision === "accepted" &&
          existingOutcome.response_json === responseJson
        ) {
          return { decision: "accepted", response: JSON.parse(responseJson) };
        }
        throw new Error("Gateway dispatch enqueue/outcome is immutable and already decided.");
      }
      this.db
        .prepare(
          `INSERT INTO gateway_dispatch_runs
           (capability_hash, assignment_id, run_id, target_session_key, idempotency_key,
            writer_id, registered_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          capabilityHash,
          row.assignment_id,
          params.runId,
          params.targetSessionKey,
          params.idempotencyKey,
          this.writerId,
          registeredAt,
        );
      this.db
        .prepare(
          `INSERT INTO gateway_dispatch_outcomes
           (capability_hash, assignment_id, decision, response_json, decided_at)
           VALUES (?, ?, 'accepted', ?, ?)`,
        )
        .run(capabilityHash, row.assignment_id, responseJson, registeredAt);
      const acceptedRoute = this.db
        .prepare(
          `SELECT 1 FROM route_events
           WHERE assignment_id = ? AND kind = 'accepted' LIMIT 1`,
        )
        .get(row.assignment_id);
      if (!acceptedRoute) {
        this.appendRouteEvent({
          assignmentId: row.assignment_id,
          kind: "accepted",
          payload: {
            childSessionKey: params.targetSessionKey,
            runId: params.runId,
          },
          createdAt: registeredAt,
        });
      }
      return { decision: "accepted", response: params.response };
    });
  }

  recordGatewayDispatchExecutionCompleted(params: {
    capability: string;
    controllerSessionKey: string;
    targetSessionKey: string;
    idempotencyKey: string;
    runId: string;
    resultText?: string;
    completedAt?: number;
  }): void {
    this.assertActiveStack();
    if (params.runId !== params.idempotencyKey) {
      throw new Error("Guarded Gateway completion must match its immutable idempotency key.");
    }
    const capabilityHash = hashDelegationIdentity(
      "gateway-dispatch-capability-v1",
      params.capability,
    );
    const completedAt = params.completedAt ?? Date.now();
    this.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT c.assignment_id FROM gateway_dispatch_capabilities c
           JOIN gateway_dispatch_uses u ON u.capability_hash = c.capability_hash
           JOIN gateway_dispatch_outcomes o ON o.capability_hash = c.capability_hash
           JOIN gateway_dispatch_runs r ON r.capability_hash = c.capability_hash
           WHERE c.capability_hash = ? AND c.controller_session_key = ?
             AND c.target_session_key = ? AND c.idempotency_key = ? AND c.epoch = ?
             AND o.decision = 'accepted' AND r.run_id = ?
             AND r.target_session_key = ? AND r.idempotency_key = ? AND r.writer_id = ?`,
        )
        .get(
          capabilityHash,
          params.controllerSessionKey,
          params.targetSessionKey,
          params.idempotencyKey,
          this.currentEpoch(),
          params.runId,
          params.targetSessionKey,
          params.idempotencyKey,
          this.writerId,
        ) as { assignment_id: string } | undefined;
      if (!row) {
        throw new Error(
          "Gateway dispatch completion requires its exact accepted run from the current writer.",
        );
      }
      if (this.hasReceiptForAssignment(row.assignment_id)) {
        const existingTerminal = this.db
          .prepare(`SELECT 1 FROM terminal_receipts WHERE assignment_id = ? LIMIT 1`)
          .get(row.assignment_id);
        if (existingTerminal) {
          return;
        }
        if (params.resultText !== undefined) {
          const sha256 = createHash("sha256").update(params.resultText, "utf8").digest("hex");
          this.recordTerminalResultReceipt({
            assignmentId: row.assignment_id,
            runId: params.runId,
            resultReceipt: {
              receiptId: createDelegationRecordId("gateway-result-receipt", {
                assignmentId: row.assignment_id,
                runId: params.runId,
                sha256,
              }),
              sha256,
              bytes: Buffer.byteLength(params.resultText, "utf8"),
              capturedAt: completedAt,
              resultText: params.resultText,
            },
            createdAt: completedAt,
          });
          if (this.acceptedReceiptForAssignment(row.assignment_id)) {
            this.promoteRecordedTerminalCompletion({
              assignmentId: row.assignment_id,
              runId: params.runId,
              createdAt: completedAt,
            });
          }
        }
        return;
      }
      this.appendGatewayCompletionWithoutReceiptIfOpen({
        assignmentId: row.assignment_id,
        targetSessionKey: params.targetSessionKey,
        runId: params.runId,
        createdAt: completedAt,
      });
    });
  }

  recordGatewayDispatchExecutionFailed(params: {
    capability: string;
    controllerSessionKey: string;
    targetSessionKey: string;
    idempotencyKey: string;
    runId: string;
    response: unknown;
    failedAt?: number;
  }): void {
    this.assertActiveStack();
    if (params.runId !== params.idempotencyKey) {
      throw new Error("Guarded Gateway failure must match its immutable idempotency key.");
    }
    const capabilityHash = hashDelegationIdentity(
      "gateway-dispatch-capability-v1",
      params.capability,
    );
    const failedAt = params.failedAt ?? Date.now();
    this.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT c.assignment_id FROM gateway_dispatch_capabilities c
           JOIN gateway_dispatch_uses u ON u.capability_hash = c.capability_hash
           JOIN gateway_dispatch_outcomes o ON o.capability_hash = c.capability_hash
           JOIN gateway_dispatch_runs r ON r.capability_hash = c.capability_hash
           WHERE c.capability_hash = ? AND c.controller_session_key = ?
             AND c.target_session_key = ? AND c.idempotency_key = ? AND c.epoch = ?
             AND o.decision = 'accepted' AND r.run_id = ?
             AND r.target_session_key = ? AND r.idempotency_key = ? AND r.writer_id = ?`,
        )
        .get(
          capabilityHash,
          params.controllerSessionKey,
          params.targetSessionKey,
          params.idempotencyKey,
          this.currentEpoch(),
          params.runId,
          params.targetSessionKey,
          params.idempotencyKey,
          this.writerId,
        ) as { assignment_id: string } | undefined;
      if (!row) {
        throw new Error(
          "Gateway dispatch failure requires its exact accepted run from the current writer.",
        );
      }
      this.appendGatewayRouteRejectionIfOpen({
        assignmentId: row.assignment_id,
        targetSessionKey: params.targetSessionKey,
        runId: params.runId,
        createdAt: failedAt,
        reason: "guarded Gateway agent execution failed",
        response: params.response,
        acceptedRun: true,
      });
    });
  }

  recordGatewayDispatchOutcome(params: {
    capability: string;
    controllerSessionKey: string;
    targetSessionKey: string;
    idempotencyKey: string;
    decision: "rejected";
    response: unknown;
    decidedAt?: number;
    rejectRoute?: boolean;
  }): DelegationGatewayDispatchOutcome {
    this.assertActiveStack();
    const capabilityHash = hashDelegationIdentity(
      "gateway-dispatch-capability-v1",
      params.capability,
    );
    const responseJson = canonicalDelegationJson(params.response);
    const decidedAt = params.decidedAt ?? Date.now();
    return this.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT c.assignment_id FROM gateway_dispatch_capabilities c
           JOIN gateway_dispatch_uses u ON u.capability_hash = c.capability_hash
           WHERE c.capability_hash = ? AND c.controller_session_key = ?
             AND c.target_session_key = ? AND c.idempotency_key = ? AND c.epoch = ?`,
        )
        .get(
          capabilityHash,
          params.controllerSessionKey,
          params.targetSessionKey,
          params.idempotencyKey,
          this.currentEpoch(),
        ) as { assignment_id: string } | undefined;
      if (!row) {
        throw new Error("Gateway dispatch outcome requires its exact current durable claim.");
      }
      const existing = this.db
        .prepare(
          `SELECT decision, response_json FROM gateway_dispatch_outcomes
           WHERE capability_hash = ?`,
        )
        .get(capabilityHash) as
        | { decision: DelegationGatewayDispatchOutcome["decision"]; response_json: string }
        | undefined;
      if (existing) {
        if (existing.decision !== params.decision || existing.response_json !== responseJson) {
          throw new Error("Gateway dispatch outcome is immutable and already decided.");
        }
        return { decision: existing.decision, response: JSON.parse(existing.response_json) };
      }
      this.db
        .prepare(
          `INSERT INTO gateway_dispatch_outcomes
           (capability_hash, assignment_id, decision, response_json, decided_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(capabilityHash, row.assignment_id, params.decision, responseJson, decidedAt);
      if (params.rejectRoute) {
        this.appendGatewayRouteRejectionIfOpen({
          assignmentId: row.assignment_id,
          targetSessionKey: params.targetSessionKey,
          runId: params.idempotencyKey,
          createdAt: decidedAt,
        });
      }
      return { decision: params.decision, response: params.response };
    });
  }

  getAssignment(assignmentId: string): DelegationAssignmentRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM assignments WHERE assignment_id = ?`)
      .get(assignmentId) as AssignmentRow | undefined;
    return row ? assignmentFromRow(row) : undefined;
  }

  bindAssignment(params: {
    assignmentId: string;
    childSessionKey: string;
    runId?: string;
    boundAt?: number;
  }): string {
    const assignment = this.getAssignment(params.assignmentId);
    if (!assignment || assignment.epoch !== this.currentEpoch()) {
      throw new Error("Cannot bind a missing or stale delegation assignment.");
    }
    const conflictingChild = this.db
      .prepare(
        `SELECT child_session_key FROM assignment_bindings
         WHERE assignment_id = ? AND child_session_key <> ? LIMIT 1`,
      )
      .get(params.assignmentId, params.childSessionKey) as
      | { child_session_key: string }
      | undefined;
    if (conflictingChild) {
      throw new Error("A delegation assignment cannot bind more than one child session.");
    }
    const existing = this.db
      .prepare(
        `SELECT binding_id FROM assignment_bindings
         WHERE assignment_id = ? AND child_session_key = ?
           AND COALESCE(run_id, '') = COALESCE(?, '')
         LIMIT 1`,
      )
      .get(params.assignmentId, params.childSessionKey, params.runId ?? null) as
      | { binding_id: string }
      | undefined;
    if (existing) {
      return existing.binding_id;
    }
    const boundAt = params.boundAt ?? Date.now();
    const bindingId = createDelegationRecordId("assignment-binding", {
      assignmentId: params.assignmentId,
      childSessionKey: params.childSessionKey,
      runId: params.runId ?? null,
      boundAt,
    });
    this.db
      .prepare(
        `INSERT INTO assignment_bindings
         (binding_id, assignment_id, child_session_key, run_id, bound_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(bindingId, params.assignmentId, params.childSessionKey, params.runId ?? null, boundAt);
    return bindingId;
  }

  bindInitialSpawnWithGatewayDispatch(params: {
    assignmentId: string;
    controllerSessionKey: string;
    childSessionKey: string;
    idempotencyKey: string;
    capability?: string;
    boundAt?: number;
  }): { bindingId: string; capability: string } {
    this.assertActiveStack();
    if (!params.idempotencyKey.trim()) {
      throw new Error("Guarded initial spawn requires a Gateway idempotency key.");
    }
    const assignment = this.getAssignment(params.assignmentId);
    if (
      !assignment ||
      assignment.epoch !== this.currentEpoch() ||
      assignment.controllerSessionKey !== params.controllerSessionKey
    ) {
      throw new Error(
        "Guarded initial spawn assignment does not belong to this current controller session.",
      );
    }
    const consumedSpawn = this.db
      .prepare(
        `SELECT u.token_hash, u.caller_agent_id, u.caller_session_key, u.target_agent_id
         FROM token_uses u
         JOIN assignment_tokens t ON t.token_hash = u.token_hash
         WHERE u.assignment_id = ? AND u.route_kind = 'spawn' AND t.route_kind = 'spawn'
         LIMIT 1`,
      )
      .get(params.assignmentId) as
      | {
          token_hash: string;
          caller_agent_id: string;
          caller_session_key: string;
          target_agent_id: string;
        }
      | undefined;
    if (
      !consumedSpawn ||
      consumedSpawn.caller_agent_id !== assignment.controllerAgentId ||
      consumedSpawn.caller_session_key !== params.controllerSessionKey ||
      consumedSpawn.target_agent_id !== assignment.workerAgentId
    ) {
      throw new Error(
        "Guarded initial spawn capability requires its exact consumed assignment route.",
      );
    }
    const boundAt = params.boundAt ?? Date.now();
    const capability = params.capability ?? randomBytes(32).toString("base64url");
    const capabilityHash = hashDelegationIdentity("gateway-dispatch-capability-v1", capability);
    return this.transaction(() => {
      this.assertAssignmentOpen(params.assignmentId);
      this.assertNoPriorGatewayDispatch(params.assignmentId);
      const bindingId = this.bindAssignment({
        assignmentId: params.assignmentId,
        childSessionKey: params.childSessionKey,
        runId: params.idempotencyKey,
        boundAt,
      });
      this.db
        .prepare(
          `INSERT INTO gateway_dispatch_capabilities
           (capability_hash, assignment_id, route_token_hash, controller_session_key,
            target_session_key, idempotency_key, epoch, issued_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          capabilityHash,
          params.assignmentId,
          consumedSpawn.token_hash,
          params.controllerSessionKey,
          params.childSessionKey,
          params.idempotencyKey,
          assignment.epoch,
          boundAt,
        );
      return { bindingId, capability };
    });
  }

  resolveAssignmentForChildSession(
    childSessionKey: string,
  ): DelegationAssignmentRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT a.* FROM assignment_bindings b
         JOIN assignments a ON a.assignment_id = b.assignment_id
         WHERE b.child_session_key = ?
         ORDER BY b.bound_at DESC, b.binding_id DESC
         LIMIT 1`,
      )
      .get(childSessionKey) as AssignmentRow | undefined;
    const assignment = row ? assignmentFromRow(row) : undefined;
    if (assignment && assignment.epoch !== this.currentEpoch()) {
      throw new Error("Bound delegation assignment is stale after an epoch change.");
    }
    return assignment;
  }

  isAssignmentCompleted(assignmentId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM route_events
           WHERE assignment_id = ? AND kind = 'completed' LIMIT 1`,
        )
        .get(assignmentId),
    );
  }

  acceptedReceiptForAssignment(
    assignmentId: string,
  ): { receiptId: string; semanticDigest: string; reportJson: string } | undefined {
    return this.db
      .prepare(
        `SELECT r.receipt_id AS receiptId, r.semantic_digest AS semanticDigest,
                r.report_json AS reportJson
         FROM receipts r
         JOIN validations v ON v.receipt_id = r.receipt_id
         WHERE r.assignment_id = ? AND v.outcome = 'accepted'
         ORDER BY v.created_at DESC, v.validation_id DESC
         LIMIT 1`,
      )
      .get(assignmentId) as
      | { receiptId: string; semanticDigest: string; reportJson: string }
      | undefined;
  }

  getReceipt(receiptId: string):
    | {
        receiptId: string;
        assignmentId: string;
        semanticDigest: string;
        reportJson: string;
        correctionOf: string | null;
      }
    | undefined {
    return this.db
      .prepare(
        `SELECT receipt_id AS receiptId, assignment_id AS assignmentId,
                semantic_digest AS semanticDigest, report_json AS reportJson,
                correction_of AS correctionOf
         FROM receipts WHERE receipt_id = ?`,
      )
      .get(receiptId) as
      | {
          receiptId: string;
          assignmentId: string;
          semanticDigest: string;
          reportJson: string;
          correctionOf: string | null;
        }
      | undefined;
  }

  initialReceiptForAssignment(assignmentId: string):
    | {
        receiptId: string;
        assignmentId: string;
        semanticDigest: string;
        reportJson: string;
        correctionOf: null;
      }
    | undefined {
    return this.db
      .prepare(
        `SELECT receipt_id AS receiptId, assignment_id AS assignmentId,
                semantic_digest AS semanticDigest, report_json AS reportJson,
                correction_of AS correctionOf
         FROM receipts
         WHERE assignment_id = ? AND correction_of IS NULL
         LIMIT 1`,
      )
      .get(assignmentId) as
      | {
          receiptId: string;
          assignmentId: string;
          semanticDigest: string;
          reportJson: string;
          correctionOf: null;
        }
      | undefined;
  }

  getValidationForReceipt(receiptId: string):
    | {
        validationId: string;
        outcome: DelegationValidationOutcome;
        validatorId: string;
        validatorVersion: string;
        validatorDigest: string;
        issues: unknown[];
      }
    | undefined {
    const row = this.db
      .prepare(
        `SELECT validation_id AS validationId, outcome,
                validator_id AS validatorId, validator_version AS validatorVersion,
                validator_digest AS validatorDigest, issues_json AS issuesJson
         FROM validations WHERE receipt_id = ?`,
      )
      .get(receiptId) as
      | {
          validationId: string;
          outcome: DelegationValidationOutcome;
          validatorId: string;
          validatorVersion: string;
          validatorDigest: string;
          issuesJson: string;
        }
      | undefined;
    return row
      ? {
          validationId: row.validationId,
          outcome: row.outcome,
          validatorId: row.validatorId,
          validatorVersion: row.validatorVersion,
          validatorDigest: row.validatorDigest,
          issues: JSON.parse(row.issuesJson) as unknown[],
        }
      : undefined;
  }

  reconcilePendingReceiptFinalizationAfterRestart(reconciledAt = Date.now()): number {
    this.assertActiveStack();
    const assignments = this.db
      .prepare(
        `SELECT a.assignment_id
         FROM assignments a
         WHERE a.epoch = ?
           AND EXISTS (SELECT 1 FROM receipts r WHERE r.assignment_id = a.assignment_id)
           AND NOT EXISTS (
             SELECT 1 FROM route_events e
             WHERE e.assignment_id = a.assignment_id
               AND e.kind IN ('route_rejected', 'validation_rejected', 'timeout', 'completed')
           )
         ORDER BY a.assignment_id`,
      )
      .all(this.currentEpoch()) as Array<{ assignment_id: string }>;
    let reconciled = 0;
    for (const row of assignments) {
      const receipt = this.db
        .prepare(
          `SELECT r.receipt_id, v.outcome
           FROM receipts r
           LEFT JOIN validations v ON v.receipt_id = r.receipt_id
           WHERE r.assignment_id = ?
           ORDER BY (r.correction_of IS NOT NULL) DESC, r.created_at DESC, r.receipt_id DESC
           LIMIT 1`,
        )
        .get(row.assignment_id) as
        | { receipt_id: string; outcome: DelegationValidationOutcome | null }
        | undefined;
      if (!receipt) {
        continue;
      }
      let outcome = receipt.outcome;
      if (!outcome) {
        this.appendValidation({
          receiptId: receipt.receipt_id,
          outcome: "blocked",
          issues: [
            {
              code: "validation-interrupted-by-restart",
              message:
                "Gateway restarted after receipt persistence but before protected validation completed.",
            },
          ],
          createdAt: reconciledAt,
        });
        outcome = "blocked";
      }
      if (outcome === "accepted") {
        const terminalReceiptId = this.promoteRecordedTerminalCompletion({
          assignmentId: row.assignment_id,
          createdAt: reconciledAt,
        });
        if (terminalReceiptId) {
          reconciled += 1;
          continue;
        }
      }
      this.appendRouteEvent({
        assignmentId: row.assignment_id,
        kind: "validation_rejected",
        payload: {
          receiptId: receipt.receipt_id,
          code:
            outcome === "accepted"
              ? "terminal-finalization-interrupted-by-restart"
              : "validation-finalization-interrupted-by-restart",
        },
        createdAt: reconciledAt,
      });
      reconciled += 1;
    }
    return reconciled;
  }

  hasReceiptForAssignment(assignmentId: string): boolean {
    return Boolean(
      this.db.prepare(`SELECT 1 FROM receipts WHERE assignment_id = ? LIMIT 1`).get(assignmentId),
    );
  }

  recordTerminalResultReceipt(params: {
    assignmentId: string;
    runId: string;
    resultReceipt: {
      receiptId: string;
      sha256: string;
      bytes: number;
      capturedAt: number;
      resultText: string;
    };
    createdAt?: number;
  }): string {
    this.assertActiveStack();
    if (
      !params.runId.trim() ||
      !params.resultReceipt.receiptId.trim() ||
      !/^[a-f0-9]{64}$/.test(params.resultReceipt.sha256) ||
      !Number.isSafeInteger(params.resultReceipt.bytes) ||
      params.resultReceipt.bytes < 0 ||
      !Number.isSafeInteger(params.resultReceipt.capturedAt) ||
      params.resultReceipt.capturedAt <= 0 ||
      Buffer.byteLength(params.resultReceipt.resultText, "utf8") !== params.resultReceipt.bytes ||
      createHash("sha256").update(params.resultReceipt.resultText, "utf8").digest("hex") !==
        params.resultReceipt.sha256
    ) {
      throw new Error("Guarded terminal receipt metadata is invalid.");
    }
    const protectedResultReceiptJson = canonicalDelegationJson({
      id: params.resultReceipt.receiptId,
      kind: "subagent_result",
      requiredRead: true,
      bytes: params.resultReceipt.bytes,
      sha256: params.resultReceipt.sha256,
      capturedAt: params.resultReceipt.capturedAt,
      resultText: params.resultReceipt.resultText,
    });
    const createdAt = params.createdAt ?? Date.now();
    return this.transaction(() => {
      const assignment = this.getAssignment(params.assignmentId);
      if (!assignment || assignment.epoch !== this.currentEpoch()) {
        throw new Error("Cannot record a terminal result for a missing or stale assignment.");
      }
      const runBinding = this.db
        .prepare(
          `SELECT 1 FROM assignment_bindings
           WHERE assignment_id = ? AND run_id = ? LIMIT 1`,
        )
        .get(params.assignmentId, params.runId);
      if (!runBinding) {
        throw new Error("Delegation assignment is not bound to this terminal run.");
      }
      const existing = this.db
        .prepare(`SELECT * FROM terminal_results WHERE assignment_id = ?`)
        .get(params.assignmentId) as
        | {
            terminal_result_id: string;
            run_id: string;
          }
        | undefined;
      if (existing) {
        if (existing.run_id === params.runId) {
          return existing.terminal_result_id;
        }
        throw new Error("Delegation assignment already has a conflicting terminal result.");
      }
      const terminalResultId = createDelegationRecordId("terminal-result", {
        assignmentId: params.assignmentId,
        runId: params.runId,
        resultReceiptId: params.resultReceipt.receiptId,
        createdAt,
      });
      this.db
        .prepare(
          `INSERT INTO terminal_results
           (terminal_result_id, assignment_id, run_id, result_receipt_id,
            result_receipt_sha256, result_receipt_bytes, result_receipt_captured_at,
            result_receipt_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          terminalResultId,
          params.assignmentId,
          params.runId,
          params.resultReceipt.receiptId,
          params.resultReceipt.sha256,
          params.resultReceipt.bytes,
          params.resultReceipt.capturedAt,
          protectedResultReceiptJson,
          createdAt,
        );
      return terminalResultId;
    });
  }

  promoteRecordedTerminalCompletion(params: {
    assignmentId: string;
    runId?: string;
    createdAt?: number;
  }): string | undefined {
    this.assertActiveStack();
    const createdAt = params.createdAt ?? Date.now();
    return this.transaction(() => {
      const assignment = this.getAssignment(params.assignmentId);
      if (!assignment || assignment.epoch !== this.currentEpoch()) {
        throw new Error("Cannot complete a missing or stale delegation assignment.");
      }
      const terminalResult = this.db
        .prepare(`SELECT * FROM terminal_results WHERE assignment_id = ?`)
        .get(params.assignmentId) as
        | {
            terminal_result_id: string;
            run_id: string;
            result_receipt_id: string;
            result_receipt_sha256: string;
            result_receipt_bytes: number | bigint;
            result_receipt_captured_at: number | bigint;
            result_receipt_json: string;
          }
        | undefined;
      if (!terminalResult) {
        return undefined;
      }
      if (params.runId && terminalResult.run_id !== params.runId) {
        throw new Error("Recorded terminal result belongs to a different assignment run.");
      }
      const runId = terminalResult.run_id;
      const runBinding = this.db
        .prepare(
          `SELECT 1 FROM assignment_bindings
           WHERE assignment_id = ? AND run_id = ? LIMIT 1`,
        )
        .get(params.assignmentId, runId);
      if (!runBinding) {
        throw new Error("Delegation assignment is not bound to this terminal run.");
      }
      const routeDecision = this.db
        .prepare(
          `SELECT
             MAX(CASE WHEN kind = 'accepted' THEN 1 ELSE 0 END) AS accepted,
             MAX(CASE WHEN kind = 'route_rejected' THEN 1 ELSE 0 END) AS rejected,
             MAX(CASE WHEN kind = 'timeout' THEN 1 ELSE 0 END) AS timed_out,
             MAX(CASE WHEN kind = 'validation_rejected' THEN 1 ELSE 0 END) AS validation_rejected
           FROM route_events WHERE assignment_id = ?`,
        )
        .get(params.assignmentId) as {
        accepted: number | bigint;
        rejected: number | bigint;
        timed_out: number | bigint;
        validation_rejected: number | bigint;
      };
      const acceptedCorrection = this.db
        .prepare(
          `SELECT 1 FROM correction_uses c
           JOIN validations v ON v.receipt_id = c.corrected_receipt_id
           WHERE c.assignment_id = ? AND v.outcome = 'accepted' LIMIT 1`,
        )
        .get(params.assignmentId);
      if (
        toNumber(routeDecision.accepted) !== 1 ||
        toNumber(routeDecision.rejected) !== 0 ||
        toNumber(routeDecision.timed_out) !== 0 ||
        (toNumber(routeDecision.validation_rejected) !== 0 && !acceptedCorrection)
      ) {
        throw new Error(
          "Delegation completion requires one accepted route with no rejection or timeout.",
        );
      }
      if (assignment.purpose === "verification" && assignment.waveId) {
        for (const role of ["tester", "reviewer"] as const) {
          const started = this.db
            .prepare(
              `SELECT 1 FROM assignments a
               JOIN route_events e ON e.assignment_id = a.assignment_id
               WHERE a.wave_id = ? AND a.purpose = 'verification' AND a.role = ?
                 AND e.kind = 'accepted'
               LIMIT 1`,
            )
            .get(assignment.waveId, role);
          if (!started) {
            throw new Error(
              "Tester and reviewer routes must both start on the frozen candidate before either can complete.",
            );
          }
        }
      }
      const existing = this.db
        .prepare(`SELECT * FROM terminal_receipts WHERE assignment_id = ?`)
        .get(params.assignmentId) as
        | {
            terminal_receipt_id: string;
            run_id: string;
          }
        | undefined;
      if (existing) {
        // Completion delivery can be observed more than once. The first protected
        // terminal receipt remains authoritative; a duplicate callback for the
        // same immutable run must not turn a successful route into a failure just
        // because the compatibility transport receipt was recaptured later.
        if (existing.run_id === runId) {
          return existing.terminal_receipt_id;
        }
        throw new Error("Delegation assignment already has a conflicting terminal receipt.");
      }
      const duplicate = this.db
        .prepare(
          `SELECT 1 FROM route_events
           WHERE assignment_id = ? AND kind = 'completed' LIMIT 1`,
        )
        .get(params.assignmentId);
      if (duplicate) {
        throw new Error("Delegation assignment already has a completed terminal event.");
      }
      const accepted = this.acceptedReceiptForAssignment(params.assignmentId);
      if (!accepted) {
        return undefined;
      }
      const terminalReceiptId = createDelegationRecordId("terminal-receipt", {
        assignmentId: params.assignmentId,
        runId,
        acceptedReceiptId: accepted.receiptId,
        resultReceiptId: terminalResult.result_receipt_id,
        createdAt,
      });
      this.db
        .prepare(
          `INSERT INTO terminal_receipts
           (terminal_receipt_id, assignment_id, run_id, accepted_receipt_id,
            accepted_semantic_digest, accepted_report_json, result_receipt_id,
            result_receipt_sha256, result_receipt_bytes, result_receipt_captured_at,
            result_receipt_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          terminalReceiptId,
          params.assignmentId,
          runId,
          accepted.receiptId,
          accepted.semanticDigest,
          accepted.reportJson,
          terminalResult.result_receipt_id,
          terminalResult.result_receipt_sha256,
          toNumber(terminalResult.result_receipt_bytes),
          toNumber(terminalResult.result_receipt_captured_at),
          terminalResult.result_receipt_json,
          createdAt,
        );
      const eventId = createDelegationRecordId("route-event", {
        assignmentId: params.assignmentId,
        kind: "completed",
        terminalReceiptId,
        createdAt,
      });
      this.db
        .prepare(
          `INSERT INTO route_events (event_id, assignment_id, kind, payload_json, created_at)
           VALUES (?, ?, 'completed', ?, ?)`,
        )
        .run(
          eventId,
          params.assignmentId,
          canonicalDelegationJson({
            runId,
            terminalReceiptId,
            acceptedReceiptId: accepted.receiptId,
            acceptedSemanticDigest: accepted.semanticDigest,
            resultReceipt: {
              receiptId: terminalResult.result_receipt_id,
              sha256: terminalResult.result_receipt_sha256,
              bytes: toNumber(terminalResult.result_receipt_bytes),
              capturedAt: toNumber(terminalResult.result_receipt_captured_at),
            },
          }),
          createdAt,
        );
      return terminalReceiptId;
    });
  }

  recordAcceptedTerminalCompletion(params: {
    assignmentId: string;
    runId: string;
    resultReceipt: {
      receiptId: string;
      sha256: string;
      bytes: number;
      capturedAt: number;
      resultText: string;
    };
    createdAt?: number;
  }): string {
    this.recordTerminalResultReceipt(params);
    const terminalReceiptId = this.promoteRecordedTerminalCompletion({
      assignmentId: params.assignmentId,
      runId: params.runId,
      createdAt: params.createdAt,
    });
    if (!terminalReceiptId) {
      throw new Error("Delegation assignment has no accepted validated report.");
    }
    return terminalReceiptId;
  }

  private resolveAssignmentToken(params: {
    delegationToken: string;
    routeKind: DelegationRouteKind;
    callerAgentId: string;
    callerSessionKey?: string;
    targetAgentId: string;
    targetSessionKey?: string;
  }): { assignment: DelegationAssignmentRecord; tokenHash: string } {
    this.assertActiveStack();
    const tokenHash = hashDelegationIdentity("delegation-token-v1", params.delegationToken);
    const row = this.db
      .prepare(
        `SELECT a.*, t.route_kind AS token_route_kind,
                t.target_session_key AS token_target_session_key
         FROM assignment_tokens t
         JOIN assignments a ON a.assignment_id = t.assignment_id
         WHERE t.token_hash = ?`,
      )
      .get(tokenHash) as
      | (AssignmentRow & {
          token_route_kind: DelegationRouteKind;
          token_target_session_key: string | null;
        })
      | undefined;
    if (!row) {
      throw new Error("Unknown delegation token.");
    }
    const assignment = assignmentFromRow(row);
    if (
      assignment.epoch !== this.currentEpoch() ||
      assignment.controllerAgentId !== params.callerAgentId ||
      assignment.controllerSessionKey !== params.callerSessionKey ||
      assignment.workerAgentId !== params.targetAgentId ||
      row.token_route_kind !== params.routeKind ||
      (row.token_target_session_key ?? undefined) !== params.targetSessionKey
    ) {
      throw new Error("Delegation token is stale or does not match this controller/worker route.");
    }
    return { assignment, tokenHash };
  }

  consumeAssignmentToken(params: {
    delegationToken: string;
    routeKind: DelegationRouteKind;
    callerAgentId: string;
    callerSessionKey?: string;
    targetAgentId: string;
    targetSessionKey?: string;
    usedAt?: number;
  }): DelegationAssignmentRecord {
    const { assignment, tokenHash } = this.resolveAssignmentToken(params);
    this.transaction(() => {
      this.assertAssignmentOpen(assignment.assignmentId);
      this.db
        .prepare(
          `INSERT INTO token_uses
           (token_hash, assignment_id, route_kind, caller_agent_id, caller_session_key,
            target_agent_id, target_session_key, used_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          tokenHash,
          assignment.assignmentId,
          params.routeKind,
          params.callerAgentId,
          params.callerSessionKey ?? null,
          params.targetAgentId,
          params.targetSessionKey ?? null,
          params.usedAt ?? Date.now(),
        );
    });
    return assignment;
  }

  consumeSendTokenWithGatewayDispatch(params: {
    delegationToken: string;
    routeKind?: Extract<DelegationRouteKind, "send" | "steer">;
    callerAgentId: string;
    callerSessionKey: string;
    targetAgentId: string;
    targetSessionKey: string;
    idempotencyKey: string;
    capability?: string;
    usedAt?: number;
  }): { assignment: DelegationAssignmentRecord; capability: string } {
    const routeKind = params.routeKind ?? "send";
    if (!params.idempotencyKey.trim()) {
      throw new Error(`Guarded ${routeKind} requires a Gateway idempotency key.`);
    }
    const { assignment, tokenHash } = this.resolveAssignmentToken({
      ...params,
      routeKind,
    });
    const usedAt = params.usedAt ?? Date.now();
    const capability = params.capability ?? randomBytes(32).toString("base64url");
    const capabilityHash = hashDelegationIdentity("gateway-dispatch-capability-v1", capability);
    this.transaction(() => {
      this.assertAssignmentOpen(assignment.assignmentId);
      this.assertNoPriorGatewayDispatch(assignment.assignmentId);
      this.db
        .prepare(
          `INSERT INTO token_uses
           (token_hash, assignment_id, route_kind, caller_agent_id, caller_session_key,
            target_agent_id, target_session_key, used_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          tokenHash,
          assignment.assignmentId,
          routeKind,
          params.callerAgentId,
          params.callerSessionKey,
          params.targetAgentId,
          params.targetSessionKey,
          usedAt,
        );
      this.db
        .prepare(
          `INSERT INTO gateway_dispatch_capabilities
           (capability_hash, assignment_id, route_token_hash, controller_session_key,
            target_session_key, idempotency_key, epoch, issued_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          capabilityHash,
          assignment.assignmentId,
          tokenHash,
          params.callerSessionKey,
          params.targetSessionKey,
          params.idempotencyKey,
          assignment.epoch,
          usedAt,
        );
    });
    return { assignment, capability };
  }

  appendRouteEvent(params: {
    assignmentId: string;
    kind: "accepted" | "route_rejected" | "validation_rejected" | "timeout";
    payload?: unknown;
    createdAt?: number;
  }): string {
    this.assertActiveStack();
    const createdAt = params.createdAt ?? Date.now();
    return this.transaction(() => {
      const assignment = this.getAssignment(params.assignmentId);
      if (!assignment || assignment.epoch !== this.currentEpoch()) {
        throw new Error("Cannot append a route event to a missing or stale assignment.");
      }
      const acceptedGatewayRun = Boolean(
        this.db
          .prepare(
            `SELECT 1 FROM gateway_dispatch_outcomes o
             JOIN gateway_dispatch_runs r ON r.capability_hash = o.capability_hash
             WHERE o.assignment_id = ? AND o.decision = 'accepted' LIMIT 1`,
          )
          .get(params.assignmentId),
      );
      const kind =
        params.kind === "route_rejected" && acceptedGatewayRun
          ? "validation_rejected"
          : params.kind;
      const payload =
        params.kind === "route_rejected" && acceptedGatewayRun
          ? {
              code: "accepted-gateway-run-outcome-uncertain",
              requestedKind: "route_rejected",
              evidence: params.payload ?? {},
            }
          : (params.payload ?? {});
      const payloadJson = canonicalDelegationJson(payload);
      const eventId = createDelegationRecordId("route-event", {
        assignmentId: params.assignmentId,
        kind,
        payload,
        createdAt,
        nonce: randomUUID(),
      });
      const rows = this.db
        .prepare(
          `SELECT event_id, kind, payload_json FROM route_events
           WHERE assignment_id = ? ORDER BY created_at, event_id`,
        )
        .all(params.assignmentId) as Array<{
        event_id: string;
        kind: string;
        payload_json: string;
      }>;
      const has = (kind: string) => rows.some((row) => row.kind === kind);
      const priorSame = rows.find((row) => row.kind === kind);
      if (priorSame && kind !== "validation_rejected" && priorSame.payload_json === payloadJson) {
        return priorSame.event_id;
      }
      if (has("completed")) {
        throw new Error("A completed delegation route cannot accept additional route events.");
      }
      if (kind === "accepted" && (has("route_rejected") || has("timeout"))) {
        throw new Error(
          "Delegation route acceptance violates the protected route transition order.",
        );
      }
      if (
        kind === "route_rejected" &&
        (has("route_rejected") ||
          has("timeout") ||
          Boolean(
            this.db
              .prepare(`SELECT 1 FROM receipts WHERE assignment_id = ? LIMIT 1`)
              .get(params.assignmentId),
          ))
      ) {
        throw new Error(
          "Delegation route rejection must precede any report and cannot follow another terminal route decision.",
        );
      }
      if (kind === "timeout" && (!has("accepted") || has("timeout"))) {
        throw new Error("Delegation timeout requires one accepted, non-timeout route.");
      }
      if (
        kind === "timeout" &&
        this.db
          .prepare(`SELECT 1 FROM receipts WHERE assignment_id = ? LIMIT 1`)
          .get(params.assignmentId)
      ) {
        throw new Error("A submitted delegation report cannot be relabeled as a route timeout.");
      }
      if (kind === "validation_rejected" && !has("accepted") && !acceptedGatewayRun) {
        throw new Error("Delegation validation rejection requires an accepted worker route.");
      }
      this.db
        .prepare(
          `INSERT INTO route_events (event_id, assignment_id, kind, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(eventId, params.assignmentId, kind, payloadJson, createdAt);
      return eventId;
    });
  }

  appendReceipt(params: {
    assignmentId: string;
    report: DelegationWorkerReport;
    semanticDigest?: string;
    createdAt?: number;
  }): string {
    this.assertActiveStack();
    validateDelegationReportCoverage(params.report);
    return this.appendInitialReceiptRecord(params);
  }

  appendRejectedReceipt(params: {
    assignmentId: string;
    report: DelegationWorkerReport;
    issues: unknown[];
    createdAt?: number;
  }): { receiptId: string; validationId: string; semanticDigest: string } {
    this.assertActiveStack();
    if (params.issues.length === 0) {
      throw new Error("A rejected delegation receipt requires at least one protected issue.");
    }
    return this.appendValidatedReceipt({
      ...params,
      outcome: "rejected",
    });
  }

  appendValidatedReceipt(params: {
    assignmentId: string;
    report: DelegationWorkerReport;
    outcome: DelegationValidationOutcome;
    issues?: unknown[];
    createdAt?: number;
  }): { receiptId: string; validationId: string; semanticDigest: string } {
    this.assertActiveStack();
    return this.transaction(() => {
      const receiptId = this.appendInitialReceiptRecord(params);
      const validationId = this.appendValidation({
        receiptId,
        outcome: params.outcome,
        issues: params.issues ?? [],
        createdAt: params.createdAt,
      });
      const receipt = this.getReceipt(receiptId);
      if (!receipt) {
        throw new Error("Protected validated receipt could not be read back after persistence.");
      }
      return { receiptId, validationId, semanticDigest: receipt.semanticDigest };
    });
  }

  private appendInitialReceiptRecord(params: {
    assignmentId: string;
    report: DelegationWorkerReport;
    semanticDigest?: string;
    createdAt?: number;
  }): string {
    const assignment = this.getAssignment(params.assignmentId);
    if (!assignment || assignment.epoch !== this.currentEpoch()) {
      throw new Error("Delegation report cannot bind a missing or stale assignment.");
    }
    const assigned = [...params.report.scope.assigned].toSorted();
    const authoritativeScope = [...assignment.scopeUnits].toSorted();
    if (canonicalDelegationJson(assigned) !== canonicalDelegationJson(authoritativeScope)) {
      throw new Error("Delegation report assigned scope does not match the protected assignment.");
    }
    const reportJson = canonicalDelegationJson(params.report);
    const semanticDigest = hashDelegationReportSemantics(params.report);
    if (params.semanticDigest && params.semanticDigest !== semanticDigest) {
      throw new Error("Caller-provided report digest does not match runtime-owned semantics.");
    }
    const existing = this.db
      .prepare(
        `SELECT receipt_id AS receiptId, semantic_digest AS semanticDigest,
                report_json AS reportJson
         FROM receipts
         WHERE assignment_id = ? AND correction_of IS NULL
         LIMIT 1`,
      )
      .get(params.assignmentId) as
      | { receiptId: string; semanticDigest: string; reportJson: string }
      | undefined;
    if (existing) {
      if (existing.semanticDigest === semanticDigest && existing.reportJson === reportJson) {
        return existing.receiptId;
      }
      throw new Error("A delegation assignment can submit only one immutable initial report.");
    }
    const terminalRoute = this.db
      .prepare(
        `SELECT 1 FROM route_events
         WHERE assignment_id = ? AND kind IN ('route_rejected', 'timeout', 'completed') LIMIT 1`,
      )
      .get(params.assignmentId);
    const remediationFrozen =
      assignment.waveId && assignment.purpose !== "remediation"
        ? this.db
            .prepare(`SELECT 1 FROM remediation_revisions WHERE source_wave_id = ? LIMIT 1`)
            .get(assignment.waveId)
        : undefined;
    if (terminalRoute || remediationFrozen) {
      throw new Error("Delegation report arrived after its route or review wave was closed.");
    }
    const createdAt = params.createdAt ?? Date.now();
    const receiptId = createDelegationRecordId("receipt", {
      assignmentId: params.assignmentId,
      semanticDigest,
      createdAt,
      nonce: randomUUID(),
    });
    this.db
      .prepare(
        `INSERT INTO receipts
         (receipt_id, assignment_id, semantic_digest, report_json, correction_of, created_at)
         VALUES (?, ?, ?, ?, NULL, ?)`,
      )
      .run(receiptId, params.assignmentId, semanticDigest, reportJson, createdAt);
    return receiptId;
  }

  appendValidation(params: {
    receiptId: string;
    outcome: DelegationValidationOutcome;
    issues?: unknown[];
    createdAt?: number;
  }): string {
    this.assertActiveStack();
    const issuesJson = canonicalDelegationJson(params.issues ?? []);
    const existing = this.db
      .prepare(
        `SELECT validation_id AS validationId, outcome, validator_id AS validatorId,
                validator_version AS validatorVersion, validator_digest AS validatorDigest,
                issues_json AS issuesJson
         FROM validations WHERE receipt_id = ? LIMIT 1`,
      )
      .get(params.receiptId) as
      | {
          validationId: string;
          outcome: DelegationValidationOutcome;
          validatorId: string;
          validatorVersion: string;
          validatorDigest: string;
          issuesJson: string;
        }
      | undefined;
    if (existing) {
      if (
        existing.outcome === params.outcome &&
        existing.validatorId === this.guard.validator.id &&
        existing.validatorVersion === this.guard.validator.version &&
        existing.validatorDigest === this.guard.validator.sha256 &&
        existing.issuesJson === issuesJson
      ) {
        return existing.validationId;
      }
      throw new Error("A protected delegation receipt can be validated only once.");
    }
    const createdAt = params.createdAt ?? Date.now();
    const validationId = createDelegationRecordId("validation", {
      ...params,
      validator: this.guard.validator,
      createdAt,
      nonce: randomUUID(),
    });
    this.db
      .prepare(
        `INSERT INTO validations
         (validation_id, receipt_id, outcome, validator_id, validator_version,
          validator_digest, issues_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        validationId,
        params.receiptId,
        params.outcome,
        this.guard.validator.id,
        this.guard.validator.version,
        this.guard.validator.sha256,
        issuesJson,
        createdAt,
      );
    return validationId;
  }

  appendFormatCorrection(params: {
    assignmentId: string;
    originalReceiptId: string;
    report: DelegationWorkerReport;
    createdAt?: number;
  }): string {
    this.assertActiveStack();
    validateDelegationReportCoverage(params.report);
    const assignment = this.getAssignment(params.assignmentId);
    if (!assignment || assignment.epoch !== this.currentEpoch()) {
      throw new Error("Format correction cannot bind a missing or stale assignment.");
    }
    const semanticDigest = hashDelegationReportSemantics(params.report);
    const reportJson = canonicalDelegationJson(params.report);
    const original = this.db
      .prepare(
        `SELECT r.assignment_id, r.semantic_digest, r.correction_of, v.outcome
         FROM receipts r
         LEFT JOIN validations v ON v.receipt_id = r.receipt_id
         WHERE r.receipt_id = ?`,
      )
      .get(params.originalReceiptId) as
      | {
          assignment_id: string;
          semantic_digest: string;
          correction_of: string | null;
          outcome: DelegationValidationOutcome | null;
        }
      | undefined;
    if (
      !original ||
      original.assignment_id !== params.assignmentId ||
      original.semantic_digest !== semanticDigest ||
      original.correction_of !== null ||
      (original.outcome !== "rejected" && original.outcome !== "blocked")
    ) {
      throw new Error(
        "Format correction requires one rejected initial receipt and must preserve its assignment and semantic digest.",
      );
    }
    const existingCorrection = this.db
      .prepare(
        `SELECT r.receipt_id AS receiptId, r.semantic_digest AS semanticDigest,
                r.report_json AS reportJson, c.original_receipt_id AS originalReceiptId
         FROM correction_uses c
         JOIN receipts r ON r.receipt_id = c.corrected_receipt_id
         WHERE c.assignment_id = ?`,
      )
      .get(params.assignmentId) as
      | {
          receiptId: string;
          semanticDigest: string;
          reportJson: string;
          originalReceiptId: string;
        }
      | undefined;
    if (existingCorrection) {
      if (
        existingCorrection.originalReceiptId === params.originalReceiptId &&
        existingCorrection.semanticDigest === semanticDigest &&
        existingCorrection.reportJson === reportJson
      ) {
        return existingCorrection.receiptId;
      }
      throw new Error("A delegation assignment permits only one immutable format correction.");
    }
    const createdAt = params.createdAt ?? Date.now();
    const correctedReceiptId = createDelegationRecordId("receipt", {
      assignmentId: params.assignmentId,
      semanticDigest,
      correctionOf: params.originalReceiptId,
      createdAt,
      nonce: randomUUID(),
    });
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO receipts
           (receipt_id, assignment_id, semantic_digest, report_json, correction_of, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          correctedReceiptId,
          params.assignmentId,
          semanticDigest,
          reportJson,
          params.originalReceiptId,
          createdAt,
        );
      this.db
        .prepare(
          `INSERT INTO correction_uses
           (correction_id, assignment_id, original_receipt_id, corrected_receipt_id,
            semantic_digest, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          createDelegationRecordId("correction", {
            assignmentId: params.assignmentId,
            createdAt,
          }),
          params.assignmentId,
          params.originalReceiptId,
          correctedReceiptId,
          semanticDigest,
          createdAt,
        );
    });
    return correctedReceiptId;
  }

  appendRemediationRevision(params: {
    sliceId: string;
    sourceWaveId: string;
    dispositions: DelegationRemediationDisposition[];
    createdAt?: number;
  }): string {
    this.assertWaveSettledForRemediation(params.sourceWaveId);
    const sourceWave = this.db
      .prepare(`SELECT slice_id, kind, epoch FROM waves WHERE wave_id = ?`)
      .get(params.sourceWaveId) as
      | { slice_id: string; kind: "verification" | "confirmation"; epoch: number | bigint }
      | undefined;
    if (
      !sourceWave ||
      sourceWave.slice_id !== params.sliceId ||
      toNumber(sourceWave.epoch) !== this.currentEpoch()
    ) {
      throw new Error("Remediation source wave is stale or belongs to another slice.");
    }
    const current = this.db
      .prepare(`SELECT COUNT(*) AS count FROM remediation_revisions WHERE slice_id = ?`)
      .get(params.sliceId) as CountRow;
    const ordinal = toNumber(current.count) + 1;
    if (ordinal > 2) {
      throw new Error("A guarded slice permits only one remediation and one bounded follow-up.");
    }
    if (
      (ordinal === 1 && sourceWave.kind !== "verification") ||
      (ordinal === 2 && sourceWave.kind !== "confirmation")
    ) {
      throw new Error(
        "Remediation revisions must follow verification, then targeted confirmation.",
      );
    }
    const terminalReports = this.db
      .prepare(
        `SELECT a.assignment_id, t.accepted_report_json
         FROM assignments a
         JOIN terminal_receipts t ON t.assignment_id = a.assignment_id
         WHERE a.wave_id = ?
         ORDER BY a.assignment_id`,
      )
      .all(params.sourceWaveId) as Array<{
      assignment_id: string;
      accepted_report_json: string;
    }>;
    const authoritativeFindings: Array<{
      assignmentId: string;
      finding: DelegationWorkerReport["findings"][number];
    }> = [];
    for (const row of terminalReports) {
      const report = JSON.parse(row.accepted_report_json) as DelegationWorkerReport;
      if (
        ordinal === 2 &&
        (report.coverage !== "complete" ||
          report.scope.omitted.length > 0 ||
          report.scope.failed.length > 0)
      ) {
        throw new Error(
          "A remediation follow-up requires complete confirmation evidence with no omission.",
        );
      }
      for (const finding of report.findings) {
        authoritativeFindings.push({ assignmentId: row.assignment_id, finding });
      }
    }
    if (authoritativeFindings.length === 0) {
      throw new Error("Consolidated remediation requires at least one validated finding.");
    }
    const expectedKeys = authoritativeFindings
      .map(({ assignmentId, finding }) => `${assignmentId}\0${finding.localId}`)
      .toSorted();
    const dispositionKeys = params.dispositions
      .map((entry) => `${entry.assignmentId}\0${entry.localId}`)
      .toSorted();
    if (
      new Set(dispositionKeys).size !== dispositionKeys.length ||
      canonicalDelegationJson(dispositionKeys) !== canonicalDelegationJson(expectedKeys)
    ) {
      throw new Error(
        "The remediation ledger must disposition every validated finding exactly once.",
      );
    }
    const dispositionByKey = new Map(
      params.dispositions.map((entry) => [`${entry.assignmentId}\0${entry.localId}`, entry]),
    );
    const findings = authoritativeFindings.map((source) => {
      const disposition = dispositionByKey.get(`${source.assignmentId}\0${source.finding.localId}`);
      if (!disposition?.rationale.trim()) {
        throw new Error("Every remediation disposition requires a rationale.");
      }
      return { source, disposition };
    });
    if (ordinal === 2) {
      if (
        findings.some(
          ({ source }) =>
            source.finding.severity !== "blocker" ||
            source.finding.proposedProvenance !== "change-induced",
        )
      ) {
        throw new Error(
          "The one remediation follow-up is limited to blockers introduced by remediation.",
        );
      }
      const prior = this.db
        .prepare(
          `SELECT findings_json FROM remediation_revisions
           WHERE slice_id = ? AND ordinal = 1`,
        )
        .get(params.sliceId) as { findings_json: string } | undefined;
      const priorSummaries = new Set<string>();
      if (prior) {
        const records = JSON.parse(prior.findings_json) as Array<{
          source?: { finding?: { summary?: string } };
        }>;
        for (const record of records) {
          const summary = record.source?.finding?.summary?.trim().toLocaleLowerCase("en-US");
          if (summary) {
            priorSummaries.add(summary);
          }
        }
      }
      if (
        findings.some(({ source }) =>
          priorSummaries.has(source.finding.summary.trim().toLocaleLowerCase("en-US")),
        )
      ) {
        throw new Error(
          "An equivalent blocker repeated after remediation; close as blocked/new-slice.",
        );
      }
    }
    const findingsDigest = hashDelegationIdentity("delegation-remediation-findings-v1", findings);
    const createdAt = params.createdAt ?? Date.now();
    const revisionId = createDelegationRecordId("remediation", {
      sliceId: params.sliceId,
      sourceWaveId: params.sourceWaveId,
      ordinal,
      findingsDigest,
      createdAt,
    });
    this.db
      .prepare(
        `INSERT INTO remediation_revisions
         (revision_id, slice_id, source_wave_id, ordinal, findings_digest, findings_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        revisionId,
        params.sliceId,
        params.sourceWaveId,
        ordinal,
        findingsDigest,
        canonicalDelegationJson(findings),
        createdAt,
      );
    return revisionId;
  }

  nextRemediationOrdinal(sliceId: string): number {
    this.assertActiveStack();
    const slice = this.getSliceScope(sliceId);
    if (!slice || slice.epoch !== this.currentEpoch()) {
      throw new Error("Cannot resolve remediation revision for a missing or stale slice.");
    }
    const current = this.db
      .prepare(`SELECT COUNT(*) AS count FROM remediation_revisions WHERE slice_id = ?`)
      .get(sliceId) as CountRow;
    return toNumber(current.count) + 1;
  }

  assertWaveSettledForRemediation(waveId: string): void {
    const wave = this.db
      .prepare(`SELECT kind, required_roles_json, epoch FROM waves WHERE wave_id = ?`)
      .get(waveId) as
      | {
          kind: "verification" | "confirmation";
          required_roles_json: string;
          epoch: number | bigint;
        }
      | undefined;
    if (!wave || toNumber(wave.epoch) !== this.currentEpoch()) {
      throw new Error("Remediation requires a current guarded verification wave.");
    }
    const requiredRoles = JSON.parse(wave.required_roles_json) as string[];
    for (const role of requiredRoles) {
      const families = this.db
        .prepare(
          `SELECT route_family_id
           FROM assignments WHERE wave_id = ? AND role = ?
           GROUP BY route_family_id`,
        )
        .all(waveId, role) as Array<{ route_family_id: string }>;
      if (families.length === 0) {
        throw new Error(`Required guarded role ${role} has no assignment.`);
      }
      for (const family of families) {
        const terminalReports = this.db
          .prepare(
            `SELECT t.accepted_report_json
             FROM assignments a
             JOIN terminal_receipts t ON t.assignment_id = a.assignment_id
             WHERE a.wave_id = ? AND a.role = ? AND a.route_family_id = ?`,
          )
          .all(waveId, role, family.route_family_id) as Array<{
          accepted_report_json: string;
        }>;
        if (terminalReports.length !== 1) {
          const timedOut = this.db
            .prepare(
              `SELECT 1 FROM assignments a
               JOIN route_events e ON e.assignment_id = a.assignment_id
               WHERE a.route_family_id = ? AND e.kind = 'timeout' LIMIT 1`,
            )
            .get(family.route_family_id);
          throw new Error(
            timedOut
              ? `A timed-out ${role} route cannot authorize remediation progression.`
              : `Required ${role} route family has no validated terminal receipt.`,
          );
        }
        if (!isProgressableTerminalReport(terminalReports[0].accepted_report_json)) {
          throw new Error(
            `A blocked or incomplete ${role} report cannot authorize remediation progression.`,
          );
        }
      }
    }
    if (wave.kind !== "verification") {
      return;
    }
    const qaReports = this.db
      .prepare(
        `SELECT t.accepted_report_json
         FROM assignments a
         JOIN terminal_receipts t ON t.assignment_id = a.assignment_id
         WHERE a.wave_id = ? AND a.role = 'qa' AND a.purpose = 'qa'`,
      )
      .all(waveId) as Array<{ accepted_report_json: string }>;
    if (qaReports.length !== 1) {
      throw new Error(
        "A settled tester/reviewer wave requires one validated terminal QA receipt; timeout is not approval.",
      );
    }
    if (!isProgressableTerminalReport(qaReports[0].accepted_report_json)) {
      throw new Error(
        "A blocked or incomplete QA report cannot authorize remediation progression.",
      );
    }
  }

  rollback(params: { actorAgentId: string; reason: string; createdAt?: number }): number {
    this.assertActiveStack();
    const createdAt = params.createdAt ?? Date.now();
    const epoch = this.currentEpoch() + 1;
    this.transaction(() => {
      this.assertNoOpenAssignmentsForEpoch(epoch - 1);
      this.db
        .prepare(
          `INSERT INTO epoch_events
           (event_id, epoch, kind, contract_version, validator_id, validator_version,
            validator_digest, policy_digest, actor_agent_id, reason, created_at)
           VALUES (?, ?, 'rollback', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          createDelegationRecordId("epoch", { epoch, createdAt, reason: params.reason }),
          epoch,
          DELEGATION_CONTRACT_VERSION,
          this.guard.validator.id,
          this.guard.validator.version,
          this.guard.validator.sha256,
          this.policyDigest,
          params.actorAgentId,
          params.reason,
          createdAt,
        );
    });
    return epoch;
  }

  status(): DelegationLedgerStatus {
    const count = (table: string): number => {
      const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as CountRow;
      return toNumber(row.count);
    };
    return {
      epoch: this.currentEpoch(),
      auditEvents: count("audit_events"),
      slices: count("slices"),
      candidates: count("candidates"),
      waves: count("waves"),
      assignments: count("assignments"),
      receipts: count("receipts"),
      validations: count("validations"),
      terminalResults: count("terminal_results"),
      remediationRevisions: count("remediation_revisions"),
    };
  }
}

const ledgerCache = new Map<string, DelegationLedger>();

export function openDelegationLedger(params: {
  guard: DelegationGuardConfig;
  policyDigest: string;
  stateDir?: string;
  reconcileGatewayTask: (params: {
    runId: string;
    targetSessionKey: string;
    requiredTask: boolean;
  }) => DelegationGatewayTaskReconciliationOutcome;
  reconcileTerminalGatewayTask?: (params: {
    runId: string;
    targetSessionKey: string;
    terminalKind: DelegationGatewayTerminalKind;
  }) => void;
  reconcileInitialSpawnTask?: (params: {
    runId: string;
    targetSessionKey: string;
  }) => DelegationGatewayTaskReconciliationOutcome;
}): DelegationLedger {
  verifyPinnedDelegationValidator(params.guard.validator, { stateDir: params.stateDir });
  const pathname = path.join(params.stateDir ?? resolveStateDir(), "delegation", "ledger.sqlite");
  const cached = ledgerCache.get(pathname);
  if (cached) {
    cached.assertConfiguredStack({
      guard: params.guard,
      policyDigest: params.policyDigest,
    });
    return cached;
  }
  ensurePermissions(pathname);
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(pathname);
  db.exec(`PRAGMA foreign_keys = ON;`);
  db.exec(`PRAGMA locking_mode = EXCLUSIVE;`);
  db.exec(`PRAGMA journal_mode = WAL;`);
  db.exec(`PRAGMA synchronous = FULL;`);
  db.exec(`PRAGMA busy_timeout = 5000;`);
  db.exec(`BEGIN IMMEDIATE; COMMIT;`);
  ensureSchema(db);
  const existingEpoch = db
    .prepare(`SELECT * FROM epoch_events ORDER BY epoch DESC LIMIT 1`)
    .get() as EpochRow | undefined;
  if (!existingEpoch) {
    const createdAt = Date.now();
    db.prepare(
      `INSERT INTO epoch_events
       (event_id, epoch, kind, contract_version, validator_id, validator_version,
        validator_digest, policy_digest, actor_agent_id, reason, created_at)
       VALUES (?, 1, 'initial', ?, ?, ?, ?, ?, NULL, 'initial protected epoch', ?)`,
    ).run(
      createDelegationRecordId("epoch", { epoch: 1, createdAt }),
      DELEGATION_CONTRACT_VERSION,
      params.guard.validator.id,
      params.guard.validator.version,
      params.guard.validator.sha256,
      params.policyDigest,
      createdAt,
    );
  } else if (
    existingEpoch.validator_id !== params.guard.validator.id ||
    existingEpoch.validator_version !== params.guard.validator.version ||
    existingEpoch.validator_digest !== params.guard.validator.sha256 ||
    existingEpoch.policy_digest !== params.policyDigest
  ) {
    if (existingEpoch.contract_version !== DELEGATION_CONTRACT_VERSION) {
      throw new Error(
        "Delegation stack transition refused because the protected fail-closed contract differs.",
      );
    }
    const staleStack = db
      .prepare(
        `SELECT 1 FROM epoch_events
         WHERE epoch < ? AND validator_id = ? AND validator_version = ?
           AND validator_digest = ? AND policy_digest = ?
         LIMIT 1`,
      )
      .get(
        existingEpoch.epoch,
        params.guard.validator.id,
        params.guard.validator.version,
        params.guard.validator.sha256,
        params.policyDigest,
      );
    if (staleStack) {
      throw new Error(
        "Delegation stack transition refused because it would reactivate a stale validator/policy epoch.",
      );
    }
    if (
      existingEpoch.validator_id === params.guard.validator.id &&
      existingEpoch.validator_digest !== params.guard.validator.sha256
    ) {
      const versionOrder = compareSemanticVersions(
        existingEpoch.validator_version,
        params.guard.validator.version,
      );
      if (versionOrder === undefined || versionOrder >= 0) {
        throw new Error(
          "Delegation validator replacement must advertise a strictly newer semantic version.",
        );
      }
    }
    const openAssignment = db
      .prepare(
        `SELECT a.assignment_id
         FROM assignments a
         WHERE a.epoch = ?
           AND NOT EXISTS (
             SELECT 1 FROM route_events e
             WHERE e.assignment_id = a.assignment_id
               AND e.kind IN ('route_rejected', 'validation_rejected', 'timeout', 'completed')
           )
         LIMIT 1`,
      )
      .get(existingEpoch.epoch) as { assignment_id: string } | undefined;
    if (openAssignment) {
      throw new Error(
        `Delegation stack transition requires every active assignment to settle first: ${openAssignment.assignment_id}`,
      );
    }
    const createdAt = Date.now();
    const epoch = toNumber(existingEpoch.epoch) + 1;
    db.prepare(
      `INSERT INTO epoch_events
       (event_id, epoch, kind, contract_version, validator_id, validator_version,
        validator_digest, policy_digest, actor_agent_id, reason, created_at)
       VALUES (?, ?, 'stack_install', ?, ?, ?, ?, ?, NULL,
               'operator-configured validator/policy stack installed on gateway restart', ?)`,
    ).run(
      createDelegationRecordId("epoch", {
        epoch,
        validatorDigest: params.guard.validator.sha256,
        policyDigest: params.policyDigest,
        createdAt,
      }),
      epoch,
      DELEGATION_CONTRACT_VERSION,
      params.guard.validator.id,
      params.guard.validator.version,
      params.guard.validator.sha256,
      params.policyDigest,
      createdAt,
    );
  }
  ensurePermissions(pathname);
  const ledger = new DelegationLedger(
    db,
    pathname,
    params.guard,
    params.policyDigest,
    params.reconcileGatewayTask,
    params.reconcileTerminalGatewayTask,
    params.reconcileInitialSpawnTask,
  );
  try {
    ledger.assertActiveStack();
    if (existingEpoch) {
      ledger.reconcilePendingReceiptFinalizationAfterRestart();
      ledger.reconcileGatewayDispatchesAfterRestart();
      ledger.reconcileInterruptedInitialSpawnsAfterRestart();
      ledger.reconcileTerminalGatewayTasksAfterRestart();
    }
    ledgerCache.set(pathname, ledger);
    return ledger;
  } catch (error) {
    db.close();
    throw error;
  }
}
