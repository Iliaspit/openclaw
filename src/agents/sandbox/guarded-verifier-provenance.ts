import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, readlink, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { canonicalDelegationJson } from "../delegation/identity.js";

export const GUARDED_VERIFIER_VOLUME_MANIFEST = ".openclaw-verifier-provenance.json";
export const GUARDED_VERIFIER_VOLUME_CONTRACT = "openclaw-guarded-verifier-oci-v1";
const SHA256 = /^[a-f0-9]{64}$/u;
const FULL_REVISION = /^[a-f0-9]{40}$/u;
const MAX_TREE_ENTRIES = 250_000;
const MAX_TREE_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 50_000;
const MAX_METADATA_BYTES = 1024 * 1024;
// Publication verifies the complete immutable dependency/browser artifact and
// can take longer on Docker Desktop. Guarded execution still supplies its
// separate 60-second caller deadline.
const DEFAULT_VERIFICATION_DEADLINE_MS = 180_000;

const RepositoryIdentitySchema = z
  .object({
    head: z.string().regex(FULL_REVISION),
    packageManager: z.string().min(3).max(128),
    packageManagerName: z.literal("yarn"),
    packageManagerVersion: z.string().min(1).max(64),
    effectiveYarnVersion: z.string().min(1).max(64),
    packageJsonSha256: z.string().regex(SHA256),
    lockfileName: z.literal("yarn.lock"),
    lockfileSha256: z.string().regex(SHA256),
    yarnRcSha256: z.string().regex(SHA256).nullable(),
    yarnPath: z.string().min(1).max(1024).nullable(),
    yarnPathSha256: z.string().regex(SHA256).nullable(),
    yarnPathMode: z.number().int().min(0).max(0o777).nullable(),
    plugins: z
      .array(
        z
          .object({
            path: z.string().min(1).max(1024),
            sha256: z.string().regex(SHA256),
            mode: z.number().int().min(0).max(0o777),
          })
          .strict(),
      )
      .max(64),
    identityDigest: z.string().regex(SHA256),
  })
  .strict();

const TreeIdentitySchema = z
  .object({
    digest: z.string().regex(SHA256),
    entries: z.number().int().positive().max(MAX_TREE_ENTRIES),
    bytes: z.number().int().nonnegative().max(MAX_TREE_BYTES),
  })
  .strict();

const PlaywrightIdentitySchema = z
  .object({
    browsersJsonSha256: z.string().regex(SHA256),
    revisions: z.array(z.string().min(1).max(128)).min(1).max(32),
    executables: z
      .array(
        z
          .object({
            path: z.string().min(1).max(1024),
            sha256: z.string().regex(SHA256),
            mode: z.number().int().min(0).max(0o777),
          })
          .strict(),
      )
      .min(1)
      .max(32),
    identityDigest: z.string().regex(SHA256),
  })
  .strict();

export const GuardedVerifierVolumeManifestSchema = z
  .object({
    contractVersion: z.literal(GUARDED_VERIFIER_VOLUME_CONTRACT),
    kind: z.enum(["dependencies", "browsers"]),
    sourceRevision: z.string().regex(FULL_REVISION),
    repository: RepositoryIdentitySchema,
    tree: TreeIdentitySchema,
    playwright: PlaywrightIdentitySchema,
    manifestDigest: z.string().regex(SHA256),
  })
  .strict();

export type GuardedVerifierVolumeManifest = z.infer<typeof GuardedVerifierVolumeManifestSchema>;

export type GuardedVerifierVolumeVerificationResult = {
  dependencyManifest: GuardedVerifierVolumeManifest;
  browserManifest: GuardedVerifierVolumeManifest;
  identityDigest: string;
};

export type GuardedVerifierVerificationControl = {
  signal?: AbortSignal;
  deadlineAt: number;
};

type VerificationFlight = {
  controller: AbortController;
  promise: Promise<GuardedVerifierVolumeVerificationResult>;
  waiters: number;
};
const verificationFlights = new Map<string, VerificationFlight>();

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function guardedVerifierAbortError(): Error {
  const error = new Error("Guarded verifier artifact verification was aborted.");
  error.name = "AbortError";
  return error;
}

function assertVerificationActive(control: GuardedVerifierVerificationControl): void {
  if (control.signal?.aborted) {
    throw guardedVerifierAbortError();
  }
  if (Date.now() >= control.deadlineAt) {
    throw new Error("Guarded verifier artifact verification exceeded its deadline.");
  }
}

