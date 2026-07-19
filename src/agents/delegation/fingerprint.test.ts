import { execFile } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { fingerprintDelegationCandidate } from "./fingerprint.js";
import { createTestGuard, installTestValidator } from "./ledger.test-helpers.js";
import { canonicalizeDelegationScope } from "./scope.js";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

async function createRepository() {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-delegation-fingerprint-"));
  tempRoots.push(rootDir);
  await execFileAsync("git", ["init", "-b", "main"], { cwd: rootDir });
  await execFileAsync("git", ["config", "user.email", "delegation@example.invalid"], {
    cwd: rootDir,
  });
  await execFileAsync("git", ["config", "user.name", "Delegation Test"], { cwd: rootDir });
  writeFileSync(path.join(rootDir, "tracked.ts"), "export const tracked = true;\n");
  mkdirSync(path.join(rootDir, "nested"));
  writeFileSync(path.join(rootDir, "nested", "file.ts"), "export const nested = true;\n");
  await execFileAsync("git", ["add", "."], { cwd: rootDir });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: rootDir });
  const validator = installTestValidator(path.join(rootDir, "operator"));
  return {
    rootDir,
    guard: createTestGuard({
      validatorPath: validator.validatorPath,
      validatorSha256: validator.sha256,
    }),
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("delegation candidate fingerprint", () => {
  it("rejects directories and symlink aliases even when their spellings are canonical", async () => {
    const fixture = await createRepository();
    const directoryScope = canonicalizeDelegationScope({
      version: "openclaw-scope-v1",
      kind: "slice",
      entries: [{ path: "nested", expectation: "existing" }],
    });
    await expect(
      fingerprintDelegationCandidate({
        repoPath: fixture.rootDir,
        scope: directoryScope,
        guard: fixture.guard,
        policyDigest: "policy",
        epoch: 1,
      }),
    ).rejects.toThrow(/non-regular path|regular file/i);

    symlinkSync("tracked.ts", path.join(fixture.rootDir, "alias.ts"));
    const aliasScope = canonicalizeDelegationScope({
      version: "openclaw-scope-v1",
      kind: "slice",
      entries: [{ path: "alias.ts", expectation: "existing" }],
    });
    await expect(
      fingerprintDelegationCandidate({
        repoPath: fixture.rootDir,
        scope: aliasScope,
        guard: fixture.guard,
        policyDigest: "policy",
        epoch: 1,
      }),
    ).rejects.toThrow(/non-regular path|regular file/i);
  });

  it("allows a canonical may-create file but rejects an undeclared missing file", async () => {
    const fixture = await createRepository();
    const mayCreate = canonicalizeDelegationScope({
      version: "openclaw-scope-v1",
      kind: "slice",
      entries: [{ path: "nested/new.ts", expectation: "may-create" }],
    });
    await expect(
      fingerprintDelegationCandidate({
        repoPath: fixture.rootDir,
        scope: mayCreate,
        guard: fixture.guard,
        policyDigest: "policy",
        epoch: 1,
      }),
    ).resolves.toMatchObject({ pathCount: 1, dirtyCount: 0, truncated: false });

    const missing = canonicalizeDelegationScope({
      version: "openclaw-scope-v1",
      kind: "slice",
      entries: [{ path: "nested/missing.ts", expectation: "existing" }],
    });
    await expect(
      fingerprintDelegationCandidate({
        repoPath: fixture.rootDir,
        scope: missing,
        guard: fixture.guard,
        policyDigest: "policy",
        epoch: 1,
      }),
    ).rejects.toThrow("Delegation scope path must be an existing regular file: nested/missing.ts");
  });

  it("returns deterministic bounded metadata for a dirty inventory larger than 185 KB", async () => {
    const fixture = await createRepository();
    appendFileSync(path.join(fixture.rootDir, "tracked.ts"), "export const dirty = true;\n");
    const dirtyDir = path.join(fixture.rootDir, "dirty");
    mkdirSync(dirtyDir);
    let inventoryBytes = 0;
    for (let index = 0; index < 850; index += 1) {
      const name = `${String(index).padStart(4, "0")}-${"x".repeat(220)}.txt`;
      const relativePath = `dirty/${name}`;
      inventoryBytes += Buffer.byteLength(`${relativePath}\0`);
      writeFileSync(path.join(dirtyDir, name), `dirty-${index}\n`);
    }
    expect(inventoryBytes).toBeGreaterThan(185 * 1024);
    const scope = canonicalizeDelegationScope({
      version: "openclaw-scope-v1",
      kind: "slice",
      entries: [{ path: "tracked.ts", expectation: "existing" }],
    });
    const request = {
      repoPath: fixture.rootDir,
      scope,
      guard: fixture.guard,
      policyDigest: "policy",
      epoch: 7,
    } as const;

    const first = await fingerprintDelegationCandidate(request);
    const second = await fingerprintDelegationCandidate(request);

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      epoch: 7,
      pathCount: 1,
      dirtyCount: 1,
      truncated: false,
    });
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(2 * 1024);
    expect(JSON.stringify(first)).not.toContain("dirty/");
  });
});
