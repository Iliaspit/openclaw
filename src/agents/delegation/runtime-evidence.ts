import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { resolveGatewayPort } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readRegistryStrict } from "../sandbox/registry.js";
import { DELEGATION_RUNTIME_EVIDENCE_VERSION } from "./contracts.js";
import {
  canonicalDelegationJson,
  compareDelegationStrings,
  hashDelegationIdentity,
} from "./identity.js";
import type { DelegationRuntime } from "./runtime.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const FULL_SOURCE_REVISION = /^[a-f0-9]{40}$/u;
const MAX_HTTP_BYTES = 512 * 1024;
const PROVENANCE_PATH = path.resolve("dist/build-provenance.json");
const DOCKER_SOCKET_PATH = "/var/run/docker.sock";
const RETAINED_PROVENANCE_ROOT = "/opt/openclaw/build-provenance";
const BUILD_PROVENANCE_VALIDATOR_ID = "openclaw-build-provenance-validator-v1";
const BUILD_PROVENANCE_VALIDATOR_PATH = "scripts/verify-build-provenance.mjs";
const RETAINED_PROVENANCE_LAYOUT = "openclaw-build-provenance-bundle-v1";

const ProvenanceFileSchema = z.object({
  path: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(SHA256),
});
const ProvenanceManifestSchema = z.object({
  version: z.literal("openclaw-build-provenance-v1"),
  sourceRevision: z.string().regex(FULL_SOURCE_REVISION),
  manifestDigest: z.string().regex(SHA256),
  build: z.object({
    profile: z.string().min(1),
    inputs: z
      .array(
        ProvenanceFileSchema.extend({
          kind: z.enum(["file", "tree"]),
          files: z.number().int().nonnegative().optional(),
        }),
      )
      .min(1),
    options: z.object({
      bundledPluginDir: z.string(),
      bundledPlugins: z.string(),
      dockerfile: z.string(),
      dockerVariant: z.string(),
      privateQa: z.boolean(),
    }),
  }),
  artifacts: z
    .array(
      ProvenanceFileSchema.extend({
        kind: z.literal("symlink").optional(),
        target: z.string().optional(),
      }),
    )
    .min(1),
  sourceMaps: z.object({
    entries: z.array(ProvenanceFileSchema.extend({ generatedArtifact: z.string().min(1) })).min(1),
    bundleDigest: z.string().regex(SHA256),
    retainedArtifact: z.object({ uri: z.string().min(1), layout: z.string().min(1) }),
  }),
  validator: z.object({
    id: z.string().min(1),
    path: z.string().min(1),
    files: z.array(ProvenanceFileSchema).min(1),
    sha256: z.string().regex(SHA256),
  }),
});

const DockerInspectSchema = z.object({
  Id: z.string().regex(SHA256),
  Image: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  Name: z.string().min(2),
  Config: z.object({
    Image: z.string().min(1),
    Labels: z.record(z.string(), z.string().nullable()).default({}),
  }),
  RestartCount: z.number().int().nonnegative(),
  State: z.object({
    Status: z.string().min(1),
    StartedAt: z.string().min(1),
    Health: z.object({ Status: z.string().min(1) }).optional(),
  }),
});

const BoundedIdSchema = z.string().min(1).max(1024);
const DigestSchema = z.string().regex(SHA256);
const CandidateFingerprintSchema = z
  .object({
    contractVersion: z.literal("openclaw-delegation-v1"),
    candidateId: BoundedIdSchema,
    candidateDigest: DigestSchema,
    contextDigest: DigestSchema,
    scopeDigest: DigestSchema,
    worktreeIdentity: DigestSchema,
    head: z.string().min(1).max(128),
    epoch: z.number().int().positive(),
    pathCount: z.number().int().nonnegative(),
    dirtyCount: z.number().int().nonnegative(),
    validatorId: BoundedIdSchema,
    validatorVersion: BoundedIdSchema,
    validatorDigest: DigestSchema,
    policyDigest: DigestSchema,
    truncated: z.literal(false),
  })
  .strict();