async function digestFile(
  filename: string,
  control?: GuardedVerifierVerificationControl,
): Promise<{ digest: string; bytes: number; mode: number }> {
  if (control) {
    assertVerificationActive(control);
  }
  const handle = await open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      throw new Error("Guarded verifier artifact is not a bounded regular file.");
    }
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      if (control) {
        assertVerificationActive(control);
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_FILE_BYTES) {
        throw new Error("Guarded verifier artifact exceeds its file byte limit.");
      }
      hash.update(buffer);
    }
    return { digest: hash.digest("hex"), bytes, mode: stat.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

async function captureEffectiveYarnVersion(params: {
  workspaceDir: string;
  control?: GuardedVerifierVerificationControl;
}): Promise<string> {
  if (params.control) {
    assertVerificationActive(params.control);
  }
  return await new Promise<string>((resolve, reject) => {
    const child = spawn("yarn", ["--version"], {
      cwd: params.workspaceDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error, value?: string) => {
      if (settled) {
        return;
      }
      settled = true;
      params.control?.signal?.removeEventListener("abort", handleAbort);
      if (error) {
        reject(error);
      } else {
        resolve(value ?? "");
      }
    };
    const handleAbort = () => {
      child.kill("SIGKILL");
      const error = new Error("Guarded verifier Yarn version capture was aborted.");
      error.name = "AbortError";
      finish(error);
    };
    params.control?.signal?.addEventListener("abort", handleAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024) {
        child.kill("SIGKILL");
        finish(new Error("Guarded verifier Yarn version output exceeded its byte limit."));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024) {
        child.kill("SIGKILL");
        finish(new Error("Guarded verifier Yarn version output exceeded its byte limit."));
      }
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (params.control) {
        try {
          assertVerificationActive(params.control);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
      const value = Buffer.concat(chunks).toString("utf8").trim();
      if (code !== 0 || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[+-][A-Za-z0-9._-]+)?$/u.test(value)) {
        finish(new Error("Guarded verifier effective Yarn version is invalid."));
        return;
      }
      finish(undefined, value);
    });
  });
}

async function readBoundedMetadata(
  filename: string,
  control?: GuardedVerifierVerificationControl,
): Promise<Buffer> {
  if (control) {
    assertVerificationActive(control);
  }
  const handle = await open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_METADATA_BYTES) {
      throw new Error("Guarded verifier metadata is not a bounded regular file.");
    }
    const content = await handle.readFile();
    if (control) {
      assertVerificationActive(control);
    }
    return content;
  } finally {
    await handle.close();
  }
}

async function readOptionalBoundedMetadata(
  filename: string,
  control?: GuardedVerifierVerificationControl,
): Promise<Buffer | null> {
  try {
    return await readBoundedMetadata(filename, control);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function captureGuardedVerifierTreeIdentity(params: {
  root: string;
  allowedSymlinkRoots: string[];
  control?: GuardedVerifierVerificationControl;
}): Promise<z.infer<typeof TreeIdentitySchema>> {
  if (params.control) {
    assertVerificationActive(params.control);
  }
  const canonicalRoot = await realpath(params.root);
  const allowedRoots = await Promise.all(
    params.allowedSymlinkRoots.map(async (root) => realpath(root)),
  );
  const records: Array<{
    path: string;
    kind: "file" | "symlink";
    digest: string;
    bytes: number;
    mode: number;
  }> = [];
  let totalBytes = 0;

  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    if (params.control) {
      assertVerificationActive(params.control);
    }
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.length > MAX_DIRECTORY_ENTRIES) {
      throw new Error("Guarded verifier artifact directory exceeds its entry limit.");
    }
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      if (params.control) {
        assertVerificationActive(params.control);
      }
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      if (relativePath === GUARDED_VERIFIER_VOLUME_MANIFEST) {
        continue;
      }
      if (records.length >= MAX_TREE_ENTRIES) {
        throw new Error("Guarded verifier artifact exceeds its entry limit.");
      }
      const pathname = path.join(directory, entry.name);
      const stat = await lstat(pathname);
      if (stat.isDirectory()) {
        await visit(pathname, relativePath);
        continue;
      }
      if (stat.isSymbolicLink()) {
        const target = await readlink(pathname);
        const resolvedTarget = await realpath(pathname);
        if (!allowedRoots.some((root) => isWithin(root, resolvedTarget))) {
          throw new Error("Guarded verifier artifact contains an out-of-scope symlink.");
        }
        records.push({
          path: relativePath,
          kind: "symlink",
          digest: sha256(target),
          bytes: 0,
          mode: stat.mode & 0o777,
        });
        continue;
      }
      if (!stat.isFile()) {
        throw new Error("Guarded verifier artifact contains a special filesystem node.");
      }
      const file = await digestFile(pathname, params.control);
      totalBytes += file.bytes;
      if (totalBytes > MAX_TREE_BYTES) {
        throw new Error("Guarded verifier artifact exceeds its byte limit.");
      }
      records.push({
        path: relativePath,
        kind: "file",
        digest: file.digest,
        bytes: file.bytes,
        mode: file.mode,
      });
    }
  };

  await visit(canonicalRoot, "");
  if (records.length === 0) {
    throw new Error("Guarded verifier artifact is empty.");
  }
  return {
    digest: sha256(canonicalDelegationJson(records)),
    entries: records.length,
    bytes: totalBytes,
  };
}

