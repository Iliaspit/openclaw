import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { DelegationGuardConfig } from "../../config/types.agents.js";
import {
  DELEGATION_CONTRACT_VERSION,
  type CanonicalDelegationScope,
  type DelegationFingerprint,
  type DelegationRepositorySnapshot,
} from "./contracts.js";
import { canonicalDelegationJson, hashDelegationIdentity } from "./identity.js";

const execFileAsync = promisify(execFile);
const MAX_GIT_TEXT_BYTES = 64 * 1024;
const MAX_SCOPE_PATHS = 10_000;

type ScopedDelegationFile = {
  path: string;
  expectation: "existing" | "may-create";
  state: "missing" | "file";
  digest?: string;
};

async function runGitText(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repoPath,
    encoding: "utf8",
    maxBuffer: MAX_GIT_TEXT_BYTES,
  });
  return stdout.trim();
}

async function streamGitOutput(params: {
  repoPath: string;
  args: string[];
  onChunk?: (chunk: Buffer) => void;
}): Promise<string> {
  const child = spawn("git", params.args, {
    cwd: params.repoPath,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exitPromise = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  const hash = createHash("sha256");
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < MAX_GIT_TEXT_BYTES) {
      stderr += chunk.toString("utf8", 0, MAX_GIT_TEXT_BYTES - stderr.length);
    }
  });
  for await (const rawChunk of child.stdout) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    hash.update(chunk);
    params.onChunk?.(chunk);
  }
  const exitCode = await exitPromise;
  if (exitCode !== 0) {
    throw new Error(`git ${params.args[0] ?? "command"} failed: ${stderr.trim()}`);
  }
  return hash.digest("hex");
}

async function hashFile(pathname: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(pathname)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function collectNullFields(onField: (field: string) => void): (chunk: Buffer) => void {
  let pending = Buffer.alloc(0);
  return (chunk) => {
    const joined = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    let start = 0;
    for (let index = 0; index < joined.length; index += 1) {
      if (joined[index] !== 0) {
        continue;
      }
      onField(joined.subarray(start, index).toString("utf8"));
      start = index + 1;
    }
    pending = Buffer.from(joined.subarray(start));
  };
}

async function* streamGitNullFields(params: {
  repoPath: string;
  args: string[];
}): AsyncGenerator<string> {
  const child = spawn("git", params.args, {
    cwd: params.repoPath,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exitPromise = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  let pending = Buffer.alloc(0);
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < MAX_GIT_TEXT_BYTES) {
      stderr += chunk.toString("utf8", 0, MAX_GIT_TEXT_BYTES - stderr.length);
    }
  });
  for await (const rawChunk of child.stdout) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    const joined = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    let start = 0;
    for (let index = 0; index < joined.length; index += 1) {
      if (joined[index] !== 0) {
        continue;
      }
      yield joined.subarray(start, index).toString("utf8");
      start = index + 1;
    }
    pending = joined.subarray(start);
  }
  const exitCode = await exitPromise;
  if (exitCode !== 0) {
    throw new Error(`git ${params.args[0] ?? "command"} failed: ${stderr.trim()}`);
  }
  if (pending.length > 0) {
    throw new Error(`git ${params.args[0] ?? "command"} returned a non-NUL-terminated field.`);
  }
}

