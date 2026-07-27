import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { canonicalDelegationJson } from "./identity.js";
import {
  completeDiscoveryAndImplementation,
  createLedgerFixture,
  createVerificationWave,
  issueAssignment,
  startAssignment,
  unsafeDatabaseForTest,
} from "./ledger.test-helpers.js";
import {
  captureDelegationRuntimeEvidence,
  createInstalledRuntimeProvenanceVerifierCache,
  createRuntimeEvidenceSingleFlight,
  resolveDelegationRuntimeEvidenceFailureStage,
  RUNTIME_EVIDENCE_DOCKER_CHANGES_TIMEOUT_MS,
  requestBounded,
  type RuntimeEvidenceDeps,
  verifyInstalledRuntimeProvenance,
} from "./runtime-evidence.js";

const SOURCE_REVISION = "b".repeat(40);
const FILE_DIGEST = "c".repeat(64);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function provenanceManifest() {
  const input = { path: "Dockerfile", bytes: 1, sha256: FILE_DIGEST, kind: "file" as const };
  const artifact = { path: "dist/index.js", bytes: 1, sha256: FILE_DIGEST };
  const sourceMap = {
    path: "dist/index.js.map",
    bytes: 1,
    sha256: FILE_DIGEST,
    generatedArtifact: "dist/index.js",
  };
  const validatorFile = {
    path: "scripts/verify-build-provenance.mjs",
    bytes: 1,
    sha256: FILE_DIGEST,
  };
  const facts = {
    version: "openclaw-build-provenance-v1" as const,
    sourceRevision: SOURCE_REVISION,
    build: {
      profile: "release",
      inputs: [input],
      options: {
        bundledPluginDir: "extensions",
        bundledPlugins: "",
        dockerfile: "Dockerfile",
        dockerVariant: "",
        privateQa: false,
      },
    },
    artifacts: [artifact],
    sourceMaps: {
      entries: [sourceMap],
      bundleDigest: sha256(canonicalDelegationJson([sourceMap])),
      retainedArtifact: {
        uri: "embedded:/opt/openclaw/build-provenance",
        layout: "openclaw-build-provenance-bundle-v1",
      },
    },
    validator: {
      id: "openclaw-build-provenance-validator-v1",
      path: "scripts/verify-build-provenance.mjs",
      files: [validatorFile],
      sha256: sha256(canonicalDelegationJson([validatorFile])),
    },
  };
  return { ...facts, manifestDigest: sha256(canonicalDelegationJson(facts)) };
}

function evidenceDeps(params?: { now?: number; manifest?: unknown }): RuntimeEvidenceDeps {
  return {
    runtimeHostname: () => "d".repeat(12),
    readProvenance: async () => params?.manifest ?? provenanceManifest(),
    inspectSelf: async () => ({
      Id: "d".repeat(64),
      Image: `sha256:${"e".repeat(64)}`,
      Name: "/openclaw-openclaw-gateway-1",
      Config: {
        Image: "openclaw:local",
        Hostname: "d".repeat(12),
        Labels: {
          "org.opencontainers.image.revision": SOURCE_REVISION,
          "ai.openclaw.provenance.uri": "embedded:/opt/openclaw/build-provenance",
        },
      },
      RestartCount: 0,
      State: {
        Status: "running",
        StartedAt: "2026-07-21T00:00:00Z",
        Health: { Status: "healthy" },
      },
      Mounts: [
        {
          Type: "bind",
          Destination: "/home/node/.openclaw",
          RW: true,
        },
      ],
    }),
    inspectSelfChanges: async () => [],
    readSelfLogs: async () => "gateway ready\n",
    probe: async (_port, probePath) => ({
      statusCode: 200,
      status: probePath === "/healthz" ? "live" : "ready",
    }),
    cleanupInventory: async (sessionKey) => [
      {
        containerName: "owned-sandbox",
        sessionKey,
        backendId: "docker",
        image: "openclaw-sandbox:bookworm-slim",
      },
    ],
    verifyInstalledProvenance: async (manifest) => ({
      installedArtifactCount: manifest.artifacts.length,
      installedArtifactsDigest: sha256(canonicalDelegationJson(manifest.artifacts)),
      buildInfoDigest: "f".repeat(64),
      retainedBundleDigest: "9".repeat(64),
      immutableRuntimePaths: true,
    }),
    now: () => params?.now ?? 1,
  };
}