export async function captureGuardedVerifierRepositoryIdentity(params: {
  workspaceDir: string;
  head: string;
  effectiveYarnVersion?: string;
  control?: GuardedVerifierVerificationControl;
}): Promise<z.infer<typeof RepositoryIdentitySchema>> {
  if (params.control) {
    assertVerificationActive(params.control);
  }
  const packageJsonPath = path.join(params.workspaceDir, "package.json");
  const packageJsonContent = await readBoundedMetadata(packageJsonPath, params.control);
  const packageJson = z
    .object({ packageManager: z.string().min(3).max(128) })
    .passthrough()
    .parse(JSON.parse(packageJsonContent.toString("utf8")) as unknown);
  const match = /^yarn@([0-9]+\.[0-9]+\.[0-9]+(?:[+-][A-Za-z0-9._-]+)?)$/u.exec(
    packageJson.packageManager,
  );
  if (!match) {
    throw new Error("Guarded verifier repository must declare one pinned Yarn packageManager.");
  }
  const packageManagerName = "yarn" as const;
  const packageManagerVersion = z.string().min(1).parse(match[1]);
  const effectiveYarnVersion =
    params.effectiveYarnVersion ?? (await captureEffectiveYarnVersion(params));
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[+-][A-Za-z0-9._-]+)?$/u.test(effectiveYarnVersion)) {
    throw new Error("Guarded verifier effective Yarn version is invalid.");
  }
  if (effectiveYarnVersion !== packageManagerVersion) {
    throw new Error("Guarded verifier effective Yarn version does not match packageManager.");
  }
  const lockfile = await digestFile(path.join(params.workspaceDir, "yarn.lock"), params.control);
  const yarnRcContent = await readOptionalBoundedMetadata(
    path.join(params.workspaceDir, ".yarnrc.yml"),
    params.control,
  );
  const yarnRc = z
    .object({
      yarnPath: z.string().min(1).max(1024).optional(),
      plugins: z
        .array(z.object({ path: z.string().min(1).max(1024) }).passthrough())
        .max(64)
        .optional(),
    })
    .passthrough()
    .parse(yarnRcContent ? (parseYaml(yarnRcContent.toString("utf8")) ?? {}) : {});
  const resolveRepositoryFile = async (
    relativePath: string,
  ): Promise<{ path: string; sha256: string; mode: number }> => {
    if (
      path.isAbsolute(relativePath) ||
      path.posix.normalize(relativePath) !== relativePath ||
      relativePath.startsWith("../")
    ) {
      throw new Error("Guarded verifier Yarn provenance path is not repository-relative.");
    }
    const filename = path.resolve(params.workspaceDir, relativePath);
    if (!isWithin(path.resolve(params.workspaceDir), filename)) {
      throw new Error("Guarded verifier Yarn provenance path escapes the repository.");
    }
    const file = await digestFile(filename, params.control);
    return {
      path: relativePath,
      sha256: file.digest,
      mode: file.mode,
    };
  };
  const yarnPathIdentity = yarnRc.yarnPath
    ? await resolveRepositoryFile(yarnRc.yarnPath)
    : undefined;
  const plugins = await Promise.all(
    (yarnRc.plugins ?? [])
      .map((plugin) => plugin.path)
      .toSorted()
      .map(resolveRepositoryFile),
  );
  const facts = {
    head: params.head,
    packageManager: packageJson.packageManager,
    packageManagerName,
    packageManagerVersion,
    effectiveYarnVersion,
    packageJsonSha256: sha256(packageJsonContent),
    lockfileName: "yarn.lock" as const,
    lockfileSha256: lockfile.digest,
    yarnRcSha256: yarnRcContent ? sha256(yarnRcContent) : null,
    yarnPath: yarnPathIdentity?.path ?? null,
    yarnPathSha256: yarnPathIdentity?.sha256 ?? null,
    yarnPathMode: yarnPathIdentity?.mode ?? null,
    plugins,
  };
  return { ...facts, identityDigest: sha256(canonicalDelegationJson(facts)) };
}