const ProtectedAssignmentSchema = z
  .object({
    assignmentId: BoundedIdSchema,
    sliceId: BoundedIdSchema,
    candidateId: BoundedIdSchema.optional(),
    waveId: BoundedIdSchema.optional(),
    controllerAgentId: BoundedIdSchema,
    controllerSessionKey: BoundedIdSchema,
    workerAgentId: BoundedIdSchema,
    role: z.enum(["helper", "implementer", "tester", "reviewer", "qa"]),
    routeFamilyId: BoundedIdSchema,
    purpose: z.enum([
      "discovery",
      "implementation",
      "verification",
      "qa",
      "remediation",
      "confirmation",
    ]),
    epoch: z.number().int().positive(),
  })
  .strict();
const StackSchema = z
  .object({
    validatorId: BoundedIdSchema,
    validatorVersion: BoundedIdSchema,
    validatorDigest: DigestSchema,
    policyDigest: DigestSchema,
  })
  .strict();
const RuntimeEvidenceStableFactsSchema = z
  .object({
    version: z.literal("openclaw-delegation-runtime-evidence-v1"),
    binding: z
      .object({
        assignmentId: BoundedIdSchema,
        sliceId: BoundedIdSchema,
        candidateId: BoundedIdSchema,
        waveId: BoundedIdSchema,
        controllerAgentId: BoundedIdSchema,
        controllerSessionKey: BoundedIdSchema,
        workerAgentId: BoundedIdSchema,
        role: z.enum(["tester", "reviewer"]),
        purpose: z.enum(["verification", "qa", "confirmation"]),
        epoch: z.number().int().positive(),
        routeFamilyId: BoundedIdSchema,
      })
      .strict(),
    candidate: z
      .object({ candidateId: BoundedIdSchema, fingerprint: CandidateFingerprintSchema })
      .strict(),
    runtime: z
      .object({
        sourceRevision: z.string().regex(FULL_SOURCE_REVISION),
        imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
        containerId: DigestSchema,
        containerName: BoundedIdSchema,
        configuredImage: BoundedIdSchema,
        containerState: BoundedIdSchema,
        containerHealth: BoundedIdSchema,
        restart: z
          .object({ restartCount: z.number().int().nonnegative(), startedAt: BoundedIdSchema })
          .strict(),
        provenance: z
          .object({
            version: z.literal("openclaw-build-provenance-v1"),
            manifestDigest: DigestSchema,
            buildProfile: BoundedIdSchema,
            buildInputsDigest: DigestSchema,
            artifactCount: z.number().int().positive(),
            artifactsDigest: DigestSchema,
            installedArtifactCount: z.number().int().positive(),
            installedArtifactsDigest: DigestSchema,
            buildInfoDigest: DigestSchema,
            retainedBundleDigest: DigestSchema,
            immutableRuntimePaths: z.literal(true),
            sourceMapCount: z.number().int().positive(),
            sourceMapBundleDigest: DigestSchema,
            retainedArtifact: z.object({ uri: BoundedIdSchema, layout: BoundedIdSchema }).strict(),
            validator: z
              .object({ id: BoundedIdSchema, path: BoundedIdSchema, digest: DigestSchema })
              .strict(),
          })
          .strict(),
      })
      .strict(),
    protected: z
      .object({
        contractVersion: z.literal("openclaw-delegation-v1"),
        epoch: z.number().int().positive(),
        stack: StackSchema,
        assignment: ProtectedAssignmentSchema,
        scopeDigest: DigestSchema,
        candidate: z
          .object({ candidateId: BoundedIdSchema, fingerprint: CandidateFingerprintSchema })
          .strict(),
        waveId: BoundedIdSchema,
        bindings: z
          .array(
            z
              .object({
                bindingId: BoundedIdSchema,
                childSessionKey: BoundedIdSchema,
                runId: BoundedIdSchema.nullable(),
              })
              .strict(),
          )
          .min(1)
          .max(8),
        routeEvents: z
          .array(z.object({ eventId: BoundedIdSchema, kind: BoundedIdSchema }).strict())
          .max(64),
        reportLinks: z
          .array(
            z
              .object({
                receiptId: BoundedIdSchema,
                semanticDigest: DigestSchema,
                validationId: BoundedIdSchema.nullable(),
                outcome: z.enum(["accepted", "rejected", "blocked"]).nullable(),
                validatorId: BoundedIdSchema.nullable(),
                validatorVersion: BoundedIdSchema.nullable(),
                validatorDigest: DigestSchema.nullable(),
              })
              .strict(),
          )
          .max(8),
        auditEvents: z
          .array(z.object({ auditEventId: BoundedIdSchema, kind: BoundedIdSchema }).strict())
          .max(64),
        terminal: z
          .object({
            terminalReceiptId: BoundedIdSchema,
            acceptedReceiptId: BoundedIdSchema,
            resultReceiptId: BoundedIdSchema,
          })
          .strict()
          .nullable(),
        discoveryAdoption: z
          .object({
            adoptionId: BoundedIdSchema,
            sourceReceiptId: BoundedIdSchema,
            sourceValidationId: BoundedIdSchema,
            authorizationDigest: DigestSchema,
            idempotencyKey: BoundedIdSchema,
            scopeDigest: DigestSchema,
            baselineFingerprintDigest: DigestSchema,
          })
          .strict()
          .nullable(),
        repairRecords: z
          .array(
            z
              .object({
                repairEventId: BoundedIdSchema,
                repairReceiptId: BoundedIdSchema,
                assignmentId: BoundedIdSchema,
                authorizationDigest: DigestSchema,
                corruptionFingerprint: DigestSchema,
                outcome: BoundedIdSchema,
              })
              .strict(),
          )
          .max(64),
        integrity: z.object({ strictReadOnlyValidation: z.literal(true) }).strict(),
      })
      .strict(),
    liveChecks: z
      .object({
        kind: z.literal("live_current"),
        health: z.object({ statusCode: z.literal(200), status: BoundedIdSchema }).strict(),
        readiness: z.object({ statusCode: z.literal(200), status: BoundedIdSchema }).strict(),
        logWindow: z.literal("current-container-tail-2000"),
        regressionSignatureCounts: z
          .object({
            operator_action_required: z.number().int().nonnegative(),
            oauth_refresh_reused: z.number().int().nonnegative(),
            database_locked: z.number().int().nonnegative(),
            service_tier_invalid: z.number().int().nonnegative(),
            ledger_integrity_failure: z.number().int().nonnegative(),
          })
          .strict(),
      })
      .strict(),
    capabilityAttestations: z
      .array(
        z
          .object({
            id: BoundedIdSchema,
            kind: z.literal("installed_artifact_contract"),
            sourceRevision: z.string().regex(FULL_SOURCE_REVISION),
            contractVersion: z.literal("openclaw-delegation-v1"),
            validatorDigest: DigestSchema,
            policyDigest: DigestSchema,
            provenanceManifestDigest: DigestSchema,
            installedArtifactsDigest: DigestSchema,
            retainedBundleDigest: DigestSchema,
          })
          .strict(),
      )
      .min(1)
      .max(32),
    cleanupInventory: z
      .array(
        z
          .object({
            containerName: BoundedIdSchema,
            sessionKey: BoundedIdSchema,
            backendId: BoundedIdSchema,
            image: BoundedIdSchema,
          })
          .strict(),
      )
      .max(8),
    producer: z
      .object({
        id: z.literal("openclaw-delegation-runtime-evidence-producer-v1"),
        serialization: z.literal("canonical-delegation-json-v1"),
        auditConsumer: z.literal("protected-delegation-report-v1"),
      })
      .strict(),
  })
  .strict();