describe("guarded installed-runtime evidence", () => {
  it("enforces wall-clock deadlines and response byte bounds", async () => {
    let delayedResponse: NodeJS.Timeout | undefined;
    const slow = createServer((_request, response) => {
      delayedResponse = setTimeout(() => response.end("late"), 100);
    });
    await new Promise<void>((resolve) => slow.listen(0, "127.0.0.1", resolve));
    try {
      const address = slow.address();
      if (!address || typeof address === "string") {
        throw new Error("test server address missing");
      }
      await expect(
        requestBounded({
          host: "127.0.0.1",
          port: address.port,
          requestPath: "/",
          timeoutMs: 10,
        }),
      ).rejects.toThrow("wall-clock deadline");
    } finally {
      if (delayedResponse) {
        clearTimeout(delayedResponse);
      }
      slow.closeAllConnections();
      await new Promise<void>((resolve) => slow.close(() => resolve()));
    }

    const large = createServer((_request, response) => response.end("too-large"));
    await new Promise<void>((resolve) => large.listen(0, "127.0.0.1", resolve));
    try {
      const address = large.address();
      if (!address || typeof address === "string") {
        throw new Error("test server address missing");
      }
      await expect(
        requestBounded({
          host: "127.0.0.1",
          port: address.port,
          requestPath: "/",
          maxBytes: 4,
        }),
      ).rejects.toThrow("byte limit");
    } finally {
      await new Promise<void>((resolve) => large.close(() => resolve()));
    }
  });
  it("verifies the installed runtime inventory and rejects a self-consistent forged manifest", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-runtime-evidence-"));
    try {
      await mkdir(path.join(root, "dist"));
      const retainedRoot = path.join(root, "retained");
      await mkdir(path.join(retainedRoot, "source-maps/dist"), { recursive: true });
      await mkdir(path.join(retainedRoot, "validator/scripts"), { recursive: true });
      const buildInfo = `${JSON.stringify({ commit: SOURCE_REVISION })}\n`;
      await writeFile(path.join(root, "dist/build-info.json"), buildInfo);
      await writeFile(path.join(root, "dist/index.js"), "x");

      await writeFile(path.join(retainedRoot, "source-maps/dist/index.js.map"), "m");
      await writeFile(
        path.join(retainedRoot, "validator/scripts/verify-build-provenance.mjs"),
        "v",
      );
      const artifacts = [
        {
          path: "dist/build-info.json",
          bytes: Buffer.byteLength(buildInfo),
          sha256: sha256(buildInfo),
        },
        { path: "dist/index.js", bytes: 1, sha256: sha256("x") },
      ];
      const sourceMap = {
        path: "dist/index.js.map",
        bytes: 1,
        sha256: sha256("m"),
        generatedArtifact: "dist/index.js",
      };
      const validatorFile = {
        path: "scripts/verify-build-provenance.mjs",
        bytes: 1,
        sha256: sha256("v"),
      };
      const facts = {
        ...provenanceManifest(),
        build: { ...provenanceManifest().build, profile: "container-default" },
        artifacts,
        sourceMaps: {
          ...provenanceManifest().sourceMaps,
          entries: [sourceMap],
          bundleDigest: sha256(canonicalDelegationJson([sourceMap])),
        },
        validator: {
          ...provenanceManifest().validator,
          files: [validatorFile],
          sha256: sha256(canonicalDelegationJson([validatorFile])),
        },
      };
      const { manifestDigest: _ignored, ...manifestFacts } = facts;
      const manifest = {
        ...manifestFacts,
        manifestDigest: sha256(canonicalDelegationJson(manifestFacts)),
      };
      await expect(
        verifyInstalledRuntimeProvenance(manifest, root, retainedRoot),
      ).resolves.toMatchObject({
        installedArtifactCount: 2,
        installedArtifactsDigest: sha256(canonicalDelegationJson(artifacts)),
      });
      await writeFile(path.join(retainedRoot, "source-maps/dist/index.js.map"), "n");
      await expect(verifyInstalledRuntimeProvenance(manifest, root, retainedRoot)).rejects.toThrow(
        "source-maps file mismatch",
      );
      await writeFile(path.join(retainedRoot, "source-maps/dist/index.js.map"), "m");
      await writeFile(path.join(root, "dist/index.js"), "y");
      await expect(verifyInstalledRuntimeProvenance(manifest, root, retainedRoot)).rejects.toThrow(
        "artifact mismatch",
      );
      await writeFile(path.join(root, "dist/index.js"), "x");

      const forgedArtifacts = structuredClone(artifacts);
      forgedArtifacts[1].sha256 = sha256("y");
      const forgedFacts = { ...manifestFacts, artifacts: forgedArtifacts };
      const forged = {
        ...forgedFacts,
        manifestDigest: sha256(canonicalDelegationJson(forgedFacts)),
      };
      await expect(verifyInstalledRuntimeProvenance(forged, root, retainedRoot)).rejects.toThrow(
        "artifact mismatch",
      );

      const forgedSourceMap = { ...sourceMap, sha256: sha256("forged-map") };
      const forgedSourceMapFacts = {
        ...manifestFacts,
        sourceMaps: {
          ...manifestFacts.sourceMaps,
          entries: [forgedSourceMap],
          bundleDigest: sha256(canonicalDelegationJson([forgedSourceMap])),
        },
      };
      await expect(
        verifyInstalledRuntimeProvenance(
          {
            ...forgedSourceMapFacts,
            manifestDigest: sha256(canonicalDelegationJson(forgedSourceMapFacts)),
          },
          root,
          retainedRoot,
        ),
      ).rejects.toThrow("source-maps file mismatch");

      const forgedValidatorFile = { ...validatorFile, sha256: sha256("forged-validator") };
      const forgedValidatorFacts = {
        ...manifestFacts,
        validator: {
          ...manifestFacts.validator,
          files: [forgedValidatorFile],
          sha256: sha256(canonicalDelegationJson([forgedValidatorFile])),
        },
      };
      await expect(
        verifyInstalledRuntimeProvenance(
          {
            ...forgedValidatorFacts,
            manifestDigest: sha256(canonicalDelegationJson(forgedValidatorFacts)),
          },
          root,
          retainedRoot,
        ),
      ).rejects.toThrow("validator file mismatch");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns deterministic bounded facts and performs no protected-ledger write", async () => {
    const fixture = createLedgerFixture(["src/one.ts"]);
    try {
      completeDiscoveryAndImplementation(fixture);
      const wave = createVerificationWave(fixture);
      const issued = issueAssignment({
        fixture,
        purpose: "verification",
        role: "tester",
        candidateId: wave.candidateId,
        waveId: wave.waveId,
      });
      const started = startAssignment({ fixture, ...issued });
      const runtime = {
        guard: fixture.guard,
        ledger: fixture.ledger,
        policyDigest: fixture.policyDigest,
      };
      const changesBefore = (
        unsafeDatabaseForTest(fixture.ledger).prepare(`SELECT total_changes() AS value`).get() as {
          value: number | bigint;
        }
      ).value;
      const statusBefore = fixture.ledger.status();

      const [first, second] = await withEnvAsync(
        { OPENCLAW_SOURCE_REVISION: SOURCE_REVISION },
        async () => [
          await captureDelegationRuntimeEvidence({
            config: { gateway: { port: 18789 } } as OpenClawConfig,
            runtime,
            assignmentId: issued.assignment.assignmentId,
            childSessionKey: started.childSessionKey,
            deps: evidenceDeps({ now: 1 }),
          }),
          await captureDelegationRuntimeEvidence({
            config: { gateway: { port: 18789 } } as OpenClawConfig,
            runtime,
            assignmentId: issued.assignment.assignmentId,
            childSessionKey: started.childSessionKey,
            deps: evidenceDeps({ now: 2 }),
          }),
        ],
      );

      expect(first.snapshotDigest).toBe(second.snapshotDigest);
      expect(first.stableSnapshotDigest).toBe(first.snapshotDigest);
      expect(first.observedAt).toBe(1);
      expect(second.observedAt).toBe(2);
      expect(first.binding).toMatchObject({
        assignmentId: issued.assignment.assignmentId,
        candidateId: wave.candidateId,
        waveId: wave.waveId,
      });
      expect(first.candidate.fingerprint).toMatchObject({
        contractVersion: "openclaw-delegation-v1",
        validatorId: fixture.guard.validator.id,
        policyDigest: fixture.policyDigest,
      });
      expect(first.runtime).toMatchObject({
        sourceRevision: SOURCE_REVISION,
        imageId: `sha256:${"e".repeat(64)}`,
        containerId: "d".repeat(64),
      });
      expect(first.protected.integrity.strictReadOnlyValidation).toBe(true);
      expect(first.protected.reportLinks).toEqual([]);
      expect(first.liveChecks).toMatchObject({
        kind: "live_current",
        regressionSignatureCounts: {
          operator_action_required: 0,
          oauth_refresh_reused: 0,
          database_locked: 0,
          service_tier_invalid: 0,
          ledger_integrity_failure: 0,
        },
      });
      expect(first.capabilityAttestations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "cross-assignment-session-replay-rejection",
            kind: "installed_artifact_contract",
          }),
        ]),
      );
      expect(first.cleanupInventory).toEqual([
        expect.objectContaining({
          containerName: "owned-sandbox",
          sessionKey: started.childSessionKey,
        }),
      ]);
      expect(fixture.ledger.status()).toEqual(statusBefore);
      const changesAfter = (
        unsafeDatabaseForTest(fixture.ledger).prepare(`SELECT total_changes() AS value`).get() as {
          value: number | bigint;
        }
      ).value;
      expect(changesAfter).toBe(changesBefore);
    } finally {
      fixture.close();
    }
  });

  it("rejects another child session and malformed installed provenance", async () => {
    const fixture = createLedgerFixture(["src/one.ts"]);
    try {
      completeDiscoveryAndImplementation(fixture);
      const wave = createVerificationWave(fixture);
      const issued = issueAssignment({
        fixture,
        purpose: "verification",
        role: "reviewer",
        candidateId: wave.candidateId,
        waveId: wave.waveId,
      });
      const started = startAssignment({ fixture, ...issued });
      const runtime = {
        guard: fixture.guard,
        ledger: fixture.ledger,
        policyDigest: fixture.policyDigest,
      };
      await expect(
        captureDelegationRuntimeEvidence({
          config: {} as OpenClawConfig,
          runtime,
          assignmentId: issued.assignment.assignmentId,
          childSessionKey: "agent:reviewer:subagent:forged",
          deps: evidenceDeps(),
        }),
      ).rejects.toThrow("assignment-bound child session");

      const malformed = { ...provenanceManifest(), manifestDigest: "f".repeat(64) };
      await withEnvAsync({ OPENCLAW_SOURCE_REVISION: SOURCE_REVISION }, async () => {
        await expect(
          captureDelegationRuntimeEvidence({
            config: {} as OpenClawConfig,
            runtime,
            assignmentId: issued.assignment.assignmentId,
            childSessionKey: started.childSessionKey,
            deps: evidenceDeps({ manifest: malformed }),
          }),
        ).rejects.toThrow("manifest digest is invalid");
      });
    } finally {
      fixture.close();
    }
  });

  it("fails closed on revision, probe, inventory, or in-call provenance drift", async () => {
    const fixture = createLedgerFixture(["src/one.ts"]);
    try {
      completeDiscoveryAndImplementation(fixture);
      const wave = createVerificationWave(fixture);
      const issued = issueAssignment({
        fixture,
        purpose: "verification",
        role: "tester",
        candidateId: wave.candidateId,
        waveId: wave.waveId,
      });
      const started = startAssignment({ fixture, ...issued });
      const runtime = {
        guard: fixture.guard,
        ledger: fixture.ledger,
        policyDigest: fixture.policyDigest,
      };
      const capture = async (deps: RuntimeEvidenceDeps) =>
        await withEnvAsync({ OPENCLAW_SOURCE_REVISION: SOURCE_REVISION }, async () =>
          captureDelegationRuntimeEvidence({
            config: { gateway: { port: 18789 } } as OpenClawConfig,
            runtime,
            assignmentId: issued.assignment.assignmentId,
            childSessionKey: started.childSessionKey,
            deps,
          }),
        );

      const revisionMismatch = evidenceDeps();
      revisionMismatch.inspectSelf = async () => {
        const base = (await evidenceDeps().inspectSelf()) as {
          Config: { Image: string; Hostname: string; Labels: Record<string, string> };
        };
        return {
          ...base,
          Config: {
            ...base.Config,
            Labels: {
              "org.opencontainers.image.revision": "a".repeat(40),
              "ai.openclaw.provenance.uri": "embedded:/opt/openclaw/build-provenance",
            },
          },
        };
      };
      await expect(capture(revisionMismatch)).rejects.toThrow("image identity");

      const wrongSelf = evidenceDeps();
      wrongSelf.inspectSelf = async () => ({
        ...(await evidenceDeps().inspectSelf()),
        Config: {
          ...((await evidenceDeps().inspectSelf()) as { Config: Record<string, unknown> }).Config,
          Hostname: "e".repeat(12),
        },
      });
      await expect(capture(wrongSelf)).rejects.toThrow("requesting Gateway container");

      const baseManifest = provenanceManifest();
      const { manifestDigest: _manifestDigest, ...baseFacts } = baseManifest;
      const forgedUriFacts = {
        ...baseFacts,
        sourceMaps: {
          ...baseFacts.sourceMaps,
          retainedArtifact: {
            ...baseFacts.sourceMaps.retainedArtifact,
            uri: "oci://forged.example/provenance:latest",
          },
        },
      };
      const forgedUri = evidenceDeps({
        manifest: {
          ...forgedUriFacts,
          manifestDigest: sha256(canonicalDelegationJson(forgedUriFacts)),
        },
      });
      await expect(capture(forgedUri)).rejects.toThrow("image identity");

      const changedRuntime = evidenceDeps();
      changedRuntime.inspectSelfChanges = async () => [
        { Path: path.join(process.cwd(), "dist/index.js"), Kind: 0 },
      ];
      const changedRuntimeError = await capture(changedRuntime).catch((error: unknown) => error);
      expect(changedRuntimeError).toBeInstanceOf(Error);
      expect((changedRuntimeError as Error).message).toContain("diverged from the image");
      expect(resolveDelegationRuntimeEvidenceFailureStage(changedRuntimeError)).toBe(
        "container-inspection",
      );

      const changedDuringCapture = evidenceDeps();
      let changesChecks = 0;
      changedDuringCapture.inspectSelfChanges = async () => {
        changesChecks += 1;
        return changesChecks === 1
          ? []
          : [{ Path: path.join(process.cwd(), "dist/index.js"), Kind: 0 }];
      };
      const changedDuringCaptureError = await capture(changedDuringCapture).catch(
        (error: unknown) => error,
      );
      expect((changedDuringCaptureError as Error).message).toContain("diverged from the image");
      expect(resolveDelegationRuntimeEvidenceFailureStage(changedDuringCaptureError)).toBe(
        "container-inspection",
      );
      expect(changesChecks).toBe(2);

      for (const destination of [
        process.cwd(),
        path.join(process.cwd(), "dist"),
        "/opt/openclaw",
        "/opt/openclaw/build-provenance/source-maps",
      ]) {
        const shadowedRuntime = evidenceDeps();
        shadowedRuntime.inspectSelf = async () => ({
          ...(await evidenceDeps().inspectSelf()),
          Mounts: [{ Type: "volume", Destination: destination, RW: false }],
        });
        const shadowError = await capture(shadowedRuntime).catch((error: unknown) => error);
        expect(resolveDelegationRuntimeEvidenceFailureStage(shadowError)).toBe(
          "container-inspection",
        );
        expect((shadowError as Error).message).toContain("shadowed by a mount");
      }

      const falseReadiness = evidenceDeps();
      falseReadiness.probe = async (_port, probePath) => ({
        statusCode: 200,
        status: probePath === "/healthz" ? "live" : "unknown",
      });
      await expect(capture(falseReadiness)).rejects.toThrow("health or readiness");

      const broadInventory = evidenceDeps();
      broadInventory.cleanupInventory = async () => [
        {
          containerName: "other-sandbox",
          sessionKey: "agent:other:subagent:forged",
          backendId: "docker",
          image: "openclaw-sandbox:bookworm-slim",
        },
      ];
      await expect(capture(broadInventory)).rejects.toThrow("assignment-owned session");

      const inCallTamper = evidenceDeps();
      let verificationCount = 0;
      inCallTamper.verifyInstalledProvenance = async (manifest) => {
        verificationCount += 1;
        return {
          installedArtifactCount: manifest.artifacts.length,
          installedArtifactsDigest: sha256(canonicalDelegationJson(manifest.artifacts)),
          buildInfoDigest: "f".repeat(64),
          retainedBundleDigest: (verificationCount === 1 ? "9" : "8").repeat(64),
          immutableRuntimePaths: true,
        };
      };
      await expect(capture(inCallTamper)).rejects.toThrow("changed during bounded capture");
    } finally {
      fixture.close();
    }
  });

  it("deduplicates successful installed provenance verification and retries failures", async () => {
    const manifest = provenanceManifest();
    const identity = {
      containerId: "d".repeat(64),
      imageId: `sha256:${"e".repeat(64)}`,
    };
    let calls = 0;
    const verification = {
      installedArtifactCount: 1,
      installedArtifactsDigest: "a".repeat(64),
      buildInfoDigest: "b".repeat(64),
      retainedBundleDigest: "c".repeat(64),
      immutableRuntimePaths: true as const,
    };
    const cached = createInstalledRuntimeProvenanceVerifierCache(async () => {
      calls += 1;
      return verification;
    });

    const [first, second] = await Promise.all([
      cached(manifest, identity),
      cached(manifest, identity),
    ]);
    expect(first).toBe(verification);
    expect(second).toBe(verification);
    expect(await cached(manifest, identity)).toBe(verification);
    expect(calls).toBe(1);

    await cached(manifest, { ...identity, containerId: "f".repeat(64) });
    expect(calls).toBe(2);

    let attempts = 0;
    const retryable = createInstalledRuntimeProvenanceVerifierCache(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("transient verifier failure");
      }
      return verification;
    });
    await expect(retryable(manifest, identity)).rejects.toThrow("transient verifier failure");
    await expect(retryable(manifest, identity)).resolves.toBe(verification);
    expect(attempts).toBe(2);
  });

  it("single-flights Docker changes inspection without caching success or failure", async () => {
    expect(RUNTIME_EVIDENCE_DOCKER_CHANGES_TIMEOUT_MS).toBe(30_000);
    let calls = 0;
    let release: (() => void) | undefined;
    const action = createRuntimeEvidenceSingleFlight(async () => {
      calls += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return calls;
    });
    const first = action();
    const second = action();
    expect(calls).toBe(1);
    release?.();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 1]);

    const third = action();
    expect(calls).toBe(2);
    release?.();
    await expect(third).resolves.toBe(2);

    let attempts = 0;
    const retryable = createRuntimeEvidenceSingleFlight(async () => {
      attempts += 1;
      throw new Error(`failure-${attempts}`);
    });
    await expect(Promise.all([retryable(), retryable()])).rejects.toThrow("failure-1");
    await expect(retryable()).rejects.toThrow("failure-2");
  });

  it("reports the first fixed capture stage when parallel probes fail", async () => {
    const fixture = createLedgerFixture(["src/one.ts"]);
    try {
      completeDiscoveryAndImplementation(fixture);
      const wave = createVerificationWave(fixture);
      const issued = issueAssignment({
        fixture,
        purpose: "verification",
        role: "tester",
        candidateId: wave.candidateId,
        waveId: wave.waveId,
      });
      const started = startAssignment({ fixture, ...issued });
      const deps = evidenceDeps();
      deps.probe = async (_port, probePath) => {
        if (probePath === "/healthz") {
          await new Promise((resolve) => setTimeout(resolve, 5));
          throw new Error("health secret");
        }
        throw new Error("readiness secret");
      };
      const error = await withEnvAsync(
        { OPENCLAW_SOURCE_REVISION: SOURCE_REVISION },
        async () =>
          await captureDelegationRuntimeEvidence({
            config: { gateway: { port: 18789 } } as OpenClawConfig,
            runtime: {
              guard: fixture.guard,
              ledger: fixture.ledger,
              policyDigest: fixture.policyDigest,
            },
            assignmentId: issued.assignment.assignmentId,
            childSessionKey: started.childSessionKey,
            deps,
          }).catch((failure: unknown) => failure),
      );

      expect(resolveDelegationRuntimeEvidenceFailureStage(error)).toBe("health-probe");
      expect((error as Error).message).toBe("health secret");
    } finally {
      fixture.close();
    }
  });
});