export async function captureGuardedVerifierPlaywrightIdentity(params: {
  dependencyRoot: string;
  browserRoot: string;
  control?: GuardedVerifierVerificationControl;
}): Promise<z.infer<typeof PlaywrightIdentitySchema>> {
  if (params.control) {
    assertVerificationActive(params.control);
  }
  const browsersJsonPath = path.join(params.dependencyRoot, "playwright-core", "browsers.json");
  const browsersJsonContent = await readBoundedMetadata(browsersJsonPath, params.control);
  const browsersJson = z
    .object({
      browsers: z
        .array(z.object({ name: z.string().min(1), revision: z.string().min(1) }).passthrough())
        .min(1),
    })
    .passthrough()
    .parse(JSON.parse(browsersJsonContent.toString("utf8")) as unknown);
  const revisions = browsersJson.browsers
    .map((browser) => `${browser.name}@${browser.revision}`)
    .toSorted();
  const executableNames = new Set([
    "chrome",
    "chrome-headless-shell",
    "chromium",
    "headless_shell",
  ]);
  const executables: Array<{ path: string; sha256: string; mode: number }> = [];
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    if (params.control) {
      assertVerificationActive(params.control);
    }
    const directoryEntries = await readdir(directory, { withFileTypes: true });
    if (directoryEntries.length > MAX_DIRECTORY_ENTRIES) {
      throw new Error("Guarded verifier browser directory exceeds its entry limit.");
    }
    for (const entry of directoryEntries.toSorted((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (params.control) {
        assertVerificationActive(params.control);
      }
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      const pathname = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(pathname, relativePath);
      } else if (entry.isFile() && executableNames.has(entry.name)) {
        const executable = await digestFile(pathname, params.control);
        if ((executable.mode & 0o111) === 0) {
          throw new Error("Guarded verifier browser executable is not executable.");
        }
        executables.push({
          path: relativePath,
          sha256: executable.digest,
          mode: executable.mode,
        });
      }
      if (executables.length > 32) {
        throw new Error("Guarded verifier browser cache has ambiguous executable identities.");
      }
    }
  };
  await visit(params.browserRoot, "");
  if (executables.length === 0) {
    throw new Error("Guarded verifier browser cache has no Playwright executable.");
  }
  const facts = {
    browsersJsonSha256: sha256(browsersJsonContent),
    revisions,
    executables: executables.toSorted((left, right) => left.path.localeCompare(right.path)),
  };
  return { ...facts, identityDigest: sha256(canonicalDelegationJson(facts)) };
}

function assertManifestDigest(manifest: GuardedVerifierVolumeManifest): void {
  const { manifestDigest, ...facts } = manifest;
  if (manifestDigest !== sha256(canonicalDelegationJson(facts))) {
    throw new Error("Guarded verifier artifact manifest digest is invalid.");
  }
  const { identityDigest: repositoryIdentityDigest, ...repositoryFacts } = manifest.repository;
  const { identityDigest: playwrightIdentityDigest, ...playwrightFacts } = manifest.playwright;
  if (
    repositoryIdentityDigest !== sha256(canonicalDelegationJson(repositoryFacts)) ||
    playwrightIdentityDigest !== sha256(canonicalDelegationJson(playwrightFacts))
  ) {
    throw new Error("Guarded verifier artifact manifest contains an invalid nested identity.");
  }
}

