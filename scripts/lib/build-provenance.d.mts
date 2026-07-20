export const BUILD_PROVENANCE_VERSION: "openclaw-build-provenance-v1";
export const BUILD_PROVENANCE_VALIDATOR_ID: "openclaw-build-provenance-validator-v1";
export const BUILD_PROVENANCE_MANIFEST: "dist/build-provenance.json";
export const BUILD_PROVENANCE_REVISION_ENV: "OPENCLAW_SOURCE_REVISION";
export const BUILD_PROVENANCE_ARTIFACT_URI_ENV: "OPENCLAW_PROVENANCE_ARTIFACT_URI";
export const BUILD_PROVENANCE_REQUIRED_ENV: "OPENCLAW_REQUIRE_SOURCE_REVISION";

export function validateFullSourceRevision(value: unknown): string;
export function resolveBuildSourceRevision(params?: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  required?: boolean;
  execFileSync?: typeof import("node:child_process").execFileSync;
}): string | null;
export function canonicalBuildProvenanceJson(value: unknown): string;
export type BuildProvenanceFile = { path: string; bytes: number; sha256: string };
export type BuildProvenanceArtifact =
  | (BuildProvenanceFile & { kind?: never })
  | (BuildProvenanceFile & { kind: "symlink"; target: string });
export type BuildProvenanceInput =
  | (BuildProvenanceFile & { kind: "file" })
  | (BuildProvenanceFile & { kind: "tree"; files: number });
export type BuildProvenanceManifest = {
  version: "openclaw-build-provenance-v1";
  sourceRevision: string;
  manifestDigest: string;
  build: {
    profile: string;
    inputs: BuildProvenanceInput[];
    options: {
      bundledPluginDir: string;
      bundledPlugins: string;
      dockerfile: string;
      dockerVariant: string;
      privateQa: boolean;
    };
  };
  artifacts: BuildProvenanceArtifact[];
  sourceMaps: {
    entries: Array<BuildProvenanceFile & { generatedArtifact: string }>;
    bundleDigest: string;
    retainedArtifact: { uri: string; layout: string };
  };
  validator: { id: string; path: string; files: BuildProvenanceFile[]; sha256: string };
};
export type BuildProvenanceParams = {
  rootDir?: string;
  env?: NodeJS.ProcessEnv;
  required?: boolean;
  sourceRevision?: string;
  buildInputPaths?: string[];
  execFileSync?: typeof import("node:child_process").execFileSync;
};
export function createBuildProvenanceManifest(
  params?: BuildProvenanceParams,
): BuildProvenanceManifest;
export function writeBuildProvenance(params?: BuildProvenanceParams): {
  manifest: BuildProvenanceManifest;
  manifestPath: string;
  bundleRoot: string;
};
export function verifyBuildProvenance(params?: {
  rootDir?: string;
  manifestPath?: string;
  sourceRoot?: string;
  artifactRoot?: string;
  validatorRoot?: string;
  expectedRevision?: string;
  expectedRetainedArtifactUri?: string;
  sourceMapRoot?: string;
  requireRetainedSourceMaps?: boolean;
}): BuildProvenanceManifest;
