import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalBuildProvenanceJson,
  resolveBuildSourceRevision,
  verifyBuildProvenance,
  writeBuildProvenance,
} from "../../scripts/lib/build-provenance.mjs";

const SOURCE_REVISION = "1234567890abcdef1234567890abcdef12345678";
const OTHER_REVISION = "abcdef1234567890abcdef1234567890abcdef12";
const fixtureRoots: string[] = [];

function createFixture(params: { sourceMap?: boolean } = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-build-provenance-"));
  fixtureRoots.push(rootDir);
  fs.mkdirSync(path.join(rootDir, "dist"), { recursive: true });
  fs.mkdirSync(path.join(rootDir, "scripts/lib"), { recursive: true });
  fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "Dockerfile"), "FROM scratch\n");
  fs.writeFileSync(path.join(rootDir, "package.json"), '{"name":"fixture"}\n');
  fs.writeFileSync(path.join(rootDir, "scripts/verify-build-provenance.mjs"), "// validator\n");
  fs.writeFileSync(path.join(rootDir, "scripts/lib/build-provenance.mjs"), "// validator lib\n");
  fs.writeFileSync(path.join(rootDir, "scripts/provenance-bundle.Dockerfile"), "FROM scratch\n");
  fs.writeFileSync(path.join(rootDir, "src/fixture.ts"), "export const fixture = true;\n");
  fs.writeFileSync(path.join(rootDir, "dist/chunk.js"), "export const value = 1;\n");
  fs.writeFileSync(
    path.join(rootDir, "dist/postinstall-inventory.json"),
    `${JSON.stringify(["dist/build-info.json", "dist/chunk.js"], null, 2)}\n`,
  );
  if (params.sourceMap !== false) {
    fs.writeFileSync(path.join(rootDir, "dist/chunk.js.map"), '{"version":3}\n');
  }
  fs.writeFileSync(
    path.join(rootDir, "dist/build-info.json"),
    `${JSON.stringify({ version: "1.0.0", commit: SOURCE_REVISION })}\n`,
  );
  return rootDir;
}

function requiredEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    OPENCLAW_SOURCE_REVISION: SOURCE_REVISION,
    OPENCLAW_REQUIRE_SOURCE_REVISION: "1",
    OPENCLAW_PROVENANCE_ARTIFACT_URI: "oci://example/openclaw-provenance:fixture",
    ...extra,
  };
}

function emitFixture(rootDir: string) {
  return writeBuildProvenance({
    rootDir,
    env: requiredEnv(),
    buildInputPaths: ["package.json", "scripts/provenance-bundle.Dockerfile", "src"],
  });
}

afterEach(() => {
  for (const rootDir of fixtureRoots.splice(0)) {
    fs.rmSync(rootDir, { force: true, recursive: true });
  }
});

