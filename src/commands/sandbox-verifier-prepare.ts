import { realpath } from "node:fs/promises";
import path from "node:path";
import {
  prepareGuardedVerifierVolumeProvenance,
  verifyGuardedVerifierVolumeProvenance,
} from "../agents/sandbox/guarded-verifier-provenance.js";
import type { RuntimeEnv } from "../runtime.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const FULL_REVISION = /^[a-f0-9]{40}$/u;

async function resolvePreparationPaths(opts: {
  workspace: string;
  browserRoot: string;
  repositoryHead: string;
}): Promise<{
  workspaceDir: string;
  dependencyRoot: string;
  browserRoot: string;
  repositoryHead: string;
}> {
  if (!path.isAbsolute(opts.workspace) || !path.isAbsolute(opts.browserRoot)) {
    throw new Error("Guarded verifier preparation paths must be absolute.");
  }
  const workspaceDir = await realpath(opts.workspace);
  const dependencyRoot = await realpath(path.join(workspaceDir, "node_modules"));
  const browserRoot = await realpath(opts.browserRoot);
  if (!FULL_REVISION.test(opts.repositoryHead)) {
    throw new Error("Guarded verifier preparation requires an exact repository HEAD.");
  }
  return {
    workspaceDir,
    dependencyRoot,
    browserRoot,
    repositoryHead: opts.repositoryHead,
  };
}

export async function sandboxVerifierPrepareCommand(
  opts: {
    workspace: string;
    browserRoot: string;
    repositoryHead: string;
    sourceRevision: string;
  },
  runtime: RuntimeEnv,
): Promise<void> {
  if (
    process.env.OPENCLAW_VERIFIER_PREPARE !== "1" ||
    (typeof process.getuid === "function" && process.getuid() !== 0)
  ) {
    throw new Error(
      "Guarded verifier preparation is restricted to the root-owned bootstrap lifecycle.",
    );
  }
  const paths = await resolvePreparationPaths(opts);
  const result = await prepareGuardedVerifierVolumeProvenance({
    ...paths,
    sourceRevision: opts.sourceRevision,
  });
  runtime.log(
    JSON.stringify({ status: "prepared", repositoryHead: paths.repositoryHead, ...result }),
  );
}

export async function sandboxVerifierVerifyCommand(
  opts: {
    workspace: string;
    browserRoot: string;
    repositoryHead: string;
    sourceRevision: string;
    dependencyManifest?: string;
    browserManifest?: string;
  },
  runtime: RuntimeEnv,
): Promise<void> {
  if (
    process.env.OPENCLAW_VERIFIER_VERIFY !== "1" ||
    (typeof process.getuid === "function" && process.getuid() !== 0) ||
    (opts.dependencyManifest !== undefined && !SHA256.test(opts.dependencyManifest)) ||
    (opts.browserManifest !== undefined && !SHA256.test(opts.browserManifest)) ||
    (opts.dependencyManifest === undefined) !== (opts.browserManifest === undefined)
  ) {
    throw new Error("Guarded verifier publication verification is not authorized.");
  }
  const paths = await resolvePreparationPaths(opts);
  const result = await verifyGuardedVerifierVolumeProvenance({
    ...paths,
    sourceRevision: opts.sourceRevision,
  });
  if (
    opts.dependencyManifest !== undefined &&
    (result.dependencyManifest.manifestDigest !== opts.dependencyManifest ||
      result.browserManifest.manifestDigest !== opts.browserManifest)
  ) {
    throw new Error("Guarded verifier published artifact identity does not match preparation.");
  }
  runtime.log(
    JSON.stringify({
      status: "verified",
      repositoryHead: paths.repositoryHead,
      dependencyManifestDigest: result.dependencyManifest.manifestDigest,
      browserManifestDigest: result.browserManifest.manifestDigest,
      toolchainDigest: result.identityDigest,
      repositoryIdentityDigest: result.dependencyManifest.repository.identityDigest,
      browserIdentityDigest: result.browserManifest.playwright.identityDigest,
      effectiveYarnVersion: result.dependencyManifest.repository.effectiveYarnVersion,
    }),
  );
}
