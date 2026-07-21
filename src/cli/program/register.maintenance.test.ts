import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerMaintenanceCommands } from "./register.maintenance.js";

const mocks = vi.hoisted(() => ({
  doctorCommand: vi.fn(),
  dashboardCommand: vi.fn(),
  delegationLedgerAdoptDiscoveryCommand: vi.fn(),
  resetCommand: vi.fn(),
  uninstallCommand: vi.fn(),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

const {
  doctorCommand,
  dashboardCommand,
  delegationLedgerAdoptDiscoveryCommand,
  resetCommand,
  uninstallCommand,
  runtime,
} = mocks;

vi.mock("../../commands/doctor.js", () => ({
  doctorCommand: mocks.doctorCommand,
}));

vi.mock("../../commands/dashboard.js", () => ({
  dashboardCommand: mocks.dashboardCommand,
}));

vi.mock("../../commands/delegation-ledger-adopt-discovery.js", () => ({
  delegationLedgerAdoptDiscoveryCommand: mocks.delegationLedgerAdoptDiscoveryCommand,
}));

vi.mock("../../commands/reset.js", () => ({
  resetCommand: mocks.resetCommand,
}));

vi.mock("../../commands/uninstall.js", () => ({
  uninstallCommand: mocks.uninstallCommand,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

describe("registerMaintenanceCommands doctor action", () => {
  async function runMaintenanceCli(args: string[]) {
    const program = new Command();
    registerMaintenanceCommands(program);
    await program.parseAsync(args, { from: "user" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exits with code 0 after successful doctor run", async () => {
    doctorCommand.mockResolvedValue(undefined);

    await runMaintenanceCli(["doctor", "--non-interactive", "--yes"]);

    expect(doctorCommand).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({
        nonInteractive: true,
        yes: true,
      }),
    );
    expect(runtime.exit).toHaveBeenCalledWith(0);
  });

  it("exits with code 1 when doctor fails", async () => {
    doctorCommand.mockRejectedValue(new Error("doctor failed"));

    await runMaintenanceCli(["doctor"]);

    expect(runtime.error).toHaveBeenCalledWith("Error: doctor failed");
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.exit).not.toHaveBeenCalledWith(0);
  });

  it("maps --fix to repair=true", async () => {
    doctorCommand.mockResolvedValue(undefined);

    await runMaintenanceCli(["doctor", "--fix"]);

    expect(doctorCommand).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({
        repair: true,
      }),
    );
  });

  it("passes noOpen to dashboard command", async () => {
    dashboardCommand.mockResolvedValue(undefined);

    await runMaintenanceCli(["dashboard", "--no-open"]);

    expect(dashboardCommand).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({
        noOpen: true,
      }),
    );
  });

  it("passes reset options to reset command", async () => {
    resetCommand.mockResolvedValue(undefined);

    await runMaintenanceCli([
      "reset",
      "--scope",
      "full",
      "--yes",
      "--non-interactive",
      "--dry-run",
    ]);

    expect(resetCommand).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({
        scope: "full",
        yes: true,
        nonInteractive: true,
        dryRun: true,
      }),
    );
  });

  it("passes uninstall options to uninstall command", async () => {
    uninstallCommand.mockResolvedValue(undefined);

    await runMaintenanceCli([
      "uninstall",
      "--service",
      "--state",
      "--workspace",
      "--app",
      "--all",
      "--yes",
      "--non-interactive",
      "--dry-run",
    ]);

    expect(uninstallCommand).toHaveBeenCalledWith(
      runtime,
      expect.objectContaining({
        service: true,
        state: true,
        workspace: true,
        app: true,
        all: true,
        yes: true,
        nonInteractive: true,
        dryRun: true,
      }),
    );
  });

  it("runs installed discovery adoption with every exact protected identity", async () => {
    delegationLedgerAdoptDiscoveryCommand.mockReturnValue({
      ok: true,
      adoptionId: "discovery-receipt-adoption-1",
    });

    await runMaintenanceCli([
      "delegation-ledger",
      "adopt-discovery",
      "--state-dir",
      "/state",
      "--config",
      "/state/openclaw.json",
      "--controller-session",
      "agent:planner:explicit:recovery",
      "--target-assignment",
      "assignment-target",
      "--source-receipt",
      "receipt-source",
      "--source-blocking-assignment",
      "assignment-blocking",
      "--operator-id",
      "operator@example.com",
      "--reason",
      "authorized exact adoption",
      "--ticket",
      "OPS-1",
      "--idempotency-key",
      "adopt-1",
    ]);

    expect(delegationLedgerAdoptDiscoveryCommand).toHaveBeenCalledWith({
      stateDir: "/state",
      config: "/state/openclaw.json",
      controllerSession: "agent:planner:explicit:recovery",
      targetAssignment: "assignment-target",
      sourceReceipt: "receipt-source",
      sourceBlockingAssignment: "assignment-blocking",
      operatorId: "operator@example.com",
      reason: "authorized exact adoption",
      ticket: "OPS-1",
      idempotencyKey: "adopt-1",
    });
    expect(runtime.log).toHaveBeenCalledWith(
      JSON.stringify({ ok: true, adoptionId: "discovery-receipt-adoption-1" }),
    );
    expect(runtime.exit).toHaveBeenCalledWith(0);
  });

  it("exits with code 1 when dashboard fails", async () => {
    dashboardCommand.mockRejectedValue(new Error("dashboard failed"));

    await runMaintenanceCli(["dashboard"]);

    expect(runtime.error).toHaveBeenCalledWith("Error: dashboard failed");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