export type RuntimeEvidenceDeps = {
  readProvenance: () => Promise<unknown>;
  inspectSelf: () => Promise<unknown>;
  readSelfLogs: () => Promise<string>;
  probe: (
    port: number,
    probePath: "/healthz" | "/readyz",
  ) => Promise<{
    statusCode: number;
    status: string;
  }>;
  cleanupInventory: (
    sessionKey: string,
  ) => Promise<
    Array<{ containerName: string; sessionKey: string; backendId: string; image: string }>
  >;
  verifyInstalledProvenance: (
    manifest: z.infer<typeof ProvenanceManifestSchema>,
  ) => Promise<InstalledProvenanceVerification>;
  now: () => number;
};

type InstalledProvenanceVerification = {
  installedArtifactCount: number;
  installedArtifactsDigest: string;
  buildInfoDigest: string;
  retainedBundleDigest: string;
  immutableRuntimePaths: true;
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertSortedSafeUniquePaths(entries: Array<{ path: string }>, label: string): void {
  const paths = entries.map((entry) => entry.path);
  if (
    paths.some(
      (entry) =>
        entry.includes("\\") ||
        path.posix.isAbsolute(entry) ||
        entry.split("/").some((segment) => segment === "" || segment === "." || segment === ".."),
    )
  ) {
    throw new Error(`Installed provenance ${label} contains an unsafe path.`);
  }
  const sorted = paths.toSorted(compareDelegationStrings);
  if (
    new Set(paths).size !== paths.length ||
    paths.some((entry, index) => entry !== sorted[index])
  ) {
    throw new Error(`Installed provenance ${label} is not sorted and unique.`);
  }
}

function isInstalledRuntimeArtifact(relativePath: string, profile: string): boolean {
  const isContainer = profile.startsWith("container");
  return (
    relativePath.startsWith("dist/") &&
    !relativePath.endsWith(".map") &&
    (!isContainer ||
      (!relativePath.endsWith(".d.ts") &&
        !relativePath.endsWith(".d.mts") &&
        !relativePath.endsWith(".d.cts"))) &&
    relativePath !== "dist/.buildstamp" &&
    relativePath !== "dist/build-provenance.json" &&
    !relativePath.endsWith("/.tsbuildinfo")
  );
}

async function assertRuntimePathImmutable(absolute: string): Promise<void> {
  const stat = await lstat(absolute);
  if (stat.uid !== 0 || (!stat.isSymbolicLink() && (stat.mode & 0o022) !== 0)) {
    throw new Error("Installed provenance path is not root-owned and runtime-read-only.");
  }
}

async function listInstalledFiles(root: string, requireImmutable: boolean): Promise<string[]> {
  if (requireImmutable) {
    await assertRuntimePathImmutable(root);
  }
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.toSorted((left, right) =>
    compareDelegationStrings(left.name, right.name),
  )) {
    const absolute = path.join(root, entry.name);
    if (requireImmutable) {
      await assertRuntimePathImmutable(absolute);
    }
    if (entry.isSymbolicLink() || entry.isFile()) {
      files.push(absolute);
    } else if (entry.isDirectory()) {
      files.push(...(await listInstalledFiles(absolute, requireImmutable)));
    }
  }
  return files;
}

