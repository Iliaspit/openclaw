#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  createDelegationLedgerRepairAuthorization,
  parseDelegationLedgerRepairAuthorization,
  parseDelegationLedgerRepairInspection,
} from "../src/agents/delegation/ledger-repair-contract.js";
import {
  applyDelegationLedgerRepair,
  inspectDelegationLedgerRepair,
} from "../src/agents/delegation/ledger-repair.js";

type Command = "inspect" | "authorize" | "apply";

function readOption(argv: string[], name: string): string {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing required ${name} option.`);
  }
  return value;
}

function absolutePath(argv: string[], name: string): string {
  const value = readOption(argv, name);
  if (!path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path.`);
  }
  return value;
}

function writeExclusiveJson(pathname: string, value: unknown): void {
  writeFileSync(pathname, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

function readJson(pathname: string): unknown {
  return JSON.parse(readFileSync(pathname, "utf8")) as unknown;
}

function run(argv: string[]): unknown {
  const command = argv[0] as Command | undefined;
  if (command === "inspect") {
    const inspection = inspectDelegationLedgerRepair({
      stateDir: absolutePath(argv, "--state-dir"),
      assignmentId: readOption(argv, "--assignment"),
    });
    const output = absolutePath(argv, "--output");
    writeExclusiveJson(output, inspection);
    return { ok: true, command, output, inspection };
  }
  if (command === "authorize") {
    const inspectionPath = absolutePath(argv, "--inspection");
    const authorization = createDelegationLedgerRepairAuthorization({
      inspection: parseDelegationLedgerRepairInspection(readJson(inspectionPath)),
      operator: {
        id: readOption(argv, "--operator-id"),
        reason: readOption(argv, "--reason"),
        ticket: readOption(argv, "--ticket"),
      },
      idempotencyKey: readOption(argv, "--idempotency-key"),
    });
    const output = absolutePath(argv, "--output");
    writeExclusiveJson(output, authorization);
    return { ok: true, command, output, authorization };
  }
  if (command === "apply") {
    const authorizationPath = absolutePath(argv, "--authorization");
    const authorization = parseDelegationLedgerRepairAuthorization(readJson(authorizationPath));
    return {
      ok: true,
      command,
      ...applyDelegationLedgerRepair({
        stateDir: absolutePath(argv, "--state-dir"),
        authorization,
      }),
    };
  }
  throw new Error("Expected one maintenance command: inspect, authorize, or apply.");
}

try {
  process.stdout.write(`${JSON.stringify(run(process.argv.slice(2)))}\n`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
