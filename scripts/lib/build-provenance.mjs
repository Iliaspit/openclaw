import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const BUILD_PROVENANCE_VERSION = "openclaw-build-provenance-v1";
export const BUILD_PROVENANCE_VALIDATOR_ID = "openclaw-build-provenance-validator-v1";
export const BUILD_PROVENANCE_MANIFEST = "dist/build-provenance.json";
export const BUILD_PROVENANCE_REVISION_ENV = "OPENCLAW_SOURCE_REVISION";
export const BUILD_PROVENANCE_ARTIFACT_URI_ENV = "OPENCLAW_PROVENANCE_ARTIFACT_URI";
export const BUILD_PROVENANCE_REQUIRED_ENV = "OPENCLAW_REQUIRE_SOURCE_REVISION";
const BUILD_PROVENANCE_VALIDATOR_PATHS = [
  "scripts/lib/build-provenance.mjs",
  "scripts/verify-build-provenance.mjs",
];

const FULL_SOURCE_REVISION_RE = /^[0-9a-f]{40}$/u;
const PLACEHOLDER_REVISIONS = new Set([
  "null",
  "unknown",
  "undefined",
  "placeholder",
  "head",
  "main",
  "dev",
  "development",
]);
const BUILD_INPUT_PATHS = [
  ".npmrc",
  "apps/shared/OpenClawKit",
  "assets",
  "docs",
  "extensions",
  "openclaw.mjs",
  "package.json",
  "packages",
  "patches",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "qa",
  "scripts",
  "skills",
  "src",
  "tsconfig.json",
  "tsconfig.plugin-sdk.dts.json",
  "tsdown.config.ts",
  "ui",
  "vendor/a2ui",
];
const CONTAINER_BUILD_INPUT_PATHS = BUILD_INPUT_PATHS.flatMap((entry) => {
  if (entry === "assets") {
    return [];
  }
  if (entry === "apps/shared/OpenClawKit") {
    return [
      "apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/tool-display.json",
      "apps/shared/OpenClawKit/Tools/CanvasA2UI",
    ];
  }
  if (entry === "vendor/a2ui") {
    return ["vendor/a2ui/renderers/lit"];
  }
  return [entry];
});
const DIST_INVENTORY_PATH = "dist/postinstall-inventory.json";
const BUILD_INPUT_EXCLUDED_DIRECTORIES = new Set([
  ".artifacts",
  ".cache",
  ".git",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
]);

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizePath(value) {
  return value.split(path.sep).join("/");
}

export function canonicalBuildProvenanceJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalBuildProvenanceJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .toSorted(compareStrings)
      .map((key) => `${JSON.stringify(key)}:${canonicalBuildProvenanceJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function validateFullSourceRevision(value) {
  if (typeof value !== "string") {
    throw new Error("Build provenance requires a full 40-character source revision.");
  }
  const normalized = value.trim().toLowerCase();
  if (
    !FULL_SOURCE_REVISION_RE.test(normalized) ||
    normalized === "0".repeat(40) ||
    PLACEHOLDER_REVISIONS.has(normalized)
  ) {
    throw new Error(
      "Build provenance source revision is missing, malformed, or a placeholder; expected a full 40-character Git SHA.",
    );
  }
  return normalized;
}

function resolveGitRevision(cwd, execFileSyncImpl = execFileSync) {
  try {
    const output = execFileSyncImpl("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return validateFullSourceRevision(output);
  } catch {
    return null;
  }
}

export function resolveBuildSourceRevision(params = {}) {
  const cwd = params.cwd ?? process.cwd();
  const env = params.env ?? process.env;
  const required = params.required ?? env[BUILD_PROVENANCE_REQUIRED_ENV] === "1";
  const suppliedRaw = env[BUILD_PROVENANCE_REVISION_ENV];
  const supplied = suppliedRaw === undefined ? null : validateFullSourceRevision(suppliedRaw);
  const gitRevision = resolveGitRevision(cwd, params.execFileSync);

  if (required && !supplied) {
    throw new Error(
      `${BUILD_PROVENANCE_REVISION_ENV} is required for release and container builds.`,
    );
  }
  if (supplied && gitRevision && supplied !== gitRevision) {
    throw new Error(
      `Build provenance source revision mismatch: supplied ${supplied}, checkout ${gitRevision}.`,
    );
  }
  return supplied ?? gitRevision;
}

function assertSafeRuntimeSymlink(scanRoot, absolutePath, fsImpl = fs) {
  const target = fsImpl.readlinkSync(absolutePath);
  if (path.isAbsolute(target)) {
    throw new Error(`Build provenance runtime artifact symlink target is unsafe: ${absolutePath}`);
  }
  const resolvedTarget = path.resolve(path.dirname(absolutePath), target);
  const relativeTarget = path.relative(scanRoot, resolvedTarget);
  if (
    relativeTarget === ".." ||
    relativeTarget.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeTarget)
  ) {
    throw new Error(`Build provenance runtime artifact symlink target is unsafe: ${absolutePath}`);
  }
  let realTarget;
  try {
    realTarget = fsImpl.realpathSync(resolvedTarget);
  } catch {
    throw new Error(`Build provenance runtime artifact symlink target is missing: ${absolutePath}`);
  }
  // Compare physical paths on platforms where the temporary-directory prefix
  // itself is an alias (for example, macOS /var -> /private/var).
  const realScanRoot = fsImpl.realpathSync(scanRoot);
  const relativeRealTarget = path.relative(realScanRoot, realTarget);
  if (
    relativeRealTarget === ".." ||
    relativeRealTarget.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeRealTarget) ||
    !fsImpl.statSync(realTarget).isFile()
  ) {
    throw new Error(`Build provenance runtime artifact symlink target is unsafe: ${absolutePath}`);
  }
}

function listFilesRecursively(rootPath, fsImpl = fs, scanRoot = rootPath) {
  let entries;
  try {
    entries = fsImpl.readdirSync(rootPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isSymbolicLink()) {
      assertSafeRuntimeSymlink(scanRoot, entryPath, fsImpl);
      files.push(entryPath);
    }
    if (entry.isDirectory()) {
      files.push(...listFilesRecursively(entryPath, fsImpl, scanRoot));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files.toSorted((left, right) => compareStrings(normalizePath(left), normalizePath(right)));
}

function listBuildInputFilesRecursively(rootPath, fsImpl = fs) {
  let entries;
  try {
    entries = fsImpl.readdirSync(rootPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory() && !BUILD_INPUT_EXCLUDED_DIRECTORIES.has(entry.name)) {
      files.push(...listBuildInputFilesRecursively(entryPath, fsImpl));
    } else if (
      (entry.isFile() || entry.isSymbolicLink()) &&
      !entry.name.endsWith(".tsbuildinfo") &&
      !entry.name.startsWith(".openclaw-runtime-deps") &&
      !(
        normalizePath(entryPath).includes("/.generated/") &&
        (entry.name.endsWith(".json") || entry.name.endsWith(".jsonl"))
      )
    ) {
      files.push(entryPath);
    }
  }
  return files.toSorted((left, right) => compareStrings(normalizePath(left), normalizePath(right)));
}

function describeFile(rootDir, absolutePath, fsImpl = fs) {
  const bytes = fsImpl.readFileSync(absolutePath);
  return {
    path: normalizePath(path.relative(rootDir, absolutePath)),
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

function describeRuntimeArtifact(rootDir, absolutePath, fsImpl = fs) {
  if (!fsImpl.lstatSync(absolutePath).isSymbolicLink()) {
    return describeFile(rootDir, absolutePath, fsImpl);
  }
  const target = normalizePath(fsImpl.readlinkSync(absolutePath));
  const bytes = Buffer.from(target);
  return {
    kind: "symlink",
    path: normalizePath(path.relative(rootDir, absolutePath)),
    target,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

function describeBuildTreeEntry(rootDir, absolutePath, fsImpl = fs) {
  const stat = fsImpl.lstatSync(absolutePath);
  if (!stat.isSymbolicLink()) {
    return { kind: "file", ...describeFile(rootDir, absolutePath, fsImpl) };
  }
  const target = fsImpl.readlinkSync(absolutePath);
  const bytes = Buffer.from(target);
  return {
    kind: "symlink",
    path: normalizePath(path.relative(rootDir, absolutePath)),
    target: normalizePath(target),
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

function describeBuildInput(rootDir, relativePath, fsImpl = fs) {
  const absolutePath = path.join(rootDir, relativePath);
  const stat = fsImpl.statSync(absolutePath);
  if (stat.isFile()) {
    return { kind: "file", ...describeFile(rootDir, absolutePath, fsImpl) };
  }
  if (!stat.isDirectory()) {
    throw new Error(`Build provenance input is not a file or directory: ${relativePath}`);
  }
  const files = listBuildInputFilesRecursively(absolutePath, fsImpl).map((file) =>
    describeBuildTreeEntry(rootDir, file, fsImpl),
  );
  return {
    kind: "tree",
    path: normalizePath(relativePath),
    files: files.length,
    bytes: files.reduce((total, entry) => total + entry.bytes, 0),
    sha256: manifestDigest(files),
  };
}

function isNpmExcludedArtifact(relativePath) {
  return (
    /^dist\/extensions\/[^/]+\/\.openclaw-runtime-deps-/u.test(relativePath) ||
    relativePath.startsWith("dist/extensions/node_modules/") ||
    /^dist\/extensions\/[^/]+\/node_modules\//u.test(relativePath) ||
    relativePath.startsWith("dist/extensions/qa-channel/") ||
    relativePath.startsWith("dist/extensions/qa-lab/") ||
    relativePath.startsWith("dist/extensions/qa-matrix/") ||
    relativePath.startsWith("dist/plugin-sdk/extensions/qa-lab/") ||
    relativePath.startsWith("dist/plugin-sdk/qa-lab.") ||
    relativePath.startsWith("dist/plugin-sdk/qa-runtime.") ||
    relativePath === "dist/plugin-sdk/src/plugin-sdk/qa-lab.d.ts" ||
    relativePath === "dist/plugin-sdk/src/plugin-sdk/qa-runtime.d.ts" ||
    /^dist\/qa-runtime-.*\.js$/u.test(relativePath)
  );
}

function isRuntimeArtifact(relativePath, env) {
  const isContainer = env.OPENCLAW_BUILD_PROFILE?.startsWith("container") === true;
  return (
    relativePath.startsWith("dist/") &&
    !relativePath.endsWith(".map") &&
    (!isContainer ||
      (!relativePath.endsWith(".d.ts") &&
        !relativePath.endsWith(".d.mts") &&
        !relativePath.endsWith(".d.cts"))) &&
    relativePath !== "dist/.buildstamp" &&
    relativePath !== BUILD_PROVENANCE_MANIFEST &&
    !relativePath.endsWith("/.tsbuildinfo") &&
    (env.OPENCLAW_BUILD_PROFILE !== "npm-release" || !isNpmExcludedArtifact(relativePath))
  );
}

function readBuildInputs(rootDir, env, fsImpl = fs, inputPaths = BUILD_INPUT_PATHS) {
  const dockerfile = env.OPENCLAW_BUILD_DOCKERFILE?.trim() || "Dockerfile";
  return [dockerfile, ...inputPaths].toSorted(compareStrings).map((relativePath) => {
    const absolutePath = path.join(rootDir, relativePath);
    if (!fsImpl.existsSync(absolutePath)) {
      throw new Error(`Build provenance input is missing: ${relativePath}`);
    }
    return describeBuildInput(rootDir, relativePath, fsImpl);
  });
}

function resolveBuildInputPaths(env, inputPaths) {
  if (inputPaths) {
    return inputPaths;
  }
  return env.OPENCLAW_BUILD_PROFILE?.startsWith("container")
    ? CONTAINER_BUILD_INPUT_PATHS
    : BUILD_INPUT_PATHS;
}

function ensureManifestInDistInventory(rootDir, fsImpl = fs) {
  const inventoryPath = path.join(rootDir, DIST_INVENTORY_PATH);
  if (!fsImpl.existsSync(inventoryPath)) {
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(fsImpl.readFileSync(inventoryPath, "utf8"));
  } catch {
    throw new Error(`Build provenance cannot update malformed ${DIST_INVENTORY_PATH}.`);
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error(`Build provenance cannot update malformed ${DIST_INVENTORY_PATH}.`);
  }
  const inventory = [...new Set([...parsed, BUILD_PROVENANCE_MANIFEST])].toSorted(compareStrings);
  fsImpl.writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
}

function resolveRetainedArtifactUri(params) {
  const supplied = params.env[BUILD_PROVENANCE_ARTIFACT_URI_ENV]?.trim();
  if (supplied) {
    return validateRetainedArtifactUri(supplied);
  }
  if (params.required) {
    throw new Error(
      `${BUILD_PROVENANCE_ARTIFACT_URI_ENV} is required for release and container builds.`,
    );
  }
  return "local:.artifacts/build-provenance";
}

function validateRetainedArtifactUri(value) {
  if (
    typeof value !== "string" ||
    !/^[a-z][a-z0-9+.-]*:(?:\/\/)?\S+$/u.test(value) ||
    PLACEHOLDER_REVISIONS.has(value.toLowerCase())
  ) {
    throw new Error("Build provenance retained-artifact URI is missing or malformed.");
  }
  return value;
}

function assertSortedUniquePaths(entries, label) {
  const paths = entries.map((entry) => entry.path);
  if (
    paths.some(
      (entry) =>
        typeof entry !== "string" ||
        entry.length === 0 ||
        entry.includes("\\") ||
        entry !== normalizePath(entry) ||
        path.posix.isAbsolute(entry) ||
        entry.split("/").some((segment) => segment === "" || segment === "." || segment === ".."),
    )
  ) {
    throw new Error(`Build provenance ${label} contain an unsafe or non-canonical path.`);
  }
  const sorted = paths.toSorted(compareStrings);
  if (
    new Set(paths).size !== paths.length ||
    paths.some((entry, index) => entry !== sorted[index])
  ) {
    throw new Error(`Build provenance ${label} must use deterministic sorted unique paths.`);
  }
}

function manifestDigest(facts) {
  return sha256(canonicalBuildProvenanceJson(facts));
}

function assertRequiredSourceMapCoverage(runtimeArtifacts, sourceMaps) {
  if (
    sourceMaps.some(
      (entry) =>
        typeof entry.generatedArtifact !== "string" ||
        entry.path !== `${entry.generatedArtifact}.map`,
    )
  ) {
    throw new Error("Build provenance source maps contain an invalid artifact binding.");
  }
  const mappedArtifacts = new Set(sourceMaps.map((entry) => entry.generatedArtifact));
  const missing = runtimeArtifacts
    .map((entry) => entry.path)
    .filter(
      (relativePath) =>
        /^dist\/[^/]+\.(?:cjs|js|mjs)$/u.test(relativePath) && !mappedArtifacts.has(relativePath),
    );
  if (sourceMaps.length === 0 || missing.length > 0) {
    throw new Error(
      `Release and container provenance requires generated source maps for every root runtime chunk${missing.length > 0 ? `; missing: ${missing.join(", ")}` : ""}.`,
    );
  }
}

export function createBuildProvenanceManifest(params = {}) {
  const rootDir = path.resolve(params.rootDir ?? process.cwd());
  const env = params.env ?? process.env;
  const required = params.required ?? env[BUILD_PROVENANCE_REQUIRED_ENV] === "1";
  const sourceRevision =
    params.sourceRevision ??
    resolveBuildSourceRevision({
      cwd: rootDir,
      env,
      required,
      execFileSync: params.execFileSync,
    });
  if (!sourceRevision) {
    throw new Error("Build provenance cannot be emitted without a full source revision.");
  }
  const validatedRevision = validateFullSourceRevision(sourceRevision);
  const allDistFiles = listFilesRecursively(path.join(rootDir, "dist"), params.fs);
  const runtimeArtifacts = allDistFiles
    .filter((file) => isRuntimeArtifact(normalizePath(path.relative(rootDir, file)), env))
    .map((file) => describeRuntimeArtifact(rootDir, file, params.fs));
  const runtimeArtifactPaths = new Set(runtimeArtifacts.map((entry) => entry.path));
  const sourceMaps = allDistFiles
    .filter((file) => file.endsWith(".map"))
    .map((file) => {
      const described = describeFile(rootDir, file, params.fs);
      return {
        path: described.path,
        bytes: described.bytes,
        sha256: described.sha256,
        generatedArtifact: described.path.slice(0, -".map".length),
      };
    })
    .filter((entry) => runtimeArtifactPaths.has(entry.generatedArtifact));
  assertSortedUniquePaths(runtimeArtifacts, "runtime artifacts");
  assertSortedUniquePaths(sourceMaps, "source maps");
  if (required) {
    assertRequiredSourceMapCoverage(runtimeArtifacts, sourceMaps);
  }
  const buildInputs = readBuildInputs(
    rootDir,
    env,
    params.fs,
    resolveBuildInputPaths(env, params.buildInputPaths),
  );
  assertSortedUniquePaths(buildInputs, "build inputs");
  const validatorPath = "scripts/verify-build-provenance.mjs";
  const validatorFiles = BUILD_PROVENANCE_VALIDATOR_PATHS.map((relativePath) =>
    describeFile(rootDir, path.join(rootDir, relativePath), params.fs),
  );
  assertSortedUniquePaths(validatorFiles, "validator files");
  const facts = {
    version: BUILD_PROVENANCE_VERSION,
    sourceRevision: validatedRevision,
    build: {
      profile: env.OPENCLAW_BUILD_PROFILE?.trim() || (required ? "release" : "source"),
      inputs: buildInputs,
      options: {
        bundledPluginDir: env.OPENCLAW_BUNDLED_PLUGIN_DIR?.trim() || "extensions",
        bundledPlugins: env.OPENCLAW_EXTENSIONS?.trim() || "",
        dockerfile: env.OPENCLAW_BUILD_DOCKERFILE?.trim() || "Dockerfile",
        dockerVariant: env.OPENCLAW_VARIANT?.trim() || "",
        privateQa: env.OPENCLAW_BUILD_PRIVATE_QA === "1",
      },
    },
    artifacts: runtimeArtifacts,
    sourceMaps: {
      entries: sourceMaps,
      bundleDigest: manifestDigest(sourceMaps),
      retainedArtifact: {
        uri: resolveRetainedArtifactUri({ env, required, sourceRevision: validatedRevision }),
        layout: "openclaw-build-provenance-bundle-v1",
      },
    },
    validator: {
      id: BUILD_PROVENANCE_VALIDATOR_ID,
      path: validatorPath,
      files: validatorFiles,
      sha256: manifestDigest(validatorFiles),
    },
  };
  return { ...facts, manifestDigest: manifestDigest(facts) };
}

export function writeBuildProvenance(params = {}) {
  const rootDir = path.resolve(params.rootDir ?? process.cwd());
  const fsImpl = params.fs ?? fs;
  // Installed-package cleanup treats this inventory as authoritative. Register
  // the manifest before hashing artifacts so later pruning preserves it and the
  // inventory digest itself remains stable.
  ensureManifestInDistInventory(rootDir, fsImpl);
  const manifest = createBuildProvenanceManifest({ ...params, rootDir, fs: fsImpl });
  const manifestPath = path.join(rootDir, BUILD_PROVENANCE_MANIFEST);
  const bundleRoot = path.join(rootDir, ".artifacts", "build-provenance");
  fsImpl.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fsImpl.rmSync(bundleRoot, { force: true, recursive: true });
  fsImpl.mkdirSync(path.join(bundleRoot, "source-maps"), { recursive: true });
  fsImpl.mkdirSync(path.join(bundleRoot, "runtime-artifacts"), { recursive: true });
  const rendered = `${JSON.stringify(manifest, null, 2)}\n`;
  fsImpl.writeFileSync(manifestPath, rendered, "utf8");
  fsImpl.writeFileSync(path.join(bundleRoot, "build-provenance.json"), rendered, "utf8");
  fsImpl.copyFileSync(
    path.join(rootDir, "scripts/provenance-bundle.Dockerfile"),
    path.join(bundleRoot, "Dockerfile"),
  );
  for (const entry of manifest.validator.files) {
    const bundledValidatorPath = path.join(bundleRoot, "validator", entry.path);
    fsImpl.mkdirSync(path.dirname(bundledValidatorPath), { recursive: true });
    fsImpl.copyFileSync(path.join(rootDir, entry.path), bundledValidatorPath);
  }
  for (const entry of manifest.artifacts.filter((artifact) => artifact.kind !== "symlink")) {
    const target = path.join(bundleRoot, "runtime-artifacts", entry.path);
    fsImpl.mkdirSync(path.dirname(target), { recursive: true });
    fsImpl.copyFileSync(path.join(rootDir, entry.path), target);
  }
  for (const entry of manifest.artifacts.filter((artifact) => artifact.kind === "symlink")) {
    const target = path.join(bundleRoot, "runtime-artifacts", entry.path);
    fsImpl.mkdirSync(path.dirname(target), { recursive: true });
    fsImpl.symlinkSync(entry.target, target);
  }
  for (const entry of manifest.sourceMaps.entries) {
    const target = path.join(bundleRoot, "source-maps", entry.path);
    fsImpl.mkdirSync(path.dirname(target), { recursive: true });
    fsImpl.copyFileSync(path.join(rootDir, entry.path), target);
  }
  return { manifest, manifestPath, bundleRoot };
}

export function verifyBuildProvenance(params = {}) {
  const rootDir = path.resolve(params.rootDir ?? process.cwd());
  const sourceRoot = path.resolve(params.sourceRoot ?? rootDir);
  const artifactRoot = path.resolve(params.artifactRoot ?? rootDir);
  const validatorRoot = path.resolve(params.validatorRoot ?? sourceRoot);
  const fsImpl = params.fs ?? fs;
  const manifestPath = path.resolve(rootDir, params.manifestPath ?? BUILD_PROVENANCE_MANIFEST);
  const manifest = JSON.parse(fsImpl.readFileSync(manifestPath, "utf8"));
  if (!manifest || manifest.version !== BUILD_PROVENANCE_VERSION) {
    throw new Error("Unsupported or malformed build provenance manifest.");
  }
  const { manifestDigest: recordedDigest, ...facts } = manifest;
  if (recordedDigest !== manifestDigest(facts)) {
    throw new Error("Build provenance manifest digest mismatch.");
  }
  const sourceRevision = validateFullSourceRevision(manifest.sourceRevision);
  if (
    params.expectedRevision &&
    sourceRevision !== validateFullSourceRevision(params.expectedRevision)
  ) {
    throw new Error("Build provenance source revision does not match the expected revision.");
  }
  assertSortedUniquePaths(manifest.build.inputs, "build inputs");
  assertSortedUniquePaths(manifest.artifacts, "runtime artifacts");
  assertSortedUniquePaths(manifest.sourceMaps.entries, "source maps");
  if (
    params.requireRetainedSourceMaps ||
    manifest.build.profile === "release" ||
    manifest.build.profile === "npm-release" ||
    manifest.build.profile.startsWith("container")
  ) {
    assertRequiredSourceMapCoverage(manifest.artifacts, manifest.sourceMaps.entries);
  }
  const actualArtifactPaths = listFilesRecursively(path.join(artifactRoot, "dist"), fsImpl)
    .map((file) => normalizePath(path.relative(artifactRoot, file)))
    .filter((entry) =>
      isRuntimeArtifact(entry, { OPENCLAW_BUILD_PROFILE: manifest.build.profile }),
    );
  if (
    canonicalBuildProvenanceJson(actualArtifactPaths) !==
    canonicalBuildProvenanceJson(manifest.artifacts.map((entry) => entry.path))
  ) {
    throw new Error("Build provenance runtime artifact inventory mismatch.");
  }
  const buildInfo = JSON.parse(
    fsImpl.readFileSync(path.join(artifactRoot, "dist/build-info.json"), "utf8"),
  );
  if (buildInfo.commit !== sourceRevision) {
    throw new Error("build-info.json commit does not match build provenance.");
  }
  for (const entry of manifest.build.inputs) {
    const actual = describeBuildInput(sourceRoot, entry.path, fsImpl);
    if (
      actual.kind !== entry.kind ||
      actual.bytes !== entry.bytes ||
      actual.sha256 !== entry.sha256 ||
      (actual.kind === "tree" && actual.files !== entry.files)
    ) {
      throw new Error(`Build provenance file mismatch: ${entry.path}`);
    }
  }
  for (const entry of manifest.artifacts) {
    if (entry.kind !== undefined && entry.kind !== "symlink") {
      throw new Error(`Build provenance runtime artifact kind is unsupported: ${entry.path}`);
    }
    const actual = describeRuntimeArtifact(
      artifactRoot,
      path.join(artifactRoot, entry.path),
      fsImpl,
    );
    if (
      actual.bytes !== entry.bytes ||
      actual.sha256 !== entry.sha256 ||
      actual.kind !== entry.kind ||
      (actual.kind === "symlink" && actual.target !== entry.target)
    ) {
      throw new Error(`Build provenance file mismatch: ${entry.path}`);
    }
  }
  const sourceMapRoot = path.resolve(params.sourceMapRoot ?? rootDir);
  for (const entry of manifest.sourceMaps.entries) {
    const sourceMapPath = path.join(sourceMapRoot, entry.path);
    const actual = describeFile(sourceMapRoot, sourceMapPath, fsImpl);
    if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) {
      throw new Error(`Build provenance source-map mismatch: ${entry.path}`);
    }
  }
  if (manifest.sourceMaps.bundleDigest !== manifestDigest(manifest.sourceMaps.entries)) {
    throw new Error("Build provenance source-map bundle digest mismatch.");
  }
  if (manifest.sourceMaps.retainedArtifact.layout !== "openclaw-build-provenance-bundle-v1") {
    throw new Error("Build provenance retained-artifact layout is unsupported.");
  }
  validateRetainedArtifactUri(manifest.sourceMaps.retainedArtifact.uri);
  assertSortedUniquePaths(manifest.validator.files, "validator files");
  const validatorFiles = manifest.validator.files.map((entry) => {
    const actual = describeFile(validatorRoot, path.join(validatorRoot, entry.path), fsImpl);
    if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) {
      throw new Error(`Build provenance validator file mismatch: ${entry.path}`);
    }
    return actual;
  });
  if (
    manifest.validator.id !== BUILD_PROVENANCE_VALIDATOR_ID ||
    manifest.validator.path !== "scripts/verify-build-provenance.mjs" ||
    manifest.validator.sha256 !== manifestDigest(validatorFiles)
  ) {
    throw new Error("Build provenance validator identity or digest mismatch.");
  }
  if (params.requireRetainedSourceMaps && !manifest.sourceMaps.retainedArtifact.uri) {
    throw new Error("Build provenance does not declare a retained source-map artifact.");
  }
  if (
    params.expectedRetainedArtifactUri &&
    manifest.sourceMaps.retainedArtifact.uri !== params.expectedRetainedArtifactUri
  ) {
    throw new Error("Build provenance retained-artifact location does not match the expected URI.");
  }
  return manifest;
}
