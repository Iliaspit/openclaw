import { realpathSync } from "node:fs";
import path from "node:path";
import { requireDelegationController } from "../agents/delegation/runtime.js";
import { loadConfig } from "../config/config.js";
import { resolveConfigPath } from "../config/paths.js";

export type DelegationLedgerAdoptDiscoveryOptions = {
  stateDir: string;
  config: string;
  controllerSession: string;
  targetAssignment: string;
  sourceReceipt: string;
  sourceBlockingAssignment: string;
  operatorId: string;
  reason: string;
  ticket: string;
  idempotencyKey: string;
};

export function delegationLedgerAdoptDiscoveryCommand(opts: DelegationLedgerAdoptDiscoveryOptions) {
  if (!path.isAbsolute(opts.stateDir) || !path.isAbsolute(opts.config)) {
    throw new Error("Delegation ledger maintenance requires absolute state and config paths.");
  }
  const stateDir = realpathSync(opts.stateDir);
  const configPath = realpathSync(opts.config);
  const activeConfigPath = realpathSync(resolveConfigPath());
  if (configPath !== activeConfigPath) {
    throw new Error(
      `Delegation ledger maintenance config mismatch: active ${activeConfigPath}, requested ${configPath}.`,
    );
  }
  const { runtime, controllerAgentId } = requireDelegationController({
    config: loadConfig(),
    stateDir,
    agentSessionKey: opts.controllerSession,
    effectiveThinking: "xhigh",
  });
  const adoption = runtime.ledger.adoptCompletedDiscoveryReceipt({
    targetAssignmentId: opts.targetAssignment,
    sourceReceiptId: opts.sourceReceipt,
    sourceBlockingAssignmentId: opts.sourceBlockingAssignment,
    controllerAgentId,
    controllerSessionKey: opts.controllerSession,
    operator: {
      id: opts.operatorId,
      reason: opts.reason,
      ticket: opts.ticket,
    },
    idempotencyKey: opts.idempotencyKey,
  });
  return { ok: true, command: "adopt-discovery", ...adoption };
}