async function resolveRepositoryContext(params: {
  repoRoot: string;
  head: string;
}): Promise<{ contextDigest: string; repositoryPathCount: number }> {
  const diffDigest = await streamGitOutput({
    repoPath: params.repoRoot,
    args: ["diff", "--binary", "--no-ext-diff", "HEAD", "--"],
  });
  let repositoryPathCount = 0;
  const repositoryInventoryDigest = await streamGitOutput({
    repoPath: params.repoRoot,
    args: ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    onChunk: collectNullFields((field) => {
      if (field) {
        repositoryPathCount += 1;
      }
    }),
  });
  const untrackedContent = createHash("sha256");
  for await (const relativePath of streamGitNullFields({
    repoPath: params.repoRoot,
    args: ["ls-files", "-z", "--others", "--exclude-standard"],
  })) {
    if (!relativePath) {
      continue;
    }
    const absolutePath = path.resolve(params.repoRoot, relativePath);
    const stat = await lstat(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Repository fingerprint cannot hash non-regular path: ${relativePath}`);
    }
    const digest = await hashFile(absolutePath);
    untrackedContent
      .update(String(Buffer.byteLength(relativePath, "utf8")))
      .update(":")
      .update(relativePath)
      .update("\0")
      .update(digest)
      .update("\0");
  }
  return {
    contextDigest: hashDelegationIdentity("delegation-repository-context-v1", {
      head: params.head,
      diffDigest,
      repositoryInventoryDigest,
      untrackedContentDigest: untrackedContent.digest("hex"),
    }),
    repositoryPathCount,
  };
}

async function collectDirtyRepositoryPaths(repoRoot: string): Promise<string[]> {
  const paths = new Set<string>();
  for await (const relativePath of streamGitNullFields({
    repoPath: repoRoot,
    args: ["diff", "--name-only", "-z", "HEAD", "--"],
  })) {
    if (relativePath) {
      paths.add(relativePath.normalize("NFC"));
    }
  }
  for await (const relativePath of streamGitNullFields({
    repoPath: repoRoot,
    args: ["ls-files", "-z", "--others", "--exclude-standard"],
  })) {
    if (relativePath) {
      paths.add(relativePath.normalize("NFC"));
    }
  }
  return [...paths].toSorted();
}

async function captureRepositorySnapshotOnce(
  repoRoot: string,
): Promise<Omit<DelegationRepositorySnapshot, "snapshotDigest">> {
  const gitCommonDirRaw = await runGitText(repoRoot, ["rev-parse", "--git-common-dir"]);
  const gitCommonDir = await realpath(path.resolve(repoRoot, gitCommonDirRaw));
  const head = await runGitText(repoRoot, ["rev-parse", "HEAD"]);
  const worktreeIdentity = hashDelegationIdentity("delegation-worktree-v1", {
    repoRoot,
    gitCommonDir,
  });
  const entries: DelegationRepositorySnapshot["entries"] = [];
  for (const relativePath of await collectDirtyRepositoryPaths(repoRoot)) {
    const absolutePath = path.resolve(repoRoot, relativePath);
    const relative = path.relative(repoRoot, absolutePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Repository snapshot path escapes the worktree: ${relativePath}`);
    }
    try {
      const stat = await lstat(absolutePath);
      if (stat.isFile()) {
        entries.push({ path: relativePath, state: "file", digest: await hashFile(absolutePath) });
      } else if (stat.isSymbolicLink()) {
        entries.push({
          path: relativePath,
          state: "symlink",
          digest: hashDelegationIdentity("delegation-symlink-v1", await readlink(absolutePath)),
        });
      } else {
        entries.push({
          path: relativePath,
          state: "other",
          digest: hashDelegationIdentity("delegation-other-path-v1", {
            mode: stat.mode,
            size: stat.size,
          }),
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      entries.push({
        path: relativePath,
        state: "missing",
        digest: hashDelegationIdentity("delegation-missing-path-v1", relativePath),
      });
    }
  }
  return {
    version: "openclaw-repository-snapshot-v1",
    repositoryRoot: repoRoot,
    head,
    worktreeIdentity,
    entries,
  };
}

/** Capture the full dirty-path inventory for protected-state comparison only. */
export async function captureDelegationRepositorySnapshot(params: {
  repoPath: string;
}): Promise<DelegationRepositorySnapshot> {
  const repoRoot = await realpath(
    await runGitText(params.repoPath, ["rev-parse", "--show-toplevel"]),
  );
  const before = await captureRepositorySnapshotOnce(repoRoot);
  const after = await captureRepositorySnapshotOnce(repoRoot);
  if (canonicalDelegationJson(before) !== canonicalDelegationJson(after)) {
    throw new Error(
      "Repository state changed while its protected delegation inventory was captured; retry.",
    );
  }
  return {
    ...after,
    snapshotDigest: hashDelegationIdentity("delegation-repository-snapshot-v1", after),
  };
}

async function assertPathWithinRoot(params: {
  rootRealPath: string;
  absolutePath: string;
  relativePath: string;
  allowMissing: boolean;
}): Promise<{ state: "missing" | "file"; digest?: string }> {
  try {
    const stat = await lstat(params.absolutePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Delegation scope path must be a regular file: ${params.relativePath}`);
    }
    const resolved = await realpath(params.absolutePath);
    if (
      resolved !== params.rootRealPath &&
      !resolved.startsWith(`${params.rootRealPath}${path.sep}`)
    ) {
      throw new Error(`Delegation scope path escapes the repository: ${params.relativePath}`);
    }
    const canonicalRelative = path
      .relative(params.rootRealPath, resolved)
      .split(path.sep)
      .join("/")
      .normalize("NFC");
    if (canonicalRelative !== params.relativePath) {
      throw new Error(
        `Delegation scope path is an alias, not the canonical file path: ${params.relativePath}`,
      );
    }
    return { state: "file", digest: await hashFile(resolved) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" || !params.allowMissing) {
      throw error;
    }
    let ancestor = path.dirname(params.absolutePath);
    while (true) {
      try {
        const resolvedAncestor = await realpath(ancestor);
        if (
          resolvedAncestor !== params.rootRealPath &&
          !resolvedAncestor.startsWith(`${params.rootRealPath}${path.sep}`)
        ) {
          throw new Error(`Delegation scope path escapes the repository: ${params.relativePath}`, {
            cause: error,
          });
        }
        const missingSuffix = path.relative(ancestor, params.absolutePath);
        const canonicalMissing = path
          .relative(params.rootRealPath, path.resolve(resolvedAncestor, missingSuffix))
          .split(path.sep)
          .join("/")
          .normalize("NFC");
        if (canonicalMissing !== params.relativePath) {
          throw new Error(
            `Delegation scope path is an alias, not the canonical may-create path: ${params.relativePath}`,
            { cause: error },
          );
        }
        break;
      } catch (ancestorError) {
        if ((ancestorError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw ancestorError;
        }
        const parent = path.dirname(ancestor);
        if (parent === ancestor) {
          throw new Error(`Cannot resolve delegation scope parent: ${params.relativePath}`, {
            cause: ancestorError,
          });
        }
        ancestor = parent;
      }
    }
    return { state: "missing" };
  }
}

async function countDirtyPaths(repoRoot: string, paths: string[]): Promise<number> {
  let count = 0;
  let skipRenameTarget = false;
  const args = ["status", "--porcelain=v1", "-z", "--untracked-files=all"];
  if (paths.length > 0) {
    args.push("--", ...paths);
  }
  await streamGitOutput({
    repoPath: repoRoot,
    args,
    onChunk: collectNullFields((field) => {
      if (skipRenameTarget) {
        skipRenameTarget = false;
        return;
      }
      if (!field) {
        return;
      }
      count += 1;
      const status = new Set(field.slice(0, 2));
      skipRenameTarget = status.has("R") || status.has("C");
    }),
  });
  return count;
}

async function resolveScopedFiles(params: {
  repoRoot: string;
  scope: CanonicalDelegationScope;
}): Promise<ScopedDelegationFile[]> {
  if (params.scope.manifest.kind !== "slice") {
    return [];
  }
  const scopedFiles: ScopedDelegationFile[] = [];
  for (const entry of params.scope.manifest.entries) {
    const fileState = await assertPathWithinRoot({
      rootRealPath: params.repoRoot,
      absolutePath: path.resolve(params.repoRoot, entry.path),
      relativePath: entry.path,
      allowMissing: entry.expectation === "may-create",
    });
    scopedFiles.push({ ...entry, ...fileState });
  }
  return scopedFiles;
}

export async function fingerprintDelegationCandidate(params: {
  repoPath: string;
  scope: CanonicalDelegationScope;
  guard: DelegationGuardConfig;
  policyDigest: string;
  epoch: number;
}): Promise<DelegationFingerprint> {
  if (params.scope.paths.length > MAX_SCOPE_PATHS) {
    throw new Error(`Delegation scope exceeds ${MAX_SCOPE_PATHS} paths.`);
  }
  const repoRoot = await realpath(
    await runGitText(params.repoPath, ["rev-parse", "--show-toplevel"]),
  );
  const gitCommonDirRaw = await runGitText(repoRoot, ["rev-parse", "--git-common-dir"]);
  const gitCommonDir = await realpath(path.resolve(repoRoot, gitCommonDirRaw));
  const head = await runGitText(repoRoot, ["rev-parse", "HEAD"]);
  const worktreeIdentity = hashDelegationIdentity("delegation-worktree-v1", {
    repoRoot,
    gitCommonDir,
  });
  const contextBefore = await resolveRepositoryContext({
    repoRoot,
    head,
  });
  const scopedFiles = await resolveScopedFiles({ repoRoot, scope: params.scope });
  const dirtyCountBefore = await countDirtyPaths(repoRoot, params.scope.paths);
  const headAfter = await runGitText(repoRoot, ["rev-parse", "HEAD"]);
  const contextAfter = await resolveRepositoryContext({ repoRoot, head: headAfter });
  const scopedFilesAfter = await resolveScopedFiles({ repoRoot, scope: params.scope });
  const dirtyCount = await countDirtyPaths(repoRoot, params.scope.paths);
  if (
    headAfter !== head ||
    contextAfter.contextDigest !== contextBefore.contextDigest ||
    contextAfter.repositoryPathCount !== contextBefore.repositoryPathCount ||
    canonicalDelegationJson(scopedFilesAfter) !== canonicalDelegationJson(scopedFiles) ||
    dirtyCount !== dirtyCountBefore
  ) {
    throw new Error(
      "Repository state changed while the delegation candidate was being fingerprinted; retry from a stable snapshot.",
    );
  }
  const { contextDigest, repositoryPathCount } = contextAfter;
  const candidateFacts = {
    contractVersion: DELEGATION_CONTRACT_VERSION,
    policyDigest: params.policyDigest,
    validator: {
      id: params.guard.validator.id,
      version: params.guard.validator.version,
      digest: params.guard.validator.sha256,
    },
    epoch: params.epoch,
    worktreeIdentity,
    head,
    scopeDigest: params.scope.scopeDigest,
    scopedFiles:
      params.scope.manifest.kind === "slice"
        ? scopedFiles
        : [{ path: "<repository>", state: "file", digest: contextDigest }],
    contextDigest,
  };
  const candidateDigest = hashDelegationIdentity("delegation-candidate-v1", candidateFacts);
  return {
    contractVersion: DELEGATION_CONTRACT_VERSION,
    candidateId: `candidate_${candidateDigest}`,
    candidateDigest,
    contextDigest,
    scopeDigest: params.scope.scopeDigest,
    worktreeIdentity,
    head,
    epoch: params.epoch,
    pathCount:
      params.scope.manifest.kind === "slice" ? params.scope.paths.length : repositoryPathCount,
    dirtyCount,
    validatorId: params.guard.validator.id,
    validatorVersion: params.guard.validator.version,
    validatorDigest: params.guard.validator.sha256,
    policyDigest: params.policyDigest,
    truncated: false,
  };
}
