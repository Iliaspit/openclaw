import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  GUARDED_VERIFIER_VOLUME_MANIFEST,
  inspectGuardedVerifierPublishedProvenance,
  prepareGuardedVerifierVolumeProvenance,
  verifyGuardedVerifierVolumeProvenance,
} from "./guarded-verifier-provenance.js";

const SOURCE_REVISION = "a".repeat(40);
const REPOSITORY_HEAD = "b".repeat(40);

async function createFixture() {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-verifier-provenance-"));
  const dependencyRoot = path.join(workspaceDir, "node_modules");
  const browserRoot = path.join(workspaceDir, "browser-cache");
  await mkdir(path.join(dependencyRoot, "playwright-core"), { recursive: true });
  await mkdir(path.join(browserRoot, "chromium-123", "chrome-linux"), { recursive: true });
  await mkdir(path.join(workspaceDir, ".yarn", "releases"), { recursive: true });
  await mkdir(path.join(workspaceDir, ".yarn", "plugins"), { recursive: true });
  await writeFile(
    path.join(workspaceDir, "package.json"),
    JSON.stringify({ packageManager: "yarn@4.9.2" }),
  );
  await writeFile(path.join(workspaceDir, "yarn.lock"), "lock-v1\n");
  await writeFile(path.join(workspaceDir, ".yarn", "releases", "yarn.cjs"), "yarn-v1\n");
  await writeFile(path.join(workspaceDir, ".yarn", "plugins", "verified.cjs"), "plugin-v1\n");
  await writeFile(
    path.join(workspaceDir, ".yarnrc.yml"),
    [
      "nodeLinker: node-modules",
      "yarnPath: .yarn/releases/yarn.cjs",
      "plugins:",
      "  - path: .yarn/plugins/verified.cjs",
      "    spec: verified",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(dependencyRoot, "playwright-core", "browsers.json"),
    JSON.stringify({ browsers: [{ name: "chromium", revision: "123" }] }),
  );
  await writeFile(path.join(dependencyRoot, "package.txt"), "dependency-v1\n");
  await writeFile(path.join(browserRoot, "chromium-123", "chrome-linux", "chrome"), "browser-v1\n");
  await chmod(path.join(browserRoot, "chromium-123", "chrome-linux", "chrome"), 0o755);
  return { workspaceDir, dependencyRoot, browserRoot };
}

describe("guarded verifier volume provenance", () => {
  it("prepares deterministic content manifests and verifies unchanged volumes", async () => {
    const fixture = await createFixture();
    try {
      const prepared = await prepareGuardedVerifierVolumeProvenance({
        ...fixture,
        repositoryHead: REPOSITORY_HEAD,
        sourceRevision: SOURCE_REVISION,
        effectiveYarnVersion: "4.9.2",
      });
      const first = await verifyGuardedVerifierVolumeProvenance({
        ...fixture,
        repositoryHead: REPOSITORY_HEAD,
        sourceRevision: SOURCE_REVISION,
        effectiveYarnVersion: "4.9.2",
      });
      const second = await verifyGuardedVerifierVolumeProvenance({
        ...fixture,
        repositoryHead: REPOSITORY_HEAD,
        sourceRevision: SOURCE_REVISION,
        effectiveYarnVersion: "4.9.2",
      });
      expect(first.identityDigest).toBe(second.identityDigest);
      expect(prepared).toMatchObject({
        dependencyManifestDigest: first.dependencyManifest.manifestDigest,
        browserManifestDigest: first.browserManifest.manifestDigest,
        toolchainDigest: first.identityDigest,
      });
      expect(
        JSON.parse(
          await readFile(
            path.join(fixture.dependencyRoot, GUARDED_VERIFIER_VOLUME_MANIFEST),
            "utf8",
          ),
        ),
      ).toMatchObject({ kind: "dependencies", sourceRevision: SOURCE_REVISION });
    } finally {
      await rm(fixture.workspaceDir, { recursive: true, force: true });
    }
  });

  it("records a missing optional Yarn configuration deterministically", async () => {
    const fixture = await createFixture();
    try {
      await rm(path.join(fixture.workspaceDir, ".yarnrc.yml"));
      const prepared = await prepareGuardedVerifierVolumeProvenance({
        ...fixture,
        repositoryHead: REPOSITORY_HEAD,
        sourceRevision: SOURCE_REVISION,
        effectiveYarnVersion: "4.9.2",
      });
      const verified = await verifyGuardedVerifierVolumeProvenance({
        ...fixture,
        repositoryHead: REPOSITORY_HEAD,
        sourceRevision: SOURCE_REVISION,
        effectiveYarnVersion: "4.9.2",
      });
      expect(verified.dependencyManifest.repository).toMatchObject({
        yarnRcSha256: null,
        yarnPath: null,
        yarnPathSha256: null,
        yarnPathMode: null,
        plugins: [],
      });
      expect(prepared.toolchainDigest).toBe(verified.identityDigest);
    } finally {
      await rm(fixture.workspaceDir, { recursive: true, force: true });
    }
  });

  it("rejects substituted dependencies, browser executables, lockfiles, and revisions", async () => {
    for (const mutate of [
      async (fixture: Awaited<ReturnType<typeof createFixture>>) =>
        writeFile(path.join(fixture.dependencyRoot, "package.txt"), "substituted\n"),
      async (fixture: Awaited<ReturnType<typeof createFixture>>) =>
        writeFile(
          path.join(fixture.browserRoot, "chromium-123", "chrome-linux", "chrome"),
          "substituted\n",
        ),
      async (fixture: Awaited<ReturnType<typeof createFixture>>) =>
        writeFile(path.join(fixture.workspaceDir, "yarn.lock"), "lock-v2\n"),
      async (fixture: Awaited<ReturnType<typeof createFixture>>) =>
        writeFile(
          path.join(fixture.workspaceDir, ".yarn", "plugins", "verified.cjs"),
          "plugin-v2\n",
        ),
      async (fixture: Awaited<ReturnType<typeof createFixture>>) =>
        chmod(path.join(fixture.workspaceDir, ".yarn", "plugins", "verified.cjs"), 0o755),
      async (fixture: Awaited<ReturnType<typeof createFixture>>) =>
        chmod(path.join(fixture.browserRoot, "chromium-123", "chrome-linux", "chrome"), 0o700),
    ]) {
      const fixture = await createFixture();
      try {
        await prepareGuardedVerifierVolumeProvenance({
          ...fixture,
          repositoryHead: REPOSITORY_HEAD,
          sourceRevision: SOURCE_REVISION,
          effectiveYarnVersion: "4.9.2",
        });
        await mutate(fixture);
        await expect(
          verifyGuardedVerifierVolumeProvenance({
            ...fixture,
            repositoryHead: REPOSITORY_HEAD,
            sourceRevision: SOURCE_REVISION,
            effectiveYarnVersion: "4.9.2",
          }),
        ).rejects.toThrow();
        await expect(
          verifyGuardedVerifierVolumeProvenance({
            ...fixture,
            repositoryHead: REPOSITORY_HEAD,
            sourceRevision: "c".repeat(40),
            effectiveYarnVersion: "4.9.2",
          }),
        ).rejects.toThrow();
      } finally {
        await rm(fixture.workspaceDir, { recursive: true, force: true });
      }
    }
  });

  it("fails closed for cancellation, invalid deadlines, and non-Yarn repositories", async () => {
    const fixture = await createFixture();
    try {
      await prepareGuardedVerifierVolumeProvenance({
        ...fixture,
        repositoryHead: REPOSITORY_HEAD,
        sourceRevision: SOURCE_REVISION,
        effectiveYarnVersion: "4.9.2",
      });
      const controller = new AbortController();
      controller.abort();
      await expect(
        verifyGuardedVerifierVolumeProvenance({
          ...fixture,
          repositoryHead: REPOSITORY_HEAD,
          sourceRevision: SOURCE_REVISION,
          effectiveYarnVersion: "4.9.2",
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
      await expect(
        verifyGuardedVerifierVolumeProvenance({
          ...fixture,
          repositoryHead: REPOSITORY_HEAD,
          sourceRevision: SOURCE_REVISION,
          effectiveYarnVersion: "4.9.2",
          deadlineMs: 0,
        }),
      ).rejects.toThrow("deadline is invalid");
      await expect(
        verifyGuardedVerifierVolumeProvenance({
          ...fixture,
          repositoryHead: REPOSITORY_HEAD,
          sourceRevision: SOURCE_REVISION,
          effectiveYarnVersion: "4.9.3",
        }),
      ).rejects.toThrow();
      await expect(
        inspectGuardedVerifierPublishedProvenance({
          dependencyRoot: fixture.dependencyRoot,
          browserRoot: fixture.browserRoot,
          repositoryHead: REPOSITORY_HEAD,
          sourceRevision: SOURCE_REVISION,
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
      await writeFile(
        path.join(fixture.workspaceDir, "package.json"),
        JSON.stringify({ packageManager: "pnpm@10.0.0" }),
      );
      await expect(
        verifyGuardedVerifierVolumeProvenance({
          ...fixture,
          repositoryHead: REPOSITORY_HEAD,
          sourceRevision: SOURCE_REVISION,
          effectiveYarnVersion: "4.9.2",
        }),
      ).rejects.toThrow("pinned Yarn");
    } finally {
      await rm(fixture.workspaceDir, { recursive: true, force: true });
    }
  });

  it("does not let one caller deadline cancel a concurrent verification waiter", async () => {
    const fixture = await createFixture();
    try {
      await writeFile(
        path.join(fixture.dependencyRoot, "slow-fixture.bin"),
        Buffer.alloc(2_000_000),
      );
      await prepareGuardedVerifierVolumeProvenance({
        ...fixture,
        repositoryHead: REPOSITORY_HEAD,
        sourceRevision: SOURCE_REVISION,
        effectiveYarnVersion: "4.9.2",
      });
      const shortWaiter = verifyGuardedVerifierVolumeProvenance({
        ...fixture,
        repositoryHead: REPOSITORY_HEAD,
        sourceRevision: SOURCE_REVISION,
        effectiveYarnVersion: "4.9.2",
        deadlineMs: 1,
      });
      const durableWaiter = verifyGuardedVerifierVolumeProvenance({
        ...fixture,
        repositoryHead: REPOSITORY_HEAD,
        sourceRevision: SOURCE_REVISION,
        effectiveYarnVersion: "4.9.2",
      });
      await expect(shortWaiter).rejects.toThrow("deadline");
      await expect(durableWaiter).resolves.toMatchObject({
        dependencyManifest: { sourceRevision: SOURCE_REVISION },
      });
    } finally {
      await rm(fixture.workspaceDir, { recursive: true, force: true });
    }
  });
});
