import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DelegationGuardConfig } from "../../config/types.agents.js";
import { DELEGATION_VALIDATOR_PROTOCOL } from "./contracts.js";
import { runPinnedDelegationValidator, verifyPinnedDelegationValidator } from "./validator.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-delegation-validator-"));
  roots.push(root);
  return root;
}

function validatorFixture(
  root: string,
  options: { source?: string; maxOutputBytes?: number } = {},
): DelegationGuardConfig["validator"] {
  const entrypoint = path.join(root, "source", "validator.mjs");
  const source = Buffer.from(options.source ?? "process.stdout.write('{}\\n');\n", "utf8");
  mkdirSync(path.dirname(entrypoint), { recursive: true, mode: 0o700 });
  writeFileSync(entrypoint, source, { mode: 0o400 });
  chmodSync(entrypoint, 0o400);
  return {
    id: "validator-test",
    version: "1.0.0",
    entrypoint,
    sha256: createHash("sha256").update(source).digest("hex"),
    maxOutputBytes: options.maxOutputBytes ?? 64 * 1024,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("pinned delegation validator", () => {
  it("copies verified bytes into a protected digest-addressed cache", () => {
    const root = tempRoot();
    const validator = validatorFixture(root);
    const stateDir = path.join(root, "state");

    verifyPinnedDelegationValidator(validator, { stateDir });

    const cacheDir = path.join(stateDir, "delegation", "validator-bundles");
    const cachedEntrypoint = path.join(cacheDir, `${validator.sha256}.mjs`);
    expect(readFileSync(cachedEntrypoint)).toEqual(readFileSync(validator.entrypoint));
    expect(lstatSync(cacheDir).mode & 0o777).toBe(0o700);
    expect(lstatSync(cachedEntrypoint).mode & 0o777).toBe(0o400);
  });

  it("rejects a source whose bytes do not match the configured digest", () => {
    const root = tempRoot();
    const validator = validatorFixture(root);
    validator.sha256 = "0".repeat(64);

    expect(() =>
      verifyPinnedDelegationValidator(validator, { stateDir: path.join(root, "state") }),
    ).toThrow(/digest mismatch/i);
  });

  it("rejects writable and symlinked validator entrypoints", () => {
    const writableRoot = tempRoot();
    const writable = validatorFixture(writableRoot);
    chmodSync(writable.entrypoint, 0o600);
    expect(() =>
      verifyPinnedDelegationValidator(writable, {
        stateDir: path.join(writableRoot, "state"),
      }),
    ).toThrow(/read-only/i);

    const symlinkRoot = tempRoot();
    const target = validatorFixture(symlinkRoot);
    const symlink = path.join(symlinkRoot, "validator-link.mjs");
    symlinkSync(target.entrypoint, symlink);
    expect(() =>
      verifyPinnedDelegationValidator(
        { ...target, entrypoint: symlink },
        { stateDir: path.join(symlinkRoot, "state") },
      ),
    ).toThrow(/non-symlink/i);
  });

  it("fails closed when a previously materialized protected bundle is corrupted", () => {
    const root = tempRoot();
    const validator = validatorFixture(root);
    const stateDir = path.join(root, "state");
    verifyPinnedDelegationValidator(validator, { stateDir });
    const cachedEntrypoint = path.join(
      stateDir,
      "delegation",
      "validator-bundles",
      `${validator.sha256}.mjs`,
    );
    chmodSync(cachedEntrypoint, 0o600);
    writeFileSync(cachedEntrypoint, "corrupt\n");

    expect(() => verifyPinnedDelegationValidator(validator, { stateDir })).toThrow(
      /cache digest mismatch/i,
    );
  });

  it("executes asynchronously with a minimal environment", async () => {
    const root = tempRoot();
    const sentinel = "OPENCLAW_DELEGATION_VALIDATOR_SECRET_SENTINEL";
    const validator = validatorFixture(root, {
      source: `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  setTimeout(() => {
    process.stdout.write(JSON.stringify({
      protocol: request.protocol,
      action: request.action,
      ok: process.env.${sentinel} === undefined,
      result: { sentinelVisible: process.env.${sentinel} !== undefined },
    }) + "\\n");
  }, 10);
});
`,
    });
    process.env[sentinel] = "must-not-be-inherited";
    try {
      const pending = runPinnedDelegationValidator({
        validator,
        stateDir: path.join(root, "state"),
        request: {
          protocol: DELEGATION_VALIDATOR_PROTOCOL,
          action: "fingerprint",
          payload: {},
        },
      });
      expect(pending).toBeInstanceOf(Promise);
      await expect(pending).resolves.toMatchObject({
        protocol: DELEGATION_VALIDATOR_PROTOCOL,
        action: "fingerprint",
        ok: true,
        result: { sentinelVisible: false },
      });
    } finally {
      delete process.env[sentinel];
    }
  });

  it("kills validators whose combined output exceeds the configured bound", async () => {
    const root = tempRoot();
    const validator = validatorFixture(root, {
      source: `process.stdout.write("x".repeat(2048));\n`,
      maxOutputBytes: 1024,
    });

    await expect(
      runPinnedDelegationValidator({
        validator,
        stateDir: path.join(root, "state"),
        request: {
          protocol: DELEGATION_VALIDATOR_PROTOCOL,
          action: "validate_report",
          payload: {},
        },
      }),
    ).rejects.toThrow(/output exceeds/i);
  });
});