describe("build provenance", () => {
  it("binds a full source revision, build inputs, runtime chunks, source maps, and validator", () => {
    const rootDir = createFixture();
    const { manifest, bundleRoot } = emitFixture(rootDir);

    expect(manifest.sourceRevision).toBe(SOURCE_REVISION);
    expect(manifest.build.inputs.map((entry) => entry.path)).toEqual([
      "Dockerfile",
      "package.json",
      "scripts/provenance-bundle.Dockerfile",
      "src",
    ]);
    expect(manifest.build.inputs.find((entry) => entry.path === "src")).toMatchObject({
      kind: "tree",
      files: 1,
    });
    expect(manifest.artifacts.map((entry) => entry.path)).toEqual([
      "dist/build-info.json",
      "dist/chunk.js",
      "dist/postinstall-inventory.json",
    ]);
    expect(
      JSON.parse(fs.readFileSync(path.join(rootDir, "dist/postinstall-inventory.json"), "utf8")),
    ).toContain("dist/build-provenance.json");
    expect(manifest.sourceMaps.entries.map((entry) => entry.path)).toEqual(["dist/chunk.js.map"]);
    expect(manifest.validator.id).toBe("openclaw-build-provenance-validator-v1");
    expect(fs.existsSync(path.join(bundleRoot, "source-maps/dist/chunk.js.map"))).toBe(true);
    expect(fs.existsSync(path.join(bundleRoot, "runtime-artifacts/dist/chunk.js"))).toBe(true);
    expect(
      fs.existsSync(path.join(bundleRoot, "validator/scripts/verify-build-provenance.mjs")),
    ).toBe(true);
    expect(fs.existsSync(path.join(bundleRoot, "validator/scripts/lib/build-provenance.mjs"))).toBe(
      true,
    );
    expect(
      verifyBuildProvenance({
        rootDir,
        expectedRevision: SOURCE_REVISION,
        requireRetainedSourceMaps: true,
      }).manifestDigest,
    ).toBe(manifest.manifestDigest);
  });

  it("verifies stripped runtime output against the separately retained source-map bundle", () => {
    const rootDir = createFixture();
    const { bundleRoot } = emitFixture(rootDir);
    fs.rmSync(path.join(rootDir, "dist/chunk.js.map"));

    expect(() =>
      verifyBuildProvenance({
        rootDir,
        sourceMapRoot: path.join(bundleRoot, "source-maps"),
        validatorRoot: path.join(bundleRoot, "validator"),
        expectedRevision: SOURCE_REVISION,
      }),
    ).not.toThrow();
  });

  it.runIf(process.platform !== "win32")(
    "records, retains, and verifies safe runtime dependency symlinks",
    () => {
      const rootDir = createFixture();
      const binDir = path.join(rootDir, "dist/extensions/diffs/node_modules/.bin");
      const packageDir = path.join(rootDir, "dist/extensions/diffs/node_modules/playwright-core");
      const alternateDir = path.join(rootDir, "dist/extensions/diffs/node_modules/alternate");
      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(packageDir, { recursive: true });
      fs.mkdirSync(alternateDir, { recursive: true });
      fs.writeFileSync(path.join(packageDir, "cli.js"), "export const cli = true;\n");
      fs.writeFileSync(path.join(alternateDir, "cli.js"), "export const cli = true;\n");
      const linkPath = path.join(binDir, "playwright-core");
      fs.symlinkSync("../playwright-core/cli.js", linkPath);

      const { manifest, bundleRoot } = emitFixture(rootDir);

      expect(
        manifest.artifacts.find(
          (entry) => entry.path === "dist/extensions/diffs/node_modules/.bin/playwright-core",
        ),
      ).toMatchObject({ kind: "symlink", target: "../playwright-core/cli.js" });
      const retainedLink = path.join(
        bundleRoot,
        "runtime-artifacts/dist/extensions/diffs/node_modules/.bin/playwright-core",
      );
      expect(fs.lstatSync(retainedLink).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(retainedLink)).toBe("../playwright-core/cli.js");
      expect(() => verifyBuildProvenance({ rootDir })).not.toThrow();

      fs.unlinkSync(linkPath);
      fs.symlinkSync("../alternate/cli.js", linkPath);
      expect(() => verifyBuildProvenance({ rootDir })).toThrow(/file mismatch/u);
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects runtime artifact symlinks that escape dist",
    () => {
      const rootDir = createFixture();
      const binDir = path.join(rootDir, "dist/extensions/diffs/node_modules/.bin");
      const outsidePath = path.join(rootDir, "outside.js");
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(outsidePath, "export const outside = true;\n");
      fs.symlinkSync(path.relative(binDir, outsidePath), path.join(binDir, "outside"));

      expect(() => emitFixture(rootDir)).toThrow(/symlink target is unsafe/u);
    },
  );

  it.each([
    ["missing", undefined],
    ["null", "null"],
    ["malformed", "abc123"],
    ["placeholder zeros", "0000000000000000000000000000000000000000"],
  ])("fails closed for a %s required source revision", (_label, revision) => {
    const env: NodeJS.ProcessEnv = { OPENCLAW_REQUIRE_SOURCE_REVISION: "1" };
    if (revision !== undefined) {
      env.OPENCLAW_SOURCE_REVISION = revision;
    }
    expect(() =>
      resolveBuildSourceRevision({
        cwd: createFixture(),
        env,
        required: true,
        execFileSync: () => {
          throw new Error("no git metadata");
        },
      }),
    ).toThrow(/source revision|OPENCLAW_SOURCE_REVISION/u);
  });

  it("rejects a supplied revision that does not match the checked-out commit", () => {
    const execFileSync = (() =>
      `${OTHER_REVISION}\n`) as typeof import("node:child_process").execFileSync;
    expect(() =>
      resolveBuildSourceRevision({
        cwd: createFixture(),
        env: requiredEnv(),
        required: true,
        execFileSync,
      }),
    ).toThrow(/source revision mismatch/u);
  });

  it("requires source maps and an explicit retained-artifact location for release builds", () => {
    const noMapRoot = createFixture({ sourceMap: false });
    expect(() =>
      writeBuildProvenance({
        rootDir: noMapRoot,
        env: requiredEnv(),
        buildInputPaths: ["package.json", "scripts/provenance-bundle.Dockerfile", "src"],
      }),
    ).toThrow(/requires generated source maps/u);

    const noUriRoot = createFixture();
    expect(() =>
      writeBuildProvenance({
        rootDir: noUriRoot,
        env: requiredEnv({ OPENCLAW_PROVENANCE_ARTIFACT_URI: undefined }),
        buildInputPaths: ["package.json", "scripts/provenance-bundle.Dockerfile", "src"],
      }),
    ).toThrow(/OPENCLAW_PROVENANCE_ARTIFACT_URI/u);

    const malformedUriRoot = createFixture();
    expect(() =>
      writeBuildProvenance({
        rootDir: malformedUriRoot,
        env: requiredEnv({ OPENCLAW_PROVENANCE_ARTIFACT_URI: "not-a-location" }),
        buildInputPaths: ["package.json", "scripts/provenance-bundle.Dockerfile", "src"],
      }),
    ).toThrow(/retained-artifact URI/u);
  });

  it("rejects artifact, build-info, validator, and source-map mismatches", () => {
    const inputRoot = createFixture();
    emitFixture(inputRoot);
    fs.appendFileSync(path.join(inputRoot, "src/fixture.ts"), "// tampered\n");
    expect(() => verifyBuildProvenance({ rootDir: inputRoot })).toThrow(/file mismatch/u);

    const artifactRoot = createFixture();
    emitFixture(artifactRoot);
    fs.appendFileSync(path.join(artifactRoot, "dist/chunk.js"), "tampered\n");
    expect(() => verifyBuildProvenance({ rootDir: artifactRoot })).toThrow(/file mismatch/u);

    const infoRoot = createFixture();
    emitFixture(infoRoot);
    fs.writeFileSync(
      path.join(infoRoot, "dist/build-info.json"),
      `${JSON.stringify({ commit: OTHER_REVISION })}\n`,
    );
    expect(() => verifyBuildProvenance({ rootDir: infoRoot })).toThrow(/build-info/u);

    const validatorRoot = createFixture();
    emitFixture(validatorRoot);
    fs.appendFileSync(
      path.join(validatorRoot, "scripts/verify-build-provenance.mjs"),
      "// tampered\n",
    );
    expect(() => verifyBuildProvenance({ rootDir: validatorRoot })).toThrow(/validator/u);

    const mapRoot = createFixture();
    emitFixture(mapRoot);
    fs.appendFileSync(path.join(mapRoot, "dist/chunk.js.map"), "tampered\n");
    expect(() => verifyBuildProvenance({ rootDir: mapRoot })).toThrow(/source-map mismatch/u);
  });

  it("emits deterministic bytes and rejects a validly rehashed nondeterministic ordering", () => {
    const rootDir = createFixture();
    const first = emitFixture(rootDir);
    const firstBytes = fs.readFileSync(first.manifestPath, "utf8");
    const second = emitFixture(rootDir);
    expect(fs.readFileSync(second.manifestPath, "utf8")).toBe(firstBytes);

    const manifest = JSON.parse(firstBytes) as Record<string, unknown> & {
      artifacts: unknown[];
      manifestDigest: string;
    };
    manifest.artifacts = [
      { path: "dist/z.js", bytes: 0, sha256: "0".repeat(64) },
      ...manifest.artifacts,
    ];
    const { manifestDigest: _discarded, ...facts } = manifest;
    manifest.manifestDigest = createHash("sha256")
      .update(canonicalBuildProvenanceJson(facts))
      .digest("hex");
    fs.writeFileSync(first.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(() => verifyBuildProvenance({ rootDir })).toThrow(/deterministic sorted unique/u);
  });
});