async function describeInstalledArtifact(root: string, absolute: string) {
  const relativePath = path.relative(root, absolute).split(path.sep).join("/");
  const stat = await lstat(absolute);
  if (!stat.isSymbolicLink()) {
    const bytes = await readFile(absolute);
    return { path: relativePath, bytes: bytes.byteLength, sha256: sha256(bytes) };
  }
  const target = (await readlink(absolute)).split(path.sep).join("/");
  if (path.posix.isAbsolute(target)) {
    throw new Error("Installed provenance contains an absolute artifact symlink.");
  }
  const resolvedTarget = path.resolve(path.dirname(absolute), target);
  const canonicalRoot = await realpath(path.join(root, "dist"));
  const canonicalTarget = await realpath(resolvedTarget);
  const relativeTarget = path.relative(canonicalRoot, canonicalTarget);
  if (
    relativeTarget === ".." ||
    relativeTarget.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeTarget) ||
    !(await lstat(canonicalTarget)).isFile()
  ) {
    throw new Error("Installed provenance contains an unsafe artifact symlink.");
  }
  const targetBytes = Buffer.from(target);
  return {
    kind: "symlink" as const,
    path: relativePath,
    target,
    bytes: targetBytes.byteLength,
    sha256: sha256(targetBytes),
  };
}