async function writeManifest(pathname: string, manifest: GuardedVerifierVolumeManifest) {
  const temporary = `${pathname}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${canonicalDelegationJson(manifest)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o444,
  });
  await rename(temporary, pathname);
}

export async function prepareGuardedVerifierVolumeProvenance(params: {
  workspaceDir: string;
  dependencyRoot: string;
  browserRoot: string;
  repositoryHead: string;
  sourceRevision: string;
  effectiveYarnVersion?: string;
}): Promise<{
  dependencyManifestDigest: string;
  browserManifestDigest: string;
  toolchainDigest: string;
}> {
  if (!FULL_REVISION.test(params.sourceRevision)) {
    throw new Error("Guarded verifier preparation requires an exact source revision.");
  }
  const [repository, playwright, dependencyTree, browserTree] = await Promise.all([
    captureGuardedVerifierRepositoryIdentity({
      workspaceDir: params.workspaceDir,
      head: params.repositoryHead,
      effectiveYarnVersion: params.effectiveYarnVersion,
    }),
    captureGuardedVerifierPlaywrightIdentity({
      dependencyRoot: params.dependencyRoot,
      browserRoot: params.browserRoot,
    }),
    captureGuardedVerifierTreeIdentity({
      root: params.dependencyRoot,
      allowedSymlinkRoots: [params.workspaceDir],
    }),
    captureGuardedVerifierTreeIdentity({
      root: params.browserRoot,
      allowedSymlinkRoots: [params.browserRoot],
    }),
  ]);
  const buildManifest = (
    kind: GuardedVerifierVolumeManifest["kind"],
    tree: z.infer<typeof TreeIdentitySchema>,
  ): GuardedVerifierVolumeManifest => {
    const facts = {
      contractVersion: GUARDED_VERIFIER_VOLUME_CONTRACT,
      kind,
      sourceRevision: params.sourceRevision,
      repository,
      tree,
      playwright,
    } as const;
    return { ...facts, manifestDigest: sha256(canonicalDelegationJson(facts)) };
  };
  const dependencyManifest = buildManifest("dependencies", dependencyTree);
  const browserManifest = buildManifest("browsers", browserTree);
  await writeManifest(
    path.join(params.dependencyRoot, GUARDED_VERIFIER_VOLUME_MANIFEST),
    dependencyManifest,
  );
  await writeManifest(
    path.join(params.browserRoot, GUARDED_VERIFIER_VOLUME_MANIFEST),
    browserManifest,
  );
  const result = {
    dependencyManifestDigest: dependencyManifest.manifestDigest,
    browserManifestDigest: browserManifest.manifestDigest,
  };
  return {
    ...result,
    toolchainDigest: sha256(
      canonicalDelegationJson({
        dependencies: dependencyManifest.manifestDigest,
        browsers: browserManifest.manifestDigest,
      }),
    ),
  };
}

async function verifyGuardedVerifierVolumeContents(params: {
  workspaceDir: string;
  dependencyRoot: string;
  browserRoot: string;
  repositoryHead: string;
  sourceRevision: string;
  effectiveYarnVersion?: string;
  dependencyManifest: GuardedVerifierVolumeManifest;
  browserManifest: GuardedVerifierVolumeManifest;
  control: GuardedVerifierVerificationControl;
}): Promise<GuardedVerifierVolumeVerificationResult> {
  const [repository, playwright, dependencyTree, browserTree] = await Promise.all([
    captureGuardedVerifierRepositoryIdentity({
      workspaceDir: params.workspaceDir,
      head: params.repositoryHead,
      effectiveYarnVersion: params.effectiveYarnVersion,
      control: params.control,
    }),
    captureGuardedVerifierPlaywrightIdentity({
      dependencyRoot: params.dependencyRoot,
      browserRoot: params.browserRoot,
      control: params.control,
    }),
    captureGuardedVerifierTreeIdentity({
      root: params.dependencyRoot,
      allowedSymlinkRoots: [params.workspaceDir],
      control: params.control,
    }),
    captureGuardedVerifierTreeIdentity({
      root: params.browserRoot,
      allowedSymlinkRoots: [params.browserRoot],
      control: params.control,
    }),
  ]);
  for (const manifest of [params.dependencyManifest, params.browserManifest]) {
    if (
      manifest.repository.identityDigest !== repository.identityDigest ||
      manifest.playwright.identityDigest !== playwright.identityDigest
    ) {
      throw new Error("Guarded verifier artifact repository or browser provenance is stale.");
    }
  }
  if (
    params.dependencyManifest.tree.digest !== dependencyTree.digest ||
    params.dependencyManifest.tree.entries !== dependencyTree.entries ||
    params.dependencyManifest.tree.bytes !== dependencyTree.bytes ||
    params.browserManifest.tree.digest !== browserTree.digest ||
    params.browserManifest.tree.entries !== browserTree.entries ||
    params.browserManifest.tree.bytes !== browserTree.bytes
  ) {
    throw new Error("Guarded verifier artifact contents do not match preparation manifests.");
  }
  return {
    dependencyManifest: params.dependencyManifest,
    browserManifest: params.browserManifest,
    identityDigest: sha256(
      canonicalDelegationJson({
        dependencies: params.dependencyManifest.manifestDigest,
        browsers: params.browserManifest.manifestDigest,
      }),
    ),
  };
}

function waitForVerification(
  verificationKey: string,
  flight: VerificationFlight,
  signal: AbortSignal | undefined,
  deadlineMs: number,
): Promise<GuardedVerifierVolumeVerificationResult> {
  flight.waiters += 1;
  let released = false;
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    flight.waiters -= 1;
    if (flight.waiters === 0) {
      if (verificationFlights.get(verificationKey) === flight) {
        verificationFlights.delete(verificationKey);
      }
      flight.controller.abort();
    }
  };
  if (signal?.aborted) {
    release();
    return Promise.reject(guardedVerifierAbortError());
  }
  return new Promise<GuardedVerifierVolumeVerificationResult>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", handleAbort);
      release();
      callback();
    };
    const handleAbort = () => {
      settle(() => reject(guardedVerifierAbortError()));
    };
    const timeout = setTimeout(() => {
      settle(() =>
        reject(new Error("Guarded verifier artifact verification exceeded its deadline.")),
      );
    }, deadlineMs);
    timeout.unref();
    signal?.addEventListener("abort", handleAbort, { once: true });
    void flight.promise.then(
      (value) => {
        settle(() => resolve(value));
      },
      (error: unknown) => {
        settle(() => reject(error));
      },
    );
  });
}

async function readValidatedManifestPair(params: {
  dependencyRoot: string;
  browserRoot: string;
  repositoryHead: string;
  sourceRevision: string;
  signal?: AbortSignal;
  deadlineAt: number;
}): Promise<{
  dependencyManifest: GuardedVerifierVolumeManifest;
  browserManifest: GuardedVerifierVolumeManifest;
}> {
  const control = { signal: params.signal, deadlineAt: params.deadlineAt };
  const [dependencyRaw, browserRaw] = await Promise.all([
    readBoundedMetadata(
      path.join(params.dependencyRoot, GUARDED_VERIFIER_VOLUME_MANIFEST),
      control,
    ),
    readBoundedMetadata(path.join(params.browserRoot, GUARDED_VERIFIER_VOLUME_MANIFEST), control),
  ]);
  const dependencyManifest = GuardedVerifierVolumeManifestSchema.parse(
    JSON.parse(dependencyRaw.toString("utf8")) as unknown,
  );
  const browserManifest = GuardedVerifierVolumeManifestSchema.parse(
    JSON.parse(browserRaw.toString("utf8")) as unknown,
  );
  assertManifestDigest(dependencyManifest);
  assertManifestDigest(browserManifest);
  if (
    dependencyManifest.kind !== "dependencies" ||
    browserManifest.kind !== "browsers" ||
    dependencyManifest.sourceRevision !== params.sourceRevision ||
    browserManifest.sourceRevision !== params.sourceRevision ||
    dependencyManifest.repository.head !== params.repositoryHead ||
    browserManifest.repository.head !== params.repositoryHead ||
    dependencyManifest.repository.identityDigest !== browserManifest.repository.identityDigest ||
    dependencyManifest.playwright.identityDigest !== browserManifest.playwright.identityDigest
  ) {
    throw new Error("Guarded verifier artifact manifest identity is stale or inconsistent.");
  }
  return { dependencyManifest, browserManifest };
}

export async function inspectGuardedVerifierPublishedProvenance(params: {
  dependencyRoot: string;
  browserRoot: string;
  repositoryHead: string;
  sourceRevision: string;
  signal?: AbortSignal;
  deadlineMs?: number;
}): Promise<GuardedVerifierVolumeVerificationResult> {
  const deadlineMs = params.deadlineMs ?? DEFAULT_VERIFICATION_DEADLINE_MS;
  if (
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs <= 0 ||
    deadlineMs > DEFAULT_VERIFICATION_DEADLINE_MS
  ) {
    throw new Error("Guarded verifier artifact inspection deadline is invalid.");
  }
  const { dependencyManifest, browserManifest } = await readValidatedManifestPair({
    dependencyRoot: params.dependencyRoot,
    browserRoot: params.browserRoot,
    repositoryHead: params.repositoryHead,
    sourceRevision: params.sourceRevision,
    signal: params.signal,
    deadlineAt: Date.now() + deadlineMs,
  });
  return {
    dependencyManifest,
    browserManifest,
    identityDigest: sha256(
      canonicalDelegationJson({
        dependencies: dependencyManifest.manifestDigest,
        browsers: browserManifest.manifestDigest,
      }),
    ),
  };
}

export async function verifyGuardedVerifierVolumeProvenance(params: {
  workspaceDir: string;
  dependencyRoot: string;
  browserRoot: string;
  repositoryHead: string;
  sourceRevision: string;
  effectiveYarnVersion?: string;
  signal?: AbortSignal;
  deadlineMs?: number;
}): Promise<GuardedVerifierVolumeVerificationResult> {
  if (!FULL_REVISION.test(params.repositoryHead) || !FULL_REVISION.test(params.sourceRevision)) {
    throw new Error("Guarded verifier artifact verification requires exact revisions.");
  }
  const deadlineMs = params.deadlineMs ?? DEFAULT_VERIFICATION_DEADLINE_MS;
  if (
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs <= 0 ||
    deadlineMs > DEFAULT_VERIFICATION_DEADLINE_MS
  ) {
    throw new Error("Guarded verifier artifact verification deadline is invalid.");
  }
  const callerDeadlineAt = Date.now() + deadlineMs;
  if (params.signal?.aborted) {
    throw guardedVerifierAbortError();
  }
  const { dependencyManifest, browserManifest } = await readValidatedManifestPair({
    dependencyRoot: params.dependencyRoot,
    browserRoot: params.browserRoot,
    repositoryHead: params.repositoryHead,
    sourceRevision: params.sourceRevision,
    signal: params.signal,
    deadlineAt: callerDeadlineAt,
  });
  const identityFacts = {
    workspaceDir: path.resolve(params.workspaceDir),
    dependencyRoot: path.resolve(params.dependencyRoot),
    browserRoot: path.resolve(params.browserRoot),
    repositoryHead: params.repositoryHead,
    sourceRevision: params.sourceRevision,
    effectiveYarnVersion: params.effectiveYarnVersion,
    dependencyManifest: dependencyManifest.manifestDigest,
    browserManifest: browserManifest.manifestDigest,
  };
  const verificationKey = sha256(canonicalDelegationJson(identityFacts));
  const remainingDeadlineMs = callerDeadlineAt - Date.now();
  if (remainingDeadlineMs <= 0) {
    throw new Error("Guarded verifier artifact verification exceeded its deadline.");
  }
  const existing = verificationFlights.get(verificationKey);
  if (existing) {
    return await waitForVerification(verificationKey, existing, params.signal, remainingDeadlineMs);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_VERIFICATION_DEADLINE_MS);
  timeout.unref();
  let flight: VerificationFlight;
  const promise = verifyGuardedVerifierVolumeContents({
    workspaceDir: params.workspaceDir,
    dependencyRoot: params.dependencyRoot,
    browserRoot: params.browserRoot,
    repositoryHead: params.repositoryHead,
    sourceRevision: params.sourceRevision,
    effectiveYarnVersion: params.effectiveYarnVersion,
    dependencyManifest,
    browserManifest,
    control: {
      signal: controller.signal,
      deadlineAt: Date.now() + DEFAULT_VERIFICATION_DEADLINE_MS,
    },
  }).finally(() => {
    clearTimeout(timeout);
    if (verificationFlights.get(verificationKey) === flight) {
      verificationFlights.delete(verificationKey);
    }
  });
  flight = { controller, promise, waiters: 0 };
  verificationFlights.set(verificationKey, flight);
  return await waitForVerification(verificationKey, flight, params.signal, remainingDeadlineMs);
}
