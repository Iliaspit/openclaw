import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  adoptCompletedDiscoveryReceipt: vi.fn(),
  loadConfig: vi.fn(() => ({ agents: {} })),
  requireDelegationController: vi.fn(),
  resolveConfigPath: vi.fn(),
}));

vi.mock("../agents/delegation/runtime.js", () => ({
  requireDelegationController: mocks.requireDelegationController,
}));

vi.mock("../config/config.js", () => ({ loadConfig: mocks.loadConfig }));
vi.mock("../config/paths.js", () => ({ resolveConfigPath: mocks.resolveConfigPath }));

import { delegationLedgerAdoptDiscoveryCommand } from "./delegation-ledger-adopt-discovery.js";

const BASE_OPTIONS = {
  controllerSession: "agent:planner-2:explicit:recovery",
  targetAssignment: "assignment-target",
  sourceReceipt: "receipt-source",
  sourceBlockingAssignment: "assignment-blocking",
  operatorId: "operator@example.com",
  reason: "authorized exact discovery adoption",
  ticket: "OPS-1",
  idempotencyKey: "adopt-1",
} as const;

describe("delegation ledger discovery adoption command", () => {
  let rootDir: string;
  let stateDir: string;
  let activeConfig: string;

  beforeEach(() => {
    vi.clearAllMocks();
    rootDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-adopt-command-"));
    stateDir = path.join(rootDir, "state");
    activeConfig = path.join(rootDir, "openclaw.json");
    writeFileSync(activeConfig, "{}\n");
    mkdirSync(stateDir);
    mocks.resolveConfigPath.mockReturnValue(activeConfig);
    mocks.requireDelegationController.mockReturnValue({
      controllerAgentId: "planner-2",
      runtime: { ledger: { adoptCompletedDiscoveryReceipt: mocks.adoptCompletedDiscoveryReceipt } },
    });
    mocks.adoptCompletedDiscoveryReceipt.mockReturnValue({
      adoptionId: "discovery-receipt-adoption-1",
      authorizationDigest: "authorization-digest",
      discoveryPrerequisiteSatisfied: true,
    });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("routes the exact active config and explicit state directory into the protected runtime", () => {
    const result = delegationLedgerAdoptDiscoveryCommand({
      ...BASE_OPTIONS,
      stateDir,
      config: activeConfig,
    });

    expect(mocks.requireDelegationController).toHaveBeenCalledWith({
      config: { agents: {} },
      stateDir: realpathSync(stateDir),
      agentSessionKey: BASE_OPTIONS.controllerSession,
      effectiveThinking: "xhigh",
    });
    expect(mocks.adoptCompletedDiscoveryReceipt).toHaveBeenCalledWith({
      targetAssignmentId: BASE_OPTIONS.targetAssignment,
      sourceReceiptId: BASE_OPTIONS.sourceReceipt,
      sourceBlockingAssignmentId: BASE_OPTIONS.sourceBlockingAssignment,
      controllerAgentId: "planner-2",
      controllerSessionKey: BASE_OPTIONS.controllerSession,
      operator: {
        id: BASE_OPTIONS.operatorId,
        reason: BASE_OPTIONS.reason,
        ticket: BASE_OPTIONS.ticket,
      },
      idempotencyKey: BASE_OPTIONS.idempotencyKey,
    });
    expect(result).toMatchObject({
      ok: true,
      command: "adopt-discovery",
      adoptionId: "discovery-receipt-adoption-1",
      discoveryPrerequisiteSatisfied: true,
    });
  });

  it("rejects relative state or config paths before opening the protected runtime", () => {
    expect(() =>
      delegationLedgerAdoptDiscoveryCommand({
        ...BASE_OPTIONS,
        stateDir: "relative-state",
        config: activeConfig,
      }),
    ).toThrow(/requires absolute state and config paths/i);
    expect(mocks.requireDelegationController).not.toHaveBeenCalled();
  });

  it("rejects a real config file that is not the active OpenClaw config", () => {
    const otherConfig = path.join(rootDir, "other.json");
    writeFileSync(otherConfig, "{}\n");

    expect(() =>
      delegationLedgerAdoptDiscoveryCommand({
        ...BASE_OPTIONS,
        stateDir,
        config: otherConfig,
      }),
    ).toThrow(/config mismatch/i);
    expect(mocks.requireDelegationController).not.toHaveBeenCalled();
  });
});