export async function verifyInstalledRuntimeProvenance(
  manifest: z.infer<typeof ProvenanceManifestSchema>,
  root = process.cwd(),
  retainedRoot = RETAINED_PROVENANCE_ROOT,
): Promise<InstalledProvenanceVerification> {
  const requireImmutable = process.env.NODE_ENV === "production";
  assertSortedSafeUniquePaths(manifest.build.inputs, "build inputs");
  assertSortedSafeUniquePaths(manifest.artifacts, "runtime artifacts");
  assertSortedSafeUniquePaths(manifest.sourceMaps.entries, "source maps");
  assertSortedSafeUniquePaths(manifest.validator.files, "validator files");
  if (
    manifest.validator.id !== BUILD_PROVENANCE_VALIDATOR_ID ||
    manifest.validator.path !== BUILD_PROVENANCE_VALIDATOR_PATH ||
    manifest.sourceMaps.retainedArtifact.layout !== RETAINED_PROVENANCE_LAYOUT ||
    !/^[a-z][a-z0-9+.-]*:(?:\/\/)?\S+$/u.test(manifest.sourceMaps.retainedArtifact.uri)
  ) {
    throw new Error("Installed provenance identity or retained-artifact contract is invalid.");
  }
  const mappedArtifacts = new Set<string>();
  for (const entry of manifest.sourceMaps.entries) {
    if (entry.path !== `${entry.generatedArtifact}.map`) {
      throw new Error("Installed provenance source-map binding is invalid.");
    }
    mappedArtifacts.add(entry.generatedArtifact);
  }
  if (manifest.build.profile.startsWith("container")) {
    const missing = manifest.artifacts
      .map((entry) => entry.path)
      .filter(
        (entry) => /^dist\/[^/]+\.(?:cjs|js|mjs)$/u.test(entry) && !mappedArtifacts.has(entry),
      );
    if (missing.length > 0) {
      throw new Error("Installed provenance is missing required root-chunk source maps.");
    }
  }
  if (requireImmutable) {
    await assertRuntimePathImmutable(path.resolve(root));
    await assertRuntimePathImmutable(path.resolve(retainedRoot));
  }
  const actualArtifacts = (
    await listInstalledFiles(path.join(path.resolve(root), "dist"), requireImmutable)
  )
    .map((absolute) => ({
      absolute,
      relative: path.relative(path.resolve(root), absolute).split(path.sep).join("/"),
    }))
    .filter((entry) => isInstalledRuntimeArtifact(entry.relative, manifest.build.profile));
  const expectedPaths = manifest.artifacts.map((entry) => entry.path);
  if (
    actualArtifacts.length !== expectedPaths.length ||
    actualArtifacts.some((entry, index) => entry.relative !== expectedPaths[index])
  ) {
    throw new Error("Installed provenance runtime artifact inventory mismatch.");
  }
  const described = [];
  for (let index = 0; index < actualArtifacts.length; index += 1) {
    const actual = await describeInstalledArtifact(
      path.resolve(root),
      actualArtifacts[index].absolute,
    );
    const expected = manifest.artifacts[index];
    if (canonicalDelegationJson(actual) !== canonicalDelegationJson(expected)) {
      throw new Error(`Installed provenance artifact mismatch: ${expected.path}`);
    }
    described.push(actual);
  }
  const buildInfoBytes = await readFile(path.join(path.resolve(root), "dist/build-info.json"));
  const buildInfo = z
    .object({ commit: z.string().regex(FULL_SOURCE_REVISION) })
    .passthrough()
    .parse(JSON.parse(buildInfoBytes.toString("utf8")));
  if (buildInfo.commit !== manifest.sourceRevision) {
    throw new Error("Installed build-info revision does not match provenance.");
  }
  const verifyRetainedInventory = async (
    subdirectory: "source-maps" | "validator",
    expected: Array<{ path: string; bytes: number; sha256: string }>,
  ) => {
    const base = path.join(path.resolve(retainedRoot), subdirectory);
    const files = await listInstalledFiles(base, requireImmutable);
    const actualPaths = files.map((absolute) =>
      path.relative(base, absolute).split(path.sep).join("/"),
    );
    if (
      actualPaths.length !== expected.length ||
      actualPaths.some((entry, index) => entry !== expected[index]?.path)
    ) {
      throw new Error(`Installed retained ${subdirectory} inventory mismatch.`);
    }
    const described = [];
    for (let index = 0; index < files.length; index += 1) {
      const stat = await lstat(files[index]);
      if (!stat.isFile()) {
        throw new Error(`Installed retained ${subdirectory} contains a non-file.`);
      }
      const bytes = await readFile(files[index]);
      const actual = {
        path: actualPaths[index],
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
      };
      if (canonicalDelegationJson(actual) !== canonicalDelegationJson(expected[index])) {
        throw new Error(`Installed retained ${subdirectory} file mismatch: ${actual.path}`);
      }
      described.push(actual);
    }
    return described;
  };
  const [retainedSourceMaps, retainedValidator] = await Promise.all([
    verifyRetainedInventory(
      "source-maps",
      manifest.sourceMaps.entries.map(
        ({ generatedArtifact: _generatedArtifact, ...entry }) => entry,
      ),
    ),
    verifyRetainedInventory("validator", manifest.validator.files),
  ]);
  const retainedSourceMapEntries = retainedSourceMaps.map((entry, index) => ({
    path: entry.path,
    bytes: entry.bytes,
    sha256: entry.sha256,
    generatedArtifact: manifest.sourceMaps.entries[index]?.generatedArtifact,
  }));
  if (
    sha256(canonicalDelegationJson(retainedSourceMapEntries)) !==
      manifest.sourceMaps.bundleDigest ||
    sha256(canonicalDelegationJson(retainedValidator)) !== manifest.validator.sha256
  ) {
    throw new Error("Installed retained provenance bundle digest mismatch.");
  }
  const verification = {
    installedArtifactCount: described.length,
    installedArtifactsDigest: sha256(canonicalDelegationJson(described)),
    buildInfoDigest: sha256(buildInfoBytes),
    retainedBundleDigest: sha256(
      canonicalDelegationJson({
        sourceMaps: retainedSourceMapEntries,
        validator: retainedValidator,
      }),
    ),
    immutableRuntimePaths: true as const,
  };
  return verification;
}

function requestBounded(params: {
  socketPath?: string;
  host?: string;
  port?: number;
  requestPath: string;
  maxBytes?: number;
}): Promise<{ statusCode: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        method: "GET",
        ...(params.socketPath
          ? { socketPath: params.socketPath }
          : { host: params.host, port: params.port }),
        path: params.requestPath,
        timeout: 5_000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > (params.maxBytes ?? MAX_HTTP_BYTES)) {
            request.destroy(new Error("Runtime evidence response exceeded its byte limit."));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({ statusCode: response.statusCode ?? 0, body: Buffer.concat(chunks) }),
        );
      },
    );
    request.on("timeout", () => request.destroy(new Error("Runtime evidence probe timed out.")));
    request.on("error", reject);
    request.end();
  });
}

async function inspectSelf(): Promise<unknown> {
  const hostname = os.hostname();
  if (!/^[a-f0-9]{12,64}$/u.test(hostname)) {
    throw new Error("Gateway runtime hostname is not a Docker container identity.");
  }
  const response = await requestBounded({
    socketPath: DOCKER_SOCKET_PATH,
    requestPath: `/containers/${hostname}/json`,
  });
  if (response.statusCode !== 200) {
    throw new Error(`Docker self-inspection failed with HTTP ${response.statusCode}.`);
  }
  return JSON.parse(response.body.toString("utf8")) as unknown;
}

async function readSelfLogs(): Promise<string> {
  const hostname = os.hostname();
  if (!/^[a-f0-9]{12,64}$/u.test(hostname)) {
    throw new Error("Gateway runtime hostname is not a Docker container identity.");
  }
  const response = await requestBounded({
    socketPath: DOCKER_SOCKET_PATH,
    requestPath: `/containers/${hostname}/logs?stdout=true&stderr=true&tail=2000&timestamps=false`,
  });
  if (response.statusCode !== 200) {
    throw new Error(`Docker log regression probe failed with HTTP ${response.statusCode}.`);
  }
  return response.body.toString("utf8");
}

async function probe(port: number, probePath: "/healthz" | "/readyz") {
  const response = await requestBounded({
    host: "127.0.0.1",
    port,
    requestPath: probePath,
    maxBytes: 16 * 1024,
  });
  let status = "unknown";
  try {
    const parsed = JSON.parse(response.body.toString("utf8")) as {
      status?: unknown;
      ok?: unknown;
      ready?: unknown;
    };
    if (typeof parsed.status === "string" && parsed.status.length <= 64) {
      status = parsed.status;
    } else if (probePath === "/readyz" && parsed.ready === true) {
      status = "ready";
    } else if (probePath === "/healthz" && parsed.ok === true) {
      status = "live";
    }
  } catch {
    // A malformed probe body remains an explicit fail-closed "unknown" fact.
  }
  return { statusCode: response.statusCode, status };
}

const defaultDeps: RuntimeEvidenceDeps = {
  readProvenance: async () => JSON.parse(await readFile(PROVENANCE_PATH, "utf8")) as unknown,
  inspectSelf,
  readSelfLogs,
  probe,
  cleanupInventory: async (sessionKey) => {
    const registry = await readRegistryStrict();
    return registry.entries
      .filter((entry) => entry.sessionKey === sessionKey)
      .map((entry) => ({
        containerName: entry.containerName,
        sessionKey: entry.sessionKey,
        backendId: entry.backendId ?? "docker",
        image: entry.image,
      }))
      .toSorted((left, right) => compareDelegationStrings(left.containerName, right.containerName));
  },
  verifyInstalledProvenance: verifyInstalledRuntimeProvenance,
  now: Date.now,
};

function countRegressionSignatures(logs: string) {
  const signatures = [
    ["operator_action_required", /operator action is required/giu],
    ["oauth_refresh_reused", /refresh_token_reused/giu],
    ["database_locked", /database is locked/giu],
    ["service_tier_invalid", /service_tier[^\n]*(?:invalid|reject|unsupported)/giu],
    ["ledger_integrity_failure", /(?:ledger|integrity)[^\n]*(?:corrupt|failed|mismatch)/giu],
  ] as const;
  return Object.fromEntries(
    signatures.map(([id, pattern]) => [id, [...logs.matchAll(pattern)].length]),
  );
}

function parseInstalledProvenance(raw: unknown) {
  const manifest = ProvenanceManifestSchema.parse(raw);
  const { manifestDigest, ...manifestFacts } = manifest;
  if (sha256(canonicalDelegationJson(manifestFacts)) !== manifestDigest) {
    throw new Error("Installed build provenance manifest digest is invalid.");
  }
  if (
    sha256(canonicalDelegationJson(manifest.sourceMaps.entries)) !==
    manifest.sourceMaps.bundleDigest
  ) {
    throw new Error("Installed build provenance source-map digest is invalid.");
  }
  if (sha256(canonicalDelegationJson(manifest.validator.files)) !== manifest.validator.sha256) {
    throw new Error("Installed build provenance validator digest is invalid.");
  }
  return manifest;
}

export async function captureDelegationRuntimeEvidence(params: {
  config: OpenClawConfig;
  runtime: DelegationRuntime;
  assignmentId: string;
  childSessionKey: string;
  deps?: Partial<RuntimeEvidenceDeps>;
}) {
  const deps = { ...defaultDeps, ...params.deps };
  const protectedFacts = params.runtime.ledger.captureProtectedEvidenceForAssignment({
    assignmentId: params.assignmentId,
    childSessionKey: params.childSessionKey,
  });
  const protectedAssignment = protectedFacts.assignment;
  if (
    !protectedAssignment.candidateId ||
    !protectedAssignment.waveId ||
    (protectedAssignment.role !== "tester" && protectedAssignment.role !== "reviewer") ||
    !["verification", "qa", "confirmation"].includes(protectedAssignment.purpose)
  ) {
    throw new Error("Runtime evidence requires an exact verifier frozen-wave assignment.");
  }
  const manifest = parseInstalledProvenance(await deps.readProvenance());
  const { manifestDigest } = manifest;
  const provenanceVerification = await deps.verifyInstalledProvenance(manifest);
  const expectedRevision = process.env.OPENCLAW_SOURCE_REVISION?.trim();
  if (!expectedRevision || !FULL_SOURCE_REVISION.test(expectedRevision)) {
    throw new Error("Installed source revision is missing or malformed.");
  }
  const container = DockerInspectSchema.parse(await deps.inspectSelf());
  const imageRevision = container.Config.Labels["org.opencontainers.image.revision"]?.trim();
  const imageProvenanceUri = container.Config.Labels["ai.openclaw.provenance.uri"]?.trim();
  if (
    expectedRevision !== manifest.sourceRevision ||
    imageRevision !== manifest.sourceRevision ||
    imageProvenanceUri !== manifest.sourceMaps.retainedArtifact.uri ||
    provenanceVerification.installedArtifactsDigest !==
      sha256(canonicalDelegationJson(manifest.artifacts))
  ) {
    throw new Error("Installed image identity does not match the build provenance manifest.");
  }
  const port = resolveGatewayPort(params.config);
  const [health, readiness, logs, cleanupInventory] = await Promise.all([
    deps.probe(port, "/healthz"),
    deps.probe(port, "/readyz"),
    deps.readSelfLogs(),
    deps.cleanupInventory(params.childSessionKey),
  ]);
  if (
    health.statusCode !== 200 ||
    health.status !== "live" ||
    readiness.statusCode !== 200 ||
    readiness.status !== "ready" ||
    container.State.Status !== "running" ||
    container.State.Health?.Status !== "healthy"
  ) {
    throw new Error("Installed gateway health or readiness probe is not green.");
  }
  if (
    cleanupInventory.length > 8 ||
    cleanupInventory.some((entry) => entry.sessionKey !== params.childSessionKey)
  ) {
    throw new Error("Runtime evidence cleanup inventory exceeded the assignment-owned session.");
  }
  const finalManifest = parseInstalledProvenance(await deps.readProvenance());
  const finalVerification = await deps.verifyInstalledProvenance(finalManifest);
  const finalProtectedFacts = params.runtime.ledger.captureProtectedEvidenceForAssignment({
    assignmentId: params.assignmentId,
    childSessionKey: params.childSessionKey,
  });
  if (
    canonicalDelegationJson(finalManifest) !== canonicalDelegationJson(manifest) ||
    canonicalDelegationJson(finalVerification) !==
      canonicalDelegationJson(provenanceVerification) ||
    canonicalDelegationJson(finalProtectedFacts) !== canonicalDelegationJson(protectedFacts)
  ) {
    throw new Error("Runtime evidence changed during bounded capture.");
  }
  const stableFacts = {
    version: DELEGATION_RUNTIME_EVIDENCE_VERSION,
    binding: {
      assignmentId: protectedAssignment.assignmentId,
      sliceId: protectedAssignment.sliceId,
      candidateId: protectedAssignment.candidateId,
      waveId: protectedAssignment.waveId,
      controllerAgentId: protectedAssignment.controllerAgentId,
      controllerSessionKey: protectedAssignment.controllerSessionKey,
      workerAgentId: protectedAssignment.workerAgentId,
      role: protectedAssignment.role,
      purpose: protectedAssignment.purpose,
      epoch: protectedAssignment.epoch,
      routeFamilyId: protectedAssignment.routeFamilyId,
    },
    candidate: protectedFacts.candidate,
    runtime: {
      sourceRevision: manifest.sourceRevision,
      imageId: container.Image,
      containerId: container.Id,
      containerName: container.Name.slice(1),
      configuredImage: container.Config.Image,
      containerState: container.State.Status,
      containerHealth: container.State.Health?.Status ?? "unavailable",
      restart: { restartCount: container.RestartCount, startedAt: container.State.StartedAt },
      provenance: {
        version: manifest.version,
        manifestDigest,
        buildProfile: manifest.build.profile,
        buildInputsDigest: sha256(canonicalDelegationJson(manifest.build.inputs)),
        artifactCount: manifest.artifacts.length,
        artifactsDigest: sha256(canonicalDelegationJson(manifest.artifacts)),
        ...provenanceVerification,
        sourceMapCount: manifest.sourceMaps.entries.length,
        sourceMapBundleDigest: manifest.sourceMaps.bundleDigest,
        retainedArtifact: manifest.sourceMaps.retainedArtifact,
        validator: {
          id: manifest.validator.id,
          path: manifest.validator.path,
          digest: manifest.validator.sha256,
        },
      },
    },
    protected: protectedFacts,
    liveChecks: {
      kind: "live_current" as const,
      health,
      readiness,
      logWindow: "current-container-tail-2000",
      regressionSignatureCounts: countRegressionSignatures(logs),
    },
    capabilityAttestations: [
      "assignment-bound-evidence-namespace",
      "nonterminal-report-preflight",
      "malformed-report-rejection",
      "stale-candidate-wave-rejection",
      "identity-separation",
      "cross-assignment-session-replay-rejection",
      "deterministic-retry-idempotency",
      "duplicate-discovery-adoption-idempotency",
      "duplicate-repair-idempotency",
      "stale-active-reconciliation",
      "child-callback-waiter-separation",
    ].map((id) => ({
      id,
      kind: "installed_artifact_contract" as const,
      sourceRevision: manifest.sourceRevision,
      contractVersion: protectedFacts.contractVersion,
      validatorDigest: protectedFacts.stack.validatorDigest,
      policyDigest: protectedFacts.stack.policyDigest,
      provenanceManifestDigest: manifestDigest,
      installedArtifactsDigest: provenanceVerification.installedArtifactsDigest,
      retainedBundleDigest: provenanceVerification.retainedBundleDigest,
    })),
    cleanupInventory,
    producer: {
      id: "openclaw-delegation-runtime-evidence-producer-v1",
      serialization: "canonical-delegation-json-v1",
      auditConsumer: "protected-delegation-report-v1",
    },
  };
  const validatedStableFacts = RuntimeEvidenceStableFactsSchema.parse(stableFacts);
  return {
    ...validatedStableFacts,
    snapshotDigest: hashDelegationIdentity(
      DELEGATION_RUNTIME_EVIDENCE_VERSION,
      validatedStableFacts,
    ),
    observedAt: deps.now(),
  };
}
